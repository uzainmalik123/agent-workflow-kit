import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  type OrchestrationResult,
  type StageExecutionRequest,
} from "@agent-workflow-kit/orchestration";
import {
  createFeatureSessionStore,
  FEATURE_ARTIFACT_FILENAMES,
  FeatureSessionStore,
  PersistenceError,
  type FeatureSession,
} from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const featureDirectory = "F-001-orchestration-failures";

class CountingSessionWriteStore extends FeatureSessionStore {
  successfulWrites = 0;
  failAfterWrites = Number.POSITIVE_INFINITY;

  protected override async atomicWriteFile(path: string, content: string): Promise<void> {
    if (path.endsWith("session.json")) {
      if (this.successfulWrites >= this.failAfterWrites) {
        throw new PersistenceError("IO_ERROR", "Injected session write failure.", { path });
      }

      this.successfulWrites += 1;
    }

    await super.atomicWriteFile(path, content);
  }
}

function fixedClock(): string {
  return "2026-06-07T08:09:10.000Z";
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-failures-"));
  roots.push(root);
  return root;
}

function featurePath(root: string): string {
  return join(root, ".agentflow", "features", featureDirectory);
}

function eventsPath(root: string): string {
  return join(featurePath(root), "events.jsonl");
}

async function breakEventLog(root: string): Promise<void> {
  await restoreEventLog(root);
  await mkdir(eventsPath(root));
}

async function restoreEventLog(root: string): Promise<void> {
  await rm(eventsPath(root), { recursive: true, force: true });
}

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
}

function createHarness(root: string): Harness {
  const store = createFeatureSessionStore(root, { clock: fixedClock });
  const executor = new FakeStageExecutor();
  return { store, executor, orchestrator: createWorkflowOrchestrator({ store, executor }) };
}

async function planStateHarness(): Promise<{ root: string } & Harness> {
  const root = await makeRoot();
  const harness = createHarness(root);

  await harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Orchestration failures",
    request: "# Request\n\nExercise every failure path.\n",
  });

  for (let step = 0; step < 3; step += 1) {
    await harness.orchestrator.runNext("F-001");
  }

  return { root, ...harness };
}

async function stateOf(harness: { readonly store: FeatureSessionStore }): Promise<WorkflowState> {
  const session = await harness.store.load("F-001");
  return session.machine.state;
}

