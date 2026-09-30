import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  STAGE_DEFINITIONS,
  type OrchestrationResult,
  type StageExecutionRequest,
  type WorkStage,
  type WorkflowOrchestrator,
} from "@agent-workflow-kit/orchestration";
import {
  createFeatureSessionStore,
  type FixHistoryDocument,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { FakeStageExecutor, findingFor } from "../fixtures/stage-executor.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly orchestrator: WorkflowOrchestrator;
}

function fixedClock(): string {
  return fixedTimestamp;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-fix-history-"));
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

function contextEntry(
  request: StageExecutionRequest | undefined,
  name: string,
): StageExecutionRequest["context"][number] | undefined {
  return request?.context.find((entry) => entry.name === name);
}

async function createFeature(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Fix history",
    request: "# Request\n\nRepair the reported defects.\n",
  });
}

async function driveToState(
  harness: Harness,
  target: WorkflowState,
): Promise<OrchestrationResult[]> {
  const observed: OrchestrationResult[] = [];

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const session = await harness.store.load("F-001");

    if (session.machine.state === target) {
      return observed;
    }

    if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
      await harness.orchestrator.approvePlan("F-001");
      continue;
    }

    if (session.machine.state === WorkflowState.AwaitingPushApproval) {
      await harness.orchestrator.approvePush("F-001");
      continue;
    }

    if (session.machine.state === WorkflowState.Failed) {
      throw new Error("Feature failed while driving to the target state.");
    }

    observed.push(await harness.orchestrator.runNext("F-001"));
  }

  throw new Error(`Workflow never reached state "${target}".`);
}

async function requestFixFrom(
  harness: Harness,
  stage: WorkStage,
  message = "the reported defect is unresolved",
): Promise<OrchestrationResult> {
  expect(STAGE_DEFINITIONS[stage].fixable).toBe(true);
  harness.executor.configure(stage, {
    outcome: "needs_fix",
    findings: [findingFor("F-001", message)],
  });

  await driveToState(harness, STAGE_DEFINITIONS[stage].state);

  const result = await harness.orchestrator.runNext("F-001");

  expect(result).toMatchObject({
    status: "fix_requested",
    stage,
    state: WorkflowState.Fixing,
    fixReturnState: STAGE_DEFINITIONS[stage].state,
  });

  return result;
}

