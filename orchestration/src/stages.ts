import {
  WorkflowState,
  type FixReturnState,
  type WorkflowEvent,
} from "@agent-workflow-kit/core";
import type { FeatureArtifactName } from "@agent-workflow-kit/persistence";

export const WORK_STAGES = [
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
] as const;

export type WorkStage = (typeof WORK_STAGES)[number];

export const STAGE_ROLES = [
  "griller",
  "planner",
  "plan_reviewer",
  "implementer",
  "code_reviewer",
  "scope_reviewer",
  "verifier",
  "fixer",
  "security_reviewer",
  "final_gate_reviewer",
  "summarizer",
] as const;

export type StageRole = (typeof STAGE_ROLES)[number];

export const HUMAN_ACTIONS = ["approve_plan", "approve_push"] as const;

export type HumanAction = (typeof HUMAN_ACTIONS)[number];

export interface StageArtifactOutputSpec {
  readonly name: FeatureArtifactName;
  readonly envelopeKey: string | null;
}

export interface StageContextPlan {
  readonly required: readonly FeatureArtifactName[];
  readonly optional: readonly FeatureArtifactName[];
}

export interface StageDefinition {
  readonly stage: WorkStage;
  readonly state: WorkflowState;
  readonly role: StageRole;
  readonly outputs: readonly StageArtifactOutputSpec[];
  readonly context: StageContextPlan;
  readonly successEvent: WorkflowEvent;
  readonly fixable: boolean;
}

function document(name: FeatureArtifactName): StageArtifactOutputSpec {
  return { name, envelopeKey: null };
}

function section(name: FeatureArtifactName, envelopeKey: string): StageArtifactOutputSpec {
  return { name, envelopeKey };
}

