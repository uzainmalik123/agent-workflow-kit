export {
  isWorkspaceBaseline,
  validateWorkspaceBaseline,
  WorkflowStateMachine,
  WORKSPACE_ACCESS_LEVELS,
  type FixReturnState,
  type ReviewFinding,
  type VerificationEvidence,
  type WorkflowEvent,
  type WorkflowMachineSnapshot,
  type WorkflowState,
  type WorkspaceAccessLevel,
  type WorkspaceBaseline,
} from "@agent-workflow-kit/core";

export {
  APPROVED_ARTIFACTS,
  APPROVAL_VERIFIED_STAGES,
  DEFERRED_WORK_STATES,
  WRITE_CAPABLE_WORK_STAGES,
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
  StageWorkspaceContext,
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

export {
  approvedScopeFromPlan,
  BASELINE_REFUSAL_CODES,
  evaluateWorkspaceIntegrity,
  evaluateWorkspaceScope,
  isEmptyWorkspaceChanges,
  isProtectedWorkspacePath,
  matchesScopePattern,
  normalizeScopePattern,
  WORKSPACE_PROTECTED_PATTERNS,
  WORKSPACE_REFUSAL_CODES,
} from "./workspace.js";
export type {
  ApprovedScopeOutcome,
  BaselineCapture,
  BaselineCaptureOutcome,
  BaselineRefusalCode,
  EnforceScopeOutcome,
  EnforceScopeRequest,
  InspectWorkspaceOutcome,
  InspectWorkspaceRequest,
  OpenWorkspaceOutcome,
  OpenWorkspaceRequest,
  ProjectWorkspace,
  ProjectWorkspaceProvider,
  ScopeEnforcement,
  WorkspaceAccess,
  WorkspaceChanges,
  WorkspaceGitState,
  WorkspaceInspection,
  WorkspaceIntegrityVerdict,
  WorkspaceRename,
  WorkspaceScopeEvidence,
  WorkspaceScopePolicy,
  WorkspaceScopeVerdict,
  WorkspaceUnauthorizedPath,
  WorkspaceRefusalCode,
} from "./workspace.js";

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

export { createWorkflowOrchestrator, workspaceIdFor, WorkflowOrchestrator } from "./orchestrator.js";
export type {
  CreateFeatureInput,
  WorkflowOrchestratorOptions,
} from "./orchestrator.js";
