import { isRecord } from "./result-validation.js";
import type { OrchestrationError } from "./errors.js";
import type { WorkStage } from "./stages.js";

/**
 * The isolated-execution port.
 *
 * After a plan is approved, no stage runs against the repository a human is standing in. Every
 * post-approval stage runs in a framework-created Git worktree that is detached at the approved
 * commit, and the framework is the only thing that decides which paths that worktree may change. This
 * file is the boundary that makes that enforceable, and it is deliberately small: five operations, all
 * of them expressed in terms of paths, commits, and lists of path names, so an implementation cannot
 * smuggle behaviour through the port.
 *
 * The division of responsibility is the point, and it is not negotiable in either direction:
 *
 * - The orchestration layer owns *policy*. It derives the approved path set from the human-approved
 *   plan, decides whether an observed change is a violation, and decides what a violation means for
 *   the workflow. It contains no filesystem and no Git.
 * - An adapter owns *mechanism*. It creates and removes worktrees, reads a diff, restores a file, and
 *   enforces a lease. It decides nothing about whether a change was acceptable; it is told which paths
 *   to act on and reports what it did.
 *
 * A single exception to that split is allowed and is confined to the filesystem: the adapter refuses
 * any path it cannot prove is safe to restore, and says so, because "is this path inside the workspace
 * and not a symlink out of it" is a question only the filesystem can answer. The refusal is reported
 * upward and the workflow stops; the adapter never decides the alternative itself.
 */
import type { WorkspaceAccessLevel, WorkspaceBaseline } from "@agent-workflow-kit/core";

/** What a stage is allowed to do to the files in its working directory. */
export type { WorkspaceAccessLevel };

/**
 * Paths a stage may never change, whatever an approved plan says.
 *
 * A plan is model-authored text that a human read. A path in it is a claim about project code, and
 * these patterns are not: `.git` is the repository's own control data, `.agentflow/` is this
 * framework's state, and the OpenCode configuration and verification configuration decide what a role
 * is allowed to do. A plan that lists one of them is asking the workflow to edit its own guard, and
 * the guard does not take requests from the thing it guards.
 *
 * The same list exists independently in the OpenCode adapter's permission rules. That duplication is
 * deliberate: two layers that both refuse these paths, without either being able to consult the other,
 * means neither a bug in the orchestration policy nor a bug in the agent permission rules can open the
 * path on its own.
 */
export const WORKSPACE_PROTECTED_PATTERNS: readonly string[] = [
  ".git",
  ".git/**",
  ".agentflow",
  ".agentflow/**",
  ".opencode",
  ".opencode/**",
  "opencode.json",
  "opencode.jsonc",
  "agent-workflow.config.json",
  "agent-workflow.config.jsonc",
];

/** The access a stage is given, decided by the framework and never by a stage. */
export interface WorkspaceAccess {
  readonly level: WorkspaceAccessLevel;
}

/** An opened, leased workspace. Handed to an executor as data and to the adapter for cleanup. */
export interface ProjectWorkspace {
  readonly workspaceId: string;
  readonly repositoryRoot: string;
  /**
   * The directory every command for this stage runs in. For a post-approval stage this is a detached
   * worktree and never the user's checkout; for a pre-approval stage it is the checkout itself,
   * read-only, because there is nothing to fork from until a human has approved a plan.
   */
  readonly workingDirectory: string;
  /**
   * The approved starting point, or null before a plan is approved.
   *
   * Null is the honest value here rather than a placeholder commit. A pre-approval stage has no
   * approved baseline, and inventing one — an empty string, `HEAD`, the current commit — would let a
   * later comparison be made against a commit no human agreed to, which is the exact confusion the
   * baseline exists to prevent. Everything that needs a baseline demands one, so a null can only reach
   * the read-only pre-approval path.
   */
  readonly baseline: WorkspaceBaseline | null;
  readonly access: WorkspaceAccess;
  /**
   * The Git state observed when the workspace was opened, or null pre-approval for the same reason as
   * the baseline. Post-approval it brackets a stage's own effects: the index was empty and the HEAD was
   * the approved commit before the agent ran, so anything else afterwards was written during the stage.
   */
  readonly gitState: WorkspaceGitState | null;
}

