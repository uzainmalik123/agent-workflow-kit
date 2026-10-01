import { createHash } from "node:crypto";
import type { FixReturnState } from "@agent-workflow-kit/core";
import type { FixHistoryEntry } from "@agent-workflow-kit/persistence";
import { orchestrationError, type OrchestrationError } from "./errors.js";
import { isRecord } from "./result-validation.js";
import { STAGE_BY_STATE, type WorkStage } from "./stages.js";
import {
  DETERMINISTIC_EVIDENCE_KEY,
  VERIFICATION_STAGE_BY_WORK_STAGE,
  validateVerificationEvidenceBundle,
  type VerificationEvidenceBundle,
  type VerificationStage,
} from "./verification.js";
import {
  securityAffectedPaths,
  securityFailureReason,
  type SecurityReviewEvidence,
} from "./security.js";
import {
  approvedPathsOf,
  isProtectedWorkspacePath,
  matchesScopePattern,
  WORKSPACE_PROTECTED_PATTERNS,
  type WorkspaceChanges,
} from "./workspace.js";

/**
 * The fixer trust model, in one module.
 *
 * The fixer is the only stage that writes, and it is the only stage whose job is to make a failing
 * check stop failing. That combination is the whole problem this file exists for: an agent that may
 * edit code and is rewarded for a green check has two ways to be useful, and only one of them is a
 * repair. The other is editing whatever the green check reads.
 *
 * So the framework splits the two authorities. The fixer owns the implementation and nothing else.
 * The meaning of success — the approved spec, the requirements and acceptance criteria in it, the
 * verification configuration, the workflow state, the approval checkpoint, the recorded evidence —
 * is framework-owned, is hashed before the fixer is invoked, and is compared again afterwards. A
 * repair that changes any of it has not repaired anything; it has moved the goalposts, and the fix
 * is rejected and the workflow is escalated to a human.
 *
 * Everything here is a deterministic decision over facts the framework already holds: the measured
 * change set, the frozen artifact digests, the recorded evidence, and the approved path patterns.
 * There is no code analysis in this file and none is planned. The checks below reject the shapes of
 * cheating that a path list and a digest can see — a deleted test, an edited configuration, a
 * rewritten spec, a write outside the approved scope — and the limits of that are stated where they
 * are reached rather than papered over. A semantic question like "is this new assertion weaker than
 * the one it replaced" needs an analyzer this framework does not have; pretending a marker list
 * settles it would be worse than saying so, because it would report a guarantee that does not exist.
 */

/**
 * How many times a fix loop may run before the framework stops.
 *
 * The number is a framework decision, not a project setting and not something a stage can raise. A
 * fixer that cannot repair a defect in five attempts is not going to repair it in six, and a loop
 * with no end is how an automated workflow spends a night oscillating between two equally wrong
 * states while appearing to make progress. Reaching the limit is a result, not a hang: the attempt
 * is refused before the fixer is invoked, the refusal is recorded in the same fix history as a real
 * attempt, and the feature is failed for a human to take.
 *
 * It is overridable at construction so a project with a genuinely slow build can raise it, and it is
 * still bounded, still counted, and still escalated at whatever the limit ends up being.
 */
export const MAX_FIX_ATTEMPTS = 5;

/** The lowest value `maxFixAttempts` may take. A limit of zero would refuse every repair. */
const MIN_FIX_ATTEMPTS = 1;

/**
 * The effective attempt limit.
 *
 * A non-integer, a negative number, and a limit below one all resolve to the default rather than to
 * the smallest limit that would still allow a repair. The failure mode of a bad limit is asymmetric:
 * too low costs a human one manual repair, and an unexpected limit is visible in the returned result,
 * while a limit that resolved to zero or `NaN` would refuse every fix and turn any defect into a
 * terminal one. Falling back to the same number an unset option gets means a malformed configuration
 * behaves exactly like no configuration, which is the only reading of "I did not say" that is safe.
 */
export function resolveMaxFixAttempts(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isInteger(value) || value < MIN_FIX_ATTEMPTS) {
    return MAX_FIX_ATTEMPTS;
  }

  return value;
}