async function expectArtifactMissing(
  harness: { readonly store: FeatureSessionStore },
  name: Parameters<FeatureSessionStore["readArtifact"]>[1],
): Promise<void> {
  await expect(harness.store.readArtifact("F-001", name)).rejects.toMatchObject({
    code: "ARTIFACT_NOT_FOUND",
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("orchestrator rejects unusable executor results", () => {
  it("rejects a missing required artifact without touching the workflow", async () => {
    const harness = await planStateHarness();
    const eventsBefore = await harness.store.readEvents("F-001");

    harness.executor.configure("planning", { artifacts: [] });
    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "planning",
      state: WorkflowState.Planning,
      committed: false,
      failureClass: "executor",
      error: { code: "missing_required_artifact" },
    });
    expect(await stateOf(harness)).toBe(WorkflowState.Planning);
    await expectArtifactMissing(harness, "plan");
    expect(await harness.store.readEvents("F-001")).toEqual(eventsBefore);

    harness.executor.reset("planning");

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "planning",
      state: WorkflowState.PlanReview,
    });
  });

  it("rejects an artifact owned by another stage", async () => {
    const harness = await planStateHarness();

    harness.executor.configure("planning", {
      artifacts: [
        { name: "plan", content: { featureId: "F-001" } },
        { name: "spec", content: { featureId: "F-001" } },
      ],
    });
    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "unexpected_artifact" },
      state: WorkflowState.Planning,
    });
    await expectArtifactMissing(harness, "plan");
    expect(await stateOf(harness)).toBe(WorkflowState.Planning);
  });

  it("rejects an artifact name that is not controlled by the store", async () => {
    const harness = await planStateHarness();

    harness.executor.configure("planning", {
      artifacts: [{ name: "../../outside.json" as "plan", content: {} }],
    });
    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "unexpected_artifact" },
    });
    expect(await stateOf(harness)).toBe(WorkflowState.Planning);
  });

  it("rejects malformed stage results", async () => {
    const harness = await planStateHarness();
    const malformed: readonly unknown[] = [
      "done",
      42,
      { outcome: "mostly_fine" },
      { outcome: "success", stage: "planning" },
      {
        outcome: "success",
        featureId: "F-001",
        stage: "planning",
        artifacts: [{ name: "plan" }],
      },
    ];

    for (const raw of malformed) {
      harness.executor.configure("planning", { raw });
      const result = await harness.orchestrator.runNext("F-001");

      expect(result.status, `raw result ${JSON.stringify(raw)}`).toBe("rejected");
      expect(result.error?.code).toBe("executor_malformed_result");
      expect(result.committed).toBe(false);
      expect(await stateOf(harness)).toBe(WorkflowState.Planning);
    }
  });

  it("rejects needs_fix from a stage where fixing is illegal", async () => {
    const harness = await planStateHarness();
    const eventsBefore = await harness.store.readEvents("F-001");

    harness.executor.configure("planning", { outcome: "needs_fix" });
    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "planning",
      state: WorkflowState.Planning,
      failureClass: "workflow",
      error: { code: "illegal_needs_fix" },
    });
    expect(result.fixReturnState).toBeNull();
    expect(await stateOf(harness)).toBe(WorkflowState.Planning);
    expect(await harness.store.readEvents("F-001")).toEqual(eventsBefore);
  });

  it("rejects an executor that tries to drive the workflow itself", async () => {
    const harness = await planStateHarness();
    const interference: readonly unknown[] = [
      "advance",
      "complete_fix",
      WorkflowState.Complete,
    ];

    for (const field of interference) {
      harness.executor.configure("planning", {
        raw: {
          outcome: "success",
          featureId: "F-001",
          stage: "planning",
          artifacts: [{ name: "plan", content: { featureId: "F-001" } }],
          event: field,
        },
      });
      const result = await harness.orchestrator.runNext("F-001");

      expect(result).toMatchObject({
        status: "rejected",
        error: { code: "executor_workflow_interference" },
        state: WorkflowState.Planning,
        committed: false,
      });
      await expectArtifactMissing(harness, "plan");
    }
  });

  it("rejects a result produced for another feature or another stage", async () => {
    const harness = await planStateHarness();

    harness.executor.configure("planning", { featureId: "F-002" });
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      error: { code: "executor_result_mismatch" },
      state: WorkflowState.Planning,
    });

    harness.executor.configure("planning", { stage: "implementation" });
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      error: { code: "executor_result_mismatch" },
      state: WorkflowState.Planning,
    });
    expect(await stateOf(harness)).toBe(WorkflowState.Planning);
  });

  it("rejects a stage result that arrives after the session already moved", async () => {
    const harness = await planStateHarness();

    harness.executor.configure("planning", {
      after: async (request: StageExecutionRequest) => {
        expect(request.stage).toBe("planning");
        const result = await harness.store.transition("F-001", "fail");

        expect(result).toEqual({ ok: true, state: WorkflowState.Failed });
      },
    });

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "planning",
      state: WorkflowState.Failed,
      committed: false,
      failureClass: "workflow",
      error: { code: "state_conflict" },
    });
    await expectArtifactMissing(harness, "plan");
  });

  it("rejects artifacts and duplicates from an unusable result", async () => {
    const harness = await planStateHarness();

    harness.executor.configure("planning", {
      outcome: "failed",
      artifacts: [{ name: "plan", content: { featureId: "F-001" } }],
    });
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      error: { code: "artifacts_not_allowed" },
    });

    harness.executor.configure("planning", {
      artifacts: [
        { name: "plan", content: { featureId: "F-001" } },
        { name: "plan", content: { featureId: "F-001" } },
      ],
    });
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      error: { code: "duplicate_artifact" },
    });

    expect(await stateOf(harness)).toBe(WorkflowState.Planning);
  });

  it("refuses to execute a stage whose required context is missing", async () => {
    const harness = await planStateHarness();

    await unlink(join(featurePath(harness.root), FEATURE_ARTIFACT_FILENAMES.grill));

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "planning",
      state: WorkflowState.Planning,
      error: { code: "missing_context_artifact", failureClass: "workflow" },
    });
    expect(harness.executor.callCount).toBe(1);
  });
});

