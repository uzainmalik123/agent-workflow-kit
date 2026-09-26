import { mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PersistenceError, hasErrorCode } from "./errors.js";

const LOCK_DIRECTORY_NAME = ".lock";
const LOCK_OWNER_FILENAME = "owner.json";

export interface FeatureLockOptions {
  /** How long to wait for a contended lock before giving up. */
  readonly lockTimeoutMs?: number;
  /** Fixed pause between acquisition attempts. */
  readonly retryDelayMs?: number;
  /** Age after which a lock is assumed to belong to a dead process. */
  readonly staleAfterMs?: number;
}

interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
}

const DEFAULTS = {
  lockTimeoutMs: 10_000,
  retryDelayMs: 5,
  staleAfterMs: 30_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOwner(value: unknown): LockOwner | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { pid, hostname: host, createdAt } = value;

  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  if (typeof host !== "string" || host.length === 0) {
    return undefined;
  }

  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    return undefined;
  }

  return { pid, hostname: host, createdAt };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return false;
    }

    return true;
  }
}

async function removeLockDirectory(lockPath: string): Promise<void> {
  try {
    await unlink(join(lockPath, LOCK_OWNER_FILENAME));
  } catch {
    // The owner record is already gone, which is the state we want to reach anyway.
  }

  try {
    await rmdir(lockPath);
  } catch {
    // A concurrent stale takeover owns the directory now; leaving it alone is correct.
  }
}

async function directoryIsOlderThan(directoryPath: string, ageMs: number): Promise<boolean> {
  try {
    const stats = await stat(directoryPath);

    return Date.now() - stats.mtimeMs > ageMs;
  } catch {
    // The directory disappeared underneath us, so whoever is waiting can simply try again.
    return true;
  }
}

async function lockIsStale(lockPath: string, staleAfterMs: number): Promise<boolean> {
  let serialized: string;

  try {
    serialized = await readFile(join(lockPath, LOCK_OWNER_FILENAME), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      // The owner record is written right after the directory. A lock that never got one is
      // either still being established, or was orphaned mid acquisition, so it is aged by the
      // directory itself instead of blocking every writer until the lock times out.
      return directoryIsOlderThan(lockPath, staleAfterMs);
    }

    throw new PersistenceError(
      "IO_ERROR",
      `Unable to read the feature lock owner at "${lockPath}".`,
      { cause: error, path: lockPath },
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    parsed = undefined;
  }

  const owner = readOwner(parsed);

  if (owner === undefined) {
    return true;
  }

  if (owner.hostname === hostname() && !processIsAlive(owner.pid)) {
    return true;
  }

  return Date.now() - Date.parse(owner.createdAt) > staleAfterMs;
}

/**
 * Minimal per-feature mutex for authoritative mutations.
 *
 * A lock is a directory created with an exclusive `mkdir`, which is atomic on POSIX and on
 * Windows, plus a JSON owner record so a lock left behind by a dead process can be taken over.
 * Locks are held only for the duration of one mutation: no AI, executor, or external call may
 * run while a lock is held. In-process contention is serialized through a promise chain so a
 * single process can never wait on its own lock. This is deliberately not a distributed lock.
 */
export class FeatureLock {
  readonly #lockPath: string;
  readonly #options: Required<FeatureLockOptions>;
  readonly #queue: Map<string, Promise<unknown>>;

  constructor(options: FeatureLockOptions = {}) {
    this.#lockPath = LOCK_DIRECTORY_NAME;
    this.#options = {
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs,
      retryDelayMs: options.retryDelayMs ?? DEFAULTS.retryDelayMs,
      staleAfterMs: options.staleAfterMs ?? DEFAULTS.staleAfterMs,
    };
    this.#queue = new Map();
  }

  async withLock<T>(featureDirectoryPath: string, task: () => Promise<T>): Promise<T> {
    const lockPath = join(featureDirectoryPath, this.#lockPath);
    const previous = this.#queue.get(lockPath) ?? Promise.resolve();
    const run = previous.then(
      () => this.#withFileLock(lockPath, task),
      () => this.#withFileLock(lockPath, task),
    );
    // The tail of the chain, resolved either way, so the next waiter never inherits a rejection.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );

    this.#queue.set(lockPath, tail);

    try {
      return await run;
    } finally {
      // Only the last waiter clears the entry: whoever queued behind this one still needs it.
      if (this.#queue.get(lockPath) === tail) {
        this.#queue.delete(lockPath);
      }
    }
  }

  async #withFileLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
    const release = await this.#acquire(lockPath);

    try {
      return await task();
    } finally {
      await release();
    }
  }

  async #acquire(lockPath: string): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.#options.lockTimeoutMs;

    for (;;) {
      try {
        await mkdir(lockPath);
        const owner: LockOwner = {
          pid: process.pid,
          hostname: hostname(),
          createdAt: new Date().toISOString(),
        };

        try {
          await writeFile(
            join(lockPath, LOCK_OWNER_FILENAME),
            `${JSON.stringify(owner, null, 2)}\n`,
            { encoding: "utf8", flag: "wx" },
          );
        } catch (error) {
          await removeLockDirectory(lockPath);
          throw new PersistenceError(
            "IO_ERROR",
            `Unable to record the owner of the feature lock "${lockPath}".`,
            { cause: error, path: lockPath },
          );
        }

        return async () => {
          await removeLockDirectory(lockPath);
        };
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw new PersistenceError(
            "IO_ERROR",
            `Unable to acquire the feature lock "${lockPath}".`,
            { cause: error, path: lockPath },
          );
        }
      }

      if (await lockIsStale(lockPath, this.#options.staleAfterMs)) {
        await removeLockDirectory(lockPath);
        continue;
      }

      if (Date.now() >= deadline) {
        throw new PersistenceError(
          "LOCK_TIMEOUT",
          `Timed out after ${String(this.#options.lockTimeoutMs)}ms waiting for the feature lock "${lockPath}".`,
          { path: lockPath },
        );
      }

      await delay(this.#options.retryDelayMs);
    }
  }
}
