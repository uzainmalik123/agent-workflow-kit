import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeatureSessionStore,
  FeatureLock,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const LOCK_DIR = ".lock";
const OWNER_FILE = "owner.json";

interface OwnerRecord {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
}

function fixedClock(): string {
  return "2026-04-05T06:07:08.000Z";
}

/** Long ago, so any test that passes is passing because of the rule, not because of the clock. */
function longAgoIso(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-lock-"));
  roots.push(root);
  return root;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;

  await new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
    child.on("error", () => {
      resolve();
    });
  });

  if (pid === undefined) {
    throw new Error("Unable to spawn a process for the dead owner fixture.");
  }

  return pid;
}

async function featureDirectory(store: FeatureSessionStore): Promise<string> {
  const directories = await readdir(store.featuresRoot);
  const match = directories.find((entry) => entry.startsWith("F-001-"));

  if (match === undefined) {
    throw new Error("Feature directory not found.");
  }

  return join(store.featuresRoot, match);
}

async function installLock(
  directory: string,
  owner: Partial<OwnerRecord> | "no-owner" | "garbage-owner",
): Promise<string> {
  const lockPath = join(directory, LOCK_DIR);

  await mkdir(lockPath, { recursive: true });

  if (owner !== "no-owner") {
    const record: OwnerRecord =
      owner === "garbage-owner"
        ? ({ nonsense: true } as unknown as OwnerRecord)
        : {
            token: "install-token",
            pid: process.pid,
            hostname: hostname(),
            createdAt: longAgoIso(),
            ...owner,
          };

    await writeFile(join(lockPath, OWNER_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  return lockPath;
}

async function readOwner(lockPath: string): Promise<OwnerRecord> {
  return JSON.parse(await readFile(join(lockPath, OWNER_FILE), "utf8")) as OwnerRecord;
}

/**
 * A clock the test can push forward, so "this lock is an hour old" is a fact rather than a wait.
 * Real time still flows, which is what makes the lock timeout fire.
 */
function createTestClock(): { readonly now: () => number; advance(ms: number): void } {
  let offset = 0;

  return {
    now: () => Date.now() + offset,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

const ONE_HOUR = 3_600_000;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("feature lock staleness", () => {
  it("never reclaims a same-host lock whose owner is still alive, however old it is", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });
    await store.create({ featureId: "F-001", title: "Live owner" });

    const directory = await featureDirectory(store);
    const lockPath = await installLock(directory, {
      token: "live-owner",
      pid: process.pid,
      hostname: hostname(),
      createdAt: longAgoIso(),
    });

    const clock = createTestClock();
    clock.advance(ONE_HOUR);
    const impatient = createFeatureSessionStore(root, {
      clock: fixedClock,
      lock: { lockTimeoutMs: 60, retryDelayMs: 1, staleAfterMs: 1_000, now: clock.now },
    });

    await expect(
      impatient.mutate("F-001", { prepare: () => ({ title: "Should not land" }) }),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    // The live lock and its owner are untouched.
    expect((await readOwner(lockPath)).token).toBe("live-owner");
    expect((await store.load("F-001")).title).toBe("Live owner");
  });

  it("reclaims a same-host lock whose owner process is gone", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });
    await store.create({ featureId: "F-001", title: "Dead owner" });

    const directory = await featureDirectory(store);
    const lockPath = await installLock(directory, {
      token: "dead-owner",
      pid: await deadPid(),
      hostname: hostname(),
      createdAt: longAgoIso(),
    });

    const clock = createTestClock();
    clock.advance(ONE_HOUR);
    const impatient = createFeatureSessionStore(root, {
      clock: fixedClock,
      lock: { lockTimeoutMs: 60, retryDelayMs: 1, staleAfterMs: 1_000, now: clock.now },
    });
    const result = await impatient.mutate("F-001", {
      prepare: () => ({ title: "Reclaimed" }),
    });

    expect(result.session.title).toBe("Reclaimed");
    // The lock is released again, so no owner record survives a completed mutation.
    await expect(readFile(join(lockPath, OWNER_FILE), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reclaims an owner-less lock only after the age threshold passes", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });
    await store.create({ featureId: "F-001", title: "Half acquired" });

    const directory = await featureDirectory(store);
    await installLock(directory, "no-owner");

    const clock = createTestClock();
    const impatient = createFeatureSessionStore(root, {
      clock: fixedClock,
      lock: { lockTimeoutMs: 60, retryDelayMs: 1, staleAfterMs: ONE_HOUR, now: clock.now },
    });

    // Freshly created and still incomplete: not yet abandoned.
    await expect(
      impatient.mutate("F-001", { prepare: () => ({ title: "Too soon" }) }),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    clock.advance(ONE_HOUR);

    const result = await impatient.mutate("F-001", {
      prepare: () => ({ title: "Reclaimed" }),
    });

    expect(result.session.title).toBe("Reclaimed");
  });

  it("reclaims a lock whose owner record cannot be trusted only once it is old", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });
    await store.create({ featureId: "F-001", title: "Garbage owner" });

    const directory = await featureDirectory(store);
    await installLock(directory, "garbage-owner");

    const clock = createTestClock();
    const impatient = createFeatureSessionStore(root, {
      clock: fixedClock,
      lock: { lockTimeoutMs: 60, retryDelayMs: 1, staleAfterMs: ONE_HOUR, now: clock.now },
    });

    await expect(
      impatient.mutate("F-001", { prepare: () => ({ title: "Too soon" }) }),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    clock.advance(ONE_HOUR);

    const result = await impatient.mutate("F-001", {
      prepare: () => ({ title: "Reclaimed" }),
    });

    expect(result.session.title).toBe("Reclaimed");
  });

  it("leaves a foreign host's lock alone and lets the lock timeout report it", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });
    await store.create({ featureId: "F-001", title: "Foreign owner" });

    const directory = await featureDirectory(store);
    const lockPath = await installLock(directory, {
      token: "foreign-owner",
      pid: 1,
      hostname: "another-machine",
      createdAt: longAgoIso(),
    });

    const clock = createTestClock();
    clock.advance(ONE_HOUR);

    // This lock is not a distributed lock, so a remote owner is never judged dead on age alone.
    await expect(
      createFeatureSessionStore(root, {
        clock: fixedClock,
        lock: { lockTimeoutMs: 60, retryDelayMs: 1, staleAfterMs: 1_000, now: clock.now },
      }).mutate("F-001", { prepare: () => ({ title: "Should not land" }) }),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    expect((await readOwner(lockPath)).token).toBe("foreign-owner");
    expect((await store.load("F-001")).title).toBe("Foreign owner");
  });
});