/**
 * The requirement and acceptance criterion a fix is being asked to satisfy.
 *
 * Null when the stage that asked for the fix did not record one. A review stage's finding is a
 * statement about code rather than about a numbered criterion, and the framework does not invent a
 * requirement id to fill the field: a fixer told "criterion AC-3" when the record says nothing of
 * the kind has been told something the record does not support.
 */
export interface FixFailureTarget {
  readonly requirementId: string;
  readonly acceptanceCriterionId: string | null;
  readonly description: string;
}

/**
 * Everything the fixer is given about the failure, and the whole of its authority.
 *
 * This object is the fixer's input contract. It is built by the framework from recorded state, it is
 * read-only, and it is deliberately shaped so that a complete answer is expressible: which stage
 * failed, which verification measured it, which criterion it was measured against, the deterministic
 * evidence verbatim, the files the failing stage suspected, the exact path patterns the fix may write,
 * the revision and fingerprint it starts from, and which attempt this is.
 *
 * What is absent is as much of the contract as what is present. There is no field for the acceptance
 * criteria, the verification commands, the workflow state, or the approval checkpoint, because those
 * are not the fixer's to state: the criteria arrive as read-only context and are hash-checked, the
 * commands are chosen by a project adapter, the state is a file the fixer has no output slot for and
 * is protected on disk, and the checkpoint is a number in a session document. A fixer cannot be given
 * a lever it has no way to pull.
 */
export interface FixerInputContract {
  readonly featureId: string;
  /** The workflow state whose failure triggered this fix, and the state the fix returns to. */
  readonly failedStage: FixReturnState;
  /** The deterministic verification that measured the failure, or null for a review-stage fix. */
  readonly failedVerification: VerificationStage | null;
  readonly target: FixFailureTarget | null;
  /** The bundle that decided the failure, verbatim, or null when the origin stage produced none. */
  readonly deterministicEvidence: VerificationEvidenceBundle | null;
  /**
   * The security record that decided the failure, verbatim, or null when the origin stage produced none.
   *
   * A fix triggered by the security gate carries one here and nothing in `deterministicEvidence`, which
   * is the point of the field. The two evidences answer different questions and have different
   * remedies: a failing verification wants a line changed, while a failed security check wants the
   * feature that introduced it to be smaller. A fixer given both would have to guess which question it
   * was answering, so it is handed exactly the record that decided.
   */
  readonly securityEvidence: SecurityReviewEvidence | null;
  readonly failureReason: string;
  /** Repository-relative paths the failing stage named, when it named any. */
  readonly suspectedFiles: readonly string[];
  /** The exact patterns this fix may write. Every other path is a rejected fix. */
  readonly approvedScope: readonly string[];
  /** The session revision this fix starts from, and the tree fingerprint it starts from. */
  readonly revision: number;
  readonly implementationFingerprint: string | null;
  /** 1-based. Equals `maxAttempts` on the last attempt the framework will run. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Restated for the fixer: the paths no fix may change, whatever the approved plan says. */
  readonly protectedPaths: readonly string[];
}

/** What a fix may never change, in the form the fixer is told about it. */
export const FIX_PROTECTED_PATTERNS: readonly string[] = [...WORKSPACE_PROTECTED_PATTERNS];

/**
 * Paths that are the verification surface rather than the implementation.
 *
 * The classification is path-shaped on purpose. A check exists as a file, and the ways to make a
 * check stop asserting something without touching the implementation are all removals of that file:
 * delete it, or rename it to a name no runner collects. Neither needs a line of code to be understood,
 * which is what makes them worth refusing deterministically while a weaker question — whether an
 * assertion inside a file that survived was loosened — is not.
 *
 * The patterns cover the conventions the project's own adapter can already run: the `*.test.*` and
 * `*.spec.*` suffixes, the `test_` prefix and `_test` infix, and the conventional test directories.
 * A project using a convention outside this list is not protected against a renamed test by this
 * check; it is protected against one by the approved scope, because a plan that never named the file
 * does not authorize replacing it.
 */
export const VERIFICATION_CHECK_PATH_PATTERNS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test_*",
  "**/*_test.*",
  "**/*_spec.*",
  "**/__tests__/**/*",
  "**/spec/**/*",
  "**/test/**/*",
  "**/tests/**/*",
  "**/conftest.*",
];

