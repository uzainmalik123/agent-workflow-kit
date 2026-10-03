import { createHash } from "node:crypto";
import type { FeatureSession, PushApprovalRecord } from "@agent-workflow-kit/persistence";
import type { FinalGateResult } from "./final-gate.js";
import { isArtifactDigest } from "./approval.js";
import { orchestrationError, type OrchestrationError, type OrchestrationErrorCode } from "./errors.js";
import { isRecord } from "./result-validation.js";
import type { ProjectWorkspace } from "./workspace.js";

/**
 * Publishing: the branch, the commit, and the push.
 *
 * A certified feature reaches `awaiting_push_approval` with a gate verdict, a summary a human read,
 * and an approval bound to the bytes of both. This file is the second half of that arrangement, and it
 * exists to make the publish boring: three Git operations with names derived from the approval, run
 * against an explicit remote, and a record of what happened.
 *
 * The division of responsibility is the same one the workspace port draws, and it is drawn in the same
 * direction:
 *
 * - The orchestration layer owns *policy*. It decides the branch name, the commit message, which paths
 *   a commit may contain, what "this branch is ours" means, whether the approval still describes what
 *   is on disk, and what a refusal means for the workflow. It runs no Git.
 * - An adapter owns *mechanism*. It creates a branch, writes a commit, and pushes one ref. It decides
 *   nothing about whether publishing should happen, and it reports a refusal with a code rather than
 *   choosing what to do about it.
 *
 * Four properties are worth stating here rather than leaving to the reader of a diff, because each of
 * them is a way this could have gone wrong and did not:
 *
 * - **Nothing is forced.** No call site in this package issues a force push, a history rewrite, a
 *   deletion, a tag push, or a ref update, and the adapter's publishing allowlist refuses those
 *   arguments as well as trusting the call site not to use them. Publishing a feature branch is an
 *   additive operation; a remote that rejects it rejects it.
 * - **`main` and `master` are not reachable.** The branch name is built here and validated here, and
 *   validation is against a pattern anchored on the framework's own prefix rather than a denylist of
 *   branch names somebody remembered. A framework that publishes to a default branch would be making a
 *   decision no one approved.
 * - **The commit is the approved tree and nothing else.** The paths handed to the adapter are the
 *   measured change set, filtered by the approved scope, and a protected path is refused rather than
 *   staged. An unauthorized file in a published commit would be invisible to every later reader.
 * - **The pushed ref is the recorded commit.** The push names the commit SHA explicitly rather than
 *   "whatever the branch points at now", so a branch moved between the commit and the push cannot
 *   change what ships.
 *
 * The two workflow states are two steps, not two halves of one: `committing` creates the branch and
 * writes the commit, `pushing` pushes the commit that was recorded, and only a successful push lets
 * the session move on. A push that is rejected leaves the feature in `pushing` with the commit still
 * recorded, which is a state a retry can finish rather than work it has to redo.
 */

/* -------------------------------------------------------------------------------------------- */
/* The port                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * Why a publishing operation was refused, in the adapter's own vocabulary.
 *
 * These are codes an implementation raises; `PUBLISH_REFUSAL_ERROR_CODE` is where the orchestration
 * layer turns each one into a workflow-visible refusal. The separation matters because the adapter
 * cannot know what the failure means for a workflow: "this branch already exists" is a fact about a
 * repository, and whether it is fatal is decided above.
 */
export const PUBLISH_REFUSAL_CODES = [
  /** The Git process could not be started at all. */
  "git_unavailable",
  /** The worktree is not at the commit the approval froze. */
  "head_moved",
  /** The worktree index already holds staged content, so the index was written by something else. */
  "staged_index_not_empty",
  /** A path in the change set cannot be staged safely. */
  "path_unsafe",
  /** The branch name cannot be expressed as a safe ref. */
  "branch_unsafe",
  /** A branch with this name exists and is not this feature's. */
  "branch_conflict",
  /** The branch could not be created or attached to. */
  "branch_failed",
  /** The repository has no commit identity, so a commit cannot be attributed to anyone. */
  "identity_unconfigured",
  /** The commit could not be written. */
  "commit_failed",
  /** The recorded commit is not in this repository. */
  "commit_missing",
  /** The branch points at a different commit than the one recorded. */
  "branch_moved",
  /** The named remote does not exist in this repository. */
  "remote_unavailable",
  /** The remote refused the push. */
  "push_rejected",
] as const;