/** The two Git facts that decide whether a workspace is still the workspace the framework froze. */
export interface WorkspaceGitState {
  /** The commit currently checked out in the workspace. */
  readonly headCommit: string;
  /** Repository-relative paths with staged content, sorted. Empty means the index was not moved. */
  readonly stagedPaths: readonly string[];
}

/** One renamed path pair, as Git reported it. */
export interface WorkspaceRename {
  readonly from: string;
  readonly to: string;
}

/**
 * A structural description of everything the working tree changed.
 *
 * Five categories rather than a boolean, because "did it change" cannot answer the question the
 * workflow actually has, which is "did it change something the plan approved". An added file, a
 * deleted file, and an untracked file are three different facts with three different restoration
 * paths, and a tool that only reports "dirty" forces the framework to guess.
 *
 * The categories are Git's own, which is what makes them checkable:
 *
 * - `modified`, `deleted`, `renamed`: paths the baseline commit contains, reported by a diff against it.
 * - `added`: a new path that something staged with `git add`. It does not exist in the baseline commit,
 *   and its presence in this list means the index was written, which the integrity check refuses; the
 *   category exists so the refusal names the path rather than saying "something staged".
 * - `untracked`: a path Git reports as not tracked at all, which is the ordinary shape of a new file
 *   in a worktree whose index is empty. Restoring it means deleting it, and deleting is the only
 *   reversal that needs no record of what the file used to contain.
 *
 * Every path is repository-relative, forward-slashed, and free of `.` and `..` segments. An adapter
 * that cannot produce that form refuses rather than normalizing silently.
 */
export interface WorkspaceChanges {
  readonly modified: readonly string[];
  readonly added: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly WorkspaceRename[];
  readonly untracked: readonly string[];
}

export function isEmptyWorkspaceChanges(changes: WorkspaceChanges): boolean {
  return (
    changes.modified.length === 0 &&
    changes.added.length === 0 &&
    changes.deleted.length === 0 &&
    changes.renamed.length === 0 &&
    changes.untracked.length === 0
  );
}

/**
 * The paths that became dirty between two inspections of the same workspace.
 *
 * This is what makes a pre-approval stage checkable. Its workspace is the human's own checkout, which
 * may already be dirty for reasons that have nothing to do with the agent, so a difference against the
 * baseline commit would report the human's work as the agent's. Comparing the tree before the stage ran
 * with the tree after it separates the two: whatever changed in between is what this stage did, and
 * everything the human had already changed is excluded.
 *
 * The subtraction is set arithmetic per category, not a diff of file contents. A path dirty in both
 * inspections stays dirty and is therefore not reported, which is a real limit of this method: a stage
 * that modifies a file the human had already modified is invisible to it. Closing that would need
 * per-path content hashes from the provider for the whole tree, and the honest trade is to say so
 * rather than to pretend the guarantee is stronger than it is. The pre-approval tree is also read-only
 * to the agent by the adapter's own permissions, so this is a second line of defence, not the first.
 */
export function subtractWorkspaceChanges(before: WorkspaceChanges, after: WorkspaceChanges): WorkspaceChanges {
  const beforeRenames = new Set(before.renamed.map((rename) => `${rename.from}\u0000${rename.to}`));

  const keep = (paths: readonly string[], exclude: ReadonlySet<string>): string[] =>
    paths.filter((path) => !exclude.has(path)).sort();

  return {
    modified: keep(after.modified, new Set([...before.modified])),
    added: keep(after.added, new Set([...before.added])),
    deleted: keep(after.deleted, new Set([...before.deleted])),
    renamed: after.renamed
      .filter((rename) => !beforeRenames.has(`${rename.from}\u0000${rename.to}`))
      .sort((left, right) => (left.from === right.from ? left.to.localeCompare(right.to) : left.from.localeCompare(right.from))),
    untracked: keep(after.untracked, new Set([...before.untracked])),
  };
}

/**
 * One consistent read of a workspace.
 *
 * The change set, the Git state, and the fingerprint are collected together so the scope decision and
 * the Git-integrity decision are made about the same tree. A port that returned them from separate
 * calls would let a stage that writes between the two produce a verdict assembled from two different
 * states, and that is exactly the kind of verdict that is right by accident.
 */
