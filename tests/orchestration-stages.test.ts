import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  DEFERRED_WORK_STATES,
  fixReportArtifact,
  humanActionForState,
  HUMAN_ACTIONS,
  isTerminalState,
  isWorkStage,
  ORCHESTRATION_FAILURE_CLASS,
  ORCHESTRATION_STATUSES,
  outputSpecFor,
  PASSIVE_ADVANCE_STATES,
  resolveStageContextPlan,
  STAGE_BY_STATE,
  STAGE_DEFINITIONS,
  STAGE_ROLES,
  stageForState,
  validateStageExecutionResult,
  WORK_STAGES,
  type FixReturnState,
  type OrchestrationErrorCode,
  type OrchestrationStatus,
  type StageExecutionRequest,
  type WorkStage,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const everyState = Object.values(WorkflowState);

function fixedClock(): string {
  return "2026-05-06T07:08:09.000Z";
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-stages-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("stage definitions", () => {
  it("models every required work stage and no other stage", () => {
    expect(WORK_STAGES).toEqual([
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
      "security_review",
      "final_gate",
      "final_summary",
    ]);

    for (const stage of WORK_STAGES) {
      const definition = STAGE_DEFINITIONS[stage];

      expect(definition.stage).toBe(stage);
      expect(STAGE_ROLES).toContain(definition.role);
      expect(stageForState(definition.state)).toBe(stage);
      expect(STAGE_BY_STATE[definition.state]).toBe(stage);
      expect(isWorkStage(stage)).toBe(true);
    }
  });

  it("maps each work stage to exactly one distinct workflow state", () => {
    const states = WORK_STAGES.map((stage) => STAGE_DEFINITIONS[stage].state);

    expect(new Set(states).size).toBe(WORK_STAGES.length);
  });

  it("partitions every workflow state into work, gate, passive, deferred, or terminal", () => {
    const classified = new Map<WorkflowState, string>();

    for (const state of everyState) {
      const categories: string[] = [];

      if (isTerminalState(state)) {
        categories.push("terminal");
      }

      if (humanActionForState(state) !== undefined) {
        categories.push("human_gate");
      }

      if (DEFERRED_WORK_STATES.has(state)) {
        categories.push("deferred");
      }

      if (PASSIVE_ADVANCE_STATES.has(state)) {
        categories.push("passive_advance");
      }

      if (stageForState(state) !== undefined) {
        categories.push("work_stage");
      }

      expect(categories.length, `state "${state}" must be classified exactly once`).toBe(1);
      classified.set(state, categories[0] ?? "");
    }

    expect(classified.get(WorkflowState.Draft)).toBe("passive_advance");
    expect(classified.get(WorkflowState.SpecReady)).toBe("passive_advance");
    expect(classified.get(WorkflowState.AwaitingPlanApproval)).toBe("human_gate");
    expect(classified.get(WorkflowState.AwaitingPushApproval)).toBe("human_gate");
    expect(classified.get(WorkflowState.Committing)).toBe("deferred");
    expect(classified.get(WorkflowState.Pushing)).toBe("deferred");
    expect(classified.get(WorkflowState.Complete)).toBe("terminal");
    expect(classified.get(WorkflowState.Failed)).toBe("terminal");
    expect(classified.get(WorkflowState.Fixing)).toBe("work_stage");
  });

  it("never treats a human gate or a deferred Git state as an executable stage", () => {
    for (const action of HUMAN_ACTIONS) {
      const state = everyState.find((candidate) => humanActionForState(candidate) === action);

      expect(state).toBeDefined();
      expect(stageForState(state as WorkflowState)).toBeUndefined();
    }

    for (const state of DEFERRED_WORK_STATES) {
      expect(stageForState(state)).toBeUndefined();
    }
  });

  it("declares the required artifact of every successful stage", () => {
    const outputs = Object.fromEntries(
      WORK_STAGES.map((stage) => [
        stage,
        STAGE_DEFINITIONS[stage].outputs.map((output) => output.name),
      ]),
    );

    expect(outputs).toEqual({
      grill: ["grill", "spec"],
      planning: ["plan"],
      plan_review: ["plan_review"],
      implementation: ["implementation"],
      code_review: ["code_review"],
      scope_review: ["scope_review"],
      static_verification: ["verification"],
      test_verification: ["verification"],
      runtime_verification: ["verification"],
      fixing: [],
      security_review: ["security_review"],
      final_gate: [],
      final_summary: ["final_summary"],
    });
  });

  it("only allows review and verification stages to request a fix", () => {
    const fixable = WORK_STAGES.filter((stage) => STAGE_DEFINITIONS[stage].fixable);

    expect(fixable).toEqual([
      "plan_review",
      "code_review",
      "scope_review",
      "static_verification",
      "test_verification",
      "runtime_verification",
      "security_review",
    ]);

    for (const stage of fixable) {
      expect(Object.values(WorkflowState)).toContain(STAGE_DEFINITIONS[stage].state);
    }
  });

  it("keeps each verification result in its own section of the shared verification file", () => {
    for (const stage of ["static_verification", "test_verification", "runtime_verification"] as const) {
      const [output] = STAGE_DEFINITIONS[stage].outputs;

      expect(output).toEqual({ name: "verification", envelopeKey: stage });
    }
  });

  it("refuses an artifact slot that the stage does not own", () => {
    expect(outputSpecFor("planning", "plan")).toEqual({ name: "plan", envelopeKey: null });
    expect(() => outputSpecFor("planning", "spec")).toThrow(/no output slot/u);
    expect(() => outputSpecFor("fixing", "implementation")).toThrow(/no output slot/u);
  });
});

describe("context routing", () => {
  it("declares a deterministic context plan for every stage", () => {
    const plan = Object.fromEntries(
      WORK_STAGES.map((stage) => [stage, resolveStageContextPlan(stage, undefined)]),
    );

    expect(plan).toEqual({
      grill: { required: [], optional: ["request"] },
      planning: { required: ["grill", "spec"], optional: ["request"] },
      plan_review: { required: ["spec", "plan"], optional: ["request"] },
      implementation: { required: ["spec", "plan"], optional: ["plan_review"] },
      code_review: { required: ["spec", "plan", "implementation"], optional: ["plan_review"] },
      scope_review: { required: ["plan", "implementation"], optional: ["spec", "plan_review"] },
      static_verification: {
        required: ["spec", "plan", "implementation"],
        optional: ["verification"],
      },
      test_verification: {
        required: ["spec", "plan", "implementation"],
        optional: ["verification"],
      },
      runtime_verification: {
        required: ["spec", "plan", "implementation"],
        optional: ["verification"],
      },
      fixing: null,
      security_review: {
        required: ["spec", "plan", "implementation", "verification"],
        optional: ["code_review", "scope_review"],
      },
      final_gate: {
        required: [
          "spec",
          "plan",
          "plan_review",
          "implementation",
          "code_review",
          "scope_review",
          "verification",
          "security_review",
        ],
        optional: [],
      },
      final_summary: {
        required: [
          "spec",
          "plan",
          "plan_review",
          "implementation",
          "code_review",
          "scope_review",
          "verification",
          "security_review",
        ],
        optional: [],
      },
    });
  });

  it("routes the failing stage report, the plan, and the implementation to the fixer", () => {
    expect(resolveStageContextPlan("fixing", WorkflowState.PlanReview)).toEqual({
      required: ["plan", "plan_review"],
      optional: ["spec"],
    });
    expect(resolveStageContextPlan("fixing", WorkflowState.RuntimeVerification)).toEqual({
      required: ["spec", "plan", "implementation", "verification"],
      optional: ["code_review", "scope_review"],
    });
    expect(resolveStageContextPlan("fixing", WorkflowState.SecurityReview)).toEqual({
      required: ["spec", "plan", "implementation", "security_review"],
      optional: ["code_review", "scope_review", "verification"],
    });
  });

  it("maps every fix return state to the report artifact the fixer needs", () => {
    const fixReturnStates: readonly FixReturnState[] = [
      WorkflowState.PlanReview,
      WorkflowState.CodeReview,
      WorkflowState.ScopeReview,
      WorkflowState.StaticVerification,
      WorkflowState.TestVerification,
      WorkflowState.RuntimeVerification,
      WorkflowState.SecurityReview,
    ];

    expect(Object.fromEntries(fixReturnStates.map((state) => [state, fixReportArtifact(state)])))
      .toEqual({
        plan_review: "plan_review",
        code_review: "code_review",
        scope_review: "scope_review",
        static_verification: "verification",
        test_verification: "verification",
        runtime_verification: "verification",
        security_review: "security_review",
      });
  });

  it("sends each stage exactly the artifacts it declared at runtime", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });
    const executor = new FakeStageExecutor();
    const orchestrator = createWorkflowOrchestrator({ store, executor });

    await orchestrator.createFeature({
      featureId: "F-001",
      title: "Google OAuth / API",
      request: "# Request\n\nSign users in with Google.\n",
    });

    for (let step = 0; step < 40; step += 1) {
      const result = await orchestrator.runNext("F-001");

      if (result.status === "awaiting_human") {
        if (result.action === "approve_plan") {
          await orchestrator.approvePlan("F-001");
        } else {
          break;
        }
      }
    }

    const routed = Object.fromEntries(
      executor.calls.map((request: StageExecutionRequest) => [
        request.stage,
        request.context.map((entry) => entry.name),
      ]),
    );

    expect(routed).toEqual({
      grill: ["request"],
      planning: ["grill", "spec", "request"],
      plan_review: ["spec", "plan", "request"],
      implementation: ["spec", "plan", "plan_review"],
      code_review: ["spec", "plan", "implementation", "plan_review"],
      scope_review: ["plan", "implementation", "spec", "plan_review"],
      static_verification: ["spec", "plan", "implementation"],
      test_verification: ["spec", "plan", "implementation", "verification"],
      runtime_verification: ["spec", "plan", "implementation", "verification"],
      security_review: [
        "spec",
        "plan",
        "implementation",
        "verification",
        "code_review",
        "scope_review",
      ],
      final_gate: [
        "spec",
        "plan",
        "plan_review",
        "implementation",
        "code_review",
        "scope_review",
        "verification",
        "security_review",
      ],
      final_summary: [
        "spec",
        "plan",
        "plan_review",
        "implementation",
        "code_review",
        "scope_review",
        "verification",
        "security_review",
      ],
    });

    const rawHistoryStages: readonly string[] = [
      "implementation",
      "code_review",
      "scope_review",
      "static_verification",
      "test_verification",
      "runtime_verification",
      "security_review",
      "final_gate",
      "final_summary",
    ];

    for (const stage of rawHistoryStages) {
      const names = routed[stage] ?? [];

      expect(names, `stage "${stage}" must not receive the raw request or the grill transcript`)
        .not.toContain("request");
      expect(names).not.toContain("grill");
    }

    expect(routed["grill"]).toEqual(["request"]);
  });
});