/** Whether a path is part of the project's verification surface rather than its implementation. */
export function isVerificationCheckPath(path: string): boolean {
  return VERIFICATION_CHECK_PATH_PATTERNS.some((pattern) => matchesScopePattern(pattern, path));
}

/**
 * The digests of the things a fix must leave exactly as it found them.
 *
 * Captured from persisted artifacts rather than from the live repository, so each field is a fact
 * about what the framework stored rather than about what some path currently says. A null is the
 * honest value for an artifact that does not exist, and a null never compares equal to a digest, so
 * a fixer that creates an approved artifact it should not have is caught by the same comparison.
 */
export interface FixIntegritySnapshot {
  /** `spec.json`: the requirements and the acceptance criteria. */
  readonly specSha256: string | null;
  /** `plan.json`: the requirements as planned, and the only approved scope. */
  readonly planSha256: string | null;
  readonly planReviewSha256: string | null;
  /**
   * The verification commands the framework recorded for the failing stage, hashed.
   *
   * This is the reproducible half of "what success means". The other half is the project's own
   * configuration file, which is a repository path and is protected by path rather than by digest,
   * because a digest of a file the orchestration layer never reads would be a digest of nothing.
   * What this digest covers is the command set the provider actually ran with, so a change to the
   * recorded verification surface is detectable even if the change was made to state rather than to
   * a repository file.
   */
  readonly verificationConfigSha256: string | null;
}

export function emptyFixIntegritySnapshot(): FixIntegritySnapshot {
  return { specSha256: null, planSha256: null, planReviewSha256: null, verificationConfigSha256: null };
}

/** The outcome of one fix attempt, as recorded in the durable history. Re-exported from the
 * persistence schema so the value a record carries and the value the framework decides are one. */
export type { FixAttemptOutcome } from "@agent-workflow-kit/persistence";

/**
 * Why a fix was refused. One code per way a fix can be a way of avoiding the work, so an operator
 * reading the history knows which of them happened rather than only that something did.
 */
export const FIX_REJECTION_CODES = [
  "fix_protected_file_touched",
  "fix_check_removed",
  "fix_target_modified",
  "fix_verification_config_modified",
  "fix_outside_approved_scope",
] as const;

export type FixRejectionCode = (typeof FIX_REJECTION_CODES)[number];

export interface FixRejection {
  readonly code: FixRejectionCode;
  /** The paths that triggered the refusal, sorted. Empty for a digest comparison. */
  readonly paths: readonly string[];
  readonly message: string;
}

/**
 * The verdict on one fix attempt.
 *
 * A non-empty rejections tuple on the failing branch is a deliberate part of the type: the list is
 * built here, so a caller cannot pass an empty one, and `fixRejected` needs a code to name rather
 * than a fallback that would report a cause nobody found.
 */
export type FixIntegrityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejections: readonly [FixRejection, ...FixRejection[]] };

export interface FixIntegrityInput {
  readonly featureId: string;
  /** The state whose failure the attempt was repairing. */
  readonly originStage: FixReturnState;
  readonly attempt: number;
  readonly approvedPatterns: readonly string[];
  /**
   * The changes the framework attributes to this attempt, which is not always the same as everything
   * the workspace reports. Before approval a fix runs in a human's checkout that may already hold their
   * uncommitted work, and blaming a fixer for edits the human made an hour ago would fail a feature over
   * something nobody in the loop did. The caller measures the difference between the tree as it looked
   * before the stage and the tree as it is now, and that difference is what this verdict is about.
   */
  readonly changes: WorkspaceChanges;
  readonly before: FixIntegritySnapshot;
  readonly after: FixIntegritySnapshot;
}

function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function changedFields(
  before: FixIntegritySnapshot,
  after: FixIntegritySnapshot,
): readonly (readonly [keyof FixIntegritySnapshot, FixRejectionCode])[] {
  const compared: readonly (readonly [keyof FixIntegritySnapshot, FixRejectionCode])[] = [
    ["specSha256", "fix_target_modified"],
    ["planSha256", "fix_target_modified"],
    ["planReviewSha256", "fix_target_modified"],
    ["verificationConfigSha256", "fix_verification_config_modified"],
  ];

  return compared.filter(([field]) => before[field] !== after[field]);
}

