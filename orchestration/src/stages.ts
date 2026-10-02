import {
  WorkflowState,
  type FixReturnState,
  type WorkflowEvent,
  type WorkspaceAccessLevel,
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

export type StageArtifactOutputKind = "document" | "section" | "history";

export interface StageArtifactOutputSpec {
  readonly name: FeatureArtifactName;
  /**
   * `document` replaces the file, `section` merges into a shared envelope under its own key, and
   * `history` appends to an orchestrator-owned history document. The executor never chooses a
   * filename and never decides how a shared file is merged.
   */
  readonly kind: StageArtifactOutputKind;
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
  /**
   * What the stage is allowed to do to the files in its working directory.
   *
   * This is a framework decision, not a role's self-description, and it is the same fact the OpenCode
   * adapter encodes as a read-only or write-capable role. It is duplicated here on purpose: the
   * orchestration layer has to choose a directory and an enforcement policy before any adapter is
   * involved, and a stage that is refused write access must be refused it even if the adapter that
   * would have run it were misconfigured to allow writes.
   *
   * A stage marked `read_only` is still scope-checked after it runs. A reviewer that rewrote a file
   * is a violation of the same approved-scope rule an implementer would violate, and the difference
   * is which report says so.
   */
  readonly access: WorkspaceAccessLevel;
}

function document(name: FeatureArtifactName): StageArtifactOutputSpec {
  return { name, kind: "document", envelopeKey: null };
}

function section(name: FeatureArtifactName, envelopeKey: string): StageArtifactOutputSpec {
  return { name, kind: "section", envelopeKey };
}

function history(name: FeatureArtifactName): StageArtifactOutputSpec {
  return { name, kind: "history", envelopeKey: null };
}

export const STAGE_DEFINITIONS: Readonly<Record<WorkStage, StageDefinition>> = {
  grill: {
    stage: "grill",
    access: "read_only",
    state: WorkflowState.Grilling,
    role: "griller",
    outputs: [document("grill"), document("spec")],
    context: { required: [], optional: ["request"] },
    successEvent: "advance",
    fixable: false,
  },
  planning: {
    stage: "planning",
    access: "read_only",
    state: WorkflowState.Planning,
    role: "planner",
    outputs: [document("plan")],
    context: { required: ["grill", "spec"], optional: ["request"] },
    successEvent: "advance",
    fixable: false,
  },
  plan_review: {
    stage: "plan_review",
    access: "read_only",
    state: WorkflowState.PlanReview,
    role: "plan_reviewer",
    outputs: [document("plan_review")],
    context: { required: ["spec", "plan"], optional: ["request"] },
    successEvent: "advance",
    fixable: true,
  },
  implementation: {
    stage: "implementation",
    access: "read_write",
    state: WorkflowState.Implementing,
    role: "implementer",
    outputs: [document("implementation")],
    context: { required: ["spec", "plan"], optional: ["plan_review"] },
    successEvent: "advance",
    fixable: false,
  },
  code_review: {
    stage: "code_review",
    access: "read_only",
    state: WorkflowState.CodeReview,
    role: "code_reviewer",
    outputs: [document("code_review")],
    context: { required: ["spec", "plan", "implementation"], optional: ["plan_review"] },
    successEvent: "advance",
    fixable: true,
  },
  scope_review: {
    stage: "scope_review",
    access: "read_only",
    state: WorkflowState.ScopeReview,
    role: "scope_reviewer",
    outputs: [document("scope_review")],
    context: { required: ["plan", "implementation"], optional: ["spec", "plan_review"] },
    successEvent: "advance",
    fixable: true,
  },
  static_verification: {
    stage: "static_verification",
    access: "read_only",
    state: WorkflowState.StaticVerification,
    role: "verifier",
    outputs: [section("verification", "static_verification")],
    context: {
      required: ["spec", "plan", "implementation"],
      optional: ["verification", "fixes"],
    },
    successEvent: "advance",
    fixable: true,
  },
  test_verification: {
    stage: "test_verification",
    access: "read_only",
    state: WorkflowState.TestVerification,
    role: "verifier",
    outputs: [section("verification", "test_verification")],
    context: {
      required: ["spec", "plan", "implementation"],
      optional: ["verification", "fixes"],
    },
    successEvent: "advance",
    fixable: true,
  },
  runtime_verification: {
    stage: "runtime_verification",
    access: "read_only",
    state: WorkflowState.RuntimeVerification,
    role: "verifier",
    outputs: [section("verification", "runtime_verification")],
    context: {
      required: ["spec", "plan", "implementation"],
      optional: ["verification", "fixes"],
    },
    successEvent: "advance",
    fixable: true,
  },
  fixing: {
    stage: "fixing",
    access: "read_write",
    state: WorkflowState.Fixing,
    role: "fixer",
    outputs: [history("fixes")],
    context: { required: [], optional: [] },
    successEvent: "complete_fix",
    fixable: false,
  },
  security_review: {
    stage: "security_review",
    access: "read_only",
    state: WorkflowState.SecurityReview,
    role: "security_reviewer",
    outputs: [document("security_review")],
    context: {
      required: ["spec", "plan", "implementation", "verification"],
      optional: ["code_review", "scope_review", "fixes"],
    },
    successEvent: "advance",
    fixable: true,
  },
  final_gate: {
    stage: "final_gate",
    access: "read_only",
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
      optional: ["fixes"],
    },
    successEvent: "advance",
    fixable: false,
  },
  /**
   * The summary is written by the framework, not by the role.
   *
   * The summarizer still runs, read-only, with the same context it always had — it is the stage that
   * can see that a plan step is only half implemented, and its judgement is worth having. What it no
   * longer does is write `final-summary.md`. A document a human approves publishing is the framework's
   * own reading of records it wrote and measured, so this stage declares no output slot at all and the
   * orchestrator composes the artifact from the recorded gate in `prepare`, where it is composed from
   * the same commit that writes it. See `buildFinalSummary` in `final-summary.ts`.
   */
  final_summary: {
    stage: "final_summary",
    access: "read_only",
    state: WorkflowState.FinalSummary,
    role: "summarizer",
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
      optional: ["fixes"],
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

/**
 * Stages that may only run against the plan, spec, and plan review a human approved. Every one
 * of them is re-verified against the approval checkpoint before the executor is called.
 */
export const APPROVAL_VERIFIED_STAGES: ReadonlySet<WorkStage> = new Set<WorkStage>([
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

/**
 * Whether a stage runs against an approved plan, which is what decides where its work lands. A stage
 * that does is given an isolated workspace forked from the approved commit; one that does not reads
 * the human's own checkout and is held to not writing to it at all.
 *
 * Almost every stage belongs to exactly one of the two — verification happens after approval, spec
 * and plan before it — but a fix belongs to whichever loop sent it there, so the answer is not a
 * property of the stage alone. A fix sent back from `plan_review` has no approval behind it and must
 * stay read-only in the human's checkout. A fix sent back from `static_verification` has one, and it
 * must write into an isolated worktree: that is the only way its changes are attributable to the fix
 * rather than to whatever the human happened to have uncommitted at the time.
 */
export function isApprovalVerifiedStage(stage: WorkStage, approvedPlanExists: boolean): boolean {
  if (APPROVAL_VERIFIED_STAGES.has(stage)) {
    return true;
  }

  return stage === "fixing" && approvedPlanExists;
}

/**
 * Stages that are allowed to change files.
 *
 * Every other stage runs with read-only access to its working directory. The set exists so the
 * framework can state the whole write surface of a workflow in one place instead of inferring it
 * from role names in three different layers.
 */
export const WRITE_CAPABLE_WORK_STAGES: ReadonlySet<WorkStage> = new Set<WorkStage>(
  (Object.keys(STAGE_DEFINITIONS) as WorkStage[]).filter(
    (stage) => STAGE_DEFINITIONS[stage].access === "read_write",
  ),
);

/** The artifacts a plan approval freezes. */
export const APPROVED_ARTIFACTS = [
  "spec",
  "plan",
  "plan_review",
] as const satisfies readonly FeatureArtifactName[];

export type ApprovedArtifactName = (typeof APPROVED_ARTIFACTS)[number];

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

/**
 * The artifact a fixer must read to understand why it was invoked. The fixer's own report goes to
 * the durable fix history instead.
 */
export function fixTriggerArtifact(fixReturnState: FixReturnState): FeatureArtifactName {
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