export const STAGE_DEFINITIONS: Readonly<Record<WorkStage, StageDefinition>> = {
  grill: {
    stage: "grill",
    state: WorkflowState.Grilling,
    role: "griller",
    outputs: [document("grill"), document("spec")],
    context: { required: [], optional: ["request"] },
    successEvent: "advance",
    fixable: false,
  },
  planning: {
    stage: "planning",
    state: WorkflowState.Planning,
    role: "planner",
    outputs: [document("plan")],
    context: { required: ["grill", "spec"], optional: ["request"] },
    successEvent: "advance",
    fixable: false,
  },
  plan_review: {
    stage: "plan_review",
    state: WorkflowState.PlanReview,
    role: "plan_reviewer",
    outputs: [document("plan_review")],
    context: { required: ["spec", "plan"], optional: ["request"] },
    successEvent: "advance",
    fixable: true,
  },
  implementation: {
    stage: "implementation",
    state: WorkflowState.Implementing,
    role: "implementer",
    outputs: [document("implementation")],
    context: { required: ["spec", "plan"], optional: ["plan_review"] },
    successEvent: "advance",
    fixable: false,
  },
  code_review: {
    stage: "code_review",
    state: WorkflowState.CodeReview,
    role: "code_reviewer",
    outputs: [document("code_review")],
    context: { required: ["spec", "plan", "implementation"], optional: ["plan_review"] },
    successEvent: "advance",
    fixable: true,
  },
  scope_review: {
    stage: "scope_review",
    state: WorkflowState.ScopeReview,
    role: "scope_reviewer",
    outputs: [document("scope_review")],
    context: { required: ["plan", "implementation"], optional: ["spec", "plan_review"] },
    successEvent: "advance",
    fixable: true,
  },
  static_verification: {
    stage: "static_verification",
    state: WorkflowState.StaticVerification,
    role: "verifier",
    outputs: [section("verification", "static_verification")],
    context: {
      required: ["spec", "plan", "implementation"],
      optional: ["verification"],
    },
    successEvent: "advance",
    fixable: true,
  },
  test_verification: {
    stage: "test_verification",
    state: WorkflowState.TestVerification,
    role: "verifier",
    outputs: [section("verification", "test_verification")],
    context: {
      required: ["spec", "plan", "implementation"],
      optional: ["verification"],
    },
    successEvent: "advance",
    fixable: true,
  },
  runtime_verification: {
    stage: "runtime_verification",
    state: WorkflowState.RuntimeVerification,
    role: "verifier",
    outputs: [section("verification", "runtime_verification")],
    context: {
      required: ["spec", "plan", "implementation"],
      optional: ["verification"],
    },
    successEvent: "advance",
    fixable: true,
  },
  fixing: {
    stage: "fixing",
    state: WorkflowState.Fixing,
    role: "fixer",
    outputs: [],
    context: { required: [], optional: [] },
    successEvent: "complete_fix",
    fixable: false,
  },
  security_review: {
    stage: "security_review",
    state: WorkflowState.SecurityReview,
    role: "security_reviewer",
    outputs: [document("security_review")],
    context: {
      required: ["spec", "plan", "implementation", "verification"],
      optional: ["code_review", "scope_review"],
    },
    successEvent: "advance",
    fixable: true,
  },
  final_gate: {
    stage: "final_gate",
    state: WorkflowState.FinalGate,
    role: "final_gate_reviewer",
    outputs: [],
    context: {
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
    successEvent: "advance",
    fixable: false,
  },
  final_summary: {
    stage: "final_summary",
    state: WorkflowState.FinalSummary,
    role: "summarizer",
    outputs: [document("final_summary")],
    context: {
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
    successEvent: "advance",
    fixable: false,
  },
};

export const STAGE_BY_STATE: Readonly<Record<WorkflowState, WorkStage | undefined>> = {
  [WorkflowState.Draft]: undefined,
  [WorkflowState.Grilling]: "grill",
  [WorkflowState.SpecReady]: undefined,
  [WorkflowState.Planning]: "planning",
  [WorkflowState.PlanReview]: "plan_review",
  [WorkflowState.AwaitingPlanApproval]: undefined,
  [WorkflowState.Implementing]: "implementation",
  [WorkflowState.CodeReview]: "code_review",
  [WorkflowState.ScopeReview]: "scope_review",
  [WorkflowState.StaticVerification]: "static_verification",
  [WorkflowState.TestVerification]: "test_verification",
  [WorkflowState.RuntimeVerification]: "runtime_verification",
  [WorkflowState.Fixing]: "fixing",
  [WorkflowState.SecurityReview]: "security_review",
  [WorkflowState.FinalGate]: "final_gate",
  [WorkflowState.FinalSummary]: "final_summary",
  [WorkflowState.AwaitingPushApproval]: undefined,
  [WorkflowState.Committing]: undefined,
  [WorkflowState.Pushing]: undefined,
  [WorkflowState.Complete]: undefined,
  [WorkflowState.Failed]: undefined,
};

export const HUMAN_ACTION_BY_STATE: Readonly<Record<WorkflowState, HumanAction | undefined>> = {
  [WorkflowState.AwaitingPlanApproval]: "approve_plan",
  [WorkflowState.AwaitingPushApproval]: "approve_push",
  [WorkflowState.Draft]: undefined,
  [WorkflowState.Grilling]: undefined,
  [WorkflowState.SpecReady]: undefined,
  [WorkflowState.Planning]: undefined,
  [WorkflowState.PlanReview]: undefined,
  [WorkflowState.Implementing]: undefined,
  [WorkflowState.CodeReview]: undefined,
  [WorkflowState.ScopeReview]: undefined,
  [WorkflowState.StaticVerification]: undefined,
  [WorkflowState.TestVerification]: undefined,
  [WorkflowState.RuntimeVerification]: undefined,
  [WorkflowState.Fixing]: undefined,
  [WorkflowState.SecurityReview]: undefined,
  [WorkflowState.FinalGate]: undefined,
  [WorkflowState.FinalSummary]: undefined,
  [WorkflowState.Committing]: undefined,
  [WorkflowState.Pushing]: undefined,
  [WorkflowState.Complete]: undefined,
  [WorkflowState.Failed]: undefined,
};

export const PASSIVE_ADVANCE_STATES: ReadonlySet<WorkflowState> = new Set([
  WorkflowState.Draft,
  WorkflowState.SpecReady,
]);

export const DEFERRED_WORK_STATES: ReadonlySet<WorkflowState> = new Set([
  WorkflowState.Committing,
  WorkflowState.Pushing,
]);

export function isTerminalState(state: WorkflowState): boolean {
  return state === WorkflowState.Complete || state === WorkflowState.Failed;
}

export function isWorkStage(value: unknown): value is WorkStage {
  return typeof value === "string" && WORK_STAGES.some((stage) => stage === value);
}

export function stageForState(state: WorkflowState): WorkStage | undefined {
  return STAGE_BY_STATE[state];
}

export function humanActionForState(state: WorkflowState): HumanAction | undefined {
  return HUMAN_ACTION_BY_STATE[state];
}

export function outputSpecFor(stage: WorkStage, name: FeatureArtifactName): StageArtifactOutputSpec {
  const outputs = STAGE_DEFINITIONS[stage].outputs;
  const match = outputs.find((output) => output.name === name);

  if (match === undefined) {
    throw new TypeError(`Stage "${stage}" has no output slot for artifact "${name}".`);
  }

  return match;
}

export function fixReportArtifact(fixReturnState: FixReturnState): FeatureArtifactName {
  switch (fixReturnState) {
    case WorkflowState.PlanReview:
      return "plan_review";
    case WorkflowState.CodeReview:
      return "code_review";
    case WorkflowState.ScopeReview:
      return "scope_review";
    case WorkflowState.StaticVerification:
    case WorkflowState.TestVerification:
    case WorkflowState.RuntimeVerification:
      return "verification";
    case WorkflowState.SecurityReview:
      return "security_review";
  }
}

function fixingContextPlan(fixReturnState: FixReturnState): StageContextPlan {
  switch (fixReturnState) {
    case WorkflowState.PlanReview:
      return {
        required: ["plan", "plan_review"],
        optional: ["spec"],
      };
    case WorkflowState.CodeReview:
      return {
        required: ["spec", "plan", "implementation", "code_review"],
        optional: ["scope_review", "verification"],
      };
    case WorkflowState.ScopeReview:
      return {
        required: ["spec", "plan", "implementation", "scope_review"],
        optional: ["code_review", "verification"],
      };
    case WorkflowState.StaticVerification:
    case WorkflowState.TestVerification:
    case WorkflowState.RuntimeVerification:
      return {
        required: ["spec", "plan", "implementation", "verification"],
        optional: ["code_review", "scope_review"],
      };
    case WorkflowState.SecurityReview:
      return {
        required: ["spec", "plan", "implementation", "security_review"],
        optional: ["code_review", "scope_review", "verification"],
      };
  }
}

export function resolveStageContextPlan(
  stage: WorkStage,
  fixReturnState: FixReturnState | undefined,
): StageContextPlan | null {
  if (stage !== "fixing") {
    return STAGE_DEFINITIONS[stage].context;
  }

  if (fixReturnState === undefined) {
    return null;
  }

  return fixingContextPlan(fixReturnState);
}