const INTEGRITY_LABELS: Readonly<Record<keyof FixIntegritySnapshot, string>> = {
  specSha256: "the approved specification, which holds the requirements and acceptance criteria",
  planSha256: "the approved plan",
  planReviewSha256: "the approved plan review",
  verificationConfigSha256: "the recorded verification configuration for the failing stage",
};

/**
 * Decides whether a fix attempt may be accepted.
 *
 * The order of the checks is the order of how badly each one compromises the workflow, and the first
 * two are the ones that cannot be argued with at all. A fix that touched a protected path edited the
 * rules it is judged by. A fix that removed a check removed the thing that would have caught it not
 * working. Neither is a repair under any reading, so both are reported without a fallback.
 *
 * The digest comparisons come next, and they are what make the first two unnecessary in the common
 * case: a fixer that rewrites the spec it is being held to is caught by the spec's digest whether or
 * not it also renamed a test.
 *
 * The scope check is last and weakest, deliberately. It is not a claim about intent — a fix may
 * legitimately touch a file the plan did not name when the plan was simply wrong — but the framework
 * has no way to tell that from a fix that wandered off, so it refuses both and lets a human amend
 * the plan. Every refusal here leaves the workspace exactly as the fixer left it. Restoring a
 * protected file would undo the very evidence of the attempt, and the workflow is being escalated
 * rather than resumed, so there is nothing to protect the next run from.
 */
export function evaluateFixIntegrity(input: FixIntegrityInput): FixIntegrityVerdict {
  const { attempt, approvedPatterns, changes, before, after } = input;
  const observed = approvedPathsOf(changes);
  const rejections: FixRejection[] = [];

  const protectedPaths = observed.filter(isProtectedWorkspacePath).sort();

  if (protectedPaths.length > 0) {
    rejections.push({
      code: "fix_protected_file_touched",
      paths: protectedPaths,
      message: [
        `Fix attempt ${String(attempt)} for "${input.originStage}" changed ${String(protectedPaths.length)} framework-controlled path(s): ${protectedPaths.join(", ")}.`,
        "Those files hold the workflow state, the generated agent configuration, and the verification configuration, so a fix that writes to them is editing the rules it is judged by rather than the code under test.",
        "The fix is rejected and the paths were left exactly as they were written, so a human can read what was changed. The framework does not restore them: the file is the evidence.",
      ].join(" "),
    });
  }

  const protectedSet = new Set(protectedPaths);
  const removedChecks = [
    ...changes.deleted,
    ...changes.renamed.map((rename) => rename.from),
  ]
    .filter((path) => isVerificationCheckPath(path))
    .filter((path) => !protectedSet.has(path))
    .sort();

  if (removedChecks.length > 0) {
    rejections.push({
      code: "fix_check_removed",
      paths: removedChecks,
      message: [
        `Fix attempt ${String(attempt)} for "${input.originStage}" removed ${String(removedChecks.length)} verification check file(s): ${removedChecks.join(", ")}.`,
        "A check is what turns a repair into a verified repair. Deleting or renaming the file that asserted the behaviour leaves the implementation exactly as broken while making the failure stop being reported.",
        "A human decides whether a check is obsolete; the framework does not remove one on the fixer's word.",
      ].join(" "),
    });
  }

  for (const [key, code] of changedFields(before, after)) {
    rejections.push({
      code,
      paths: [],
      message: [
        `Fix attempt ${String(attempt)} for "${input.originStage}" changed ${INTEGRITY_LABELS[key]}.`,
        `Before: ${before[key] ?? "absent"}. After: ${after[key] ?? "absent"}.`,
        "The fixer may change the implementation and nothing else. The thing it is being held to is not its to modify, so a fix that edits it is rejected and escalated to a human rather than accepted against a goal it moved itself.",
      ].join(" "),
    });
  }

  const outsideScope = observed
    .filter((path) => !protectedSet.has(path))
    .filter((path) => !approvedPatterns.some((pattern) => matchesScopePattern(pattern, path)))
    .sort();

  if (outsideScope.length > 0) {
    rejections.push({
      code: "fix_outside_approved_scope",
      paths: outsideScope,
      message: [
        `Fix attempt ${String(attempt)} for "${input.originStage}" changed ${String(outsideScope.length)} path(s) the approved plan does not describe: ${outsideScope.join(", ")}.`,
        approvedPatterns.length === 0
          ? "The approved plan names no paths at all, so nothing was authorized to change."
          : `The approved scope is ${approvedPatterns.join(", ")}.`,
        "Scope is never widened automatically. A human has to amend and re-approve the plan, or the changes have to be undone.",
      ].join(" "),
    });
  }

  if (rejections.length === 0) {
    return { ok: true };
  }

  const [first, ...rest] = rejections;

  return first === undefined ? { ok: true } : { ok: false, rejections: [first, ...rest] };
}