export type PublishRefusalCode = (typeof PUBLISH_REFUSAL_CODES)[number];

/**
 * How the orchestration layer maps each refusal onto the workflow's own error codes.
 *
 * Every entry is named rather than derived, because the mapping is a judgement: `head_moved` and
 * `staged_index_not_empty` are both "the tree is not what was approved", and both are workspace
 * failures rather than workflow ones, while `branch_conflict` is a repository that already has this
 * name in it and needs a person to look. A caller can therefore branch on the code without reading the
 * message.
 */
export const PUBLISH_REFUSAL_ERROR_CODE: Readonly<Record<PublishRefusalCode, OrchestrationErrorCode>> =
  {
    git_unavailable: "publish_publisher_failed",
    head_moved: "publish_tree_changed",
    staged_index_not_empty: "publish_tree_changed",
    path_unsafe: "publish_path_unsafe",
    branch_unsafe: "publish_branch_unsafe",
    branch_conflict: "publish_branch_conflict",
    branch_failed: "publish_branch_failed",
    identity_unconfigured: "publish_identity_unconfigured",
    commit_failed: "publish_commit_failed",
    commit_missing: "publish_commit_missing",
    branch_moved: "publish_branch_moved",
    remote_unavailable: "publish_remote_unavailable",
    push_rejected: "publish_push_rejected",
  };

/**
 * What "this branch belongs to this feature's publishing approval" means.
 *
 * The tokens are chosen here and only checked against the repository by the adapter, because deciding
 * ownership is policy — the framework knows what its own commit messages say — while reading a commit
 * message is mechanism. An adapter that invented the tokens could recognise only its own, and one that
 * decided ownership on its own could accept a branch it had no evidence for.
 */
export interface PublishBranchOwnership {
  readonly featureId: string;
  /** The digest of the summary the approval was bound to. */
  readonly summarySha256: string;
}

export interface PublishCommitRequest {
  /** The isolated worktree the verified work lives in. */
  readonly workspace: ProjectWorkspace;
  readonly featureId: string;
  /** The exact ref to create or reuse, already validated by {@link buildFeatureBranch}. */
  readonly branch: string;
  /** The exact commit message, already built by {@link buildFeatureCommitMessage}. */
  readonly commitMessage: string;
  /** Repository-relative paths, sorted, already scope-checked by the orchestration layer. */
  readonly paths: readonly string[];
  /** The commit the worktree must be at, which is the approved baseline. */
  readonly expectedHead: string;
  readonly ownership: PublishBranchOwnership;
  readonly signal?: AbortSignal | null;
}

export type PublishCommitOutcome =
  | {
      readonly ok: true;
      /** The commit that now holds the approved change set. */
      readonly commit: string;
      /** True when this feature's approval had already been committed and the work was reused. */
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly code: PublishRefusalCode; readonly message: string };

export interface PublishPushRequest {
  /**
   * The repository the remote belongs to.
   *
   * The push runs here rather than in the isolated worktree because the worktree's HEAD has moved by
   * then — that is what committing on a branch does — and because refs and the object database are
   * shared between a worktree and its repository. Nothing in a human's working tree is written: a push
   * writes the repository's own refs, not files.
   */
  readonly repositoryRoot: string;
  readonly featureId: string;
  readonly branch: string;
  /** The commit recorded when it was written. Pushed as an explicit source, never as a branch name. */
  readonly commit: string;
  /** The remote to push to. Must exist in this repository; nothing here guesses a name. */
  readonly remote: string;
  readonly signal?: AbortSignal | null;
}

export type PublishPushOutcome =
  | { readonly ok: true; readonly branch: string; readonly commit: string; readonly remote: string }
  | { readonly ok: false; readonly code: PublishRefusalCode; readonly message: string };