describe("orchestrator failure categories", () => {
  it("keeps the workflow recoverable when the executor throws", async () => {
    const harness = await planStateHarness();

    harness.executor.configure("planning", { error: new Error("the agent crashed") });
    const thrown = await harness.orchestrator.runNext("F-001");

    expect(thrown).toMatchObject({
      status: "executor_error",
      stage: "planning",
      state: WorkflowState.Planning,
      committed: false,
      failureClass: "executor",
      error: { code: "executor_threw" },
    });
    expect(thrown.error?.message).toContain("the agent crashed");
    expect(await stateOf(harness)).toBe(WorkflowState.Planning);

    harness.executor.reset("planning");

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      state: WorkflowState.PlanReview,
    });
  });

  it("treats a reported stage failure as a workflow failure that needs an explicit decision", async () => {
    const harness = await planStateHarness();

    harness.executor.configure("planning", {
      outcome: "failed",
      artifacts: [],
      summary: "The request is ambiguous.",
    });
    const reported = await harness.orchestrator.runNext("F-001");

    expect(reported).toMatchObject({
      status: "stage_failed",
      stage: "planning",
      state: WorkflowState.Planning,
      committed: false,
      failureClass: "workflow",
      error: { code: "stage_reported_failure" },
    });
    await expectArtifactMissing(harness, "plan");

    const retried = await harness.orchestrator.runNext("F-001");

    expect(retried.status).toBe("stage_failed");

    expect(await harness.orchestrator.failFeature("F-001")).toMatchObject({
      status: "feature_failed",
      event: "fail",
      state: WorkflowState.Failed,
      committed: true,
    });

    const terminal = await harness.orchestrator.runNext("F-001");

    expect(terminal).toMatchObject({
      status: "terminal",
      state: WorkflowState.Failed,
      executedStages: [],
      committed: false,
    });
    expect(harness.executor.callCount).toBe(3);
  });

  it("records an inconclusive result without transitioning and re-runs the stage", async () => {
    const harness = await planStateHarness();

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "planning",
      state: WorkflowState.PlanReview,
    });

    harness.executor.configure("plan_review", {
      outcome: "inconclusive",
      artifacts: [],
      summary: "The plan cannot be judged without a target service.",
    });
    const inconclusive = await harness.orchestrator.runNext("F-001");

    expect(inconclusive).toMatchObject({
      status: "inconclusive",
      stage: "plan_review",
      state: WorkflowState.PlanReview,
      committed: false,
    });
    await expectArtifactMissing(harness, "plan_review");

    harness.executor.reset("plan_review");

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "plan_review",
      state: WorkflowState.AwaitingPlanApproval,
    });
  });

  it("refuses an approval that is not legal in the current state", async () => {
    const harness = await planStateHarness();

    expect(await harness.orchestrator.approvePlan("F-001")).toMatchObject({
      status: "rejected",
      state: WorkflowState.Planning,
      committed: false,
      error: { code: "illegal_transition", failureClass: "workflow" },
    });
    expect(await harness.orchestrator.approvePush("F-001")).toMatchObject({
      status: "rejected",
      state: WorkflowState.Planning,
      error: { code: "illegal_transition" },
    });
    expect(await stateOf(harness)).toBe(WorkflowState.Planning);
    expect(harness.executor.callCount).toBe(1);
  });
});