/** The refusal for a fix loop that has already used every attempt it was given. */
export function fixAttemptsExhausted(
  originStage: FixReturnState,
  attempt: number,
  maxAttempts: number,
): OrchestrationError {
  return orchestrationError(
    "fix_attempts_exhausted",
    `The fix loop for "${originStage}" has used all ${String(maxAttempts)} of its automatic attempts. Attempt ${String(attempt)} was not run: the framework does not start a fix it has already decided to stop, and it never performs one more than the limit allows. The feature is failed for a human, who can repair the defect, amend the approved plan or spec, or re-approve the feature.`,
  );
}

/** The refusal for a fix attempt the framework will not accept, naming every shape it found. */
export function fixRejected(
  rejections: readonly [FixRejection, ...FixRejection[]],
): OrchestrationError {
  const [first, ...rest] = rejections;

  return orchestrationError(
    first.code,
    `${first.message}${
      rest.length > 0
        ? ` The framework found ${String(rest.length)} further violation(s) in the same attempt: ${rest.map((rejection) => rejection.code).join(", ")}.`
        : ""
    } The fix was not recorded as a repair, the workspace was left as the fixer wrote it, and the feature is failed for a human.`,
  );
}

/**
 * Whether a bundle was collected before the last fix was recorded.
 *
 * Binding already ties a bundle to the revision that asked for it, which is what stops a completed
 * session's evidence being replayed. It cannot stop a provider that caches one bundle and restamps
 * it with the current revision, because the restamped bundle is internally consistent and describes a
 * revision that is genuinely the one running. The collection time is the field that survives that: a
 * cached result was gathered before the fix that the stage exists to re-test, and comparing the two
 * timestamps is the difference between "this check ran against the current tree" and "this check ran
 * once and its answer has been carried forward".
 *
 * Timestamps are compared rather than equal because a provider with a coarse clock can legitimately
 * report the same instant as the fix it was collected after.
 */
export function staleVerificationEvidence(
  bundle: VerificationEvidenceBundle,
  lastFix: { readonly recordedAt: string; readonly revisionBefore: number },
): OrchestrationError | null {
  const collected = Date.parse(bundle.collectedAt);
  const recorded = Date.parse(lastFix.recordedAt);

  if (!Number.isNaN(collected) && !Number.isNaN(recorded) && collected < recorded) {
    return orchestrationError(
      "stale_verification_evidence",
      `The ${bundle.verification} evidence for revision ${String(bundle.revision)} was collected at ${bundle.collectedAt}, before the fix recorded at ${lastFix.recordedAt} was applied. It describes the tree the fix was supposed to repair, so it cannot decide whether the repair worked. The verification provider decides whether this is fixed, from a run performed after the fix; the framework does not re-stamp an older result as a newer one.`,
    );
  }

  if (bundle.revision <= lastFix.revisionBefore) {
    return orchestrationError(
      "stale_verification_evidence",
      `The ${bundle.verification} evidence carries revision ${String(bundle.revision)}, which is not newer than the revision ${String(lastFix.revisionBefore)} the last fix started from, so it describes code that fix had not yet produced.`,
    );
  }

  return null;
}

