export {
  WorkflowStateMachine,
  type FixReturnState,
  type ReviewFinding,
  type VerificationEvidence,
  type WorkflowEvent,
  type WorkflowMachineSnapshot,
  type WorkflowState,
} from "@agent-workflow-kit/core";

export {
  DEFERRED_WORK_STATES,
  fixReportArtifact,
  humanActionForState,
  HUMAN_ACTIONS,
  isTerminalState,
  isWorkStage,
  outputSpecFor,
  PASSIVE_ADVANCE_STATES,
  resolveStageContextPlan,
  STAGE_BY_STATE,
  STAGE_DEFINITIONS,
  stageForState,
  STAGE_ROLES,
  WORK_STAGES,
} from "./stages.js";
export type {
  HumanAction,
  StageArtifactOutputSpec,
  StageContextPlan,
  StageDefinition,
  StageRole,
  WorkStage,
} from "./stages.js";

export { isStageOutcome, STAGE_OUTCOMES } from "./executor.js";
export type {
  StageArtifactContext,
  StageArtifactOutput,
  StageExecutionRequest,
  StageExecutionResult,
  StageExecutor,
  StageFeatureContext,
  StageOutcome,
} from "./executor.js";

export { validateStageExecutionResult } from "./result-validation.js";
export type { StageResultValidation } from "./result-validation.js";

export { buildOrchestrationResult, ORCHESTRATION_STATUSES } from "./result.js";
export type {
  OrchestrationResult,
  OrchestrationResultInput,
  OrchestrationStatus,
} from "./result.js";

export { orchestrationError, ORCHESTRATION_FAILURE_CLASS } from "./errors.js";
export type {
  OrchestrationError,
  OrchestrationErrorCode,
  OrchestrationFailureClass,
} from "./errors.js";

export { createWorkflowOrchestrator, WorkflowOrchestrator } from "./orchestrator.js";
export type {
  CreateFeatureInput,
  WorkflowOrchestratorOptions,
} from "./orchestrator.js";
