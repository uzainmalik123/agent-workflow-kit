import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeatureSessionStore,
  FeatureSessionStore,
  PersistenceError,
  FEATURE_SESSION_SCHEMA_VERSION,
} from "@agent-workflow-kit/persistence";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

function fixedClock(): string {
  return fixedTimestamp;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-revisions-"));
  roots.push(root);
  return root;
}

async function createStore(root: string): Promise<FeatureSessionStore> {
  const store = createFeatureSessionStore(root, { clock: fixedClock });
  await store.create({ featureId: "F-001", title: "Revisions" });
  await store.writeArtifact("F-001", "request", "# Request\n\nOne writer at a time.\n");
  return store;
}

async function featurePath(store: FeatureSessionStore, filename: string): Promise<string> {
  const directory = (await readdir(store.featuresRoot)).find((entry) =>
    entry.startsWith("F-001"),
  );

  if (directory === undefined) {
    throw new Error("Feature directory not found.");
  }

  return join(store.featuresRoot, directory, filename);
}

class FailingSessionWriteStore extends FeatureSessionStore {
  failSessionWrites = false;

  protected override async atomicWriteFile(path: string, content: string): Promise<void> {
    if (this.failSessionWrites && path.endsWith("session.json")) {
      throw new PersistenceError("IO_ERROR", "Injected session write failure.", { path });
    }

    await super.atomicWriteFile(path, content);
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("feature session revisions", () => {
  it("counts every authoritative write and starts from nothing written", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });

    await store.create({ featureId: "F-001", title: "Revisions" });

    const session = await store.load("F-001");

    expect(session.revision).toBe(0);
    expect(session.schemaVersion).toBe(FEATURE_SESSION_SCHEMA_VERSION);
    expect(session.approvals).toEqual({ plan: null });
  });

  it("records the request artifact as its own revision", async () => {
    const store = await createStore(await makeRoot());
    const session = await store.load("F-001");

    expect(session.revision).toBe(1);
    expect(session.schemaVersion).toBe(FEATURE_SESSION_SCHEMA_VERSION);
    expect(session.approvals).toEqual({ plan: null });
  });