/**
 * The canonical description of what a stage was verified with, as reproducible text.
 *
 * Two surfaces are covered, because the three verification stages fail differently. A static or test
 * stage runs commands, so every check contributes its id, its capability, and its exact command: that
 * is what a fix would have to change to make the checks pass for a different reason. A runtime stage
 * runs no command per criterion — it starts a service and makes requests — so what is covered is the
 * set of criterion ids, which changes when a criterion is added, removed, or renamed.
 *
 * Volatile fields are deliberately excluded. A duration, an exit timestamp, or a captured output
 * excerpt changes on every run, and a hash over any of them would report a configuration change
 * where none happened. The expectations inside a runtime criterion — its method, URL, status, and
 * fragment — are not covered here, because a runtime stage's expectations live in the project's own
 * configuration file and that file is a protected path rather than something this layer reads.
 */
export function verificationConfigurationText(
  bundle: VerificationEvidenceBundle,
): string | null {
  const commands = bundle.checks
    .map((check) => [check.id, check.capability, check.executable ?? "", check.args.join(" ")])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));

  return JSON.stringify({
    verification: bundle.verification,
    checks: bundle.checks.map((check) => check.id).sort(),
    commands,
  });
}

/** The digest stored in a fix record for the verification configuration the failure was measured with. */
export function verificationConfigurationDigest(
  verification: unknown,
  stage: WorkStage,
): string | null {
  const bundle = latestRecordedEvidence(verification, stage);

  if (bundle === null) {
    return null;
  }

  const text = verificationConfigurationText(bundle);

  return text === null ? null : digestOf(text);
}

/**
 * The newest evidence the framework itself recorded for a stage.
 *
 * The value is re-validated rather than trusted, because it comes back off disk as `unknown`. A
 * record that no longer validates is reported as no evidence at all: the weaker consequence is that
 * a fixer is handed less context, and the stronger one would be to treat a corrupt file as a reason to
 * believe a stage was measured when the framework cannot show what it was measured with.
 */
export function latestRecordedEvidence(
  verification: unknown,
  stage: WorkStage,
): VerificationEvidenceBundle | null {
  if (!isRecord(verification)) {
    return null;
  }

  const evidence = verification[DETERMINISTIC_EVIDENCE_KEY];

  if (!isRecord(evidence)) {
    return null;
  }

  const attempts = evidence[stage];

  if (!Array.isArray(attempts) || attempts.length === 0) {
    return null;
  }

  const validated = validateVerificationEvidenceBundle(attempts[attempts.length - 1]);

  return validated.ok ? validated.bundle : null;
}

