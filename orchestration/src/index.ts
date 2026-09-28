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
  APPROVED_ARTIFACTS,
  APPROVAL_VERIFIED_STAGES,
  DEFERRED_WORK_STATES,
  fixTriggerArtifact,
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
  ApprovedArtifactName,
  HumanAction,
  StageArtifactOutputKind,
  StageArtifactOutputSpec,
  StageContextPlan,
  StageDefinition,
  StageRole,
  WorkStage,
} from "./stages.js";

export { digestArtifactText } from "./approval.js";
export type { ApprovalOutcome, ApprovalVerification } from "./approval.js";

export { appendFixHistoryEntry } from "./fix-history.js";
export type { FixHistoryOutcome } from "./fix-history.js";

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

export {
  applyDeterministicEvidence,
  bindVerificationEvidenceToRequest,
  CAPABILITY_REASONS,
  CAPABILITY_STATUSES,
  DETERMINISTIC_EVIDENCE_KEY,
  evidenceBlocksSuccess,
  MAX_EVIDENCE_DETAIL_CHARS,
  MAX_EVIDENCE_EXCERPT_CHARS,
  mergeDeterministicEvidence,
  validateVerificationEvidenceBundle,
  VERIFICATION_ARTIFACT_NAME,
  VERIFICATION_CAPABILITIES,
  VERIFICATION_CHECK_STATUSES,
  VERIFICATION_OUTCOMES,
  VERIFICATION_STAGES,
  VERIFICATION_STAGE_BY_WORK_STAGE,
  VERIFICATION_WORK_STAGES,
  verificationEvidenceSummaries,
  verificationFailureFindings,
} from "./verification.js";
export type {
  CapabilityDetection,
  CapabilityReason,
  CapabilityStatus,
  DeterministicEvidenceApplication,
  ProjectProfileSummary,
  VerificationBundleValidation,
  VerificationCapability,
  VerificationCheckStatus,
  VerificationCommandEvidence,
  VerificationEvidenceBundle,
  VerificationOutcome,
  VerificationProvider,
  VerificationRequest,
  VerificationStage,
  ControlPlaneIntegrity,
  WorkspaceIntegrity,
} from "./verification.js";

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