/**
 * The mechanism this milestone needs, and the whole of it.
 *
 * Two operations rather than one, because the workflow has two states for them and because a push
 * should be able to be retried without re-committing anything. An implementation is expected to be
 * idempotent: committing twice for one approval returns the commit that is already there, and pushing
 * the same commit twice reports the same answer.
 */
export interface FeaturePublisher {
  commitFeature(request: PublishCommitRequest): Promise<PublishCommitOutcome>;
  pushBranch(request: PublishPushRequest): Promise<PublishPushOutcome>;
}

/* -------------------------------------------------------------------------------------------- */
/* Branch names                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** Every branch this framework creates starts here, which is what makes `main` unreachable. */
export const PUBLISHING_BRANCH_PREFIX = "agentflow";

/** How much of the approval digest goes into the branch name. */
export const BRANCH_UNIQUE_SUFFIX_LENGTH = 12;

/** The longest ref this framework will create, short of Git's own 255-byte limit on purpose. */
export const MAX_BRANCH_NAME_LENGTH = 200;

export const MAX_FEATURE_ID_LENGTH = 64;

/**
 * The characters Git reserves in a ref, or that a following argument would read as something else.
 *
 * `~` and `^` are revision operators, `:` starts pathspec magic, `?` and `*` are glob characters, `[`
 * opens a character class, and the backslash is an escape. They are listed rather than pattern-matched so
 * the rule reads as a list of forbidden characters rather than as a character class to decode.
 */
const RESERVED_REF_CHARACTERS: ReadonlySet<string> = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

/**
 * Whether a name contains whitespace, a control character, or a character Git reserves.
 *
 * Scanned rather than pattern-matched, because a regular expression for control characters has to spell
 * them as escapes inside a character class, where they read as noise rather than as a rule. The test
 * `codePointAt(0) <= 0x20` is every C0 control character and the space in one comparison, and `0x7f` is
 * DEL — together, the set `git check-ref-format` refuses. It is applied to the whole assembled name
 * rather than to the feature id alone, so a name this module builds cannot produce a ref Git would
 * rewrite or reject.
 */
function hasUnsafeRefCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;

    if (code <= 0x20 || code === 0x7f || RESERVED_REF_CHARACTERS.has(character)) {
      return true;
    }
  }

  return false;
}

/** Branch names that mean "the project's own line of development", whatever branch they are on. */
const RESERVED_BRANCH_NAMES: ReadonlySet<string> = new Set(["main", "master", "HEAD", "develop"]);

export type BranchNameOutcome =
  | { readonly ok: true; readonly branch: string; readonly suffix: string }
  | { readonly ok: false; readonly error: OrchestrationError };

/**
 * The branch this approval publishes to.
 *
 * Deterministic, and derived from the approval rather than from the clock or a counter: the same
 * approval always names the same branch, so a retried publish finds the branch it created instead of
 * colliding with it, and two features — or two attempts of one feature — cannot land on the same name.
 *
 * The suffix is a digest of the summary and gate the approval was bound to, which is also what makes
 * ownership decidable: a branch named for this approval can be recognized later by its own name and its
 * commit's trailers, with nothing remembered outside the repository.
 */
export function buildFeatureBranch(input: {
  readonly featureId: string;
  readonly approval: PushApprovalRecord;
}): BranchNameOutcome {
  const featureId = input.featureId;
  const reason = unsafeFeatureIdReason(featureId);

  if (reason !== null) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_branch_unsafe",
        `Feature "${featureId}" cannot be part of a branch name: ${reason}. The framework derives branch names from feature ids rather than slugging them, so a rename is safer than a rule that guesses what a name was meant to be.`,
      ),
    };
  }

  const suffix = createHash("sha256")
    .update(
      [
        input.approval.featureId,
        input.approval.summarySha256,
        input.approval.finalGateSha256,
        String(input.approval.approvedRevision),
      ].join(" "),
      "utf8",
    )
    .digest("hex")
    .slice(0, BRANCH_UNIQUE_SUFFIX_LENGTH);

  const branch = `${PUBLISHING_BRANCH_PREFIX}/${featureId}-${suffix}`;

  if (!isSafeBranchName(branch)) {
    // Unreachable for a feature id that passed the check above, and treated as a refusal rather than a
    // throw: a caller that built the name differently must not be able to reach `git` with it.
    return {
      ok: false,
      error: orchestrationError(
        "publish_branch_unsafe",
        `The branch name derived for feature "${featureId}" is not a safe ref. Refusing rather than passing it to Git and letting the repository decide what it means.`,
      ),
    };
  }

  return { ok: true, branch, suffix };
}