/** The stage's own recorded section, which is the model's account of what it checked. */
function originSection(artifact: unknown, stage: WorkStage): Record<string, unknown> | null {
  if (!isRecord(artifact)) {
    return null;
  }

  const section = artifact[stage];

  return isRecord(section) ? section : null;
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The requirement and criterion a verification stage recorded as failing.
 *
 * Read from the stage's own section rather than inferred, and null when the section records no
 * numbered failing result. The alternative — matching whatever is in the section and calling it the
 * criterion — is how a fixer ends up told that `AC-2` is the problem when the record only ever said
 * "the module is wrong".
 */
export function failureTargetFrom(artifact: unknown, stage: WorkStage): FixFailureTarget | null {
  const section = originSection(artifact, stage);

  if (section === null || !Array.isArray(section["results"])) {
    return null;
  }

  for (const entry of section["results"]) {
    if (!isRecord(entry) || entry["status"] !== "failed") {
      continue;
    }

    const requirementId = textField(entry["requirementId"]);

    if (requirementId === null) {
      continue;
    }

    const criterion = textField(entry["acceptanceCriterionId"]);
    const description = textField(entry["description"]);

    return {
      requirementId,
      acceptanceCriterionId: criterion,
      description:
        description ?? `Requirement ${requirementId} did not pass during ${stage}${criterion === null ? "" : ` (${criterion})`}.`,
    };
  }

  return null;
}

/**
 * Paths the failing stage named, from either its results or its findings.
 *
 * A security record's own paths come first, and they displace the artifact's entirely when present.
 * The artifact is what the stage wrote about itself, which for a security review is a report; the record
 * is what the scanner measured, and naming a path the reviewer chose to mention would point a fixer at
 * the wrong file. The two are never mixed, so a fixer is always pointed at one origin.
 */
export function suspectedFilesFrom(
  artifact: unknown,
  stage: WorkStage,
  security: SecurityReviewEvidence | null = null,
): readonly string[] {
  if (security !== null) {
    return securityAffectedPaths(security);
  }

  const section = originSection(artifact, stage);

  if (section === null) {
    return [];
  }

  const paths = new Set<string>();

  for (const list of [section["results"], section["findings"]]) {
    if (!Array.isArray(list)) {
      continue;
    }

    for (const entry of list) {
      if (!isRecord(entry)) {
        continue;
      }

      const path = textField(entry["filePath"]);

      if (path !== null) {
        paths.add(path);
      }
    }
  }

  return [...paths].sort().slice(0, 20);
}

/**
 * One sentence naming why the previous stage asked for a fix.
 *
 * The deterministic check is preferred over the model's account of it, for the same reason the
 * verifier's prompt is rendered from the bundle rather than from prose: an exit code is a fact and a
 * diagnosis is an interpretation. When there is no bundle there is no fact, and the sentence says so
 * rather than inventing one.
 */
export function failureReasonFrom(
  originStage: FixReturnState,
  bundle: VerificationEvidenceBundle | null,
  target: FixFailureTarget | null,
  security: SecurityReviewEvidence | null = null,
): string {
  // The security record is preferred over the model's account, and over the acceptance criterion,
  // for the same reason the deterministic check is: a named path and a named regex are facts about the
  // tree, while "this feature touched the wrong kind of file" is an interpretation. It is preferred over
  // the bundle too, but not because it is more important — because a fix loop triggered by the security
  // gate has no bundle, so the comparison is only ever one or the other in practice.
  if (security !== null) {
    return securityFailureReason(security);
  }

  const failing = bundle?.checks.find(
    (check) => check.status === "failed" || check.status === "blocked" || check.status === "timed_out",
  );

  if (failing !== undefined) {
    const command =
      failing.executable === null
        ? "no command ran"
        : `${failing.executable} ${failing.args.join(" ")}`;

    return `The deterministic ${failing.capability} check "${failing.id}" is ${failing.status} (${command}). ${failing.detail}`;
  }

  if (target !== null) {
    const criterion = target.acceptanceCriterionId === null ? "" : ` (${target.acceptanceCriterionId})`;

    return `Acceptance criterion "${target.requirementId}"${criterion} was not met during "${originStage}": ${target.description}`;
  }

  return `The "${originStage}" stage asked for a fix. It recorded no deterministic evidence and named no numbered acceptance criterion, so the defect is described in the report routed to this stage.`;
}

/** The number of attempts already spent on one origin stage, so the next one is counted correctly. */
export function nextFixAttempt(
  entries: readonly { readonly fixReturnState: FixReturnState }[],
  originStage: FixReturnState,
): number {
  return entries.filter((entry) => entry.fixReturnState === originStage).length + 1;
}

/**
 * The newest recorded attempt to repair one stage's failure, or null when there is none.
 *
 * Scoped to a stage on purpose. A fix loop for `test_verification` is re-tested by `test_verification`,
 * and an attempt recorded for `static_verification` says nothing about whether the tree is still the
 * one its fix produced: the workflow may have run two more stages, and a repair to one of those could
 * have invalidated a fix loop that ran before it. Comparing a fresh bundle against an unrelated older
 * fix would refuse evidence that is perfectly current.
 *
 * A rejected attempt counts, because the timestamp that matters is when the last change was recorded,
 * not whether the framework believed it. It is only the last entry that is consulted, so a loop that
 * ran twice is compared against the one that ran most recently.
 */
export function latestFixEntry(
  entries: readonly FixHistoryEntry[],
  stage: WorkStage,
): FixHistoryEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry !== undefined && workStageForOrigin(entry.fixReturnState) === stage) {
      return entry;
    }
  }

  return null;
}

/** The work stage a fix origin state runs, which is the key its own section is stored under. */
export function workStageForOrigin(originStage: FixReturnState): WorkStage | null {
  return STAGE_BY_STATE[originStage] ?? null;
}

/** The deterministic verification a fix origin was measured by, or null for a review stage. */
export function verificationForOrigin(originStage: FixReturnState): VerificationStage | null {
  const stage = workStageForOrigin(originStage);

  return stage === null ? null : (VERIFICATION_STAGE_BY_WORK_STAGE[stage] ?? null);
}