export interface WorkspaceInspection {
  readonly workspaceId: string;
  readonly changes: WorkspaceChanges;
  readonly gitState: WorkspaceGitState;
  /**
   * A SHA-256 digest over the canonical serialization of the change set. Two inspections of the same
   * tree produce the same value, and it changes when any path, category, or rename endpoint changes.
   */
  readonly fingerprint: string;
  readonly collectedAt: string;
}

/** Why a baseline could not be captured. Each one is a different operator problem. */
export const BASELINE_REFUSAL_CODES = [
  "not_a_git_repository",
  "head_unborn",
  "tracked_workspace_dirty",
  "repository_unreadable",
] as const;

export type BaselineRefusalCode = (typeof BASELINE_REFUSAL_CODES)[number];

/**
 * The result of reading the repository's starting point.
 *
 * `trackedState` is reported even on a refusal, because the operator's next action is to look at those
 * paths. A refusal that only says "dirty" makes the caller re-run Git by hand to find out what to
 * clean, which is the one thing this milestone is supposed to make unnecessary.
 */
export interface BaselineCapture {
  readonly repositoryRoot: string;
  readonly headCommit: string;
  readonly clean: boolean;
  /** Repository-relative paths with staged content. */
  readonly stagedPaths: readonly string[];
  /** Repository-relative paths with unstaged modifications, including staged ones. */
  readonly unstagedPaths: readonly string[];
  readonly capturedAt: string;
}

export type BaselineCaptureOutcome =
  | { readonly ok: true; readonly capture: BaselineCapture }
  | {
      readonly ok: false;
      readonly code: BaselineRefusalCode;
      readonly message: string;
      /** Present when the repository was readable enough to report what was dirty. */
      readonly capture: BaselineCapture | null;
    };

/** Why a workspace could not be opened. Each one is a refusal, never a silent recreation. */
export const WORKSPACE_REFUSAL_CODES = [
  "workspace_not_configured",
  "baseline_missing",
  "repository_unavailable",
  "head_changed",
  "workspace_metadata_missing",
  "workspace_metadata_corrupt",
  "workspace_registered_elsewhere",
  "workspace_path_occupied",
  "workspace_failed",
  "lease_unavailable",
] as const;

export type WorkspaceRefusalCode = (typeof WORKSPACE_REFUSAL_CODES)[number];

export interface OpenWorkspaceRequest {
  readonly featureId: string;
  readonly baseline: WorkspaceBaseline;
  readonly access: WorkspaceAccessLevel;
  readonly signal?: AbortSignal | null;
}

export type OpenWorkspaceOutcome =
  | { readonly ok: true; readonly workspace: ProjectWorkspace }
  | { readonly ok: false; readonly code: WorkspaceRefusalCode; readonly message: string };

export interface InspectWorkspaceRequest {
  readonly workspace: ProjectWorkspace;
  readonly signal?: AbortSignal | null;
}

export type InspectWorkspaceOutcome =
  | { readonly ok: true; readonly inspection: WorkspaceInspection }
  | { readonly ok: false; readonly code: "workspace_failed"; readonly message: string };

export interface EnforceScopeRequest {
  readonly workspace: ProjectWorkspace;
  /**
   * Exactly the paths the framework decided were unauthorized, as they appeared in the change set, and
   * whether each existed in the baseline commit. The adapter restores or removes them and reports what
   * it did; it does not recompute the list, because a second opinion about which paths were allowed
   * would be a second policy.
   */
  readonly paths: readonly WorkspaceUnauthorizedPath[];
  readonly signal?: AbortSignal | null;
}

/** One unauthorized path, with the fact restoration needs and the framework does not have. */
export interface WorkspaceUnauthorizedPath {
  readonly path: string;
  readonly category: "tracked" | "untracked";
  /**
   * Whether the baseline commit contains this path. False means there is nothing to restore from, so the
   * only reversal is removal, whether Git considers the path tracked or not.
   */
  readonly existedAtBaseline: boolean;
}

/**
 * What a restoration actually achieved.
 *
 * `unsafePaths` is the field that matters most: a path the adapter could not prove safe to touch is
 * reported rather than handled, and its presence means the workflow stops and a human looks at the
 * workspace. An adapter that quietly skipped an unsafe path and returned success would turn "the
 * framework could not prove this safe" into "the framework is fine with it".
 */
