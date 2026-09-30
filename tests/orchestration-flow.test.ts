import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  DETERMINISTIC_EVIDENCE_KEY,
  type OrchestrationResult,
  type StageExecutionRequest,
} from "@agent-workflow-kit/orchestration";
import {
  createFeatureSessionStore,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
}

function fixedClock(): string {
  return fixedTimestamp;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-orchestration-"));
  roots.push(root);
  return root;
}

function createHarness(root: string): Harness {
  const store = createFeatureSessionStore(root, { clock: fixedClock });
  const executor = new FakeStageExecutor();
  return { store, executor, orchestrator: createWorkflowOrchestrator({ store, executor, verification: createFakeVerificationProvider() , workspace: createFakeWorkspaceProvider() }) };
}

function contextNames(request: StageExecutionRequest | undefined): readonly string[] {
  return (request?.context ?? []).map((entry) => entry.name);
}

async function driveUntil(
  orchestrator: Harness["orchestrator"],
  status: OrchestrationResult["status"],
): Promise<OrchestrationResult[]> {
  const observed: OrchestrationResult[] = [];

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await orchestrator.runNext("F-001");
    observed.push(result);

    if (result.status === status) {
      return observed;
    }
  }

  throw new Error(`Workflow never reached status "${status}".`);
}

async function createFeature(harness: Harness): Promise<OrchestrationResult> {
  return harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Google OAuth / API",
    request: "# Request\n\nSign users in with Google.\n",
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("orchestrator full flow", () => {
  it("runs every stage, requests and repairs a fix, and stops at both human gates", async () => {
    const root = await makeRoot();
    const { store, executor, orchestrator } = createHarness(root);

    expect(await createFeature({ store, executor, orchestrator })).toMatchObject({
      status: "created",
      fromState: WorkflowState.Draft,
      state: WorkflowState.Draft,
      executedStages: [],
      artifacts: ["request"],
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "advanced",
      state: WorkflowState.Grilling,
      executedStages: [],
      event: "advance",
      committed: true,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "grill",
      role: "griller",
      fromState: WorkflowState.Grilling,
      state: WorkflowState.SpecReady,
      artifacts: ["grill", "spec"],
      executedStages: ["grill"],
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "advanced",
      state: WorkflowState.Planning,
      executedStages: [],
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "planning",
      role: "planner",
      state: WorkflowState.PlanReview,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "plan_review",
      role: "plan_reviewer",
      state: WorkflowState.AwaitingPlanApproval,
    });

    const planGate = await orchestrator.runNext("F-001");

    expect(planGate).toMatchObject({
      status: "awaiting_human",
      action: "approve_plan",
      state: WorkflowState.AwaitingPlanApproval,
      executedStages: [],
      committed: false,
      failureClass: "none",
    });
    expect(executor.callCount).toBe(3);

    expect(await orchestrator.approvePush("F-001")).toMatchObject({
      status: "rejected",
      state: WorkflowState.AwaitingPlanApproval,
      committed: false,
      error: { code: "illegal_transition", failureClass: "workflow" },
    });
    expect(executor.callCount).toBe(3);

    expect(await orchestrator.approvePlan("F-001")).toMatchObject({
      status: "gate_approved",
      event: "approve_plan",
      state: WorkflowState.Implementing,
      committed: true,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "implementation",
      role: "implementer",
      state: WorkflowState.CodeReview,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "code_review",
      role: "code_reviewer",
      state: WorkflowState.ScopeReview,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "scope_review",
      role: "scope_reviewer",
      state: WorkflowState.StaticVerification,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "static_verification",
      role: "verifier",
      state: WorkflowState.TestVerification,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "test_verification",
      role: "verifier",
      state: WorkflowState.RuntimeVerification,
    });

    executor.configure("runtime_verification", {
      outcome: "needs_fix",
      findings: [
        {
          featureId: "F-001",
          severity: "error",
          message: "The refresh token flow never completes.",
        },
      ],
      evidence: [{ kind: "runtime", description: "Manual sign-in run failed." }],
    });

    const needsFix = await orchestrator.runNext("F-001");

    expect(needsFix).toMatchObject({
      status: "fix_requested",
      stage: "runtime_verification",
      state: WorkflowState.Fixing,
      event: "request_fix",
      committed: true,
      fixReturnState: WorkflowState.RuntimeVerification,
    });
    expect(needsFix.findings).toEqual([
      { featureId: "F-001", severity: "error", message: "The refresh token flow never completes." },
    ]);
    expect(needsFix.evidence).toEqual([
      { kind: "runtime", description: "Manual sign-in run failed." },
    ]);

    executor.reset("runtime_verification");

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "fixing",
      role: "fixer",
      fromState: WorkflowState.Fixing,
      state: WorkflowState.RuntimeVerification,
      event: "complete_fix",
      artifacts: ["fixes"],
    });

    const rechecked = await orchestrator.runNext("F-001");

    expect(rechecked).toMatchObject({
      status: "stage_completed",
      stage: "runtime_verification",
      fromState: WorkflowState.RuntimeVerification,
      state: WorkflowState.SecurityReview,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "security_review",
      role: "security_reviewer",
      state: WorkflowState.FinalGate,
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "final_gate",
      role: "final_gate_reviewer",
      state: WorkflowState.FinalSummary,
      artifacts: [],
    });

    expect(await orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "final_summary",
      role: "summarizer",
      state: WorkflowState.AwaitingPushApproval,
      artifacts: ["final_summary"],
    });

    const pushGate = await orchestrator.runNext("F-001");

    expect(pushGate).toMatchObject({
      status: "awaiting_human",
      action: "approve_push",
      state: WorkflowState.AwaitingPushApproval,
      executedStages: [],
      committed: false,
    });

    expect(executor.executedStages).toEqual([
      "grill",
      "planning",
      "plan_review",
      "implementation",
      "code_review",
      "scope_review",
      "static_verification",
      "test_verification",
      "runtime_verification",
      "fixing",
      "runtime_verification",
      "security_review",
      "final_gate",
      "final_summary",
    ]);

    const session = await store.load("F-001");

    expect(session.machine).toEqual({ state: WorkflowState.AwaitingPushApproval });
    expect(session.artifacts.final_summary).toEqual({
      filename: "final-summary.md",
      status: "present",
      updatedAt: fixedTimestamp,
    });
    expect(typeof (await store.readArtifact("F-001", "final_summary"))).toBe("string");

    const verification = (await store.readArtifact("F-001", "verification")) as Record<
      string,
      unknown
    >;

    // The three model sections in the order the stages ran, beside the framework's own key, which is
    // appended to rather than taking a section of its own.
    expect(Object.keys(verification).filter((key) => key !== DETERMINISTIC_EVIDENCE_KEY)).toEqual([
      "static_verification",
      "test_verification",
      "runtime_verification",
    ]);
    expect(Object.keys(verification)).toContain(DETERMINISTIC_EVIDENCE_KEY);

    expect(await store.readEvents("F-001")).toHaveLength(17);
    expect(await store.readEvents("F-001")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          previousState: WorkflowState.RuntimeVerification,
          event: "request_fix",
          resultingState: WorkflowState.Fixing,
        }),
        expect.objectContaining({
          previousState: WorkflowState.Fixing,
          event: "complete_fix",
          resultingState: WorkflowState.RuntimeVerification,
        }),
      ]),
    );
  });

  it("never approves, commits, or pushes on its own", async () => {
    const root = await makeRoot();
    const { store, executor, orchestrator } = createHarness(root);

    await createFeature({ store, executor, orchestrator });
    await driveUntil(orchestrator, "awaiting_human");
    await orchestrator.approvePlan("F-001");
    await driveUntil(orchestrator, "awaiting_human");

    expect((await store.load("F-001")).machine).toEqual({
      state: WorkflowState.AwaitingPushApproval,
    });

    const callsBeforeApproval = executor.callCount;

    await orchestrator.approvePush("F-001");
    const deferred = await orchestrator.runNext("F-001");

    expect(deferred).toMatchObject({
      status: "deferred",
      state: WorkflowState.Committing,
      executedStages: [],
      committed: false,
      error: { code: "git_integration_deferred", failureClass: "workflow" },
    });
    expect(executor.callCount).toBe(callsBeforeApproval);
    expect((await store.load("F-001")).machine).toEqual({ state: WorkflowState.Committing });
  });

  it("executes at most one work stage per call", async () => {
    const root = await makeRoot();
    const { store, executor, orchestrator } = createHarness(root);
    const observed: OrchestrationResult[] = [];

    await createFeature({ store, executor, orchestrator });
    observed.push(...(await driveUntil(orchestrator, "awaiting_human")));
    observed.push(await orchestrator.approvePlan("F-001"));
    observed.push(...(await driveUntil(orchestrator, "awaiting_human")));

    const stageResults = observed.filter((result) => result.status === "stage_completed");

    expect(stageResults.map((result) => result.stage)).toEqual([
      "grill",
      "planning",
      "plan_review",
      "implementation",
      "code_review",
      "scope_review",
      "static_verification",
      "test_verification",
      "runtime_verification",
      "security_review",
      "final_gate",
      "final_summary",
    ]);

    for (const result of observed) {
      expect(result.executedStages.length).toBeLessThanOrEqual(1);
    }

    const gateIndex = observed.findIndex((result) => result.status === "gate_approved");
    const stagesAfterApproval = observed
      .slice(gateIndex)
      .filter((result) => result.status === "stage_completed");

    expect(stagesAfterApproval.length).toBe(9);
    expect(executor.callCount).toBe(stageResults.length);
  });
});

