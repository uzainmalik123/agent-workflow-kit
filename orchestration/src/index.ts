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
  isApprovalVerifiedStage,
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

export { appendFixHistoryEntry, parseFixHistory } from "./fix-history.js";
export type { FixAttemptRecord, FixHistoryOutcome, FixHistoryRead } from "./fix-history.js";

export {
  evaluateFixIntegrity,
  failureReasonFrom,
  failureTargetFrom,
  fixAttemptsExhausted,
  fixRejected,
  FIX_PROTECTED_PATTERNS,
  FIX_REJECTION_CODES,
  isVerificationCheckPath,
  latestFixEntry,
  latestRecordedEvidence,
  MAX_FIX_ATTEMPTS,
  nextFixAttempt,
  resolveMaxFixAttempts,
  staleVerificationEvidence,
  suspectedFilesFrom,
  verificationConfigurationDigest,
  verificationConfigurationText,
  verificationForOrigin,
  VERIFICATION_CHECK_PATH_PATTERNS,
  workStageForOrigin,
} from "./fix-policy.js";
export type {
  FixFailureTarget,
  FixIntegrityInput,
  FixIntegritySnapshot,
  FixIntegrityVerdict,
  FixRejection,
  FixRejectionCode,
  FixerInputContract,
} from "./fix-policy.js";

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
  deferredRuntimeBlocksSuccess,
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
  DEFAULT_RUNTIME_CHECK_TIMEOUT_MS,
  DEFAULT_RUNTIME_READINESS_POLL_MS,
  DEFAULT_RUNTIME_TIMEOUT_MS,
  READINESS_FAILURE_REASONS,
  RUNTIME_CHECK_KINDS,
  RUNTIME_CHECK_REASONS,
  RUNTIME_HTTP_METHODS,
  RUNTIME_VERIFICATION_STATUSES,
} from "./runtime-verification.js";
export type {
  RuntimeCheckConfiguration,
  RuntimeCheckEvidence,
  RuntimeCheckKind,
  RuntimeCheckReason,
  RuntimeCommandConfiguration,
  RuntimeHttpCheckConfiguration,
  RuntimeHttpMethod,
  RuntimeProcessDiagnostics,
  RuntimeProcessStartCheckConfiguration,
  RuntimeReadinessConfiguration,
  RuntimeReadinessEvidence,
  RuntimeVerificationConfiguration,
  RuntimeVerificationDiagnostics,
  RuntimeVerificationProvider,
  RuntimeVerificationRequest,
  RuntimeVerificationResult,
  RuntimeVerificationStatus,
} from "./runtime-verification.js";

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
  FixOutcomeSummary,
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