/**
 * Whether a name is a ref this framework is willing to push.
 *
 * The check is a property of the name, not a comparison against a list of branches the project happens
 * to have: any name outside `agentflow/…` is refused, and a name inside it still has to be a well-formed
 * ref whose last segment is not one of the project's own lines of development.
 */
export function isSafeBranchName(name: string): boolean {
  return unsafeBranchNameReason(name) === null;
}

/**
 * Why a branch name is refused, or null when it is acceptable. Named rather than returned as a boolean
 * so every refusal can say what was wrong with the name instead of that the name was wrong.
 */
export function unsafeBranchNameReason(name: string): string | null {
  if (name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) {
    return `a ref must be between 1 and ${String(MAX_BRANCH_NAME_LENGTH)} characters`;
  }

  if (hasUnsafeRefCharacter(name)) {
    return "it contains whitespace, a control character, or one of Git's revision operators (~ ^ : ? * [ \\)";
  }

  if (name.includes("..") || name.includes("@{")) {
    return "it contains \"..\" or \"@{\", which Git reads as a revision rather than as a name";
  }

  if (name.endsWith("/") || name.includes("//")) {
    return "it has an empty ref segment";
  }

  const segments = name.split("/");

  if (segments.some((segment) => segment.length === 0)) {
    return "it has an empty ref segment";
  }

  if (segments.some((segment) => segment.startsWith("-") || segment.startsWith("."))) {
    return "a ref segment starts with \"-\" or \".\"";
  }

  if (segments.some((segment) => segment.endsWith(".") || segment.endsWith(".lock"))) {
    return "a ref segment ends with \".\" or \".lock\"";
  }

  const prefix = `${PUBLISHING_BRANCH_PREFIX}/`;

  if (!name.startsWith(prefix)) {
    return `it is not under "${prefix}", and this framework publishes only to branches it names itself`;
  }

  if (RESERVED_BRANCH_NAMES.has(segments[segments.length - 1] ?? "")) {
    return "it names a line of development rather than a feature branch";
  }

  return null;
}

function unsafeFeatureIdReason(featureId: string): string | null {
  if (featureId.length === 0 || featureId.length > MAX_FEATURE_ID_LENGTH) {
    return `it must be between 1 and ${String(MAX_FEATURE_ID_LENGTH)} characters`;
  }

  if (hasUnsafeRefCharacter(featureId)) {
    return "it contains whitespace, a control character, or a character Git reserves";
  }

  if (featureId.includes("..") || featureId.includes("@{")) {
    return "it contains \"..\" or \"@{\", which Git reads as a revision rather than as a name";
  }

  if (featureId.startsWith("-") || featureId.startsWith(".")) {
    return "it starts with \"-\" or \".\"";
  }

  if (featureId.endsWith(".") || featureId.endsWith(".lock")) {
    return "it ends with \".\" or \".lock\"";
  }

  return null;
}

/* -------------------------------------------------------------------------------------------- */
/* Remote names                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * The remote used when an orchestrator is not told one.
 *
 * Named here rather than inferred: `git push` with no remote asks Git to pick, and picking is a
 * decision. An operator who publishes somewhere else configures it, and an operator whose repository
 * has no `origin` gets a refusal rather than an interactive prompt inside a framework process.
 */
export const DEFAULT_PUBLISH_REMOTE = "origin";

export type RemoteNameOutcome =
  | { readonly ok: true; readonly remote: string }
  | { readonly ok: false; readonly error: OrchestrationError };

/** Remote names this framework will name on a command line. */
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

/**
 * Whether a configured remote name is one this framework will put on a command line.
 *
 * The interesting part is the leading `-`: a remote called `--mirror` would be read by Git as the
 * mirror flag, and a name that reaches the process at all is a name that came from configuration
 * rather than from the framework, so it is checked rather than trusted.
 */
