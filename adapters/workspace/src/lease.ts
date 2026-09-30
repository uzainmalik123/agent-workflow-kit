import { hostname } from "node:os";

import { WorkspaceAdapterError } from "./errors.js";
import {
  leaseBelongsToThisProcess,
  newLease,
  readSidecar,
  writeSidecar,
  type WorkspaceLease,
  type WorkspaceSidecar,
} from "./sidecar.js";

/**
 * Exclusive ownership of a workspace directory, for as long as a stage is running in it.
 *
 * Two runs of the same feature in the same worktree would interleave their writes and produce a
 * result that describes neither. The lease is the mechanism that makes that impossible, and the
 * interesting part is not taking it — it is the four ways this module refuses to take one:
 *
 * - A lease held by a live process is never taken, whatever the clock says. The deadline exists to
 *   release a lease whose owner crashed, not to let a second run cut in on a slow one, so a
 *   same-host lease is checked against the process table and a lease on any other host is assumed
 *   live, because this process cannot see that host's processes and a wrong answer either way
 *   corrupts a worktree.
 * - A lease whose owner is this process is not stolen either: re-entering means a bug, and two code
 *   paths in one process holding one directory is exactly the interleaving this exists to prevent.
 * - Release is matched on the token, so a run that times out and comes back cannot release the lease
 *   its successor took.
 * - Nothing here ever breaks a lease. A workspace whose lease is unreleasable is a workspace a human
 *   clears, and the cost of being wrong in that direction — a stuck directory — is smaller than the
 *   cost of the other one.
 */

/** How long a lease lives before it is considered abandoned. Long enough for a slow stage. */
export const DEFAULT_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

export interface AcquireLeaseOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export type AcquireLeaseOutcome =
  | { readonly ok: true; readonly lease: WorkspaceLease }
  | { readonly ok: false; readonly code: "lease_held"; readonly message: string };

/**
 * Whether a process is still running.
 *
 * `signal 0` performs the permission and existence check without delivering anything, which is the
 * only way to ask about a process this one may not signal. `EPERM` is the answer "yes, it exists,
 * owned by somebody else", so it counts as alive; `ESRCH` is the answer "no".
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "EPERM") {
      return true;
    }

    if (code === "ESRCH") {
      return false;
    }

    // Anything else is an answer this code does not understand, and "alive" is the answer that does
    // not let a second process in.
    return true;
  }
}

/**
 * Whether a recorded lease still has a live owner.
 *
 * A lease on another host is never reported dead. This process cannot observe that host's process
 * table, and the deadline is a wall clock rather than a shared heartbeat, so a machine with a skewed
 * clock could make a live lease look expired. The cost of being wrong is one stuck workspace; the cost
 * of being wrong the other way is two runs writing one directory.
 */
export function leaseIsHeldByALiveProcess(lease: WorkspaceLease, now: number = Date.now()): boolean {
  if (lease.host !== hostname()) {
    return true;
  }

  if (!processIsAlive(lease.pid)) {
    return false;
  }

  return lease.expiresAt > now;
}

/** Takes the lease on an existing workspace, or explains why it cannot. */
export async function acquireLease(
  workspaceDirectory: string,
  sidecar: WorkspaceSidecar,
  options: AcquireLeaseOptions = {},
): Promise<AcquireLeaseOutcome> {
  const now = options.now?.() ?? Date.now();
  const current = sidecar.lease;

  if (current !== null) {
    if (leaseBelongsToThisProcess(current)) {
      throw new WorkspaceAdapterError(
        "lease_held",
        `The workspace at ${workspaceDirectory} is already leased by this process (pid ${String(current.pid)}). Two stages of one feature in one worktree would interleave their writes, so the second is refused rather than allowed to run beside the first.`,
      );
    }

    if (leaseIsHeldByALiveProcess(current, now)) {
      return {
        ok: false,
        code: "lease_held",
        message: `The workspace at ${workspaceDirectory} is leased by pid ${String(current.pid)} on ${current.host} until ${new Date(current.expiresAt).toISOString()}. A lease with a live owner is never taken: two runs writing one worktree would produce a result that describes neither.`,
      };
    }
  }

  const lease = newLease(options.ttlMs ?? DEFAULT_LEASE_TTL_MS, now);

  await writeSidecar(workspaceDirectory, { ...sidecar, lease });

  return { ok: true, lease };
}

/**
 * Releases a lease this process owns.
 *
 * The token has to match. A run that lost its lease to its own deadline, came back, and finished late
 * must not release the lease a successor is now holding — that would open the workspace underneath a
 * live process, which is the exact failure the lease prevents.
 */
export async function releaseLease(
  workspaceDirectory: string,
  token: string,
  options: { readonly now?: () => number } = {},
): Promise<boolean> {
  const sidecar = await readSidecar(workspaceDirectory);
  const current = sidecar.lease;

  if (current === null || current.token !== token) {
    return false;
  }

  if (current.expiresAt <= (options.now?.() ?? Date.now())) {
    // The lease had already lapsed, so somebody else may hold the workspace now. Leaving the record
    // alone is the honest thing: a release that happened after the fact is indistinguishable from one
    // that did not.
    return false;
  }

  await writeSidecar(workspaceDirectory, { ...sidecar, lease: null });

  return true;
}
