import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  digestArtifactText,
  type OrchestrationResult,
  type WorkflowOrchestrator,
} from "@agent-workflow-kit/orchestration";
import {
  createFeatureSessionStore,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function fixedClock(): string {
  return "2026-07-08T09:10:11.000Z";
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-concurrency-"));
  roots.push(root);
  return root;
}

interface Gate {
  open(): void;
  wait(): Promise<void>;
}

function createGate(): Gate {
  let release = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    open: release,
    wait: () => opened,
  };
}

interface Harness {
  readonly root: string;
  readonly store: FeatureSessionStore;
  readonly path: (filename: string) => Promise<string>;
}

function createHarness(root: string): Harness {
  const store = createFeatureSessionStore(root, { clock: fixedClock });

  return {
    root,
    store,
    path: async (filename) => {
      const features = store.featuresRoot;
      const directories = await readdir(features);

      return join(features, directories.find((entry) => entry.startsWith("F-001")) ?? "", filename);
    },
  };
}

async function createAtPlanning(harness: Harness): Promise<void> {
  const executor = new FakeStageExecutor();
  const orchestrator = createWorkflowOrchestrator({ store: harness.store, executor });

  await orchestrator.createFeature({
    featureId: "F-001",
    title: "Concurrency",
    request: "# Request\n\nProve the race is impossible.\n",
  });

  for (let step = 0; step < 3; step += 1) {
    await orchestrator.runNext("F-001");
  }

  expect((await harness.store.load("F-001")).machine.state).toBe(WorkflowState.Planning);
}

async function driveToState(
  harness: Harness,
  target: WorkflowState,
  executor: FakeStageExecutor = new FakeStageExecutor(),
): Promise<WorkflowOrchestrator> {
  const orchestrator = createWorkflowOrchestrator({ store: harness.store, executor });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const session = await harness.store.load("F-001");

    if (session.machine.state === target) {
      return orchestrator;
    }

    if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
      await orchestrator.approvePlan("F-001");
      continue;
    }

    if (session.machine.state === WorkflowState.AwaitingPushApproval) {
      await orchestrator.approvePush("F-001");
      continue;
    }

    if (session.machine.state === WorkflowState.Failed) {
      throw new Error("Feature failed while driving to the target state.");
    }

    await orchestrator.runNext("F-001");
  }

  throw new Error(`Workflow never reached state "${target}".`);
}