export interface ScopeEnforcement {
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly unsafePaths: readonly string[];
  readonly enforcementErrors: readonly string[];
  readonly enforcedAt: string;
}

export type EnforceScopeOutcome =
  | { readonly ok: true; readonly enforcement: ScopeEnforcement }
  | { readonly ok: false; readonly code: "workspace_failed"; readonly message: string };

/**
 * The port an adapter implements.
 *
 * `open` is expected to be idempotent for a given baseline *across runs*: a feature re-opened after a
 * crash finds the workspace it created before, reuses it if it is still valid, and refuses if it is
 * not. Within one process it is expected to refuse a second open of a workspace the first has not
 * released, because two stages of one feature running concurrently in one worktree would interleave
 * their writes and the lease is the only thing standing between that and a result describing neither.
 * It is also expected to release exactly its own lease in `close`; a caller that forgets leaves a lease
 * that times out rather than one that is stolen.
 */
export interface ProjectWorkspaceProvider {
  captureBaseline(
    repositoryRoot: string,
    signal?: AbortSignal | null,
  ): Promise<BaselineCaptureOutcome>;
  open(request: OpenWorkspaceRequest): Promise<OpenWorkspaceOutcome>;
  inspect(request: InspectWorkspaceRequest): Promise<InspectWorkspaceOutcome>;
  enforceScope(request: EnforceScopeRequest): Promise<EnforceScopeOutcome>;
  close(workspace: ProjectWorkspace): Promise<void>;
}

/* -------------------------------------------------------------------------------------------- */
/* Approved scope                                                                                 */
/* -------------------------------------------------------------------------------------------- */

export type ApprovedScopeOutcome =
  | { readonly ok: true; readonly patterns: readonly string[] }
  | { readonly ok: false; readonly error: OrchestrationError };

/**
 * Derives the approved path set from the human-approved plan.
 *
 * A plan's `expectedFiles` is the only authorization a write has, so the parsing here is strict on
 * purpose:
 *
 * - A path must be repository-relative. An absolute path, a `..` segment, a `.` segment, a backslash,
 *   a NUL byte, or an empty entry is refused rather than cleaned up, because "fix it and continue" is
 *   how a scope rule becomes a suggestion.
 * - A pattern may be an exact path, a directory prefix ending in `/`, or a glob using `*`, `**`, `?`,
 *   or `[...]`. Anything else — a brace group, a negated pattern, a leading `!` — is refused, because
 *   this framework does not implement it and a plan that assumes it did would be approved against a
 *   wider scope than the human read.
 * - A protected path listed in the plan is dropped from the approved set, and the drop is visible in
 *   the returned patterns rather than silent.
 *
 * An unreadable or absent plan yields an empty approved set, which approves nothing. That is the
 * direction to be wrong in: the first consequence is a scope violation on the next write, and a human
 * has to approve a new plan, rather than a widened set nobody looked at.
 */
export function approvedScopeFromPlan(plan: unknown): ApprovedScopeOutcome {
  if (!isRecord(plan)) {
    return { ok: true, patterns: [] };
  }

  const steps = plan["steps"];

  if (!Array.isArray(steps)) {
    return { ok: true, patterns: [] };
  }

  const patterns: string[] = [];

  for (const step of steps) {
    if (!isRecord(step)) {
      continue;
    }

    const expected = step["expectedFiles"];

    if (!Array.isArray(expected)) {
      continue;
    }

    for (const entry of expected) {
      if (typeof entry !== "string") {
        return {
          ok: false,
          error: {
            code: "scope_expansion_required",
            failureClass: "workspace",
            message:
              "The approved plan lists a non-text entry in expectedFiles, so the approved scope cannot be determined. A human has to re-approve a plan whose expectedFiles are all repository-relative text paths.",
          },
        };
      }

      const normalized = normalizeScopePattern(entry);

      if (normalized === null) {
        return {
          ok: false,
          error: {
            code: "scope_expansion_required",
            failureClass: "workspace",
            message: `The approved plan lists "${entry}" in expectedFiles, which is not a repository-relative path or glob this framework can enforce. Scope is never widened to accommodate a pattern it cannot check.`,
          },
        };
      }

      if (isProtectedWorkspacePath(normalized)) {
        continue;
      }

      patterns.push(normalized);
    }
  }

  return { ok: true, patterns: [...new Set(patterns)].sort() };
}