export function verifyRemoteName(remote: string): RemoteNameOutcome {
  if (!isSafeRemoteName(remote)) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_remote_unavailable",
        `The configured publishing remote "${remote}" is not a remote name this framework will pass to Git. A remote must start with a letter or digit and may contain letters, digits, dots, dashes, slashes, and underscores.`,
      ),
    };
  }

  if (remote.includes("..")) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_remote_unavailable",
        `The configured publishing remote "${remote}" contains "..", which is never a remote name.`,
      ),
    };
  }

  return { ok: true, remote };
}

/**
 * The same rule {@link verifyRemoteName} applies, as a predicate the record parser can use.
 *
 * One definition rather than two: a name the orchestrator would refuse to configure is a name the parser
 * must also refuse to accept, and a check that exists only in the caller is a check a hand-edited record
 * walks straight past.
 */
function isSafeRemoteName(remote: string): boolean {
  return SAFE_REMOTE_NAME.test(remote) && !remote.includes("..");
}

/* -------------------------------------------------------------------------------------------- */
/* Commit messages                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** The longest title a commit subject may carry, so the subject stays a subject. */
export const MAX_COMMIT_TITLE_LENGTH = 72;

export type CommitMessageOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: OrchestrationError };

/**
 * The commit message this approval publishes under.
 *
 * The subject is `feat(<feature-id>): <feature title>`, derived from the session rather than composed,
 * so two runs of the same feature produce the same message and a reader can tell from the subject alone
 * which workflow wrote it. The title is put on one line and bounded, because a subject is a summary and
 * a title a human typed may be several.
 *
 * The body carries the approval's own digests as trailers. They are there for two reasons: an audit
 * asks "which approval published this commit" and can answer it from the commit, and ownership of a
 * branch is decidable from those trailers rather than from anything remembered outside the repository.
 * No command output, no transcript, and no model-written prose goes in here.
 */
export function buildFeatureCommitMessage(input: {
  readonly featureId: string;
  readonly title: string;
  readonly approval: PushApprovalRecord;
}): CommitMessageOutcome {
  const title = commitTitleOf(input.title);

  if (title === null) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_commit_message_invalid",
        `The title of feature "${input.featureId}" contains nothing that can be written into a commit subject. The framework writes the subject from the feature title rather than inventing one.`,
      ),
    };
  }

  const trailers = [
    `Feature-Id: ${input.featureId}`,
    `Push-Approval-Summary-Sha256: ${input.approval.summarySha256}`,
    `Push-Approval-Gate-Sha256: ${input.approval.finalGateSha256}`,
    `Push-Approval-Revision: ${String(input.approval.approvedRevision)}`,
    ...(input.approval.actor === null ? [] : [`Push-Approval-Actor: ${input.approval.actor}`]),
  ];

  return { ok: true, message: [`feat(${input.featureId}): ${title}`, "", ...trailers].join("\n") };
}

/**
 * A commit subject's title, or null when the input cannot produce one.
 *
 * Whitespace is collapsed rather than trimmed only, because a title with a newline in it is a title
 * that would otherwise split a subject into two lines and change what a commit log shows. An over-long
 * title is truncated with an ellipsis rather than refused: the feature id already identifies the work,
 * and refusing to publish because a title was verbose would be a strange failure.
 */
export function commitTitleOf(title: string): string | null {
  const collapsed = title.replace(/\s+/gu, " ").trim();

  if (collapsed.length === 0) {
    return null;
  }

  if (collapsed.length <= MAX_COMMIT_TITLE_LENGTH) {
    return collapsed;
  }

  return `${collapsed.slice(0, MAX_COMMIT_TITLE_LENGTH - 3)}...`;
}

/**
 * Whether a commit message is this feature's, for this approval.
 *
 * Used to decide whether an existing branch may be reused: a branch whose tip was written by some other
 * feature, some other approval, or some other tool is refused rather than pushed over. The check is on
 * the branch tip's own trailers, so the answer survives the framework having no memory of the branch.
 */