describe("orchestration result contract", () => {
  it("classifies every error code and declares every status", () => {
    expect(ORCHESTRATION_STATUSES).toContain("persistence_error");

    for (const code of Object.keys(ORCHESTRATION_FAILURE_CLASS) as OrchestrationErrorCode[]) {
      expect(ORCHESTRATION_FAILURE_CLASS[code]).not.toBe("none");
    }

    const statuses: readonly OrchestrationStatus[] = ORCHESTRATION_STATUSES;

    expect(new Set(statuses).size).toBe(statuses.length);
  });
});

describe("stage result validation", () => {
  const request: StageExecutionRequest = {
    feature: {
      featureId: "F-001",
      title: "Google OAuth / API",
      slug: "google-oauth-api",
      state: WorkflowState.Planning,
      createdAt: "2026-05-06T07:08:09.000Z",
      updatedAt: "2026-05-06T07:08:09.000Z",
    },
    stage: "planning",
    role: "planner",
    state: WorkflowState.Planning,
    context: [],
    outputs: [{ name: "plan", envelopeKey: null }],
    fixReturnState: null,
  };

  const valid = {
    outcome: "success",
    featureId: "F-001",
    stage: "planning",
    artifacts: [{ name: "plan", content: { featureId: "F-001" } }],
  };

  it("normalizes a valid result", () => {
    const validation = validateStageExecutionResult(valid, request);

    expect(validation.ok).toBe(true);

    if (validation.ok) {
      expect(validation.result).toEqual({
        ...valid,
        findings: [],
        evidence: [],
        summary: null,
      });
    }
  });

  it("rejects malformed shapes, unknown fields, and workflow interference", () => {
    expect(validateStageExecutionResult("done", request)).toMatchObject({
      ok: false,
      code: "executor_malformed_result",
    });
    expect(validateStageExecutionResult(null, request)).toMatchObject({
      ok: false,
      code: "executor_malformed_result",
    });
    expect(validateStageExecutionResult({ ...valid, outcome: "maybe" }, request)).toMatchObject({
      ok: false,
      code: "executor_malformed_result",
    });
    expect(validateStageExecutionResult({ ...valid, extra: 1 }, request)).toMatchObject({
      ok: false,
      code: "executor_malformed_result",
    });
    expect(validateStageExecutionResult({ ...valid, event: "advance" }, request)).toMatchObject({
      ok: false,
      code: "executor_workflow_interference",
    });
    expect(validateStageExecutionResult({ ...valid, nextState: "complete" }, request)).toMatchObject(
      { ok: false, code: "executor_workflow_interference" },
    );
  });

  it("rejects artifact ownership and outcome violations", () => {
    expect(validateStageExecutionResult({ ...valid, artifacts: [] }, request)).toMatchObject({
      ok: false,
      code: "missing_required_artifact",
    });
    expect(
      validateStageExecutionResult(
        { ...valid, artifacts: [{ name: "spec", content: {} }] },
        request,
      ),
    ).toMatchObject({ ok: false, code: "unexpected_artifact" });
    expect(
      validateStageExecutionResult(
        {
          ...valid,
          artifacts: [
            { name: "plan", content: {} },
            { name: "plan", content: {} },
          ],
        },
        request,
      ),
    ).toMatchObject({ ok: false, code: "duplicate_artifact" });
    expect(
      validateStageExecutionResult(
        { ...valid, outcome: "failed" },
        request,
      ),
    ).toMatchObject({ ok: false, code: "artifacts_not_allowed" });
    expect(
      validateStageExecutionResult(
        { ...valid, outcome: "needs_fix" },
        request,
      ),
    ).toMatchObject({ ok: false, code: "illegal_needs_fix" });
  });

  it("rejects results for another feature or stage and malformed findings", () => {
    expect(
      validateStageExecutionResult({ ...valid, featureId: "F-999" }, request),
    ).toMatchObject({ ok: false, code: "executor_result_mismatch" });
    expect(
      validateStageExecutionResult({ ...valid, stage: "implementation" as WorkStage }, request),
    ).toMatchObject({ ok: false, code: "executor_result_mismatch" });
    expect(
      validateStageExecutionResult(
        {
          ...valid,
          findings: [{ featureId: "F-002", severity: "error", message: "m" }],
        },
        request,
      ),
    ).toMatchObject({ ok: false, code: "executor_malformed_result" });
    expect(
      validateStageExecutionResult(
        { ...valid, findings: [{ featureId: "F-001", severity: "fatal", message: "m" }] },
        request,
      ),
    ).toMatchObject({ ok: false, code: "executor_malformed_result" });
    expect(
      validateStageExecutionResult(
        { ...valid, evidence: [{ kind: "manual", description: "d" }] },
        request,
      ),
    ).toMatchObject({ ok: false, code: "executor_malformed_result" });
  });
});
