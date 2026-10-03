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
  | "publisher_not_configured"
  | "publish_not_approved"
  | "publish_state_invalid"
  | "publish_already_published"
  | "publish_summary_mismatch"
  | "publish_approval_stale"
  | "publish_fix_unresolved"
  | "publish_record_missing"
  | "publish_record_invalid"
  | "publish_commit_message_invalid"
  | "publish_change_set_empty"
  | "publish_scope_violation"
  | "publish_tree_changed"
  | "publish_path_unsafe"
  | "publish_branch_unsafe"
  | "publish_branch_conflict"
  | "publish_branch_failed"
  | "publish_identity_unconfigured"
  | "publish_commit_failed"
  | "publish_commit_missing"
  | "publish_branch_moved"
  | "publish_remote_unavailable"
  | "publish_push_rejected"
  | "publish_publisher_failed"
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
  publisher_not_configured: "workflow",
  publish_not_approved: "workflow",
  publish_state_invalid: "workflow",
  publish_already_published: "workflow",
  publish_summary_mismatch: "workflow",
  publish_approval_stale: "workflow",
  publish_fix_unresolved: "workflow",
  publish_record_missing: "workflow",
  publish_record_invalid: "workflow",
  publish_commit_message_invalid: "workflow",
  publish_change_set_empty: "workflow",
  publish_scope_violation: "workspace",
  publish_tree_changed: "workspace",
  publish_path_unsafe: "workspace",
  publish_branch_unsafe: "workspace",
  publish_branch_conflict: "workspace",
  publish_branch_failed: "workspace",
  publish_identity_unconfigured: "workspace",
  publish_commit_failed: "workspace",
  publish_commit_missing: "workspace",
  publish_branch_moved: "workspace",
  publish_remote_unavailable: "workspace",
  publish_push_rejected: "workspace",
  publish_publisher_failed: "workspace",
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