export function commitCarriesOwnership(
  message: string,
  ownership: PublishBranchOwnership,
): boolean {
  const lines = new Map<string, string>();

  for (const line of message.split("\n")) {
    const separator = line.indexOf(":");

    if (separator > 0) {
      // First occurrence wins: a trailer cannot be redefined further down the same message.
      if (!lines.has(line.slice(0, separator).trim())) {
        lines.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      }
    }
  }

  return (
    lines.get("Feature-Id") === ownership.featureId &&
    lines.get("Push-Approval-Summary-Sha256") === ownership.summarySha256
  );
}

/* -------------------------------------------------------------------------------------------- */
/* The approval, re-checked                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** Which of the two publishing steps is being performed. */
export const PUBLISH_STEPS = ["commit", "push"] as const;

export type PublishStep = (typeof PUBLISH_STEPS)[number];

/**
 * How far the session revision moves between the approval and each step.
 *
 * The approval is recorded in the mutation that enters `committing`, so the commit step starts on the
 * approval's own revision and the push step starts one later, on the revision that recorded the commit.
 * Anything else means something was recorded in between that this approval did not cover.
 */
const PUBLISH_STEP_REVISION_OFFSET: Readonly<Record<PublishStep, number>> = { commit: 0, push: 1 };

export interface PublishApprovalEvidence {
  /** The final gate as it is recorded on disk. */
  readonly gate: FinalGateResult;
  /** The digest of the exact bytes of `final-gate.json`. */
  readonly gateSha256: string;
  /** The digest of the exact bytes of `final-summary.md`. */
  readonly summarySha256: string;
  readonly step: PublishStep;
}

export type PublishApprovalVerdict =
  | { readonly ok: true; readonly approval: PushApprovalRecord }
  | { readonly ok: false; readonly error: OrchestrationError };

/**
 * Whether the recorded approval still describes this feature, this tree, and this point in the
 * workflow.
 *
 * This is the same set of bindings the approval recorded, checked from the other side. Approval and
 * publishing are separate events, and between them a summary can be edited, a gate can be re-run, a
 * fixer can leave a repair nothing re-tested, and the session can record something else entirely. Any
 * of those changes what the human agreed to publish, so each is refused by name rather than detected by
 * a mismatch later on.
 *
 * The working tree is deliberately *not* compared here. That comparison needs a measurement, and the
 * measurement is taken by the publish step itself against the workspace it is about to commit — a
 * fingerprint read from a session file would say nothing about the tree.
 */
export function verifyPublishApproval(
  session: FeatureSession,
  evidence: PublishApprovalEvidence,
): PublishApprovalVerdict {
  const approval = session.approvals.push;

  if (approval === null) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_not_approved",
        `Feature "${session.featureId}" records no publishing approval. A gate verdict and a summary are not an approval: publishing waits for an explicit one, and the framework never writes one on a human's behalf.`,
      ),
    };
  }

  if (approval.featureId !== session.featureId) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_not_approved",
        `The publishing approval recorded in this session belongs to feature "${approval.featureId}", not to "${session.featureId}".`,
      ),
    };
  }

  if (approval.summarySha256 !== evidence.summarySha256) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_summary_mismatch",
        `The recorded approval was given for a summary hashing to ${approval.summarySha256}, and the summary on disk hashes to ${evidence.summarySha256}. A human approved those exact bytes, and an edited summary is a different document. Re-run the final summary and obtain a new approval.`,
      ),
    };
  }

  const gate = evidence.gate;

  if (
    gate.featureId !== session.featureId ||
    gate.revision !== approval.finalGateRevision ||
    gate.fingerprint !== approval.finalGateFingerprint ||
    gate.fingerprint !== approval.workingTreeFingerprint ||
    evidence.gateSha256 !== approval.finalGateSha256
  ) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_approval_stale",
        `The recorded approval was given against the final gate at revision ${String(approval.finalGateRevision)} for tree ${approval.finalGateFingerprint}, and the gate on disk is revision ${String(gate.revision)} for tree ${gate.fingerprint}. Nothing refreshes an approval into agreement: a new gate, a new summary, and a new approval are the only way through.`,
      ),
    };
  }

  if (gate.fixer === "unreverified" || gate.fixer === "exhausted") {
    return {
      ok: false,
      error: orchestrationError(
        "publish_fix_unresolved",
        `The recorded final gate reports the fixer as "${gate.fixer}", so a repair in this feature has not been re-tested to the gate's satisfaction. Publishing an unrepaired feature is refused; re-run the stages the fix touched and the gate.`,
      ),
    };
  }

  const expectedRevision = approval.approvedRevision + PUBLISH_STEP_REVISION_OFFSET[evidence.step];

  if (session.revision !== expectedRevision) {
    return {
      ok: false,
      error: orchestrationError(
        "publish_approval_stale",
        `The ${evidence.step} step of publishing expects this feature to be at revision ${String(expectedRevision)} — the approval plus this step's own records — and it is at ${String(session.revision)}. Something was recorded after the approval that it does not cover.`,
      ),
    };
  }

  return { ok: true, approval };
}

