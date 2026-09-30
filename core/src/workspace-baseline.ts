import { resolve } from "node:path";

/**
 * The frozen starting point of a feature's work.
 *
 * A baseline is captured once, at plan approval, and it is the only thing that defines what "the code
 * as it was when the human approved this" means for every later stage. It lives in `core` because it is
 * a domain fact rather than an adapter detail: the persistence layer records it, the orchestration
 * layer decides from it, and a workspace adapter has to reproduce it exactly or refuse.
 *
 * Every field is load-bearing, which is why each one is validated rather than trusted:
 *
 * - `repositoryRoot` is the canonical, resolved repository directory. It is compared as a resolved
 *   path so the same directory reached as `/repo`, `/repo/`, or a symlinked path cannot pass as two
 *   different repositories.
 * - `baselineCommit` is a full 40-character lowercase SHA-1 object name, never an abbreviated form and
 *   never a symbolic name such as `HEAD` or a branch: a worktree is created by detaching exactly this
 *   commit, and an abbreviation or a reference would resolve to whatever it pointed at later.
 * - `approvedRevision` is the session revision the approval produced, which ties the baseline to the
 *   approval checkpoint rather than to a moment in wall-clock time. It is at least one, because the
 *   approval is itself a mutation.
 * - `workspaceId` becomes a directory name in the workspace cache, so it is restricted to characters
 *   that cannot escape a path component or confuse a shell, and it may not begin with a dot.
 * - `capturedAt` is an ISO timestamp for evidence. Nothing decides on it; it is recorded so a reader
 *   can see when the freeze happened.
 */

export const WORKSPACE_ACCESS_LEVELS = ["read_only", "read_write"] as const;

export type WorkspaceAccessLevel = (typeof WORKSPACE_ACCESS_LEVELS)[number];

export interface WorkspaceBaseline {
  /** Canonical, resolved path of the repository the approved work belongs to. */
  readonly repositoryRoot: string;
  /** Full 40-character lowercase commit the worktree is created from. */
  readonly baselineCommit: string;
  /** The session revision the plan approval was accepted at. */
  readonly approvedRevision: number;
  /** Framework-generated identity, also used as the workspace directory name. */
  readonly workspaceId: string;
  /** ISO-8601 timestamp of the capture. Evidence only. */
  readonly capturedAt: string;
}

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * A workspace id is a path component, so the character set is part of the trust boundary: letters,
 * digits, dot, underscore, and dash, never a separator, never a NUL, and never a leading dot that
 * would make the directory hidden or collide with the sidecar names beside it.
 */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type WorkspaceBaselineValidation =
  | { readonly ok: true; readonly baseline: WorkspaceBaseline }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Validates a persisted or provider-supplied baseline and returns it in its canonical shape.
 *
 * `expectedRepositoryRoot` is optional, and a caller that is about to act on a baseline should pass
 * it. Structure alone does not say *whose* repository this is: a well-formed baseline for a different
 * repository is still a well-formed baseline, and a worktree created from it would be a real worktree
 * of the wrong project. Comparing it here, with the same resolved-path rule the type documents, is
 * what keeps that mistake from being a caller's to remember.
 */
export function validateWorkspaceBaseline(
  value: unknown,
  expectedRepositoryRoot?: string,
): WorkspaceBaselineValidation {
  if (!isRecord(value)) {
    return { ok: false, message: "A workspace baseline must be an object." };
  }

  const repositoryRoot = value["repositoryRoot"];

  if (
    typeof repositoryRoot !== "string" ||
    repositoryRoot.length === 0 ||
    repositoryRoot.includes("\0") ||
    !repositoryRoot.startsWith("/")
  ) {
    return {
      ok: false,
      message: "A workspace baseline must record an absolute repository root with no NUL byte.",
    };
  }

  if (expectedRepositoryRoot !== undefined && resolve(repositoryRoot) !== resolve(expectedRepositoryRoot)) {
    return {
      ok: false,
      message: `A workspace baseline must name the repository it was captured from: it names ${repositoryRoot}, and the caller is running in ${expectedRepositoryRoot}.`,
    };
  }

  const baselineCommit = value["baselineCommit"];

  if (typeof baselineCommit !== "string" || !FULL_COMMIT_PATTERN.test(baselineCommit)) {
    return {
      ok: false,
      message: "A workspace baseline must record a full 40-character lowercase commit id.",
    };
  }

  const approvedRevision = value["approvedRevision"];

  // At least one, not zero: the approval is itself a revision-guarded mutation, so the baseline it
  // captures is stamped with the revision that approval produces. A zero here would mean the plan was
  // approved before anything had been written, which is not a state the workflow can be in.
  if (typeof approvedRevision !== "number" || !Number.isInteger(approvedRevision) || approvedRevision < 1) {
    return {
      ok: false,
      message: "A workspace baseline must record an approved revision of at least 1.",
    };
  }

  const workspaceId = value["workspaceId"];

  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return {
      ok: false,
      message:
        "A workspace baseline must record a workspace id of 1-64 characters from A-Z, a-z, 0-9, dot, underscore, and dash, starting with a letter or digit.",
    };
  }

  const capturedAt = value["capturedAt"];

  if (!isTimestamp(capturedAt)) {
    return { ok: false, message: "A workspace baseline must record a valid capture timestamp." };
  }

  return {
    ok: true,
    baseline: { repositoryRoot, baselineCommit, approvedRevision, workspaceId, capturedAt },
  };
}

export function isWorkspaceBaseline(value: unknown): value is WorkspaceBaseline {
  return validateWorkspaceBaseline(value).ok;
}
