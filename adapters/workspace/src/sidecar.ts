import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { WorkspaceAdapterError } from "./errors.js";

/**
 * What the framework writes beside a worktree so that a later run can recognise it.
 *
 * The sidecar is the only record of which repository a worktree belongs to and which commit it was
 * detached at. It lives beside the worktree directory, not inside it. Git's own worktree metadata can answer the second question, but not the first in a form
 * that survives the repository being moved, and it cannot say who created the worktree or when. So the
 * sidecar exists, and — this is the part that matters — it is never reconstructed on a doubt. A
 * missing or unreadable sidecar is a refusal, because a workspace the framework cannot vouch for is
 * one whose files it has no business restoring or deleting.
 */

/**
 * The sidecar's name, relative to the workspace directory's parent.
 *
 * The file sits *beside* the worktree rather than inside it, and that is a decision with a reason: a
 * file inside the worktree is an untracked file in the worktree, so the framework's own bookkeeping
 * would show up in the very change set it is supposed to be describing. Writing the exclude rule that
 * would hide it is not available either — for a linked worktree, `info/exclude` belongs to the shared
 * repository, and the framework does not edit a human's repository to tidy up after itself.
 */
export const SIDECAR_SUFFIX = ".workspace.json";

/** Sidecar version, bumped only with a migration that is written in this file. */
export const SIDECAR_VERSION = 1;

export interface WorkspaceSidecar {
  readonly version: number;
  readonly workspaceId: string;
  readonly featureId: string;
  /** Canonical, resolved repository root the worktree was created from. */
  readonly repositoryRoot: string;
  readonly baselineCommit: string;
  readonly approvedRevision: number;
  readonly createdAt: string;
  /** The lease currently held on this workspace, if any. */
  readonly lease: WorkspaceLease | null;
}

export interface WorkspaceLease {
  /** Opaque and unguessable, so a release can be shown to be the owner's own. */
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
  /** Epoch milliseconds after which the lease is considered abandoned. */
  readonly expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

/**
 * Validates a parsed sidecar, field by field.
 *
 * Each check names the field it rejected, because a corrupt sidecar is something a human has to look
 * at, and "the metadata is wrong" is not a starting point. A field this adapter cannot interpret is
 * never defaulted: the whole point of the file is to say which repository and which commit a directory
 * belongs to, and an invented value would be a lie in the one place there is no room for one.
 */
function parseSidecar(text: string, source: string): WorkspaceSidecar {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw corrupt(source, "it is not JSON");
  }

  if (!isRecord(parsed)) {
    throw corrupt(source, "it is not a JSON object");
  }

  if (parsed["version"] !== SIDECAR_VERSION) {
    throw corrupt(source, `its version is ${JSON.stringify(parsed["version"])} rather than ${String(SIDECAR_VERSION)}`);
  }

  const workspaceId = parsed["workspaceId"];

  if (!isText(workspaceId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workspaceId)) {
    throw corrupt(source, "its workspace id is not a safe directory name");
  }

  const featureId = parsed["featureId"];

  if (!isText(featureId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(featureId)) {
    throw corrupt(source, "its feature id is not a safe identifier");
  }

  const repositoryRoot = parsed["repositoryRoot"];

  if (!isText(repositoryRoot) || !repositoryRoot.startsWith("/")) {
    throw corrupt(source, "its repository root is not an absolute path");
  }

  const baselineCommit = parsed["baselineCommit"];

  if (typeof baselineCommit !== "string" || !/^[0-9a-f]{40}$/.test(baselineCommit)) {
    throw corrupt(source, "its baseline commit is not a full 40-character commit id");
  }

  const approvedRevision = parsed["approvedRevision"];

  if (typeof approvedRevision !== "number" || !Number.isInteger(approvedRevision) || approvedRevision < 1) {
    throw corrupt(source, "its approved revision is not an integer of at least one");
  }

  const createdAt = parsed["createdAt"];

  if (!isText(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    throw corrupt(source, "its creation timestamp is not a date");
  }

  const lease = parsed["lease"];

  return {
    version: SIDECAR_VERSION,
    workspaceId,
    featureId,
    repositoryRoot,
    baselineCommit,
    approvedRevision,
    createdAt,
    lease: lease === null ? null : parseLease(lease, source),
  };
}

function corrupt(source: string, because: string): WorkspaceAdapterError {
  return new WorkspaceAdapterError(
    "metadata_corrupt",
    `The workspace metadata at ${source} cannot be used because ${because}. It is left exactly as it is: this adapter never rewrites metadata it could not read, because a rewritten sidecar is a sidecar nobody vouches for.`,
  );
}

function parseLease(value: unknown, source: string): WorkspaceLease {
  if (!isRecord(value)) {
    throw corrupt(source, "its lease is not a JSON object");
  }

  const token = value["token"];

  if (!isText(token) || token.length < 16) {
    throw corrupt(source, "its lease token is not an owner token");
  }

  const pid = value["pid"];

  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) {
    throw corrupt(source, "its lease names a process that cannot exist");
  }

  const host = value["host"];

  if (!isText(host)) {
    throw corrupt(source, "its lease names no host");
  }

  const acquiredAt = value["acquiredAt"];

  if (!isText(acquiredAt) || Number.isNaN(Date.parse(acquiredAt))) {
    throw corrupt(source, "its lease has no acquisition time");
  }

  const expiresAt = value["expiresAt"];

  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw corrupt(source, "its lease has no expiry");
  }

  return { token, pid, host, acquiredAt, expiresAt };
}

export function sidecarPath(workspaceDirectory: string): string {
  const parent = dirname(workspaceDirectory);

  if (parent === "" || parent === workspaceDirectory) {
    throw new WorkspaceAdapterError(
      "metadata_corrupt",
      `A workspace directory of "${workspaceDirectory}" has no parent to keep metadata beside.`,
    );
  }

  return join(parent, `${basename(workspaceDirectory)}${SIDECAR_SUFFIX}`);
}

/** Reads a sidecar, or throws the reason it could not be read. Never returns a default. */
export async function readSidecar(workspaceDirectory: string): Promise<WorkspaceSidecar> {
  const path = sidecarPath(workspaceDirectory);
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceAdapterError(
        "metadata_missing",
        `The workspace at ${workspaceDirectory} has no metadata file. A directory the framework cannot identify is one it must not restore into or delete, so the workspace is refused rather than adopted.`,
      );
    }

    throw error;
  }

  return parseSidecar(text, path);
}

/**
 * Writes a sidecar atomically.
 *
 * The rename is the point: a sidecar is read again by the next run of the same feature, and a file
 * truncated by a crash halfway through a write would be a corrupt-metadata refusal for a workspace
 * that is perfectly fine. So the new content goes to a temporary name in the same directory and
 * replaces the old one in a single step.
 */
export async function writeSidecar(workspaceDirectory: string, sidecar: WorkspaceSidecar): Promise<void> {
  const target = sidecarPath(workspaceDirectory);
  const temporary = `${target}.${randomUUID()}.tmp`;

  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(sidecar, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

/** A fresh lease owned by this process on this host. */
export function newLease(ttlMs: number, now: number = Date.now()): WorkspaceLease {
  return {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  };
}

export function leaseBelongsToThisProcess(lease: WorkspaceLease): boolean {
  return lease.pid === process.pid && lease.host === hostname();
}
