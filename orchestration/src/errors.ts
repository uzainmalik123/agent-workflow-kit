export type OrchestrationFailureClass = "none" | "workflow" | "executor" | "persistence" | "verification";

export type OrchestrationErrorCode =
  | "stage_reported_failure"
  | "executor_threw"
  | "executor_malformed_result"
  | "executor_workflow_interference"
  | "executor_result_mismatch"
  | "missing_required_artifact"
  | "unexpected_artifact"
  | "duplicate_artifact"
  | "artifacts_not_allowed"
  | "illegal_needs_fix"
  | "illegal_transition"
  | "missing_context_artifact"
  | "unmergeable_artifact"
  | "inconsistent_fix_state"
  | "revision_conflict"
  | "approval_missing"
  | "approval_invalidated"
  | "approval_evidence_missing"
  | "verification_provider_failed"
  | "verification_evidence_invalid"
  | "unhandled_state"
  | "git_integration_deferred"
  | "persistence_transition_committed"
  | "persistence_transition_not_committed"
  | "persistence_transition_superseded"
  | "persistence_verification_failed"
  | "persistence_failed";

export interface OrchestrationError {
  readonly code: OrchestrationErrorCode;
  readonly failureClass: OrchestrationFailureClass;
  readonly message: string;
}

export const ORCHESTRATION_FAILURE_CLASS: Readonly<Record<OrchestrationErrorCode, OrchestrationFailureClass>> =
  {
    stage_reported_failure: "workflow",
    executor_threw: "executor",
    executor_malformed_result: "executor",
    executor_workflow_interference: "executor",
    executor_result_mismatch: "executor",
    missing_required_artifact: "executor",
    unexpected_artifact: "executor",
    duplicate_artifact: "executor",
    artifacts_not_allowed: "executor",
    illegal_needs_fix: "workflow",
    illegal_transition: "workflow",
    missing_context_artifact: "workflow",
    unmergeable_artifact: "persistence",
    inconsistent_fix_state: "workflow",
    revision_conflict: "persistence",
    approval_missing: "workflow",
    approval_invalidated: "workflow",
    approval_evidence_missing: "workflow",
    verification_provider_failed: "verification",
    verification_evidence_invalid: "verification",
    unhandled_state: "workflow",
    git_integration_deferred: "workflow",
    persistence_transition_committed: "persistence",
    persistence_transition_not_committed: "persistence",
    persistence_transition_superseded: "persistence",
    persistence_verification_failed: "persistence",
    persistence_failed: "persistence",
  };

export function orchestrationError(
  code: OrchestrationErrorCode,
  message: string,
): OrchestrationError {
  return { code, failureClass: ORCHESTRATION_FAILURE_CLASS[code], message };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "An unidentified error occurred.";
}