/**
 * Normalizes one approved path or glob, or returns `null` when the entry cannot be enforced.
 *
 * The returned form is a forward-slashed relative pattern with no `.` or `..` segment. A trailing `/`
 * is preserved for a directory pattern, and a leading `!` is refused rather than treated as a literal
 * character, because a plan author who wrote `!` meant negation and this framework has none.
 */
export function normalizeScopePattern(entry: string): string | null {
  const trimmed = entry.trim();

  if (trimmed.length === 0 || trimmed.includes("\0") || trimmed.includes("\\")) {
    return null;
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("!") || /^[A-Za-z]:/u.test(trimmed)) {
    return null;
  }

  if (trimmed.includes("{")) {
    return null;
  }

  const directoryPattern = trimmed.endsWith("/");
  const body = directoryPattern ? trimmed.slice(0, -1) : trimmed;

  if (body.length === 0) {
    return null;
  }

  const segments = body.split("/");

  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return null;
    }
  }

  return directoryPattern ? `${body}/**` : body;
}

/** The characters that make a pattern segment a pattern rather than a path. */
const GLOB_CHARACTER = /[*?[]/u;

/**
 * Matches one repository-relative path against one approved pattern.
 *
 * The translation is small and total, which is the point: `**` crosses directory separators, `*` and
 * `?` do not, and a character class is passed through to the regular expression engine only after
 * every other metacharacter is escaped. A pattern cannot smuggle a regular expression, and it cannot
 * match outside the workspace because the caller only ever asks about paths that are already relative
 * to it.
 */
export function matchesScopePattern(pattern: string, path: string): boolean {
  // The `/**` shortcut is only a shortcut when the part in front of it is literal. A prefix that still
  // contains a wildcard — `**/tests/**`, the natural way to write "the tests directory anywhere" — is
  // not a path prefix at all, so taking this branch for it would compare the path against the literal
  // string `**/tests` and match nothing at all. A pattern that silently approves nothing is worse than
  // one that refuses: the writer believes it named something, and the scope check agrees with them.
  if (pattern.endsWith("/**") && !GLOB_CHARACTER.test(pattern.slice(0, -3))) {
    const prefix = pattern.slice(0, -3);

    return path === prefix || path.startsWith(`${prefix}/`);
  }

  return patternToRegExp(pattern).test(path);
}

function patternToRegExp(pattern: string): RegExp {
  const parts: string[] = [];
  let index = 0;

  while (index < pattern.length) {
    const character = pattern[index] ?? "";

    if (character === "*") {
      if (pattern[index + 1] !== "*") {
        parts.push("[^/]*");
        index += 1;
        continue;
      }

      if (index + 2 === pattern.length) {
        // A trailing `**` is the rest of the tree, separators included.
        parts.push(".*");
        index += 2;
        continue;
      }

      if (pattern[index + 2] === "/") {
        // `**/` is zero or more whole directories, so `src/**/*.ts` matches `src/a.ts` as well as
        // `src/a/b/c.ts`.
        parts.push("(?:.*/)?");
        index += 3;
        continue;
      }

      parts.push(".*");
      index += 2;
      continue;
    }

    if (character === "?") {
      parts.push("[^/]");
      index += 1;
      continue;
    }

    if (character === "[") {
      // Brackets are literal, never a character class. In a framework-adjacent repository the
      // convention `app/[id]/page.tsx` names one real directory, while a glob author means
      // `app/[abc]/page.tsx` to mean three, and nothing on the wire says which. Reading it as a class
      // would authorize every sibling directory a human never approved, so the narrower reading wins:
      // a plan that wants a class has to spell the paths out, and a plan that wants the directory says
      // what it means.
      parts.push("\\[");
      index += 1;
      continue;
    }

    parts.push(character.replace(/[.*+?^${}()|[\]\\]/u, "\\$&"));
    index += 1;
  }

  return new RegExp(`^${parts.join("")}$`, "u");
}

/** Whether a path is one of the paths no stage may change, whatever a plan says. */
export function isProtectedWorkspacePath(path: string): boolean {
  return WORKSPACE_PROTECTED_PATTERNS.some((pattern) => matchesScopePattern(pattern, path));
}

/**
 * The framework's own invocation recording, in exactly the shape the recorder writes it:
 * `.agentflow/recordings/<featureId>/<stage>/<stamp>-<suffix>/{invocation.json,stdout.txt,stderr.txt}`,
 * with sanitized single-segment feature and stage names, the compact UTC stamp the recorder derives
 * from `startedAt`, and its fixed four-hex-char suffix and three filenames.
 *
 * The recording is diagnostics the framework writes into the very tree the scope check measures, so
 * it is not a stage write, and a guard that blamed a stage for it would fail every feature at its
 * first recorded run. This is deliberately not an exclusion of `.agentflow/`: every other path under
 * the workflow's own directory stays protected, so a file a stage put anywhere in there is still a
 * violation. It is the exact shape rather than a prefix for the same reason — only a file at that
 * location, with that name, behind that stamp is excused.
 *
 * The location mirrors `OPENCODE_RECORDINGS_DIRECTORY` in `adapters/opencode/src/diagnostics.ts`,
 * where the install policy reserves it.
 */
const FRAMEWORK_RECORDING_PATH =
  /^\.agentflow\/recordings\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/\d{8}T\d{6}Z-[0-9a-f]{4}\/(?:invocation\.json|stdout\.txt|stderr\.txt)$/u;

/** Whether a path is the framework's own recording rather than something a stage wrote. */
export function isFrameworkRecordingPath(path: string): boolean {
  return FRAMEWORK_RECORDING_PATH.test(path);
}

/* -------------------------------------------------------------------------------------------- */
/* Scope and Git-state decisions                                                                   */
/* -------------------------------------------------------------------------------------------- */

export interface WorkspaceScopePolicy {
  readonly approvedPatterns: readonly string[];
}

export type WorkspaceScopeVerdict =
  | { readonly ok: true; readonly approved: readonly string[] }
  | { readonly ok: false; readonly unauthorized: readonly WorkspaceUnauthorizedPath[] };

/**
 * Decides which observed changes are outside the approved scope.
 *
 * Every path in every category is considered, including the deletion of a file and a rename's *old*
 * path: a rename that removes an approved file is as much a change to an approved path as an edit to
 * it, and a rename whose destination lands outside the approved set creates a path the plan never
 * described. A path that appears in more than one category is reported once.
 */
export function evaluateWorkspaceScope(
  inspection: WorkspaceInspection,
  policy: WorkspaceScopePolicy,
): WorkspaceScopeVerdict {
  const unauthorized = new Map<string, WorkspaceUnauthorizedPath>();

  // `existedAtBaseline` is what restoration needs and the category alone cannot answer: a staged add
  // is in Git's index, so it is a tracked path that the baseline commit does not contain, and an
  // adapter that read "tracked" as "restore from the baseline" would try to restore a file that was
  // never there.
  const consider = (
    path: string,
    category: "tracked" | "untracked",
    existedAtBaseline: boolean,
  ): void => {
    // The framework's own recording is excused before the protected check below would otherwise blame
    // every recorded stage for `.agentflow/**`; see `isFrameworkRecordingPath` for why the exclusion
    // is this exact.
    if (isFrameworkRecordingPath(path)) {
      return;
    }

    const entry: WorkspaceUnauthorizedPath = { path, category, existedAtBaseline };

    if (isProtectedWorkspacePath(path)) {
      unauthorized.set(path, entry);
      return;
    }

    if (policy.approvedPatterns.some((pattern) => matchesScopePattern(pattern, path))) {
      return;
    }

    unauthorized.set(path, entry);
  };

  for (const path of inspection.changes.modified) {
    consider(path, "tracked", true);
  }

  for (const path of inspection.changes.added) {
    consider(path, "tracked", false);
  }

  for (const path of inspection.changes.deleted) {
    consider(path, "tracked", true);
  }

  for (const rename of inspection.changes.renamed) {
    consider(rename.from, "tracked", true);
    consider(rename.to, "tracked", true);
  }

  for (const path of inspection.changes.untracked) {
    consider(path, "untracked", false);
  }

  if (unauthorized.size === 0) {
    return { ok: true, approved: approvedPathsOf(inspection.changes) };
  }

  return {
    ok: false,
    unauthorized: [...unauthorized.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function approvedPathsOf(changes: WorkspaceChanges): readonly string[] {
  return [
    ...changes.modified,
    ...changes.added,
    ...changes.deleted,
    ...changes.untracked,
    ...changes.renamed.flatMap((rename) => [rename.from, rename.to]),
  ].sort();
}

/**
 * The deterministic record of one scope check.
 *
 * It is a *measurement*, not a verdict: the approved patterns and the observed paths are both here so
 * a reader can re-derive the verdict without the framework, and the fingerprint ties the record to the
 * exact change set it was taken from. Paths only, never content, so it is safe to persist, to print,
 * and to hand to a model as context.
 *
 * The AI scope reviewer receives this record beside the plan. It cannot widen it: a review stage that
 * reports "the extra file was fine" produces an artifact, and the artifact is a claim about a decision
 * the framework already made.
 */
export interface WorkspaceScopeEvidence {
  readonly schemaVersion: 1;
  readonly featureId: string;
  readonly stage: WorkStage;
  readonly sessionRevision: number;
  readonly workspaceId: string;
  readonly workingDirectory: string;
  /** The approved commit, or null for a pre-approval stage, which has none. */
  readonly baselineCommit: string | null;
  /** Sorted patterns derived from the approved plan, with protected paths removed. */
  readonly approvedPatterns: readonly string[];
  readonly observedPaths: readonly string[];
  readonly unauthorizedPaths: readonly string[];
  readonly protectedPathsTouched: readonly string[];
  /** Paths returned to their approved baseline content by the framework after a violation. */
  readonly restoredPaths: readonly string[];
  /**
   * Paths the framework deleted after a violation, because the approved commit does not contain them
   * and so there was nothing to restore. A separate list from `restoredPaths` on purpose: "put back
   * what was there" and "removed what was never approved" are different facts, and a reader deciding
   * whether a file survived needs to know which happened.
   */
  readonly removedPaths: readonly string[];
  /** Paths the framework refused to touch because it could not prove the action safe. */
  readonly unsafePaths: readonly string[];
  readonly fingerprint: string;
  readonly headCommit: string;
  readonly stagedPaths: readonly string[];
  readonly recordedAt: string;
  /**
   * Whether the framework actually looked at the tree for this stage.
   *
   * False means no workspace provider was configured, so nothing was measured and the empty path lists
   * below mean "not checked" rather than "clean". Without this field a record could not tell those two
   * apart, and a reader would take silence for a clean run.
   */
  readonly measured: boolean;
}

export type WorkspaceIntegrityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Decides whether the workspace is still the frozen starting point the framework approved.
 *
 * Three facts are checked, and each is a separate way the guarantee can be broken:
 *
 * - `HEAD` must still be the baseline commit. A commit inside the workspace means a history the human
 *   never approved, and it makes every later diff describe something other than the approved base.
 * - The index must be empty of staged paths. A staged path means something ran `git add`, which is the
 *   step immediately before a commit, and a framework that has forbidden committing has no reason to
 *   tolerate the other half of it.
 * - Nothing in the approved set may have been committed, which is the same fact as the first check
 *   seen from the other side, and is stated rather than re-derived.
 */
export function evaluateWorkspaceIntegrity(
  inspection: WorkspaceInspection,
  baseline: WorkspaceBaseline,
): WorkspaceIntegrityVerdict {
  if (inspection.gitState.headCommit !== baseline.baselineCommit) {
    return {
      ok: false,
      reason: `The workspace HEAD is ${inspection.gitState.headCommit}, but the approved baseline is ${baseline.baselineCommit}. A commit was made inside the isolated workspace, so no later comparison describes the approved starting point.`,
    };
  }

  if (inspection.gitState.stagedPaths.length > 0) {
    return {
      ok: false,
      reason: `The workspace index holds ${String(inspection.gitState.stagedPaths.length)} staged path(s) (${inspection.gitState.stagedPaths.join(", ")}). Staging is the step before a commit, and the framework does not commit.`,
    };
  }

  return { ok: true };
}
