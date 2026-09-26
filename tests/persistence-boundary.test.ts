import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createFeatureSessionStore,
  type FeatureSession,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { writeSessionDocument } from "../fixtures/session-documents.js";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

function fixedClock(): string {
  return fixedTimestamp;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-boundary-"));
  roots.push(root);
  return root;
}

async function makeStore(): Promise<{ root: string; store: FeatureSessionStore }> {
  const root = await makeRoot();
  const store = createFeatureSessionStore(root, { clock: fixedClock });
  await store.create({ featureId: "F-001", title: "Boundary" });
  return { root, store };
}

/** A session that claims the workflow already finished, with a revision that looks continuous. */
function fabricatedSession(session: FeatureSession): FeatureSession {
  return {
    ...session,
    revision: session.revision + 1,
    machine: { state: WorkflowState.Complete },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("workflow state has no raw write path", () => {
  it("exposes no whole session save and no generic metadata patch", async () => {
    const { store } = await makeStore();

    expect(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(store), "save")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(store), "update")).toBe(
      false,
    );

    const escapeHatch = store as unknown as {
      save?: unknown;
      update?: unknown;
    };

    expect(escapeHatch.save).toBeUndefined();
    expect(escapeHatch.update).toBeUndefined();
  });

  it("refuses a mutation plan that tries to carry workflow state", async () => {
    const { store } = await makeStore();
    const before = await store.load("F-001");

    for (const smuggled of [
      { machine: { state: WorkflowState.Complete } },
      { revision: before.revision + 5 },
      { featureId: "F-002" },
      { slug: "hijacked" },
      { createdAt: "2020-01-01T00:00:00.000Z" },
    ]) {
      await expect(
        store.mutate("F-001", {
          prepare: () => smuggled as never,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }

    const after = await store.load("F-001");

    expect(after).toEqual(before);
    expect(after.machine.state).toBe(WorkflowState.Draft);
    expect(after.revision).toBe(before.revision);
  });

  it("cannot persist an arbitrary machine snapshot at a continuous revision", async () => {
    const { store } = await makeStore();
    const before = await store.load("F-001");
    const document = fabricatedSession(before);

    // There is no API that accepts this document, and the store will not invent one.
    const attempt = await store
      .mutate("F-001", {
        expectedRevision: before.revision,
        prepare: () => document as never,
      })
      .then(
        () => "resolved",
        (error: unknown) => (error as { code?: string }).code,
      );

    expect(attempt).toBe("INVALID_ARGUMENT");

    const after = await store.load("F-001");

    expect(after.machine.state).toBe(WorkflowState.Draft);
    expect(after.revision).toBe(before.revision);
    expect(await store.readEvents("F-001")).toHaveLength(0);
  });

  it("refuses an event the state machine does not allow and keeps the revision", async () => {
    const { store } = await makeStore();
    const before = await store.load("F-001");
    // Plan approval is only legal once a plan has been reviewed.
    const result = await store.transition("F-001", "approve_plan");

    expect(result).toMatchObject({ ok: false, code: "illegal_transition", state: WorkflowState.Draft });

    const after = await store.load("F-001");

    expect(after.machine.state).toBe(WorkflowState.Draft);
    // A refused event is recorded, but it never advances authoritative state.
    expect(after.revision).toBe(before.revision);
    expect(await store.readEvents("F-001")).toHaveLength(1);
    expect((await store.readEvents("F-001"))[0]).toMatchObject({ success: false });
  });

  it("does not let an artifact write reach the session document", async () => {
    const { store } = await makeStore();

    for (const name of ["session", "session.json", "events", "../session"] as const) {
      await expect(
        store.writeArtifact("F-001", name as never, { machine: { state: "complete" } }),
      ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_NAME" });
    }

    const sessionPath = join(
      (await makeDirectoryOf(store)),
      "session.json",
    );

    expect(JSON.parse(await readFile(sessionPath, "utf8"))).toMatchObject({
      machine: { state: WorkflowState.Draft },
    });
  });
});

describe("approval metadata cannot be fabricated", () => {
  it("leaves an unapproved session unapproved through every generic route", async () => {
    const { store } = await makeStore();
    const before = await store.load("F-001");
    const forgery = {
      approvals: {
        plan: {
          approvedAt: fixedTimestamp,
          approvedRevision: before.revision + 1,
          specSha256: "0".repeat(64),
          planSha256: "0".repeat(64),
          planReviewSha256: "0".repeat(64),
        },
      },
    };

    // A patch-shaped key is not part of a mutation plan.
    await expect(
      store.mutate("F-001", { prepare: () => ({ ...forgery, machine: undefined }) as never }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    // There is no update() and no save() to smuggle it through.
    const escapeHatch = store as unknown as { update?: (id: string, patch: unknown) => unknown };

    expect(escapeHatch.update).toBeUndefined();

    const after = await store.load("F-001");

    expect(after.approvals).toEqual({ plan: null });
  });

  it("accepts an approval only together with the event that earns it", async () => {
    const { store } = await makeStore();

    for (let step = 0; step < 5; step += 1) {
      await store.transition("F-001", "advance");
    }

    expect((await store.load("F-001")).machine.state).toBe(WorkflowState.AwaitingPlanApproval);

    const approved = await store.mutate("F-001", {
      prepare: () => ({
        event: "approve_plan" as const,
        approvals: {
          plan: {
            approvedAt: fixedTimestamp,
            approvedRevision: 5,
            specSha256: "a".repeat(64),
            planSha256: "a".repeat(64),
            planReviewSha256: "a".repeat(64),
          },
        },
      }),
    });

    expect(approved.session.approvals.plan).toEqual({
      approvedAt: fixedTimestamp,
      approvedRevision: 5,
      specSha256: "a".repeat(64),
      planSha256: "a".repeat(64),
      planReviewSha256: "a".repeat(64),
    });
    expect(approved.session.machine.state).toBe(WorkflowState.Implementing);
    expect(approved.session.revision).toBe(6);
  });

  it("keeps the approval out of the session when the event is refused", async () => {
    const { store } = await makeStore();

    // No plan has been reviewed, so the same approval payload is rejected rather than stored.
    const result = await store.mutate("F-001", {
      prepare: () => ({
        event: "approve_plan" as const,
        approvals: {
          plan: {
            approvedAt: fixedTimestamp,
            approvedRevision: 0,
            specSha256: "a".repeat(64),
            planSha256: "a".repeat(64),
            planReviewSha256: "a".repeat(64),
          },
        },
      }),
    });

    expect(result.event).toMatchObject({
      event: "approve_plan",
      success: false,
      errorCode: "illegal_transition",
      resultingState: WorkflowState.Draft,
    });
    expect(result.session.approvals.plan).toBeNull();
    expect(result.session.machine.state).toBe(WorkflowState.Draft);
  });
});

describe("the guarded mutation path still works", () => {
  it("renames a feature through a revision guarded mutation", async () => {
    const { store } = await makeStore();
    const before = await store.load("F-001");
    const renamed = await store.mutate("F-001", {
      expectedRevision: before.revision,
      prepare: () => ({ title: "Renamed" }),
    });

    expect(renamed.session).toMatchObject({ title: "Renamed", revision: before.revision + 1 });
    expect(renamed.event).toBeNull();
    expect((await store.load("F-001")).title).toBe("Renamed");
  });

  it("still refuses a stale precondition and rolls the artifacts back", async () => {
    const { store } = await makeStore();
    const before = await store.load("F-001");

    await expect(
      store.mutate("F-001", {
        expectedRevision: before.revision + 3,
        prepare: () => ({ artifacts: [{ name: "plan", content: { plan: true } }] }),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    await expect(store.readArtifact("F-001", "plan")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  it("still applies a legal event and records it in order", async () => {
    const { store } = await makeStore();
    const result = await store.transition("F-001", "advance");

    expect(result).toEqual({ ok: true, state: WorkflowState.Grilling });
    expect((await store.load("F-001")).machine.state).toBe(WorkflowState.Grilling);
    expect((await store.readEvents("F-001"))[0]).toMatchObject({
      event: "advance",
      revision: 1,
      success: true,
    });
  });

  it("detects a hand edited session document rather than trusting it silently", async () => {
    const { store } = await makeStore();
    const session = await store.load("F-001");

    // The library cannot defend against someone with filesystem access, so a doctored document
    // is at least detected rather than read as a legitimate approval.
    await writeSessionDocument(store, "F-001", {
      ...session,
      machine: { state: WorkflowState.PlanReview },
    });

    const reloaded = await store.load("F-001");

    expect(reloaded.machine.state).toBe(WorkflowState.PlanReview);
    expect(reloaded.approvals.plan).toBeNull();
    expect(reloaded.revision).toBe(session.revision);
  });
});

async function makeDirectoryOf(store: FeatureSessionStore): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const directories = await readdir(store.featuresRoot);
  const match = directories.find((entry) => entry.startsWith("F-001-"));

  if (match === undefined) {
    throw new Error("Feature directory not found.");
  }

  return join(store.featuresRoot, match);
}