async function completeFix(harness: Harness, stage: WorkStage): Promise<OrchestrationResult> {
  const result = await harness.orchestrator.runNext("F-001");

  expect(result).toMatchObject({ status: "stage_completed", stage: "fixing" });

  // The review that asked for the fix passes once the fixer has reported.
  harness.executor.reset(stage);

  return result;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("durable fix history", () => {
  it("refuses to finish a fixing stage that produced no report", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await requestFixFrom(harness, "code_review");

    const silent = new FakeStageExecutor();
    silent.configure("fixing", { artifacts: [] });
    const withoutReport = createWorkflowOrchestrator({
      workspace: createFakeWorkspaceProvider(),
      store: harness.store,
      executor: silent,
      verification: createFakeVerificationProvider(),
    });
    const result = await withoutReport.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "fixing",
      fromState: WorkflowState.Fixing,
      state: WorkflowState.Fixing,
      committed: false,
      error: { code: "missing_required_artifact" },
    });
    await expect(harness.store.readArtifact("F-001", "fixes")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  it("appends exactly one report for one fixing run", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await requestFixFrom(harness, "code_review");

    const beforeFixing = await harness.store.load("F-001");
    const result = await completeFix(harness, "code_review");

    expect(result).toMatchObject({
      status: "stage_completed",
      stage: "fixing",
      fromState: WorkflowState.Fixing,
      state: WorkflowState.CodeReview,
      artifacts: ["fixes"],
      committed: true,
    });

    const history = (await harness.store.readArtifact("F-001", "fixes")) as FixHistoryDocument;

    // The entry is mostly framework-written. Only `report` is the fixer's, and it is stored beside
    // the framework's own account of the attempt rather than in place of it: the attempt number, the
    // revision it was made against, and the outcome are all things the fixer cannot supply and would
    // have no reason to state honestly.
    expect(history.fixes).toHaveLength(1);
    expect(history.fixes[0]).toMatchObject({
      sequence: 1,
      attempt: 1,
      fixReturnState: WorkflowState.CodeReview,
      failureSummary: null,
      recordedAt: fixedTimestamp,
      revisionBefore: beforeFixing.revision,
      revisionAfter: beforeFixing.revision + 1,
      sessionRevision: beforeFixing.revision + 1,
      implementationFingerprint: null,
      changedPaths: [],
      outcome: "accepted",
      report: {
        featureId: "F-001",
        fixedFor: WorkflowState.CodeReview,
        summary: `Deterministic fix for ${WorkflowState.CodeReview}.`,
        changes: [],
      },
    });
    expect(history).toMatchObject({ schemaVersion: 1 });
    // A review-stage fix has no deterministic surface, so there is nothing to hash here and the
    // framework says so rather than inventing a digest.
    expect(history.fixes[0]?.integrity.verificationConfigSha256).toBeNull();

    for (const digest of [
      history.fixes[0]?.integrity.specSha256,
      history.fixes[0]?.integrity.planSha256,
      history.fixes[0]?.integrity.planReviewSha256,
    ]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect((await harness.store.load("F-001")).revision).toBe(beforeFixing.revision + 1);
  });

  it("preserves every report and numbers them in order", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await requestFixFrom(harness, "code_review");

    const firstRevision = (await harness.store.load("F-001")).revision;

    await completeFix(harness, "code_review");
    await requestFixFrom(harness, "runtime_verification", "the smoke test is still flaky");

    const secondRevision = (await harness.store.load("F-001")).revision;

    await completeFix(harness, "runtime_verification");

    expect((await harness.store.load("F-001")).machine.state).toBe(WorkflowState.RuntimeVerification);

    const history = (await harness.store.readArtifact("F-001", "fixes")) as FixHistoryDocument;

    expect(history.schemaVersion).toBe(1);
    expect(
      history.fixes.map((entry) => [
        entry.sequence,
        entry.fixReturnState,
        entry.recordedAt,
        entry.sessionRevision,
      ]),
    ).toEqual([
      [1, WorkflowState.CodeReview, fixedTimestamp, firstRevision + 1],
      [2, WorkflowState.RuntimeVerification, fixedTimestamp, secondRevision + 1],
    ]);
    expect(
      history.fixes.map((entry) => (entry.report as { fixedFor: WorkflowState }).fixedFor),
    ).toEqual([WorkflowState.CodeReview, WorkflowState.RuntimeVerification]);
  });

  it("keeps the fixer report out of the stage artifact it explains", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await requestFixFrom(harness, "code_review");
    await completeFix(harness, "code_review");

    const fixingRequest = harness.executor.requestFor("fixing");

    expect(contextNames(fixingRequest)).toEqual(
      expect.arrayContaining(["spec", "plan", "implementation", "code_review"]),
    );
    expect(contextNames(fixingRequest)).not.toContain("fixes");
    expect(harness.executor.requestFor("code_review")?.outputs).toEqual([
      { name: "code_review", kind: "document", envelopeKey: null },
    ]);
  });

  it("routes the accumulated history into later verification", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await requestFixFrom(harness, "static_verification");
    await completeFix(harness, "static_verification");
    await driveToState(harness, WorkflowState.TestVerification);
    await harness.orchestrator.runNext("F-001");

    const request = harness.executor.requestFor("test_verification");

    expect(contextNames(request)).toEqual(
      expect.arrayContaining(["spec", "plan", "implementation", "verification", "fixes"]),
    );
    expect(contextEntry(request, "fixes")).toMatchObject({
      name: "fixes",
      filename: "fixes.json",
    });
  });

  it("re-verifies after every fix and keeps each result in its own section", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await requestFixFrom(harness, "runtime_verification", "the smoke test is flaky");
    await completeFix(harness, "runtime_verification");

    // The fix returns to the verifier that asked for it, so the re-check is the next stage.
    expect((await harness.store.load("F-001")).machine.state).toBe(WorkflowState.RuntimeVerification);
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "runtime_verification",
      state: WorkflowState.SecurityReview,
    });
    await harness.orchestrator.runNext("F-001");

    const verification = await harness.store.readArtifact("F-001", "verification");

    expect(verification).toMatchObject({
      static_verification: { stage: "static_verification" },
      test_verification: { stage: "test_verification" },
      runtime_verification: { stage: "runtime_verification" },
    });
    expect(contextEntry(harness.executor.requestFor("security_review"), "fixes")).toMatchObject({
      name: "fixes",
    });
  });

  it("exposes the history to the final gate and summary but never to the raw request", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await requestFixFrom(harness, "code_review");
    await completeFix(harness, "code_review");
    await driveToState(harness, WorkflowState.FinalSummary);
    await harness.orchestrator.runNext("F-001");

    const gateRequest = harness.executor.requestFor("final_gate");
    const summaryRequest = harness.executor.requestFor("final_summary");

    expect(contextNames(gateRequest)).toContain("fixes");
    expect(contextNames(summaryRequest)).toEqual(
      expect.arrayContaining(["spec", "plan", "verification", "security_review", "fixes"]),
    );
    expect(contextNames(summaryRequest)).not.toContain("request");
    expect(contextNames(summaryRequest)).not.toContain("grill");
    expect(contextEntry(summaryRequest, "fixes")).toMatchObject({ name: "fixes" });
  });
});