function planContent(featureId: string, planBody: string): Record<string, unknown> {
  return {
    featureId,
    summary: planBody,
    steps: [],
    body: planBody,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("optimistic concurrency", () => {
  it("refuses a stale planning result that would skip plan review", async () => {
    const harness = createHarness(await makeRoot());
    await createAtPlanning(harness);

    const revisionBefore = (await harness.store.load("F-001")).revision;
    const started = createGate();
    const releaseStale = createGate();

    const staleExecutor = new FakeStageExecutor();
    const stale = createWorkflowOrchestrator({ store: harness.store, executor: staleExecutor });

    staleExecutor.configure("planning", {
      artifacts: [{ name: "plan", content: planContent("F-001", "stale plan") }],
      after: async () => {
        started.open();
        await releaseStale.wait();
      },
    });

    const winnerExecutor = new FakeStageExecutor();
    const winner = createWorkflowOrchestrator({ store: harness.store, executor: winnerExecutor });

    winnerExecutor.configure("planning", {
      artifacts: [{ name: "plan", content: planContent("F-001", "winning plan") }],
      after: async () => {
        await started.wait();
      },
    });

    const staleRun = stale.runNext("F-001");
    const winnerResult = await winner.runNext("F-001");

    expect(winnerResult).toMatchObject({
      status: "stage_completed",
      stage: "planning",
      fromState: WorkflowState.Planning,
      state: WorkflowState.PlanReview,
      committed: true,
      artifacts: ["plan"],
    });

    releaseStale.open();

    const staleResult = await staleRun;

    // The loser is told it lost, and nothing it produced is allowed to reach storage.
    expect(staleResult).toMatchObject({
      status: "conflict",
      stage: "planning",
      fromState: WorkflowState.Planning,
      state: WorkflowState.PlanReview,
      committed: false,
      failureClass: "persistence",
      error: { code: "revision_conflict" },
    });

    const session = await harness.store.load("F-001");

    expect(session.machine.state).toBe(WorkflowState.PlanReview);
    expect(session.revision).toBe(revisionBefore + 1);
    expect(await harness.store.readArtifact("F-001", "plan")).toEqual(
      planContent("F-001", "winning plan"),
    );

    const events = await harness.store.readEvents("F-001");

    expect(
      events.filter(
        (event) => event.event === "advance" && event.resultingState === WorkflowState.PlanReview,
      ),
    ).toHaveLength(1);
  });

  it("executes no second stage after a revision conflict", async () => {
    const harness = createHarness(await makeRoot());
    await createAtPlanning(harness);

    const started = createGate();
    const releaseStale = createGate();
    const staleExecutor = new FakeStageExecutor();
    const stale = createWorkflowOrchestrator({ store: harness.store, executor: staleExecutor });

    staleExecutor.configure("planning", {
      artifacts: [{ name: "plan", content: planContent("F-001", "stale plan") }],
      after: async () => {
        started.open();
        await releaseStale.wait();
      },
    });

    const winnerExecutor = new FakeStageExecutor();
    const winner = createWorkflowOrchestrator({ store: harness.store, executor: winnerExecutor });

    winnerExecutor.configure("planning", {
      after: async () => {
        await started.wait();
      },
    });

    const staleRun = stale.runNext("F-001");

    await winner.runNext("F-001");
    releaseStale.open();
    await staleRun;

    expect(staleExecutor.executedStages).toEqual(["planning"]);
    expect(winnerExecutor.executedStages).toEqual(["planning"]);

    // The recovery is the caller's decision, and it lands on the next legal stage.
    const resumed = await stale.runNext("F-001");

    expect(resumed).toMatchObject({
      status: "stage_completed",
      stage: "plan_review",
      state: WorkflowState.AwaitingPlanApproval,
    });
    expect(staleExecutor.executedStages).toEqual(["planning", "plan_review"]);
  });

  it("cannot reach plan approval without reviewing the plan that is actually stored", async () => {
    const harness = createHarness(await makeRoot());
    await createAtPlanning(harness);

    const started = createGate();
    const releaseStale = createGate();
    const staleExecutor = new FakeStageExecutor();
    const stale = createWorkflowOrchestrator({ store: harness.store, executor: staleExecutor });

    staleExecutor.configure("planning", {
      artifacts: [{ name: "plan", content: planContent("F-001", "stale plan") }],
      after: async () => {
        started.open();
        await releaseStale.wait();
      },
    });

    const winnerExecutor = new FakeStageExecutor();
    const winner = createWorkflowOrchestrator({ store: harness.store, executor: winnerExecutor });

    winnerExecutor.configure("planning", {
      artifacts: [{ name: "plan", content: planContent("F-001", "winning plan") }],
      after: async () => {
        await started.wait();
      },
    });

    const staleRun = stale.runNext("F-001");

    await winner.runNext("F-001");
    releaseStale.open();
    await staleRun;

    const review = await winner.runNext("F-001");

    expect(review).toMatchObject({
      status: "stage_completed",
      stage: "plan_review",
      state: WorkflowState.AwaitingPlanApproval,
    });

    const planReviewRequest = winnerExecutor.requestFor("plan_review");
    const reviewedPlan = planReviewRequest?.context.find((entry) => entry.name === "plan");

    expect(reviewedPlan?.content).toEqual(planContent("F-001", "winning plan"));

    const approval = await winner.approvePlan("F-001");
    const session = await harness.store.load("F-001");
    const planText = await harness.store.readArtifactText("F-001", "plan");

    expect(approval).toMatchObject({ status: "gate_approved", state: WorkflowState.Implementing });
    expect(session.approvals.plan?.planSha256).toBe(digestArtifactText(planText));
    expect(session.approvals.plan?.planSha256).not.toBe(
      digestArtifactText(`${JSON.stringify(planContent("F-001", "stale plan"), null, 2)}\n`),
    );
  });

  it("rejects a stale artifact write without touching the newer artifact", async () => {
    const harness = createHarness(await makeRoot());
    await createAtPlanning(harness);

    const started = createGate();
    const releaseStale = createGate();
    const staleExecutor = new FakeStageExecutor();
    const stale = createWorkflowOrchestrator({ store: harness.store, executor: staleExecutor });

    staleExecutor.configure("planning", {
      artifacts: [{ name: "plan", content: planContent("F-001", "stale plan") }],
      after: async () => {
        started.open();
        await releaseStale.wait();
      },
    });

    const winnerExecutor = new FakeStageExecutor();
    const winner = createWorkflowOrchestrator({ store: harness.store, executor: winnerExecutor });

    winnerExecutor.configure("planning", {
      artifacts: [{ name: "plan", content: planContent("F-001", "winning plan") }],
      after: async () => {
        await started.wait();
      },
    });

    const staleRun = stale.runNext("F-001");

    await winner.runNext("F-001");

    const before = await readFile(await harness.path("plan.json"), "utf8");

    releaseStale.open();

    const staleResult = await staleRun;

    expect(staleResult.status).toBe("conflict");
    expect(await readFile(await harness.path("plan.json"), "utf8")).toBe(before);
    expect((await harness.store.load("F-001")).artifacts.plan.status).toBe("present");
  });

  it("lets exactly one of several concurrent writers win and never prepares the losers", async () => {
    const harness = createHarness(await makeRoot());
    await createAtPlanning(harness);

    const revision = (await harness.store.load("F-001")).revision;
    const prepared: number[] = [];
    const writers = Array.from({ length: 4 }, (_unused, index) =>
      harness.store.mutate("F-001", {
        expectedRevision: revision,
        prepare: async () => {
          prepared.push(index);
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { artifacts: [{ name: "request", content: `# Request\n\nwriter ${String(index)}\n` }] };
        },
      }),
    );
    const settled = await Promise.allSettled(writers);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");

    // The revision check happens before any artifact work, so a loser never even prepares.
    expect(prepared).toHaveLength(1);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);

    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ code: "REVISION_CONFLICT" });
    }

    expect((await harness.store.load("F-001")).revision).toBe(revision + 1);
  });
});