  it("increments by exactly one per authoritative mutation and never skips", async () => {
    const store = await createStore(await makeRoot());
    const observed: number[] = [(await store.load("F-001")).revision];

    for (let step = 0; step < 5; step += 1) {
      const current = await store.load("F-001");

      await store.mutate("F-001", {
        expectedRevision: current.revision,
        prepare: (reader) => {
          expect(reader.session.revision).toBe(current.revision);
          expect(reader.nextRevision).toBe(current.revision + 1);
          return {
            artifacts: [{ name: "plan", content: { step, featureId: "F-001" } }],
          };
        },
      });

      observed.push((await store.load("F-001")).revision);
    }

    expect(observed).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects a stale expected revision before any artifact is written", async () => {
    const store = await createStore(await makeRoot());
    const current = await store.load("F-001");
    let prepared = false;

    await expect(
      store.mutate("F-001", {
        expectedRevision: current.revision + 5,
        prepare: () => {
          prepared = true;
          return { artifacts: [{ name: "plan", content: { plan: true } }] };
        },
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    expect(prepared).toBe(false);
    await expect(store.readArtifact("F-001", "plan")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
    expect((await store.load("F-001")).revision).toBe(current.revision);
  });

  it("rolls back artifacts when the session write cannot commit", async () => {
    const root = await makeRoot();
    const store = new FailingSessionWriteStore(root, { clock: fixedClock });

    await store.create({ featureId: "F-001", title: "Revisions" });
    store.failSessionWrites = true;

    const current = await store.load("F-001");

    await expect(
      store.mutate("F-001", {
        expectedRevision: current.revision,
        prepare: () => ({ artifacts: [{ name: "plan", content: { plan: true } }] }),
      }),
    ).rejects.toMatchObject({ code: "IO_ERROR" });

    await expect(store.readArtifact("F-001", "plan")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
    expect((await store.load("F-001")).revision).toBe(current.revision);
  });

  it("survives a restart with the same revision and event history", async () => {
    const root = await makeRoot();
    const store = await createStore(root);
    const session = await store.load("F-001");

    await store.mutate("F-001", {
      expectedRevision: session.revision,
      prepare: () => ({ artifacts: [{ name: "plan", content: { plan: true } }] }),
    });

    const before = await store.load("F-001");
    const restarted = createFeatureSessionStore(root, { clock: fixedClock });
    const reloaded = await restarted.load("F-001");

    expect(reloaded).toEqual(before);
    expect(await restarted.readEvents("F-001")).toEqual(await store.readEvents("F-001"));

    await restarted.mutate("F-001", {
      expectedRevision: before.revision,
      prepare: () => ({ artifacts: [{ name: "plan_review", content: { review: true } }] }),
    });

    expect((await restarted.load("F-001")).revision).toBe(before.revision + 1);
  });

  it("returns the exact persisted bytes for hashing", async () => {
    const store = await createStore(await makeRoot());

    await store.writeArtifact("F-001", "plan", { plan: true });

    const text = await store.readArtifactText("F-001", "plan");

    expect(text).toBe(await readFile(await featurePath(store, "plan.json"), "utf8"));
    expect(JSON.parse(text)).toEqual({ plan: true });
  });
});

describe("feature write locking", () => {
  it("never lets two mutations of one feature overlap", async () => {
    const store = await createStore(await makeRoot());
    const start = (await store.load("F-001")).revision;
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    const writers = [0, 1, 2, 3].map((index) =>
      store.mutate("F-001", {
        prepare: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          order.push(index);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight -= 1;
          return { artifacts: [{ name: "plan", content: { index } }] };
        },
      }),
    );

    await Promise.all(writers);

    expect(peak).toBe(1);
    expect(order).toHaveLength(4);
    expect((await store.load("F-001")).revision).toBe(start + 4);
  });

  it("lets a caller recover by re-reading the revision and retrying", async () => {
    const store = await createStore(await makeRoot());
    const baseline = (await store.load("F-001")).revision;
    let committed = 0;
    let attempt = 0;
    const writes = [0, 1, 2].map(async () => {
      for (let retry = 0; retry < 5; retry += 1) {
        attempt += 1;
        const current = await store.load("F-001");

        try {
          await store.mutate("F-001", {
            expectedRevision: current.revision,
            prepare: () => ({
              artifacts: [{ name: "plan", content: { committed } }],
            }),
          });
          committed += 1;
          return;
        } catch (error) {
          expect(error).toMatchObject({ code: "REVISION_CONFLICT" });
        }
      }

      throw new Error("Writer never won a slot.");
    });

    await Promise.all(writes);

    expect(committed).toBe(3);
    expect(attempt).toBeGreaterThan(3);
    expect((await store.load("F-001")).revision).toBe(baseline + 3);
  });

  it("releases the lock after a failed mutation", async () => {
    const store = await createStore(await makeRoot());
    const revision = (await store.load("F-001")).revision;

    await expect(
      store.mutate("F-001", {
        expectedRevision: revision,
        prepare: () => {
          throw new Error("preparation failed");
        },
      }),
    ).rejects.toThrow("preparation failed");

    const recovered = await store.mutate("F-001", {
      expectedRevision: revision,
      prepare: () => ({ artifacts: [{ name: "plan", content: { plan: true } }] }),
    });

    expect(recovered.session.revision).toBe(revision + 1);
  });

  it("keeps different features independent", async () => {
    const store = await createStore(await makeRoot());

    await store.create({ featureId: "F-002", title: "Second feature" });

    const firstBefore = (await store.load("F-001")).revision;
    const secondBefore = (await store.load("F-002")).revision;
    const [first, second] = await Promise.all([
      store.mutate("F-001", {
        expectedRevision: firstBefore,
        prepare: () => ({ artifacts: [{ name: "plan", content: { featureId: "F-001" } }] }),
      }),
      store.mutate("F-002", {
        expectedRevision: secondBefore,
        prepare: () => ({ artifacts: [{ name: "plan", content: { featureId: "F-002" } }] }),
      }),
    ]);

    expect(first.session.revision).toBe(firstBefore + 1);
    expect(second.session.revision).toBe(secondBefore + 1);
  });
});
