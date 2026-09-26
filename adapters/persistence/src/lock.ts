import { mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PersistenceError, hasErrorCode } from "./errors.js";

const LOCK_DIRECTORY_NAME = ".lock";
const LOCK_OWNER_FILENAME = "owner.json";

export interface FeatureLockOptions {
  /** How long to wait for a contended lock before giving up. */
  readonly lockTimeoutMs?: number;
  /** Fixed pause between acquisition attempts. */
  readonly retryDelayMs?: number;
  /**
   * Age after which a lock with no usable owner record is treated as abandoned. It is never used
   * to condemn a live owner, only a lock whose acquisition never completed.
   */
  readonly staleAfterMs?: number;
  /** Epoch milliseconds source. Injected so staleness can be tested without waiting. */
  readonly now?: () => number;
}

interface LockOwner {
  /** Identifies one acquisition, so a replaced owner can never be deleted by its predecessor. */
  readonly token: string;
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

  const { token, pid, hostname: host, createdAt } = value;

  if (typeof token !== "string" || token.length === 0) {
    return undefined;
  }

  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  if (typeof host !== "string" || host.length === 0) {
    return undefined;
  }

  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    return undefined;
  }

  return { token, pid, hostname: host, createdAt };
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

async function directoryIsOlderThan(
  directoryPath: string,
  ageMs: number,
  now: () => number,
): Promise<boolean> {
  try {
    const stats = await stat(directoryPath);

    return now() - stats.mtimeMs > ageMs;
  } catch {
    // The directory disappeared underneath us, so whoever is waiting can simply try again.
    return true;
  }
}

/**
 * Decides whether an existing lock directory may be taken over.
 *
 * Age alone is never enough: a slow but live process on this machine would be stolen from, and two
 * authoritative mutations would then run at the same time. A lock is only reclaimable when the
 * owner record is unusable, or when it is our own host with a process that no longer exists. A lock
 * from another host is left alone until the ordinary lock timeout reports the contention, because
 * this lock is deliberately not a distributed lock and cannot judge a remote process.
 */
async function lockCanBeTakenOver(
  lockPath: string,
  options: Required<Pick<FeatureLockOptions, "staleAfterMs" | "now">>,
): Promise<boolean> {
  let serialized: string;

  try {
    serialized = await readFile(join(lockPath, LOCK_OWNER_FILENAME), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      // The owner record is written right after the directory. A lock that never got one is either
      // still being established, or was abandoned mid acquisition, so it is aged by the directory.
      return directoryIsOlderThan(lockPath, options.staleAfterMs, options.now);
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
    // An owner record that cannot be trusted is treated like a missing one: bounded age, no guess.
    return directoryIsOlderThan(lockPath, options.staleAfterMs, options.now);
  }

  if (owner.hostname !== hostname()) {
    return false;
  }

  return !processIsAlive(owner.pid);
}

/**
 * Minimal per-feature mutex for authoritative mutations.
 *
 * A lock is a directory created with an exclusive `mkdir`, which is atomic on POSIX and on
 * Windows, plus a JSON owner record holding a unique token, the owning pid, its host, and when the
 * lock was taken. Locks are held only for the duration of one mutation: no AI, executor, or
 * external call may run while a lock is held. In-process contention is serialized through a
 * promise chain so a single process can never wait on its own lock.
 *
 * This is deliberately not a distributed lock. It protects one repository on one machine, so it
 * refuses to take over a lock that is demonstrably still in use: a live local pid, or any lock
 * owned by another host, is left to the ordinary lock timeout. A lock is only reclaimed when the
 * local owner is gone, or when the owner record never became usable and the lock directory itself
 * has aged past the threshold.
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
      now: options.now ?? Date.now,
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
    const deadline = this.#options.now() + this.#options.lockTimeoutMs;

    for (;;) {
      let taken = false;

      try {
        await mkdir(lockPath);
        taken = true;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw new PersistenceError(
            "IO_ERROR",
            `Unable to acquire the feature lock "${lockPath}".`,
            { cause: error, path: lockPath },
          );
        }
      }

      if (taken) {
        const owner: LockOwner = {
          token: randomUUID(),
          pid: process.pid,
          hostname: hostname(),
          createdAt: new Date(this.#options.now()).toISOString(),
        };

        try {
          await writeFile(
            join(lockPath, LOCK_OWNER_FILENAME),
            `${JSON.stringify(owner, null, 2)}\n`,
            { encoding: "utf8", flag: "wx" },
          );
        } catch (error) {
          // The directory is ours and half initialized, so leaving it would strand every writer
          // until the staleness threshold. Take it back down and report the real failure.
          await removeLockDirectory(lockPath);
          throw new PersistenceError(
            "IO_ERROR",
            `Unable to record the owner of the feature lock "${lockPath}".`,
            { cause: error, path: lockPath },
          );
        }

        return async () => {
          await this.#release(lockPath, owner.token);
        };
      }

      if (await lockCanBeTakenOver(lockPath, this.#options)) {
        // A deliberate takeover: the previous owner is dead or unknown, so its lock is removed.
        await removeLockDirectory(lockPath);
        continue;
      }

      if (this.#options.now() >= deadline) {
        throw new PersistenceError(
          "LOCK_TIMEOUT",
          `Timed out after ${String(this.#options.lockTimeoutMs)}ms waiting for the feature lock "${lockPath}".`,
          { path: lockPath },
        );
      }

      await delay(this.#options.retryDelayMs);
    }
  }

  /**
   * Removes the lock only while this acquisition still owns it.
   *
   * A lock that was reclaimed while a slow task was still running belongs to its new owner by then,
   * and deleting it would let a third writer in beside that owner. When the token no longer
   * matches, the lock is left exactly as it is.
   */
  async #release(lockPath: string, token: string): Promise<void> {
    const ownerPath = join(lockPath, LOCK_OWNER_FILENAME);
    let current: LockOwner | undefined;

    try {
      const parsed: unknown = JSON.parse(await readFile(ownerPath, "utf8"));

      current = readOwner(parsed);
    } catch {
      current = undefined;
    }

    if (current === undefined || current.token !== token) {
      return;
    }

    try {
      await unlink(ownerPath);
      await rmdir(lockPath);
    } catch {
      // A concurrent takeover owns the directory now; leaving it alone is correct.
    }
  }
}