/* -------------------------------------------------------------------------------------------- */
/* The record                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export const PUBLISH_ARTIFACT_NAME = "publish" as const;

export interface PublishApprovalReference {
  readonly approvedAt: string;
  readonly approvedRevision: number;
  readonly summarySha256: string;
  readonly finalGateSha256: string;
  readonly actor: string | null;
}

/**
 * What publishing did, as the session records it.
 *
 * Small on purpose. It answers the question a reader of a feature directory actually has — was this
 * published, where, and on whose approval — with eight facts and no command output: the branch, the
 * commit, the remote, whether the push succeeded, the two revisions it moved through, and the approval
 * it was performed under.
 *
 * It is written twice, once per step, and the second write is the same document with the push recorded.
 * The commit is durable in the repository whether or not the session file is updated, so the record that
 * matters for "did this ship" is written after the push succeeded and never before it: a record naming a
 * remote that never received the branch does not exist.
 */
export interface PublishRecord {
  readonly schemaVersion: 1;
  readonly featureId: string;
  readonly branch: string;
  /** The commit holding the approved change set. */
  readonly commit: string;
  /** The remote, once one has been pushed to. */
  readonly remote: string | null;
  readonly result: "committed" | "pushed";
  /** Every repository-relative path the commit contains, sorted. */
  readonly paths: readonly string[];
  /** The session revision the approval was recorded at. */
  readonly revisionBefore: number;
  /** The session revision that carried this record. */
  readonly revisionAfter: number;
  readonly recordedAt: string;
  readonly pushedAt: string | null;
  readonly approval: PublishApprovalReference;
}

export function publishApprovalReference(approval: PushApprovalRecord): PublishApprovalReference {
  return {
    approvedAt: approval.approvedAt,
    approvedRevision: approval.approvedRevision,
    summarySha256: approval.summarySha256,
    finalGateSha256: approval.finalGateSha256,
    actor: approval.actor,
  };
}

/**
 * The record after a push, given the record that named the commit.
 *
 * Written as a replacement rather than as an edit so that every field of the document was produced by
 * one step of one attempt, and a reader never has to merge two.
 */
export function withPushRecorded(
  record: PublishRecord,
  push: { readonly remote: string; readonly at: string; readonly revisionAfter: number },
): PublishRecord {
  return {
    ...record,
    remote: push.remote,
    result: "pushed",
    pushedAt: push.at,
    revisionAfter: push.revisionAfter,
  };
}

