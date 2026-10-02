export type OrchestrationFailureClass =
  | "none"
  | "workflow"
  | "executor"
  | "persistence"
  | "verification"
  | "security"
  | "workspace";

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
  | "fix_attempts_exhausted"
  | "fix_protected_file_touched"
  | "fix_check_removed"
  | "fix_target_modified"
  | "fix_verification_config_modified"
  | "fix_outside_approved_scope"
  | "missing_context_artifact"
  | "unmergeable_artifact"
  | "inconsistent_fix_state"
  | "revision_conflict"
  | "approval_missing"
  | "approval_invalidated"
  | "approval_evidence_missing"
  | "verification_not_configured"
  | "verification_provider_failed"
  | "verification_evidence_invalid"
  | "verification_evidence_mismatch"
  | "stale_verification_evidence"
  | "final_gate_blocked"
  | "final_gate_not_recorded"
  | "final_gate_evidence_stale"
  | "push_approval_stale"
  | "push_approval_already_granted"
  | "security_not_configured"
  | "security_provider_failed"
  | "security_evidence_invalid"
  | "security_evidence_mismatch"
  | "stale_security_evidence"
  | "workspace_not_configured"
  | "workspace_unavailable"
  | "workspace_baseline_missing"
  | "workspace_lease_unavailable"
  | "workspace_dirty_baseline"
  | "scope_violation"
  | "scope_expansion_required"
  | "scope_restoration_unsafe"
  | "repository_state_changed"
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
    fix_attempts_exhausted: "workflow",
    fix_protected_file_touched: "workflow",
    fix_check_removed: "workflow",
    fix_target_modified: "workflow",
    fix_verification_config_modified: "workflow",
    fix_outside_approved_scope: "workflow",
    missing_context_artifact: "workflow",
    unmergeable_artifact: "persistence",
    inconsistent_fix_state: "workflow",
    revision_conflict: "persistence",
    approval_missing: "workflow",
    approval_invalidated: "workflow",
    approval_evidence_missing: "workflow",
    verification_not_configured: "verification",
    verification_provider_failed: "verification",
    verification_evidence_invalid: "verification",
  verification_evidence_mismatch: "verification",
  stale_verification_evidence: "verification",
  final_gate_blocked: "workflow",
    final_gate_not_recorded: "workflow",
    final_gate_evidence_stale: "workspace",
    push_approval_stale: "workflow",
    push_approval_already_granted: "workflow",
  security_not_configured: "security",
  security_provider_failed: "security",
  security_evidence_invalid: "security",
  security_evidence_mismatch: "security",
  stale_security_evidence: "security",
  workspace_not_configured: "workspace",
  workspace_unavailable: "workspace",
  workspace_baseline_missing: "workspace",
  workspace_lease_unavailable: "workspace",
  workspace_dirty_baseline: "workspace",
  scope_violation: "workspace",
  scope_expansion_required: "workspace",
  scope_restoration_unsafe: "workspace",
  repository_state_changed: "workspace",
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