describe("orchestrator resume", () => {
  it("continues from persisted state with fresh instances", async () => {
    const root = await makeRoot();
    const first = createHarness(root);

    await createFeature(first);
    await driveUntil(first.orchestrator, "awaiting_human");

    const plan = await first.store.readArtifact("F-001", "plan");
    const paused = await first.store.load("F-001");

    const second = createHarness(root);

    expect(second.executor.callCount).toBe(0);
    expect(await second.store.load("F-001")).toEqual(paused);

    expect(await second.orchestrator.runNext("F-001")).toMatchObject({
      status: "awaiting_human",
      action: "approve_plan",
    });

    expect(await second.orchestrator.approvePlan("F-001")).toMatchObject({
      status: "gate_approved",
      state: WorkflowState.Implementing,
    });

    expect(await second.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "implementation",
      state: WorkflowState.CodeReview,
    });

    expect(second.executor.executedStages).toEqual(["implementation"]);
    expect(await second.store.readArtifact("F-001", "plan")).toEqual(plan);
    expect(contextNames(second.executor.requestFor("implementation"))).toEqual([
      "spec",
      "plan",
      "plan_review",
    ]);
  });

  it("restores a pending fix return state and repairs the same stage", async () => {
    const root = await makeRoot();
    const first = createHarness(root);

    await createFeature(first);
    await driveUntil(first.orchestrator, "awaiting_human");
    await first.orchestrator.approvePlan("F-001");
    first.executor.configure("runtime_verification", { outcome: "needs_fix" });

    for (let step = 0; step < 30; step += 1) {
      const result = await first.orchestrator.runNext("F-001");

      if (result.status === "fix_requested") {
        break;
      }
    }

    expect((await first.store.load("F-001")).machine).toEqual({
      state: WorkflowState.Fixing,
      fixReturnState: WorkflowState.RuntimeVerification,
    });

    const second = createHarness(root);
    const fix = await second.orchestrator.runNext("F-001");

    expect(fix).toMatchObject({
      status: "stage_completed",
      stage: "fixing",
      role: "fixer",
      state: WorkflowState.RuntimeVerification,
    });
    expect(second.executor.requestFor("fixing")?.fixReturnState).toBe(
      WorkflowState.RuntimeVerification,
    );
    expect(contextNames(second.executor.requestFor("fixing"))).toEqual([
      "spec",
      "plan",
      "implementation",
      "verification",
      "code_review",
      "scope_review",
    ]);

    expect(await second.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "runtime_verification",
      state: WorkflowState.SecurityReview,
    });
    expect(second.executor.executedStages).toEqual(["fixing", "runtime_verification"]);
  });
});