export type PublishRecordVerdict =
  | { readonly ok: true; readonly record: PublishRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * The recorded publish document, or why it cannot be used.
 *
 * Parsing is strict in the same way the gate's is: a record that cannot be read is a refusal rather than
 * a partial read, because the push step acts on the commit named in here and a guess about which commit
 * that was would be a guess about what ships.
 */
export function publishRecordFrom(value: unknown): PublishRecordVerdict {
  if (!isRecord(value)) {
    return { ok: false, reason: "it is not a JSON object" };
  }

  if (value["schemaVersion"] !== 1) {
    return { ok: false, reason: "its schemaVersion is not 1" };
  }

  const featureId = value["featureId"];

  if (typeof featureId !== "string" || featureId.length === 0) {
    return { ok: false, reason: "it names no feature" };
  }

  const branch = value["branch"];

  if (typeof branch !== "string" || unsafeBranchNameReason(branch) !== null) {
    return { ok: false, reason: "it names no branch this framework would have pushed" };
  }

  const commit = value["commit"];

  if (typeof commit !== "string" || !FULL_OBJECT_NAME.test(commit)) {
    return { ok: false, reason: "it names no commit" };
  }

  const result = value["result"];

  if (result !== "committed" && result !== "pushed") {
    return { ok: false, reason: "its result is neither \"committed\" nor \"pushed\"" };
  }

  const remote = value["remote"];

  if (remote !== null && (typeof remote !== "string" || !isSafeRemoteName(remote))) {
    return { ok: false, reason: "it names no remote this framework would have pushed to" };
  }

  if (result === "pushed" && remote === null) {
    return { ok: false, reason: "it reports a push without naming a remote" };
  }

  const paths = value["paths"];

  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && path.length > 0)) {
    return { ok: false, reason: "it records no list of committed paths" };
  }

  const revisionBefore = value["revisionBefore"];
  const revisionAfter = value["revisionAfter"];

  if (!isRevision(revisionBefore) || !isRevision(revisionAfter) || revisionAfter <= revisionBefore) {
    return { ok: false, reason: "its revisions do not describe one step of one attempt" };
  }

  const recordedAt = value["recordedAt"];

  if (typeof recordedAt !== "string" || recordedAt.length === 0) {
    return { ok: false, reason: "it carries no timestamp" };
  }

  const pushedAt = value["pushedAt"];

  if (result === "pushed" && (typeof pushedAt !== "string" || pushedAt.length === 0)) {
    return { ok: false, reason: "it reports a push with no time" };
  }

  if (result === "committed" && pushedAt !== null) {
    return { ok: false, reason: "it carries a push time without reporting a push" };
  }

  const approval = value["approval"];

  if (!isRecord(approval)) {
    return { ok: false, reason: "it records no approval" };
  }

  const approvalReason = approvalReferenceReason(approval);

  if (approvalReason !== null) {
    return { ok: false, reason: `its approval reference is unusable because ${approvalReason}` };
  }

  return {
    ok: true,
    record: {
      schemaVersion: 1,
      featureId,
      branch,
      commit,
      remote,
      result,
      paths: [...(paths as readonly string[])].sort(),
      revisionBefore,
      revisionAfter,
      recordedAt,
      pushedAt: result === "pushed" ? (pushedAt as string) : null,
      approval: {
        approvedAt: approval["approvedAt"] as string,
        approvedRevision: approval["approvedRevision"] as number,
        summarySha256: approval["summarySha256"] as string,
        finalGateSha256: approval["finalGateSha256"] as string,
        actor: (approval["actor"] ?? null) as string | null,
      },
    },
  };
}

/** A full, unabbreviated Git object name. Abbreviations are ambiguous and are never recorded. */
const FULL_OBJECT_NAME = /^[0-9a-f]{40}$/u;

/** A session revision: a positive integer, as JSON writes it. */
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function approvalReferenceReason(approval: Record<string, unknown>): string | null {
  if (typeof approval["approvedAt"] !== "string" || approval["approvedAt"].length === 0) {
    return "it carries no approval time";
  }

  if (!isRevision(approval["approvedRevision"])) {
    return "it carries no approval revision";
  }

  if (!isArtifactDigest(approval["summarySha256"])) {
    return "it names no summary digest";
  }

  if (!isArtifactDigest(approval["finalGateSha256"])) {
    return "it names no final gate digest";
  }

  if (approval["actor"] !== null && typeof approval["actor"] !== "string") {
    return "its actor is neither a string nor null";
  }

  return null;
}

/**
 * Whether a recorded commit was recorded under the approval now in force.
 *
 * The push step reads a document another step wrote, and the approval may since have been replaced by a
 * hand-edited session. Both have to describe one decision before anything is sent to a remote.
 */
export function publishRecordMatchesApproval(record: PublishRecord, approval: PushApprovalRecord): boolean {
  return (
    record.featureId === approval.featureId &&
    record.approval.approvedRevision === approval.approvedRevision &&
    record.approval.summarySha256 === approval.summarySha256 &&
    record.approval.finalGateSha256 === approval.finalGateSha256
  );
}