describe("feature lock release ownership", () => {
  it("lets only the current owner remove the lock", async () => {
    const root = await makeRoot();
    const directory = join(root, "feature");
    const lock = new FeatureLock({ lockTimeoutMs: 500, retryDelayMs: 1, staleAfterMs: 1 });
    const lockPath = join(directory, LOCK_DIR);

    await mkdir(directory, { recursive: true });

    const observed: string[] = [];

    await lock.withLock(directory, async () => {
      observed.push((await readOwner(lockPath)).token);

      // While this owner is still working, a newer owner takes the lock over.
      const replacement: OwnerRecord = {
        token: "replacement-token",
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      };

      await writeFile(
        join(lockPath, OWNER_FILE),
        `${JSON.stringify(replacement, null, 2)}\n`,
        "utf8",
      );

      // The stale owner finishes and tries to clean up after itself.
      return undefined;
    });

    // The replacement lock survives, because the previous owner does not own it any more.
    expect((await readOwner(lockPath)).token).toBe("replacement-token");
    expect(observed).toHaveLength(1);
  });

  it("removes its own lock on a normal release", async () => {
    const root = await makeRoot();
    const directory = join(root, "feature");
    const lock = new FeatureLock();
    const lockPath = join(directory, LOCK_DIR);

    await mkdir(directory, { recursive: true });
    await lock.withLock(directory, async () => {
      expect((await readOwner(lockPath)).pid).toBe(process.pid);
      expect((await readOwner(lockPath)).token).toEqual(expect.any(String));
    });

    await expect(readFile(join(lockPath, OWNER_FILE), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("mints a different token for every acquisition", async () => {
    const root = await makeRoot();
    const directory = join(root, "feature");
    const lock = new FeatureLock();
    const lockPath = join(directory, LOCK_DIR);
    const tokens: string[] = [];

    await mkdir(directory, { recursive: true });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await lock.withLock(directory, async () => {
        tokens.push((await readOwner(lockPath)).token);
      });
    }

    expect(new Set(tokens).size).toBe(3);
  });

  it("releases the lock when the task throws", async () => {
    const root = await makeRoot();
    const directory = join(root, "feature");
    const lock = new FeatureLock();
    const lockPath = join(directory, LOCK_DIR);

    await mkdir(directory, { recursive: true });

    await expect(
      lock.withLock(directory, () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");

    await expect(readFile(join(lockPath, OWNER_FILE), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("feature lock contention", () => {
  it("never runs two tasks at once for one feature", async () => {
    const root = await makeRoot();
    const directory = join(root, "feature");
    const lock = new FeatureLock();
    let inFlight = 0;
    let peak = 0;

    await mkdir(directory, { recursive: true });

    await Promise.all(
      Array.from({ length: 6 }, () =>
        lock.withLock(directory, async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
  });

  it("keeps different features independent", async () => {
    const root = await makeRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    const lock = new FeatureLock();
    let inFlight = 0;
    let peak = 0;

    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    const task = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    };

    await Promise.all([lock.withLock(first, task), lock.withLock(second, task)]);

    expect(peak).toBe(2);
  });
});