describe("orchestrator persistence recovery", () => {
  it("detects a transition that committed before the event log failed", async () => {
    const root = await makeRoot();
    const { store, executor, orchestrator } = createHarness(root);

    await orchestrator.createFeature({
      featureId: "F-001",
      title: "Orchestration failures",
      request: "# Request\n\nExercise every failure path.\n",
    });
    await breakEventLog(root);
    const firstAdvance = await orchestrator.runNext("F-001");

    expect(firstAdvance).toMatchObject({
      status: "persistence_error",
      fromState: WorkflowState.Draft,
      state: WorkflowState.Grilling,
      committed: true,
      error: { code: "persistence_transition_committed" },
    });

    await breakEventLog(root);

    const result = await orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "persistence_error",
      stage: "grill",
      fromState: WorkflowState.Grilling,
      state: WorkflowState.SpecReady,
      committed: true,
      failureClass: "persistence",
      error: { code: "persistence_transition_committed" },
    });
    expect((await store.load("F-001")).machine).toEqual({ state: WorkflowState.SpecReady });
    expect((await store.load("F-001")).artifacts.spec.status).toBe("present");
    expect((await store.load("F-001")).artifacts.grill.status).toBe("present");

    await restoreEventLog(root);

    const logged = await store.readEvents("F-001");

    expect(logged).toEqual([]);
    expect((await store.load("F-001")).machine).toEqual({ state: WorkflowState.SpecReady });

    const resumed = await orchestrator.runNext("F-001");

    expect(resumed).toMatchObject({
      status: "advanced",
      state: WorkflowState.Planning,
      executedStages: [],
    });
    expect(executor.executedStages).toEqual(["grill"]);
  });

  it("keeps the stage retryable when an artifact write fails", async () => {
    const root = await makeRoot();
    const { store, executor } = createHarness(root);
    const healthy = createWorkflowOrchestrator({ store, executor });

    await healthy.createFeature({
      featureId: "F-001",
      title: "Orchestration failures",
      request: "# Request\n\nExercise every failure path.\n",
    });

    for (let step = 0; step < 3; step += 1) {
      await healthy.runNext("F-001");
    }

    const failingStore = new CountingSessionWriteStore(root, { clock: fixedClock });
    failingStore.failAfterWrites = 0;
    const failing = createWorkflowOrchestrator({ store: failingStore, executor });

    const blocked = await failing.runNext("F-001");

    expect(blocked).toMatchObject({
      status: "persistence_error",
      stage: "planning",
      state: WorkflowState.Planning,
      committed: false,
      failureClass: "persistence",
      error: { code: "persistence_failed" },
    });
    await expectArtifactMissing(healthy, "plan");
    expect((await store.load("F-001")).machine).toEqual({ state: WorkflowState.Planning });

    const retried = await healthy.runNext("F-001");

    expect(retried).toMatchObject({
      status: "stage_completed",
      stage: "planning",
      state: WorkflowState.PlanReview,
    });
    expect(executor.executedStages).toEqual(["grill", "planning", "planning"]);
  });

  it("does not commit a transition that could not be persisted", async () => {
    const root = await makeRoot();
    const { store, executor } = createHarness(root);
    const healthy = createWorkflowOrchestrator({ store, executor });

    await healthy.createFeature({
      featureId: "F-001",
      title: "Orchestration failures",
      request: "# Request\n\nExercise every failure path.\n",
    });

    for (let step = 0; step < 3; step += 1) {
      await healthy.runNext("F-001");
    }

    const failingStore = new CountingSessionWriteStore(root, { clock: fixedClock });
    failingStore.failAfterWrites = 1;
    const failing = createWorkflowOrchestrator({ store: failingStore, executor });

    const blocked = await failing.runNext("F-001");

    expect(blocked).toMatchObject({
      status: "persistence_error",
      stage: "planning",
      fromState: WorkflowState.Planning,
      state: WorkflowState.Planning,
      committed: false,
      failureClass: "persistence",
      error: { code: "persistence_transition_not_committed" },
    });
    expect(blocked.artifacts).toEqual(["plan"]);
    expect(await store.readArtifact("F-001", "plan")).toMatchObject({ featureId: "F-001" });
    expect((await store.load("F-001")).machine).toEqual({ state: WorkflowState.Planning });

    const retried = await healthy.runNext("F-001");

    expect(retried).toMatchObject({
      status: "stage_completed",
      stage: "planning",
      state: WorkflowState.PlanReview,
    });
    expect(executor.executedStages).toEqual(["grill", "planning", "planning"]);
  });

  it("never repairs a non-object verification envelope by overwriting it", async () => {
    const root = await makeRoot();
    const { store, orchestrator } = createHarness(root);

    await orchestrator.createFeature({
      featureId: "F-001",
      title: "Orchestration failures",
      request: "# Request\n\nExercise every failure path.\n",
    });

    for (let step = 0; step < 5; step += 1) {
      await orchestrator.runNext("F-001");
    }

    await orchestrator.approvePlan("F-001");
    await orchestrator.runNext("F-001");
    await orchestrator.runNext("F-001");
    await orchestrator.runNext("F-001");

    expect(await stateOf({ store })).toBe(WorkflowState.StaticVerification);

    await writeFile(
      join(featurePath(root), FEATURE_ARTIFACT_FILENAMES.verification),
      JSON.stringify(["not", "an", "envelope"]),
      "utf8",
    );

    const result = await orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "static_verification",
      state: WorkflowState.StaticVerification,
      failureClass: "persistence",
      error: { code: "unmergeable_artifact" },
    });
    expect(
      JSON.parse(
        await readFile(join(featurePath(root), FEATURE_ARTIFACT_FILENAMES.verification), "utf8"),
      ),
    ).toEqual(["not", "an", "envelope"]);
  });

  it("refuses to run a stage for a feature that has no session", async () => {
    const root = await makeRoot();
    const { orchestrator } = createHarness(root);

    await expect(orchestrator.runNext("F-404")).rejects.toMatchObject({
      code: "FEATURE_NOT_FOUND",
    });
  });

  it("propagates invalid identifiers instead of inventing a session", async () => {
    const root = await makeRoot();
    const { orchestrator } = createHarness(root);

    await expect(orchestrator.createFeature({ featureId: "nope", title: "Bad id" })).rejects
      .toMatchObject({ code: "INVALID_FEATURE_ID" });
    await expect(
      orchestrator.createFeature({ featureId: "F-001", title: "Duplicate" }).then(
        async () => orchestrator.createFeature({ featureId: "F-001", title: "Duplicate" }),
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_FEATURE" });
  });
});

describe("orchestrator session independence", () => {
  it("derives every decision from the persisted session", async () => {
    const root = await makeRoot();
    const { store, orchestrator } = createHarness(root);

    await orchestrator.createFeature({
      featureId: "F-001",
      title: "Orchestration failures",
      request: "# Request\n\nExercise every failure path.\n",
    });
    await orchestrator.runNext("F-001");

    const session: FeatureSession = await store.load("F-001");
    const serialised = JSON.stringify(session);

    expect(serialised).not.toContain("executor");

    const detached = createWorkflowOrchestrator({
      store: createFeatureSessionStore(root, { clock: fixedClock }),
      executor: new FakeStageExecutor(),
    });

    const result: OrchestrationResult = await detached.runNext("F-001");

    expect(result).toMatchObject({
      status: "stage_completed",
      stage: "grill",
      fromState: WorkflowState.Grilling,
      state: WorkflowState.SpecReady,
    });
  });
});