describe("session revisions", () => {
  it("starts at a deterministic revision and increments once per authoritative mutation", async () => {
    const harness = createHarness(await makeRoot());
    const orchestrator = createWorkflowOrchestrator({
      store: harness.store,
      executor: new FakeStageExecutor(),
    });
    const revisions: number[] = [];

    const created = await orchestrator.createFeature({
      featureId: "F-001",
      title: "Revisions",
      request: "# Request\n\nCount revisions.\n",
    });

    revisions.push(created.fromState === WorkflowState.Draft ? 0 : -1);
    expect((await harness.store.load("F-001")).revision).toBe(1);

    for (let step = 0; step < 4; step += 1) {
      const before = (await harness.store.load("F-001")).revision;
      await orchestrator.runNext("F-001");
      const after = (await harness.store.load("F-001")).revision;

      revisions.push(after - before);
    }

    expect(revisions).toEqual([0, 1, 1, 1, 1]);
  });

  it("survives a process restart", async () => {
    const harness = createHarness(await makeRoot());
    const executor = new FakeStageExecutor();
    const orchestrator = createWorkflowOrchestrator({ store: harness.store, executor });

    await orchestrator.createFeature({ featureId: "F-001", title: "Revisions" });
    await driveToState(harness, WorkflowState.Planning);

    const before = await harness.store.load("F-001");
    const restartedStore = createFeatureSessionStore(harness.root, { clock: fixedClock });
    const restarted = createWorkflowOrchestrator({
      store: restartedStore,
      executor: new FakeStageExecutor(),
    });
    const reloaded = await restartedStore.load("F-001");

    expect(reloaded.revision).toBe(before.revision);
    expect(reloaded).toEqual(before);

    const advanced = await restarted.runNext("F-001");

    expect(advanced).toMatchObject({ status: "stage_completed", stage: "planning" });
    expect((await restartedStore.load("F-001")).revision).toBe(before.revision + 1);
  });

  it("reports a rejected mutation when the expected revision is stale", async () => {
    const harness = createHarness(await makeRoot());
    const orchestrator = createWorkflowOrchestrator({
      store: harness.store,
      executor: new FakeStageExecutor(),
    });

    await orchestrator.createFeature({ featureId: "F-001", title: "Revisions" });
    await harness.store.writeArtifact("F-001", "request", "# Request\n");

    await expect(
      harness.store.mutate("F-001", {
        expectedRevision: 0,
        prepare: () => ({ artifacts: [{ name: "plan", content: { featureId: "F-001" } }] }),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    await expect(harness.store.readArtifact("F-001", "plan")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
    expect(orchestrator).toBeDefined();
  });
});

describe("human plan approval checkpoint", () => {
  async function approveInFreshFeature(title: string): Promise<{
    readonly harness: Harness;
    readonly store: FeatureSessionStore;
  }> {
    const harness = createHarness(await makeRoot());
    const store = harness.store;
    const orchestrator = createWorkflowOrchestrator({ store, executor: new FakeStageExecutor() });

    await orchestrator.createFeature({ featureId: "F-001", title });
    await driveToState(harness, WorkflowState.AwaitingPlanApproval);
    await orchestrator.approvePlan("F-001");

    return { harness, store };
  }

  it("records deterministic digests of the exact approved artifact bytes", async () => {
    const first = await approveInFreshFeature("Approval A");
    const second = await approveInFreshFeature("Approval B");

    const firstRecord = (await first.store.load("F-001")).approvals.plan;
    const secondRecord = (await second.store.load("F-001")).approvals.plan;

    expect(firstRecord).not.toBeNull();
    expect(firstRecord?.specSha256).toBe(secondRecord?.specSha256);
    expect(firstRecord?.planSha256).toBe(secondRecord?.planSha256);
    expect(firstRecord?.planReviewSha256).toBe(secondRecord?.planReviewSha256);

    const planText = await first.store.readArtifactText("F-001", "plan");

    expect(firstRecord?.planSha256).toBe(
      createHash("sha256").update(planText, "utf8").digest("hex"),
    );
    expect(planText).toBe(await readFile(await first.harness.path("plan.json"), "utf8"));
    expect(firstRecord?.approvedAt).toBe(fixedClock());
    expect((await first.store.load("F-001")).revision).toBe(firstRecord?.approvedRevision);
  });

  it("survives a restart and keeps the digests verifiable", async () => {
    const { store } = await approveInFreshFeature("Approval restart");
    const restarted = createFeatureSessionStore(store.repositoryRoot, { clock: fixedClock });
    const record = (await restarted.load("F-001")).approvals.plan;

    expect(record).not.toBeNull();
    expect(record?.planSha256).toBe(
      digestArtifactText(await restarted.readArtifactText("F-001", "plan")),
    );
    expect(record?.specSha256).toBe(
      digestArtifactText(await restarted.readArtifactText("F-001", "spec")),
    );
    expect(record?.planReviewSha256).toBe(
      digestArtifactText(await restarted.readArtifactText("F-001", "plan_review")),
    );
  });

  it("lets implementation proceed when the approved artifacts are unchanged", async () => {
    const { store } = await approveInFreshFeature("Approval proceeds");
    const restarted = createFeatureSessionStore(store.repositoryRoot, { clock: fixedClock });
    const executor = new FakeStageExecutor();
    const orchestrator = createWorkflowOrchestrator({ store: restarted, executor });

    const result = await orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "stage_completed",
      stage: "implementation",
      role: "implementer",
      state: WorkflowState.CodeReview,
    });
    expect(await restarted.readArtifact("F-001", "implementation")).toMatchObject({
      featureId: "F-001",
      stage: "implementation",
    });
  });

  for (const [label, filename] of [
    ["plan", "plan.json"],
    ["spec", "spec.json"],
    ["plan review", "plan-review.json"],
  ] as const) {
    it(`refuses to implement when the approved ${label} changed after approval`, async () => {
      const { harness, store } = await approveInFreshFeature(`Approval invalid ${label}`);
      const executor = new FakeStageExecutor();
      const orchestrator = createWorkflowOrchestrator({ store, executor });

      await writeFile(await harness.path(filename), '{"tampered":true}\n', "utf8");

      const result = await orchestrator.runNext("F-001");

      expect(result).toMatchObject({
        status: "rejected",
        stage: "implementation",
        fromState: WorkflowState.Implementing,
        state: WorkflowState.Implementing,
        committed: false,
        failureClass: "workflow",
        error: { code: "approval_invalidated" },
      });
      expect(executor.executedStages).toEqual([]);
      await expect(store.readArtifact("F-001", "implementation")).rejects.toMatchObject({
        code: "ARTIFACT_NOT_FOUND",
      });
      expect((await store.load("F-001")).approvals.plan).not.toBeNull();
    });
  }

  it("refuses to run any post approval stage without a checkpoint and never re-approves", async () => {
    const { store } = await approveInFreshFeature("Approval missing");
    const session = await store.load("F-001");
    const withoutApproval = { ...session, approvals: { plan: null }, revision: session.revision + 1 };
    const harness = createHarness(store.repositoryRoot);

    await store.save(withoutApproval);

    const orchestrator = createWorkflowOrchestrator({
      store: createFeatureSessionStore(harness.root, { clock: fixedClock }),
      executor: new FakeStageExecutor(),
    });
    const result: OrchestrationResult = await orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "implementation",
      error: { code: "approval_missing" },
    });
    expect((await store.load("F-001")).approvals.plan).toBeNull();
  });
});
