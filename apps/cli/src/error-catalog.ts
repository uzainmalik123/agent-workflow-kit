/**
 * One catalog for every refusal, failure, blocked, or inconclusive message the CLI prints (D-20).
 *
 * Location: apps/cli, not orchestration, because these strings are presentation. The CLI owns
 * printing; orchestration owns the state machine, evidence, and approvals and must stay
 * behavior-free under R-263. The CLI already depends on orchestration, project, and opencode
 * types, so no new cross-package dependency is introduced and no workflow behavior changes here.
 * D-19 evidence behavior (skipped vs blocked) lives in adapters/project, not here.
 *
 * Every entry has four parts: (1) what happened, (2) why naming the real cause, (3) how to fix
 * with the exact command or edit, (4) where the evidence is (a file path), plus the next command.
 * The raw code appears in parentheses so it can be searched. "Unknown error" is never emitted;
 * when the cause is not determined the message says "cause not determined" and gives the evidence
 * path and the status command for the feature. Lines are wrapped (never truncated) and control characters
 * are stripped.
 *
 * Sources (read, not assumed):
 * - OrchestrationErrorCode: orchestration/src/errors.ts:10-88 (78 members; failure classes at
 *   orchestration/src/errors.ts:96-176). Refusal sites sampled: orchestration/src/orchestrator.ts
 *   (illegal_transition at :566, workspace_unavailable capture at :748-772, dirty baseline via
 *   dirtyBaselineError at :369-376 mapped to workspace_dirty_baseline, executor_threw at :1904,
 *   final_gate_blocked at :1781, publish_* across :963-1388), orchestration/src/fix-policy.ts:397-423
 *   (fix_attempts_exhausted, fixRejected), orchestration/src/approval.ts (approval_*),
 *   orchestration/src/verification.ts and security.ts (verification and security validation codes).
 *   Where the cause genuinely cannot be known from the source, the why says so and the Detail
 *   line carries the orchestrator's message.
 * - CAPABILITY_REASONS: orchestration/src/verification.ts:66-78; usages in
 *   adapters/project/src/node-adapter.ts:80-142, adapters/project/src/profile.ts:162-213,
 *   adapters/project/src/provider.ts:131-170.
 * - OpenCode codes: adapters/opencode/src/errors.ts:1-15 (14 members); transport_timeout +
 *   non_zero_exit + transport_cancelled + output_truncated in adapters/opencode/src/process.ts:12
 *   and adapters/opencode/src/executor.ts:419,424-429; empty/malformed/invalid in
 *   adapters/opencode/src/executor.ts:432-465 and
 *   adapters/opencode/src/response-protocol.ts:64-152; opencode_configuration_tampered in
 *   adapters/opencode/src/configuration-integrity.ts and runtime-config.ts:579;
 *   unknown_role/role_mismatch in adapters/opencode/src/executor.ts:364-413;
 *   transport_failed in adapters/opencode/src/cli-transport.ts:116,377,392,399;
 *   unsafe_output_path in adapters/opencode/src/agents.ts:293-380;
 *   project_plugin_detected in adapters/opencode/src/plugin-preflight.ts:108,155,237,432;
 *   workspace_mismatch in adapters/opencode/src/executor.ts:517.
 * - Project codes: adapters/project/src/errors.ts:8-16 (8 members); thrown in
 *   adapters/project/src/fs-safe.ts:111-124 (manifest_unreadable), adapters/project/src/profile.ts:340
 *   (root_unavailable), config/command/fingerprint paths in adapters/project/src/config.ts,
 *   commands.ts, fingerprint.ts.
 * - Baseline refusals: orchestration/src/workspace.ts:201-207 (4 members, includes
 *   tracked_workspace_dirty); raised in adapters/workspace/src/provider.ts:138-150
 *   (tracked_workspace_dirty).
 * - Workspace refusals: orchestration/src/workspace.ts:239-251 (10 members); raised in
 *   adapters/workspace/src/provider.ts:160-419 and mapped in :727-746 (refusalFor).
 * - CLI statuses the run loop prints: apps/cli/src/commands.ts:1059-1068 (rejected,
 *   executor_error, stage_failed, feature_failed, inconclusive, scope_violation, conflict,
 *   persistence_error) with shapes in orchestration/src/result.ts:18-36.
 *   apps/cli/src/commands.ts:1013-1031 (run loop statuses),
 *   orchestration/README.md:253/279/341 (illegal_transition, approval_evidence_missing,
 *   workspace_not_configured).
 *
 * Exhaustiveness: each group below is a Record keyed by its real union, so adding a code to the
 * source union without adding a message here fails `pnpm typecheck` / the build. The combined
 * CATALOG is typed Record<CatalogCode, ...> for the same reason.
 */

import type {
  BaselineRefusalCode,
  CapabilityReason,
  OrchestrationErrorCode,
  WorkspaceRefusalCode,
} from "@agent-workflow-kit/orchestration";
import { stripAnsiCodes } from "@agent-workflow-kit/opencode";
import type { OpenCodeAdapterErrorCode } from "@agent-workflow-kit/opencode";
import type { ProjectAdapterErrorCode } from "@agent-workflow-kit/project";

/** CLI run-loop statuses printed via the catalog fallback path (not orchestration error codes). */
export const CLI_STATUS_CODES = [
  "executor_error",
  "stage_failed",
  "inconclusive",
  "rejected",
  "conflict",
  "persistence_error",
  "feature_failed",
] as const;

export type CliStatusCode = (typeof CLI_STATUS_CODES)[number];

/** Every code the CLI can render through the catalog. */
export type CatalogCode =
  | OrchestrationErrorCode
  | CapabilityReason
  | OpenCodeAdapterErrorCode
  | ProjectAdapterErrorCode
  | BaselineRefusalCode
  | WorkspaceRefusalCode
  | CliStatusCode;

export type CapabilityReasonCode = CapabilityReason;
export type OpenCodeErrorCode = OpenCodeAdapterErrorCode;
export type ProjectErrorCode = ProjectAdapterErrorCode;
export type OrchestrationStatusCode =
  | "scope_violation"
  | "executor_error"
  | "stage_failed"
  | "inconclusive"
  | "illegal_transition"
  | "approval_evidence_missing"
  | "tracked_workspace_dirty"
  | "workspace_not_configured"
  | "fix_attempts_exhausted"
  | "fix_target_modified"
  | "fix_outside_approved_scope";

/** Legacy tuple exports kept for existing importers; prefer the union types above. */
export const CAPABILITY_REASON_CODES: readonly CapabilityReason[] = [
  "detected",
  "script_absent",
  "configured",
  "language_without_typecheck",
  "ecosystem_unsupported",
  "not_configured",
  "dependency_missing",
  "package_manager_unknown",
  "runtime_deferred",
];

export const OPENCODE_ERROR_CODES: readonly OpenCodeAdapterErrorCode[] = [
  "unknown_role",
  "role_mismatch",
  "transport_failed",
  "transport_timeout",
  "transport_cancelled",
  "non_zero_exit",
  "output_truncated",
  "empty_response",
  "malformed_response",
  "invalid_result",
  "unsafe_output_path",
  "project_plugin_detected",
  "opencode_configuration_tampered",
  "workspace_mismatch",
];

export const ORCHESTRATION_STATUS_CODES = [
  "scope_violation",
  "executor_error",
  "stage_failed",
  "inconclusive",
  "illegal_transition",
  "approval_evidence_missing",
  "tracked_workspace_dirty",
  "workspace_not_configured",
  "fix_attempts_exhausted",
  "fix_target_modified",
  "fix_outside_approved_scope",
] as const;

export const ALL_CATALOG_CODES: readonly CatalogCode[] = [
  ...CAPABILITY_REASON_CODES,
  ...OPENCODE_ERROR_CODES,
  "stage_reported_failure",
  "executor_threw",
  "executor_malformed_result",
  "executor_workflow_interference",
  "executor_result_mismatch",
  "missing_required_artifact",
  "unexpected_artifact",
  "duplicate_artifact",
  "artifacts_not_allowed",
  "illegal_needs_fix",
  "illegal_transition",
  "fix_attempts_exhausted",
  "fix_protected_file_touched",
  "fix_check_removed",
  "fix_target_modified",
  "fix_verification_config_modified",
  "fix_outside_approved_scope",
  "missing_context_artifact",
  "unmergeable_artifact",
  "inconsistent_fix_state",
  "revision_conflict",
  "approval_missing",
  "approval_invalidated",
  "approval_evidence_missing",
  "verification_not_configured",
  "verification_provider_failed",
  "verification_evidence_invalid",
  "verification_evidence_mismatch",
  "stale_verification_evidence",
  "final_gate_blocked",
  "final_gate_not_recorded",
  "final_gate_evidence_stale",
  "push_approval_stale",
  "push_approval_unverified_runtime",
  "push_approval_already_granted",
  "publisher_not_configured",
  "publish_not_approved",
  "publish_state_invalid",
  "publish_already_published",
  "publish_summary_mismatch",
  "publish_approval_stale",
  "publish_fix_unresolved",
  "publish_record_missing",
  "publish_record_invalid",
  "publish_commit_message_invalid",
  "publish_change_set_empty",
  "publish_scope_violation",
  "publish_tree_changed",
  "publish_path_unsafe",
  "publish_branch_unsafe",
  "publish_branch_conflict",
  "publish_branch_failed",
  "publish_identity_unconfigured",
  "publish_commit_failed",
  "publish_commit_missing",
  "publish_branch_moved",
  "publish_remote_unavailable",
  "publish_push_rejected",
  "publish_publisher_failed",
  "security_not_configured",
  "security_provider_failed",
  "security_evidence_invalid",
  "security_evidence_mismatch",
  "stale_security_evidence",
  "workspace_not_configured",
  "workspace_unavailable",
  "workspace_baseline_missing",
  "workspace_lease_unavailable",
  "workspace_dirty_baseline",
  "scope_violation",
  "scope_expansion_required",
  "scope_restoration_unsafe",
  "repository_state_changed",
  "unhandled_state",
  "persistence_transition_committed",
  "persistence_transition_not_committed",
  "persistence_transition_superseded",
  "persistence_verification_failed",
  "persistence_failed",
  "root_unavailable",
  "unsafe_path",
  "manifest_unreadable",
  "manifest_malformed",
  "config_invalid",
  "command_invalid",
  "command_forbidden",
  "fingerprint_failed",
  "not_a_git_repository",
  "head_unborn",
  "tracked_workspace_dirty",
  "repository_unreadable",
  "baseline_missing",
  "repository_unavailable",
  "head_changed",
  "workspace_metadata_missing",
  "workspace_metadata_corrupt",
  "workspace_registered_elsewhere",
  "workspace_path_occupied",
  "workspace_failed",
  "lease_unavailable",
  "executor_error",
  "stage_failed",
  "inconclusive",
  "rejected",
  "conflict",
  "persistence_error",
  "feature_failed",
];

export interface CatalogContext {
  readonly featureId?: string;
  /** Human-readable detail from the check/error, when one was recorded. */
  readonly detail?: string | null;
  /** File or folder path where the evidence lives, when the caller knows it. */
  readonly evidencePath?: string | null;
  /** Capability or check id, for verification messages. */
  readonly checkId?: string | null;
  /** Workflow stage the message is about, for recording and evidence paths. */
  readonly stage?: string | null;
}

interface CatalogEntry {
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly evidence: string;
  readonly next: string;
}

type CatalogBuilder = (context: CatalogContext) => CatalogEntry;

function statusOf(context: CatalogContext): string {
  // No literal "<id>" placeholder may reach a printed message: without a real feature id the
  // command is stated without one rather than with a placeholder.
  return context.featureId === undefined ? "agentflow status" : `agentflow status ${context.featureId}`;
}

/**
 * Replaces the `<id>` and `<stage>` placeholders with the real feature id and stage, so no printed
 * message contains a literal "<id>" or "<stage>". Unknown values read as "unknown" rather than as
 * a placeholder.
 */
function interpolatePlaceholders(text: string, context: CatalogContext): string {
  return text
    .replaceAll("<id>", context.featureId ?? "unknown")
    .replaceAll("<stage>", context.stage ?? "unknown");
}

function evidenceOf(context: CatalogContext, fallback: string): string {
  const configured = context.evidencePath ?? fallback;
  return interpolatePlaceholders(configured, context);
}

/** The `agentflow run` command for this feature, with the real id rather than a placeholder. */
function runOf(context: CatalogContext, rest = ""): string {
  const id = context.featureId ?? "unknown";
  return `agentflow run ${id}${rest}`;
}

/** Shorthand for static entries whose text does not depend on context beyond status/run paths. */
function staticEntry(
  what: string,
  why: string,
  fix: (context: CatalogContext) => string,
  evidenceFallback: string,
): CatalogBuilder {
  return (context) => ({
    what,
    why,
    fix: fix(context),
    evidence: evidenceOf(context, evidenceFallback),
    next: statusOf(context),
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Capability reasons: orchestration/src/verification.ts:66-78                                  */
/* ------------------------------------------------------------------------------------------ */

const CAPABILITY_CATALOG: Record<CapabilityReason, CatalogBuilder> = {
  // orchestration/src/verification.ts:67
  detected: (context) => ({
    what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} is applicable and will run`,
    why: "the project manifest declares the script for this capability, so the framework selected it",
    fix: "No fix is needed. To change what runs, edit the script in package.json or declare the command in agent-workflow.config.json",
    evidence: evidenceOf(context, "package.json"),
    next: statusOf(context),
  }),
  // orchestration/src/verification.ts:68; adapters/project/src/node-adapter.ts:84-141
  script_absent: (context) => ({
    what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} was skipped because the project declares nothing for it`,
    why: "the manifest declares no script for this capability, so there is nothing the framework could run without inventing a command",
    fix: 'To verify this capability, add the script to package.json (for example "lint": "eslint .") or declare the command in agent-workflow.config.json under verification.static or verification.test',
    evidence: evidenceOf(context, "package.json"),
    next: statusOf(context),
  }),
  // orchestration/src/verification.ts:69; no detection path in adapters/project sets it as a
  // capability reason, so the cause is not known from the source.
  configured: (context) => {
    const hasDetail =
      context.detail !== undefined && context.detail !== null && context.detail.trim() !== "";
    return {
      what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} refers to project configuration`,
      why: hasDetail
        ? 'the recorded detail below names the project state; the "configured" reason code itself is listed in CAPABILITY_REASONS but no detection path in adapters/project sets it as a capability reason'
        : 'cause not determined: the "configured" reason code is listed in CAPABILITY_REASONS but no detection path in adapters/project sets it as a capability reason, so its real project state is not understood from the source',
      fix: "Inspect package.json and agent-workflow.config.json to see what the project declares for this capability",
      evidence: evidenceOf(context, "agent-workflow.config.json"),
      next: statusOf(context),
    };
  },
  // orchestration/src/verification.ts:70; adapters/project/src/profile.ts:162-190
  language_without_typecheck: (context) => ({
    what: "Typecheck was recorded as not applicable",
    why: "the project declares no TypeScript configuration (tsconfig.json) and no typescript dependency, so the language has no type system to check",
    fix: "No fix is needed for a JavaScript project. To add typechecking, add typescript to devDependencies and a typecheck script, for example npm install --save-dev typescript",
    evidence: evidenceOf(context, "package.json"),
    next: statusOf(context),
  }),
  // orchestration/src/verification.ts:71; adapters/project/src/profile.ts:162-213
  ecosystem_unsupported: (context) => ({
    what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} is unsupported for this ecosystem`,
    why: "the project was recognised as python, rust, java, or unknown from its markers, and this milestone has no adapter that infers commands for it",
    fix: 'Declare the command in agent-workflow.config.json, for example { "schemaVersion": 1, "verification": { "static": [{ "id": "lint", "capability": "lint", "executable": "ruff", "args": ["check"] }] } }',
    evidence: evidenceOf(context, "agent-workflow.config.json"),
    next: statusOf(context),
  }),
  // orchestration/src/verification.ts:72; adapters/project/src/provider.ts:131-170 discovery refusal
  not_configured: (context) => ({
    what: `Verification could not be measured for${context.checkId === undefined || context.checkId === null ? " this capability" : ` "${context.checkId}"`}`,
    why: "the project could not be inspected (unreadable manifest or unsafe path), so no capability could be classified; the refusal code is in the recorded detail",
    fix: "Make package.json readable and not a symlink, then re-run. Check the detail for the refusal code (root_unavailable, manifest_malformed, config_invalid)",
    evidence: evidenceOf(context, "package.json"),
    next: statusOf(context),
  }),
  // orchestration/src/verification.ts:73; adapters/project/src/node-adapter.ts dependency check
  dependency_missing: (context) => ({
    what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} is blocked because dependencies are not installed`,
    why: "the project has no node_modules directory, so a script invoked through the package manager cannot run; nothing is installed automatically",
    fix: "Install dependencies with the project manager, for example pnpm install (or npm install, yarn install, bun install to match the lockfile)",
    evidence: evidenceOf(context, "package.json"),
    next: statusOf(context),
  }),
  // orchestration/src/verification.ts:74; adapters/project/src/node-adapter.ts:80-142
  package_manager_unknown: (context) => ({
    what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} is blocked because the package manager is unknown`,
    why: "this project has no lockfile and no `packageManager` field in package.json, so the framework cannot tell which manager (pnpm, npm, yarn, bun) would run the declared script",
    fix: 'Commit a lockfile (for example npm install --package-lock-only) or set the manager in package.json (for example "packageManager": "pnpm@12.9.1"), or declare the check as a bare tool in agent-workflow.config.json so no manager is needed',
    evidence: evidenceOf(context, "package.json"),
    next: statusOf(context),
  }),
  // orchestration/src/verification.ts:75; adapters/project/src/runtime.ts:280-317
  runtime_deferred: (context) => ({
    what: "Runtime verification was deferred because nothing was declared to run",
    why: "a manifest cannot say how an application starts and this framework never infers one, so no runtime command was planned",
    fix: "Declare the runtime in agent-workflow.config.json under verification.runtime with a command, a readiness url, and checks",
    evidence: evidenceOf(context, "agent-workflow.config.json"),
    next: statusOf(context),
  }),
};

/* ------------------------------------------------------------------------------------------ */
/* OpenCode adapter codes: adapters/opencode/src/errors.ts:1-15                                 */
/* ------------------------------------------------------------------------------------------ */

const OPENCODE_CATALOG: Record<OpenCodeAdapterErrorCode, CatalogBuilder> = {
  // adapters/opencode/src/errors.ts:2; refused when the stage names a role the adapter defines.
  unknown_role: staticEntry(
    "The OpenCode run was refused for an unknown role",
    "cause not determined from the source: the adapter defines the role set and the prompt carries the role, so the recorded detail names which role was requested",
    (context) => `Re-run ${runOf(context)}; if it repeats, inspect the recording manifest for the requested role`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // adapters/opencode/src/errors.ts:3; adapters/opencode/src/executor.ts:364-413
  role_mismatch: staticEntry(
    "The OpenCode run was refused for a role mismatch",
    "the transport answered for a different capability set than the prompt granted, so the reply cannot be attributed to this stage",
    (context) => `Re-run ${runOf(context)} and inspect the recording manifest for the expected and actual agents`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // adapters/opencode/src/errors.ts:4; adapters/opencode/src/cli-transport.ts:116,377,392,399
  transport_failed: staticEntry(
    "The OpenCode transport failed before the stage could run",
    "the opencode child process could not be spawned or failed outside any stage timeout; the detail names the spawn or I/O cause",
    (context) => `Read the recording manifest stderr excerpt, then re-run ${runOf(context)}; if the binary is missing, install OpenCode V2`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // adapters/opencode/src/errors.ts:5; adapters/opencode/src/process.ts:86-189
  transport_timeout: (context) => ({
    what: "The OpenCode stage run timed out",
    why: "the opencode child process exceeded its per-stage time budget and was killed; the budget is the shared runner deadline",
    fix: `Re-run with a larger budget, for example ${runOf(context, " --stage-timeout 1800")}, or reduce what the stage is asked to do`,
    evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
    next: statusOf(context),
  }),
  // adapters/opencode/src/errors.ts:6; adapters/opencode/src/process.ts:12
  transport_cancelled: staticEntry(
    "The OpenCode run was cancelled",
    "the framework cancelled the child process (abort or shutdown) before it completed; nothing about the stage was decided",
    (context) => `Re-run ${runOf(context)}`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // adapters/opencode/src/errors.ts:7; adapters/opencode/src/process.ts:86-189
  non_zero_exit: (context) => ({
    what: "The OpenCode run exited with a non-zero code",
    why: "the opencode CLI process itself failed before any reply could be judged; this is a failed run, not a rejected reply, and it is never retried as a format issue",
    fix: `Read the recording manifest stderr excerpt, then re-run ${runOf(context)}; if the binary is missing, install OpenCode V2`,
    evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
    next: statusOf(context),
  }),
  // adapters/opencode/src/errors.ts:8; adapters/opencode/src/process.ts:12 output ceiling
  output_truncated: staticEntry(
    "The OpenCode run was stopped for exceeding the output ceiling",
    "the child process produced more output than the transport records, so it was stopped rather than trusted partially",
    (context) => `Re-run ${runOf(context)}; if it repeats, reduce what the stage is asked to emit`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // adapters/opencode/src/errors.ts:9; adapters/opencode/src/executor.ts:432-465
  empty_response: (context) => ({
    what: "The OpenCode run returned no response text",
    why: "the agent process exited 0 but produced an empty reply, so there is no fenced JSON block to judge; empty replies are retried up to 2 times",
    fix: `Re-run ${runOf(context)}; if it repeats, inspect the recording stdout.txt for what the model actually emitted`,
    evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
    next: statusOf(context),
  }),
  // adapters/opencode/src/errors.ts:10; adapters/opencode/src/response-protocol.ts:64-152
  malformed_response: (context) => ({
    what: "The OpenCode reply was rejected as malformed",
    why: "the reply had no fenced JSON block, an unclosed fence, invalid JSON, or a missing required field; the contract requires exactly one fenced JSON object",
    fix: `No manual fix is needed for one miss: the stage is retried up to 2 times with a rejection notice. Re-run ${runOf(context)} if all attempts were rejected`,
    evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
    next: statusOf(context),
  }),
  // adapters/opencode/src/errors.ts:11; adapters/opencode/src/executor.ts:432-465
  invalid_result: (context) => ({
    what: "The OpenCode reply failed validation",
    why: "the fenced JSON parsed but carried a workflow control field or failed the stage result schema; an agent may not choose transitions or approvals",
    fix: `No manual fix is needed for one miss: the stage is retried up to 2 times. Re-run ${runOf(context)} if all attempts were rejected`,
    evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
    next: statusOf(context),
  }),
  // adapters/opencode/src/errors.ts:12; adapters/opencode/src/agents.ts:293-380
  unsafe_output_path: staticEntry(
    "The OpenCode run was refused for an unsafe output path",
    "a generated agent or output path escaped the framework-owned directory or resolved through a symlink, so writing it would leave framework control",
    (context) => `Re-run ${runOf(context)}; if it repeats, remove unexpected .opencode paths in the repository and re-run`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // adapters/opencode/src/errors.ts:13; adapters/opencode/src/plugin-preflight.ts:108-432
  project_plugin_detected: staticEntry(
    "The OpenCode run was refused because the repository declares an OpenCode plugin",
    "a repository .opencode plugin, agent id, or instruction source shadows a framework profile, so the run would execute repository-controlled capabilities",
    (context) => `Remove the repository .opencode plugin or shadowing agent id, then re-run ${runOf(context)}`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // adapters/opencode/src/errors.ts:14; adapters/opencode/src/configuration-integrity.ts
  opencode_configuration_tampered: (context) => ({
    what: "The OpenCode run was refused because framework configuration was tampered with",
    why: "a generated agent file or a repository OpenCode boundary (permission, plugin, tool, or instruction source) failed integrity: missing, malformed, or crossed by the repository",
    fix: `Do not hand-edit generated agent files. Re-run ${runOf(context)} to regenerate them outside the repository, and remove any repository .opencode plugin or agent id that shadows a framework profile`,
    evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
    next: statusOf(context),
  }),
  // adapters/opencode/src/errors.ts:15; adapters/opencode/src/executor.ts:517
  workspace_mismatch: staticEntry(
    "The OpenCode run was refused for a workspace mismatch",
    "the invocation resolved to a different working directory than the stage workspace, so the agent would read or write the wrong tree",
    (context) => `Re-run ${runOf(context)}; if it repeats, report the expected and actual directories from the recording manifest`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
};

/* ------------------------------------------------------------------------------------------ */
/* Project adapter codes: adapters/project/src/errors.ts:8-16                                   */
/* ------------------------------------------------------------------------------------------ */

const PROJECT_CATALOG: Record<ProjectAdapterErrorCode, CatalogBuilder> = {
  // adapters/project/src/errors.ts:9; adapters/project/src/profile.ts:340
  root_unavailable: staticEntry(
    "The project could not be inspected because the repository root is unavailable",
    "the configured project root could not be resolved or entered, so no manifest could be read",
    () => "Check that the repository directory exists and is readable, then re-run",
    "package.json",
  ),
  // adapters/project/src/errors.ts:10; adapters/project/src/fs-safe.ts
  unsafe_path: staticEntry(
    "The project refused an unsafe path",
    "a requested path escaped the project root or resolved through a symlink, so reading or running it would leave the project",
    () => "Use a repository-relative path with no `..` segments or symlinks, then re-run",
    "package.json",
  ),
  // adapters/project/src/errors.ts:11; adapters/project/src/fs-safe.ts:111-124
  manifest_unreadable: staticEntry(
    "The project manifest could not be read",
    "package.json exists but is not a readable file (missing, a directory, a symlink, or unreadable), so no capability could be classified",
    () => "Make package.json a readable regular file, then re-run",
    "package.json",
  ),
  // adapters/project/src/errors.ts:12
  manifest_malformed: staticEntry(
    "The project manifest could not be parsed",
    "package.json is readable but is not valid JSON or has an unusable shape, so scripts and the package manager cannot be determined",
    () => "Fix the JSON syntax in package.json (run `node -e \"JSON.parse(require('fs').readFileSync('package.json','utf8'))\"` to check), then re-run",
    "package.json",
  ),
  // adapters/project/src/errors.ts:13; adapters/project/src/config.ts
  config_invalid: staticEntry(
    "The project verification configuration is invalid",
    "agent-workflow.config.json is present but fails schema validation, so declared commands cannot be trusted",
    () => "Validate agent-workflow.config.json against the documented schema and fix the named key, then re-run",
    "agent-workflow.config.json",
  ),
  // adapters/project/src/errors.ts:14; adapters/project/src/commands.ts
  command_invalid: staticEntry(
    "A declared verification command is invalid",
    "a command in agent-workflow.config.json names a missing executable, an absolute path, or unusable arguments, so the framework will not run it",
    () => "Fix the executable and args for the named check in agent-workflow.config.json, then re-run",
    "agent-workflow.config.json",
  ),
  // adapters/project/src/errors.ts:15; adapters/project/src/commands.ts
  command_forbidden: staticEntry(
    "A declared verification command is forbidden",
    "the command resolves to a package-manager mutation verb (install, add, update, remove) or another denied operation, so running it would change the project instead of measuring it",
    () => "Replace the mutating command with a read-only check in agent-workflow.config.json, then re-run",
    "agent-workflow.config.json",
  ),
  // adapters/project/src/errors.ts:16; adapters/project/src/fingerprint.ts
  fingerprint_failed: staticEntry(
    "The implementation fingerprint could not be measured",
    "the working tree could not be hashed (unreadable files or git failure), so evidence cannot be bound to this tree",
    (context) => `Check git status works in the tree, then re-run ${runOf(context)}`,
    ".agentflow/features/<id>/",
  ),
};

/* ------------------------------------------------------------------------------------------ */
/* Orchestration codes: orchestration/src/errors.ts:10-88 (78 members)                          */
/* Each `why` names the real cause where the refusal site states one; otherwise it says the     */
/* cause is not determined from the source and the Detail line carries the report.              */
/* ------------------------------------------------------------------------------------------ */

function orchestrationEntry(
  what: string,
  why: string,
  fix: (context: CatalogContext) => string,
  evidenceFallback = ".agentflow/features/<id>/",
): CatalogBuilder {
  return (context) => ({
    what,
    why,
    fix: fix(context),
    evidence: evidenceOf(context, evidenceFallback),
    next: statusOf(context),
  });
}

const ORCHESTRATION_CATALOG: Record<OrchestrationErrorCode, CatalogBuilder> = {
  // orchestration/src/errors.ts:11
  stage_reported_failure: orchestrationEntry(
    "The stage reported failure",
    "the executor completed the stage and the stage itself reported failed with findings",
    (context) => `Read the findings with the status command, repair the defect, then re-run ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:12; orchestration/src/orchestrator.ts:1904
  executor_threw: orchestrationEntry(
    "The stage executor threw instead of returning a result",
    "the adapter refused or the transport failed (timeout, non-zero exit, tampered config); the workflow records no stage opinion for this run",
    (context) => `Read the recording folder named on stderr, then re-run ${runOf(context)}`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // orchestration/src/errors.ts:13
  executor_malformed_result: orchestrationEntry(
    "The stage executor returned a malformed result",
    "the executor answered with a payload that fails result validation, so the framework cannot tell what the stage decided",
    (context) => `Re-run ${runOf(context)}; if it repeats, inspect the recording for the raw reply`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // orchestration/src/errors.ts:14
  executor_workflow_interference: orchestrationEntry(
    "The stage reply was refused as workflow interference",
    "the reply carried a workflow control field (transition, approval, or state directive) that only the framework may decide",
    (context) => `Re-run ${runOf(context)}; the retry carries a rejection notice naming the forbidden field`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // orchestration/src/errors.ts:15
  executor_result_mismatch: orchestrationEntry(
    "The stage reply was refused for naming another feature or stage",
    "the reply names a feature id or stage different from the one that was invoked, so applying it would attribute work to the wrong place",
    (context) => `Re-run ${runOf(context)}`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // orchestration/src/errors.ts:16
  missing_required_artifact: orchestrationEntry(
    "A required stage artifact is missing",
    "a success or needs_fix response did not fill every output slot the stage definition requires",
    (context) => `Re-run ${runOf(context)}; the response contract lists the required artifact slots`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // orchestration/src/errors.ts:17
  unexpected_artifact: orchestrationEntry(
    "The stage returned an artifact it was not given a slot for",
    "the reply names an artifact outside the stage outputs, so the framework cannot store it",
    (context) => `Re-run ${runOf(context)} with only the listed output slots filled`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // orchestration/src/errors.ts:18
  duplicate_artifact: orchestrationEntry(
    "The stage returned the same artifact twice",
    "the reply lists one artifact name more than once, so the framework cannot tell which content stands",
    (context) => `Re-run ${runOf(context)} with each artifact name at most once`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // orchestration/src/errors.ts:19
  artifacts_not_allowed: orchestrationEntry(
    "The stage returned artifacts it may not produce",
    "this stage has no artifact slot, so any artifact name is rejected",
    (context) => `Re-run ${runOf(context)} with an empty artifacts array`,
    ".agentflow/recordings/<id>/<stage>/",
  ),
  // orchestration/src/errors.ts:20
  illegal_needs_fix: orchestrationEntry(
    "The stage asked for a fix it may not request",
    "needs_fix is available only on fixable stages; this stage must report failed or inconclusive instead",
    (context) => `Re-run ${runOf(context)}; a real defect on this stage is reported as failed`,
  ),
  // orchestration/src/errors.ts:21; orchestration/src/orchestrator.ts:566
  illegal_transition: (context) => ({
    what: "The requested event is not legal in the current workflow state",
    why: "the state machine refused the transition (for example approving a push while still planning); only the machine decides what an event means",
    fix: `Run ${statusOf(context)} to see the current state, then use the command the Next line recommends`,
    evidence: evidenceOf(context, ".agentflow/features/<id>/session.json"),
    next: statusOf(context),
  }),
  // orchestration/src/errors.ts:22; orchestration/src/fix-policy.ts:397-407
  fix_attempts_exhausted: (context) => ({
    what: "The fix loop has used all of its automatic attempts",
    why: "the fixer could not repair the defect within 5 attempts (MAX_FIX_ATTEMPTS); the framework never runs one more than the limit allows",
    fix: "Repair the defect by hand, or amend the approved plan or spec, then start from the human gate",
    evidence: evidenceOf(context, ".agentflow/features/<id>/"),
    next: statusOf(context),
  }),
  // orchestration/src/errors.ts:23; orchestration/src/fix-policy.ts:322-334
  fix_protected_file_touched: orchestrationEntry(
    "A fix attempt was rejected for touching a framework-controlled path",
    "the fix wrote to .git, .agentflow, .opencode, or the verification configuration, which hold the rules the fix is judged by",
    () => "Restore the protected paths, keep the repair inside the implementation, and let a human re-run the fix",
  ),
  // orchestration/src/errors.ts:24; orchestration/src/fix-policy.ts:336-355
  fix_check_removed: orchestrationEntry(
    "A fix attempt was rejected for removing a verification check",
    "the fix deleted or renamed a file that asserts the behavior, which would silence the failure instead of repairing it",
    () => "Restore the deleted check file and repair the implementation instead; a human decides whether a check is obsolete",
  ),
  // orchestration/src/errors.ts:25
  fix_target_modified: (context) => ({
    what: "A fix attempt was rejected for changing what it is judged by",
    why: "the fix changed the digest of the approved spec, plan, or plan review; the fixer may change the implementation and nothing else",
    fix: "Restore the approved files, amend the plan or spec as a human, and re-approve before fixing",
    evidence: evidenceOf(context, ".agentflow/features/<id>/"),
    next: statusOf(context),
  }),
  // orchestration/src/errors.ts:26; orchestration/src/fix-policy.ts:357-367
  fix_verification_config_modified: orchestrationEntry(
    "A fix attempt was rejected for changing the verification configuration",
    "the fix changed the recorded verification configuration digest, so the evidence would prove a different check set than the repair was judged against",
    () => "Restore agent-workflow.config.json and the verification setup, then re-run the fix",
  ),
  // orchestration/src/errors.ts:27
  fix_outside_approved_scope: (context) => ({
    what: "A fix attempt was rejected for writing outside the approved scope",
    why: "the fix changed paths the approved plan does not describe in steps[].expectedFiles; scope is never widened automatically",
    fix: "Undo the out-of-scope paths or amend and re-approve the plan, then re-run",
    evidence: evidenceOf(context, ".agentflow/features/<id>/"),
    next: statusOf(context),
  }),
  // orchestration/src/errors.ts:28
  missing_context_artifact: orchestrationEntry(
    "A required context artifact could not be read",
    "cause not determined from the source: the Detail line below carries which artifact the stage needed and why it was unreadable",
    (context) => `Run ${statusOf(context)} to see which artifacts exist, then re-run ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:29
  unmergeable_artifact: orchestrationEntry(
    "A stage artifact could not be merged into the stored envelope",
    "cause not determined from the source: the Detail line below carries the merge conflict the framework found",
    (context) => `Inspect the recorded artifact, then re-run ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:30
  inconsistent_fix_state: orchestrationEntry(
    "The session is fixing without a recorded fix return state",
    "the persisted machine says fixing but names no origin stage, so there is no failure to repair and no place to return to",
    (context) => `Run ${statusOf(context)}; this needs a human to inspect the session file`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:31
  revision_conflict: orchestrationEntry(
    "The write was refused for a revision conflict",
    "the session moved between the read and the write, so the mutation precondition failed rather than overwriting a concurrent change",
    (context) => `Run ${statusOf(context)} for the current revision, then re-run ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:32
  approval_missing: orchestrationEntry(
    "The gate found no recorded approval",
    "the session records no plan or push approval where one is required, so there is nothing certified to act on",
    (context) => `Approve the gate explicitly, then run ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:33
  approval_invalidated: orchestrationEntry(
    "A recorded approval no longer matches what was approved",
    "an approved artifact no longer hashes to the digest the human approved, so the certified bytes are not the current bytes",
    () => "Re-approve from the current artifacts; do not hand-edit approved files",
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:34
  approval_evidence_missing: (context) => ({
    what: "The approval gate is missing the evidence it must freeze",
    why: "an approved artifact (plan, spec, gate result, or fingerprint) is absent or unreadable at the gate",
    fix: `Run ${runOf(context)} until the producing stage completes, then re-approve`,
    evidence: evidenceOf(context, ".agentflow/features/<id>/"),
    next: statusOf(context),
  }),
  // orchestration/src/errors.ts:35
  verification_not_configured: orchestrationEntry(
    "The verification stage has no provider configured",
    "the orchestrator was built without a verification provider, so deterministic evidence cannot be collected and the stage fails closed",
    () => "Re-run with the product stack, which wires the project verification provider",
  ),
  // orchestration/src/errors.ts:36
  verification_provider_failed: orchestrationEntry(
    "The verification provider failed",
    "the provider threw or returned an unusable bundle instead of measured evidence; the Detail line carries the provider message",
    (context) => `Inspect the verification configuration, then re-run ${runOf(context)}`,
    "agent-workflow.config.json",
  ),
  // orchestration/src/errors.ts:37
  verification_evidence_invalid: orchestrationEntry(
    "The verification evidence is invalid",
    "the bundle fails structural validation (shape, timestamps, fingerprints, or outcome rules); the Detail line names the first violation",
    (context) => `Inspect the recorded bundle, then re-run ${runOf(context)}`,
    ".agentflow/features/<id>/",
  ),
  // orchestration/src/errors.ts:38
  verification_evidence_mismatch: orchestrationEntry(
    "The verification evidence answers the wrong question",
    "the bundle is well formed but belongs to another stage, revision, root, or workspace, so it cannot describe this run",
    (context) => `Re-run ${runOf(context)} so the provider answers the current request`,
    ".agentflow/features/<id>/",
  ),
  // orchestration/src/errors.ts:39
  stale_verification_evidence: orchestrationEntry(
    "The verification evidence is stale",
    "the bundle predates the last fix or describes a different tree than the newest measurement, so it cannot prove the current code",
    (context) => `Re-run ${runOf(context)} to collect fresh evidence after the fix`,
  ),
  // orchestration/src/errors.ts:40; orchestration/src/orchestrator.ts:1781
  final_gate_blocked: orchestrationEntry(
    "The final gate refused to certify the feature",
    "at least one recorded surface (verification, security, scope, approval, or fixer) is not good enough; the Detail line names the blockers",
    (context) => `Run ${statusOf(context)} to read the blockers, repair the routed stage, then re-run ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:41
  final_gate_not_recorded: orchestrationEntry(
    "No usable final gate result is recorded",
    "the final_gate artifact is missing or cannot be parsed, so later stages have nothing certified to point at",
    (context) => `Run the workflow until final_gate passes, then re-run ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:42
  final_gate_evidence_stale: orchestrationEntry(
    "The recorded final gate no longer describes this tree",
    "the tree or revision moved after the gate was decided, so the verdict certifies code that no longer exists",
    (context) => `Re-run the verification stages, then the gate, via ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:43
  push_approval_stale: orchestrationEntry(
    "The publishing approval is stale",
    "the tree, revision, or gate moved after the push approval was recorded, so the approval no longer covers this code",
    (context) => `Re-run to a fresh gate and approve push again, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:45
  push_approval_unverified_runtime: orchestrationEntry(
    "Push approval was refused: runtime verification was not performed",
    "the recorded final gate carries a runtime stage that advanced with no verification configured, and publishing it needs the acknowledgment `--accept-unverified runtime`",
    (context) => `Read the refusal, then run agentflow approve push ${context.featureId ?? "<id>"} --accept-unverified runtime`,
  ),
  // orchestration/src/errors.ts:44; orchestration/src/orchestrator.ts:851-860
  push_approval_already_granted: orchestrationEntry(
    "A publishing approval is already recorded",
    "the session already records a push approval, so a second one would cover evidence the first did not",
    (context) => `Run ${runOf(context)} to publish under the existing approval`,
  ),
  // orchestration/src/errors.ts:45
  publisher_not_configured: orchestrationEntry(
    "No publisher is configured",
    "the feature is approved to publish but the orchestrator was built without a publishing adapter",
    () => "Configure a publishing adapter or leave the feature at its certified state",
  ),
  // orchestration/src/errors.ts:46
  publish_not_approved: orchestrationEntry(
    "Publishing was refused without an approval",
    "the session is not in a publishing state with a recorded push approval, so nothing is approved to publish",
    (context) => `Approve push explicitly, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:47
  publish_state_invalid: orchestrationEntry(
    "Publishing was refused from this workflow state",
    "publishing runs only in committing and pushing; any other state has nothing approved to publish",
    (context) => `Run ${statusOf(context)} to see the current state`,
  ),
  // orchestration/src/errors.ts:48; orchestration/src/orchestrator.ts:977-981
  publish_already_published: orchestrationEntry(
    "The feature is already published",
    "the session is complete and records a push, so a second publish would push the same branch again",
    (context) => `Run ${statusOf(context)}; nothing further is needed`,
  ),
  // orchestration/src/errors.ts:49
  publish_summary_mismatch: orchestrationEntry(
    "Publishing cannot compare its evidence",
    "the final gate or final summary is not on disk, so the approval cannot be checked against the documents it names",
    (context) => `Run the workflow until final_summary is recorded, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:50
  publish_approval_stale: orchestrationEntry(
    "The recorded commit is not under the current approval",
    "the commit was recorded under a different approval than the session now records, so it is not known to be the approved tree",
    (context) => `Re-run the commit step under the current approval via ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:51
  publish_fix_unresolved: orchestrationEntry(
    "Publishing was refused with an unresolved fix",
    "cause not determined from the source beyond the code: the Detail line carries which fix the publisher requires",
    (context) => `Run ${statusOf(context)}, resolve the recorded fix, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:52
  publish_record_missing: orchestrationEntry(
    "The publishing commit record is missing",
    "the session is in pushing but records no commit to push, so the commit step never completed for this approval",
    (context) => `Re-run the commit step via ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:53
  publish_record_invalid: orchestrationEntry(
    "The recorded publishing result cannot be used",
    "the publish record is malformed, disagrees with the session, or changed mid-flight; the Detail line names the reason",
    (context) => `Run ${statusOf(context)} and inspect the publish artifact before retrying`,
  ),
  // orchestration/src/errors.ts:54
  publish_commit_message_invalid: orchestrationEntry(
    "The publish commit message is invalid",
    "the composed title or body breaks the branch/commit contract (length or characters); the Detail line names the violation",
    (context) => `Shorten the feature title, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:55
  publish_change_set_empty: orchestrationEntry(
    "There is nothing to publish",
    "the approved worktree has no changes against the approved commit, and the framework does not write an empty commit",
    () => "Implement the approved plan so the tree differs, or abandon the feature",
  ),
  // orchestration/src/errors.ts:56
  publish_scope_violation: orchestrationEntry(
    "Publishing was refused for an out-of-scope change set",
    "the measured change set touches paths the approved plan does not describe or paths the framework protects",
    () => "Run git status to list the paths, remove or amend the out-of-scope work, then re-run",
  ),
  // orchestration/src/errors.ts:57
  publish_tree_changed: orchestrationEntry(
    "The publishing tree changed under the run",
    "workspace integrity failed (moved HEAD or staged index), so the tree that would be committed is not the approved starting point",
    (context) => `Inspect the workspace, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:58
  publish_path_unsafe: orchestrationEntry(
    "A publish path is unsafe",
    "a path in the change set cannot be proved safe to commit (absolute, escaping, or symlink); the Detail line names it",
    () => "Remove the unsafe path from the change set, then re-run",
  ),
  // orchestration/src/errors.ts:59
  publish_branch_unsafe: orchestrationEntry(
    "The publish branch name is unsafe",
    "the derived branch name fails the safe-branch contract, so pushing it could collide or escape",
    (context) => `Shorten the feature id or title, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:60
  publish_branch_conflict: orchestrationEntry(
    "The publish branch already exists",
    "the feature branch name is taken by a different commit, so pushing would overwrite work the framework did not record",
    () => "Inspect the existing branch, delete or rename it as a human, then re-run",
  ),
  // orchestration/src/errors.ts:61
  publish_branch_failed: orchestrationEntry(
    "The publish branch could not be created",
    "cause not determined from the source beyond the code: the Detail line carries the git failure",
    (context) => `Check git state, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:62
  publish_identity_unconfigured: orchestrationEntry(
    "The publish identity is unconfigured",
    "no git author identity is available for the commit, so the framework will not invent one",
    () => 'Configure git user.name and user.email, then re-run',
  ),
  // orchestration/src/errors.ts:63
  publish_commit_failed: orchestrationEntry(
    "The publish commit failed",
    "cause not determined from the source beyond the code: the Detail line carries the git failure",
    (context) => `Check git state, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:64
  publish_commit_missing: orchestrationEntry(
    "The recorded publish commit does not exist",
    "the commit the record names cannot be found in the repository, so there is nothing to push",
    (context) => `Re-run the commit step via ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:65
  publish_branch_moved: orchestrationEntry(
    "The publish branch moved during the push",
    "the branch pointed at a different commit than the recorded one when the push ran, so the push was refused rather than made over it",
    (context) => `Inspect the branch, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:66
  publish_remote_unavailable: orchestrationEntry(
    "The publish remote is unavailable",
    "the configured remote cannot be reached or is not configured, so the push has nowhere to go",
    () => "Check git remote configuration and network access, then re-run",
  ),
  // orchestration/src/errors.ts:67
  publish_push_rejected: orchestrationEntry(
    "The publish push was rejected",
    "the remote refused the push; the Detail line carries the remote reason",
    () => "Read the remote message (permissions, protection rules), resolve it as a human, then re-run",
  ),
  // orchestration/src/errors.ts:68
  publish_publisher_failed: orchestrationEntry(
    "The publisher failed",
    "the publishing adapter threw or broke its contract; the Detail line carries the adapter message",
    (context) => `Inspect the adapter output, then ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:69
  security_not_configured: orchestrationEntry(
    "The security stage has no provider configured",
    "the orchestrator was built without a security provider, so no deterministic record can be collected and the stage fails closed",
    () => "Re-run with the product stack, which wires the project security provider",
  ),
  // orchestration/src/errors.ts:70
  security_provider_failed: orchestrationEntry(
    "The security provider failed",
    "the provider threw instead of returning a measured record; the Detail line carries the provider message",
    (context) => `Inspect the security configuration, then re-run ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:71
  security_evidence_invalid: orchestrationEntry(
    "The security evidence is invalid",
    "the record fails structural validation; the Detail line names the first violation",
    (context) => `Re-run ${runOf(context)} to collect a fresh record`,
  ),
  // orchestration/src/errors.ts:72
  security_evidence_mismatch: orchestrationEntry(
    "The security evidence answers the wrong question",
    "the record is well formed but belongs to another revision or tree, so it cannot describe this run",
    (context) => `Re-run ${runOf(context)} so the provider answers the current request`,
  ),
  // orchestration/src/errors.ts:73
  stale_security_evidence: orchestrationEntry(
    "The security evidence is stale",
    "the record predates the last fix or describes a different tree, so it cannot prove the current code",
    (context) => `Re-run security_review via ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:74
  workspace_not_configured: (context) => ({
    what: "The orchestrator has no workspace provider configured",
    why: "a post-approval stage or fix needs an isolated worktree to measure, but the orchestrator was built without one; through the CLI this is a wiring defect, not a project defect",
    fix: `Re-run with the product stack (createRealStack wires GitWorkspaceProvider); if this persists, report the wiring and re-run ${statusOf(context)}`,
    evidence: evidenceOf(context, ".agentflow/features/<id>/session.json"),
    next: statusOf(context),
  }),
  // orchestration/src/errors.ts:75
  workspace_unavailable: orchestrationEntry(
    "The workspace could not be opened or read",
    "the provider refused or failed (cache inside repository, missing baseline, git failure); the Detail line carries the provider message",
    (context) => `Read the Detail line, fix the named cause, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:76
  workspace_baseline_missing: orchestrationEntry(
    "The approval names no usable baseline",
    "the recorded baseline is absent or names a repository this orchestrator is not bound to, so no worktree can be opened",
    (context) => `Re-approve the plan from this repository, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:77
  workspace_lease_unavailable: orchestrationEntry(
    "The workspace lease is held",
    "another run holds the worktree lease, so a second open would interleave writes",
    (context) => `Wait for the other run to finish, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:78; orchestration/src/orchestrator.ts:369-376
  workspace_dirty_baseline: (context) => ({
    what: "The plan cannot be approved on top of uncommitted tracked work",
    why: "the baseline capture found staged or unstaged tracked changes; the approved baseline must be the commit the human reviewed",
    fix: "Run git status to list the work, then run git stash or git commit to reach a clean tree before approving",
    evidence: evidenceOf(context, ".agentflow/features/<id>/session.json"),
    next: statusOf(context),
  }),
  // orchestration/src/errors.ts:79
  scope_violation: (context) => ({
    what: "The stage was refused for writing outside the approved scope",
    why: "the measured change set contains paths the approved plan never named in steps[].expectedFiles, or paths the framework protects",
    fix: "Run git status to list the paths, restrict the stage to the approved files, or amend the plan and re-approve it",
    evidence: evidenceOf(context, ".agentflow/features/<id>/"),
    next: statusOf(context),
  }),
  // orchestration/src/errors.ts:80
  scope_expansion_required: orchestrationEntry(
    "The approved scope cannot be determined",
    "the plan lists a non-text or unenforceable expectedFiles entry, so the framework cannot check any write; scope is never widened to accommodate it",
    () => "Ask a human to amend the plan so every expectedFiles entry is a repository-relative path or supported glob, then re-approve",
  ),
  // orchestration/src/errors.ts:81
  scope_restoration_unsafe: orchestrationEntry(
    "An out-of-scope path could not be safely restored",
    "the adapter could not prove a reversal safe (escaping path or symlink), so it was left for a human rather than partially cleaned",
    () => "Inspect the named path as a human and restore or remove it by hand",
  ),
  // orchestration/src/errors.ts:82
  repository_state_changed: orchestrationEntry(
    "The repository state changed under the run",
    "HEAD moved or the index was written where the framework forbids it, so later comparisons would describe the wrong base",
    (context) => `Check git status and log, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:83
  unhandled_state: orchestrationEntry(
    "The workflow reached a state the handler does not cover",
    "cause not determined from the source: the Detail line carries the state and event the code did not expect",
    (context) => `Run ${statusOf(context)} and report the state and Detail line`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:84
  persistence_transition_committed: orchestrationEntry(
    "The transition was already committed",
    "the mutation precondition found the expected revision already replaced, so the write is a replay rather than a decision",
    (context) => `Run ${statusOf(context)} for the current state`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:85
  persistence_transition_not_committed: orchestrationEntry(
    "The transition could not be committed",
    "cause not determined from the source beyond the code: the Detail line carries the store message",
    (context) => `Run ${statusOf(context)}, then retry ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:86
  persistence_transition_superseded: orchestrationEntry(
    "The transition was superseded",
    "a newer revision replaced the one this write was based on, so applying it would overwrite a concurrent change",
    (context) => `Run ${statusOf(context)} for the current revision, then re-run`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/errors.ts:87
  persistence_verification_failed: orchestrationEntry(
    "The persisted verification record failed re-validation",
    "the stored bundle no longer validates when read back, so it is treated as no evidence rather than trusted",
    (context) => `Re-run the verification stage via ${runOf(context)}`,
  ),
  // orchestration/src/errors.ts:88
  persistence_failed: orchestrationEntry(
    "The session store operation failed",
    "cause not determined from the source beyond the code: the Detail line carries the I/O or parse failure",
    (context) => `Check disk state and permissions under .agentflow, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
};

/* ------------------------------------------------------------------------------------------ */
/* Baseline refusals: orchestration/src/workspace.ts:201-207                                    */
/* ------------------------------------------------------------------------------------------ */

const BASELINE_CATALOG: Record<BaselineRefusalCode, CatalogBuilder> = {
  // orchestration/src/workspace.ts:202; adapters/workspace README:250
  not_a_git_repository: staticEntry(
    "The directory is not a git repository",
    "no git repository was found at the project root, so no baseline commit can be captured",
    () => "Run git init and make an initial commit, then re-run",
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:203
  head_unborn: staticEntry(
    "The repository has no commits",
    "HEAD is unborn, so there is no commit to fork a baseline or worktree from",
    () => "Make an initial commit first, then re-run",
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:204; adapters/workspace/src/provider.ts:138-150
  tracked_workspace_dirty: (context) => ({
    what: "The plan cannot be approved on top of uncommitted tracked work",
    why: "the baseline capture found staged or unstaged tracked changes; the approved baseline must be the commit the human reviewed",
    fix: "Run git status to list the work, then run git stash or git commit to reach a clean tree before approving",
    evidence: evidenceOf(context, ".agentflow/features/<id>/session.json"),
    next: statusOf(context),
  }),
  // orchestration/src/workspace.ts:205
  repository_unreadable: staticEntry(
    "The repository could not be read for a baseline",
    "git state could not be inspected, so the framework cannot prove the tree is clean",
    (context) => `Check git status works, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
};

/* ------------------------------------------------------------------------------------------ */
/* Workspace refusals: orchestration/src/workspace.ts:239-251                                   */
/* ------------------------------------------------------------------------------------------ */

const WORKSPACE_CATALOG: Record<WorkspaceRefusalCode, CatalogBuilder> = {
  // orchestration/src/workspace.ts:241
  workspace_not_configured: (context) => ({
    what: "The orchestrator has no workspace provider configured",
    why: "a post-approval stage or fix needs an isolated worktree to measure, but the orchestrator was built without one; through the CLI this is a wiring defect, not a project defect",
    fix: `Re-run with the product stack (createRealStack wires GitWorkspaceProvider); if this persists, report the wiring and re-run ${statusOf(context)}`,
    evidence: evidenceOf(context, ".agentflow/features/<id>/session.json"),
    next: statusOf(context),
  }),
  // orchestration/src/workspace.ts:242; adapters/workspace/src/provider.ts:168-174
  baseline_missing: staticEntry(
    "No usable approval baseline exists for this workspace",
    "the approval baseline is absent or malformed, so the worktree cannot be forked from an approved commit",
    (context) => `Re-approve the plan, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:243
  repository_unavailable: staticEntry(
    "The repository is unavailable for a workspace",
    "the directory is not a repository, git is missing, or the cache mapping failed; the Detail line names which",
    (context) => `Check git availability and the repository path, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:244; adapters/workspace/src/provider.ts:275-284,393-401
  head_changed: staticEntry(
    "The repository moved off the approved commit",
    "HEAD no longer equals the approved baseline commit, so a worktree from either would certify the wrong tree",
    () => "Re-approve the plan from the current commit, or finish the work already in progress first",
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:245
  workspace_metadata_missing: staticEntry(
    "The workspace metadata is missing",
    "an existing worktree carries no sidecar file, so the framework cannot prove it created it and refuses to adopt it",
    (context) => `Remove or rename the directory named in the Detail line as a human, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:246
  workspace_metadata_corrupt: staticEntry(
    "The workspace metadata is corrupt",
    "the sidecar file cannot be parsed, so the worktree cannot be attributed to any feature or commit",
    (context) => `Remove or repair the directory named in the Detail line as a human, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:247
  workspace_registered_elsewhere: staticEntry(
    "The workspace belongs to another repository or commit",
    "the existing worktree is registered to a different repository root or baseline commit and is left alone",
    (context) => `Use a fresh workspace id (re-approve) rather than reusing this directory, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:248
  workspace_path_occupied: staticEntry(
    "The workspace path is occupied",
    "the worktree directory exists and is not a workspace this framework created, so it is left untouched",
    () => "Remove or rename the occupying directory as a human, then re-run",
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:249
  workspace_failed: staticEntry(
    "The workspace operation failed",
    "cause not determined from the source beyond the code: the Detail line carries the git or filesystem failure",
    (context) => `Read the Detail line, fix the named cause, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // orchestration/src/workspace.ts:250
  lease_unavailable: staticEntry(
    "The workspace is leased to another run",
    "another process holds the worktree lease, so a concurrent open would interleave writes",
    (context) => `Wait for the other run, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
};

/* ------------------------------------------------------------------------------------------ */
/* CLI run-loop statuses: apps/cli/src/commands.ts:1059-1068                                    */
/* These are statuses, not error codes; they reuse the orchestration wording where the code     */
/* overlaps and name the status where it does not.                                              */
/* ------------------------------------------------------------------------------------------ */

const CLI_STATUS_CATALOG: Record<CliStatusCode, CatalogBuilder> = {
  executor_error: (context) => ({
    what: "The stage executor threw instead of returning a result",
    why: "the adapter refused or the transport failed (timeout, non-zero exit, tampered config); the workflow records no stage opinion for this run",
    fix: `Read the recording folder named on stderr, then re-run ${runOf(context)}`,
    evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
    next: statusOf(context),
  }),
  stage_failed: (context) => ({
    what: "The stage reported failure",
    why: "the executor completed the stage and the stage itself reported failed with findings",
    fix: `Read the findings with the status command, repair the defect, then re-run ${runOf(context)}`,
    evidence: evidenceOf(context, ".agentflow/features/<id>/"),
    next: statusOf(context),
  }),
  inconclusive: (context) => ({
    what: "The workflow is inconclusive at this stage and could not conclude",
    why: "the stage committed no event and carried no error object; typically deferred verification (nothing declared to run) or an unmeasured check",
    fix: `Declare what is missing (verification command or runtime config) or read the stage evidence, then re-run ${runOf(context)}`,
    evidence: evidenceOf(context, ".agentflow/features/<id>/"),
    next: statusOf(context),
  }),
  // apps/cli/src/commands.ts:1060; orchestration/src/result.ts:18-36
  rejected: orchestrationEntry(
    "The request was rejected without running a stage",
    "a refusal stopped the run before the executor was involved; the Detail line names the refused check",
    (context) => `Read the Detail line, fix the named cause, then ${runOf(context)}`,
  ),
  // apps/cli/src/commands.ts:1066
  conflict: orchestrationEntry(
    "The run conflicted with the stored session",
    "the session revision moved between the read and the write, so the write was refused rather than made over it",
    (context) => `Run ${statusOf(context)} for the current state, then re-run`,
    ".agentflow/features/<id>/session.json",
  ),
  // apps/cli/src/commands.ts:1067
  persistence_error: orchestrationEntry(
    "The session store operation failed",
    "cause not determined from the source beyond the code: the Detail line carries the I/O or parse failure",
    (context) => `Check disk state and permissions under .agentflow, then ${runOf(context)}`,
    ".agentflow/features/<id>/session.json",
  ),
  // apps/cli/src/commands.ts:1063
  feature_failed: orchestrationEntry(
    "The feature reached its failed terminal state",
    "a refusal or exhausted fix loop ended the feature; the Detail line names the terminal cause",
    (context) => `Run ${statusOf(context)} to read the terminal state`,
    ".agentflow/features/<id>/session.json",
  ),
};

/**
 * The combined catalog. Typed as Record<CatalogCode, CatalogBuilder> so a code added to any
 * source union without a message here fails the build.
 */
const CATALOG: Record<CatalogCode, CatalogBuilder> = {
  ...CAPABILITY_CATALOG,
  ...OPENCODE_CATALOG,
  ...ORCHESTRATION_CATALOG,
  ...PROJECT_CATALOG,
  ...BASELINE_CATALOG,
  ...WORKSPACE_CATALOG,
  ...CLI_STATUS_CATALOG,
};

function isCatalogCode(code: string): code is CatalogCode {
  return Object.hasOwn(CATALOG, code);
}

/**
 * The catalog entry for a code, or the unknown fallback. Exported for tests so exhaustiveness
 * can be asserted without printing.
 */
export function catalogEntryFor(code: string, context: CatalogContext = {}): CatalogEntry {
  const builder: CatalogBuilder | undefined = isCatalogCode(code) ? CATALOG[code] : undefined;
  if (builder !== undefined) {
    return builder(context);
  }
  const status = statusOf(context);
  const hasDetail =
    context.detail !== undefined && context.detail !== null && context.detail.trim() !== "";
  return {
    what: "The command could not conclude",
    why: hasDetail
      ? "the recorded detail below carries what the orchestrator reported"
      : "cause not determined",
    fix: "Re-run the command; if it repeats, inspect the evidence path below",
    evidence: evidenceOf(context, ".agentflow/features/<id>/"),
    next: status,
  };
}

/**
 * Strips complete ANSI/CSI escape sequences and then the remaining C0, DEL, and C1 control
 * characters, so model or tool text can reach a terminal.
 *
 * The sequences go first, and with their leading escape byte: removing the byte alone is what used
 * to leave "[0m"- and "[91m[1m"-shaped fragments printed after it (Task Y, P-34). Text that never
 * carried an escape byte is returned as it was, control characters aside.
 */
export function stripControlCharacters(text: string): string {
  const withoutSequences = stripAnsiCodes(text);
  let out = "";
  for (const character of withoutSequences) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    out += character;
  }
  return out;
}

/** Wraps one printable line with a hanging indent. Nothing is truncated. */
function wrapHanging(line: string, width: number): readonly string[] {
  const safeWidth = Math.max(40, Math.floor(width));
  if (line.length <= safeWidth) {
    return [line];
  }
  const continuation = "    ";
  const words = line.split(" ").filter((word) => word !== "");
  const lines: string[] = [];
  let current = "";
  const pushCurrent = (): void => {
    if (current === "") {
      return;
    }
    lines.push(lines.length === 0 ? current : `${continuation}${current}`);
    current = "";
  };
  for (const word of words) {
    if (current === "") {
      if (word.length <= safeWidth - (lines.length === 0 ? 0 : continuation.length)) {
        current = word;
        continue;
      }
      let rest = word;
      while (rest.length > safeWidth - (lines.length === 0 ? 0 : continuation.length)) {
        const limit = safeWidth - (lines.length === 0 ? 0 : continuation.length);
        lines.push(lines.length === 0 ? rest.slice(0, limit) : `${continuation}${rest.slice(0, limit)}`);
        rest = rest.slice(limit);
      }
      current = rest;
      continue;
    }
    const limit = lines.length === 0 ? safeWidth : safeWidth - continuation.length;
    const candidate = `${current} ${word}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    pushCurrent();
    let rest = word;
    while (rest.length > safeWidth - continuation.length) {
      lines.push(`${continuation}${rest.slice(0, safeWidth - continuation.length)}`);
      rest = rest.slice(safeWidth - continuation.length);
    }
    current = rest;
  }
  pushCurrent();
  return lines;
}

function wrapLines(lines: readonly string[], width: number): readonly string[] {
  return lines.flatMap((line) => wrapHanging(line, width));
}

/**
 * Formats one catalog code as wrapped, stripped lines with the raw code in parentheses.
 * Unknown codes fall back to "cause not determined" with the evidence path and status command.
 *
 * The orchestrator's raw message is always printed as a `Detail:` line (verbatim, wrapped, control
 * characters and complete ANSI sequences stripped), even when the catalog explains the code; the
 * catalog may add the fix and the evidence path but never removes the message. "cause not
 * determined" appears only when the message is empty. Consecutive identical detail lines are
 * collapsed to one, so a banner a process printed twice reads as the single fact it was (Task Y).
 * No printed line contains a literal "<id>" or "<stage>": placeholders are interpolated with the
 * real feature id and stage.
 */
export function formatCatalogCode(code: string, context: CatalogContext = {}, width = 100): readonly string[] {
  const entry = catalogEntryFor(code, context);
  const first = `${entry.what} (${code}). Why: ${entry.why}. Fix: ${entry.fix}. Evidence: ${entry.evidence}. Next: ${entry.next}.`;
  const lines = wrapLines([stripControlCharacters(interpolatePlaceholders(first, context))], width);
  const detail = context.detail ?? "";
  if (detail.trim() === "") {
    return lines;
  }
  // Verbatim apart from wrapping and control-character stripping: split on newlines first so a
  // multi-line message keeps its lines, then wrap each one. Consecutive identical lines are
  // collapsed first (Task Y): a provider banner OpenCode printed twice read as two separate
  // facts when it was one, and the repetition carried nothing the first line did not.
  const strippedDetailLines = detail
    .split("\n")
    .map((line) => stripControlCharacters(line))
    .filter((line, index, all) => index === 0 || line !== all[index - 1]);
  const detailLines = strippedDetailLines.flatMap((line) =>
    wrapLines([`Detail: ${line}`], width),
  );
  return [...lines, ...detailLines];
}

/** Formats a CLI error without ever printing "Unknown error". */
export function formatCliError(
  code: string,
  context: CatalogContext = {},
  width = 100,
): readonly string[] {
  return formatCatalogCode(code, context, width);
}

/** One verification check as `id: status (reason)` with its detail, wrapped and stripped. */
export function formatVerificationCheck(
  check: { readonly id: string; readonly status: string; readonly reason: string | null; readonly detail: string },
  width = 100,
): string {
  const reason = check.reason ?? "no reason recorded";
  const line = `${check.id}: ${check.status} (${reason}) - ${check.detail}`;
  return wrapLines([stripControlCharacters(line)], width).join("\n");
}

/** Every check in a bundle as one line each, so skipped capabilities are visible. */
export function formatVerificationSummary(
  checks: readonly { readonly id: string; readonly status: string; readonly reason: string | null; readonly detail: string }[],
  width = 100,
): readonly string[] {
  return checks.flatMap((check) => wrapLines([stripControlCharacters(`${check.id}: ${check.status} (${check.reason ?? "no reason recorded"}) - ${check.detail}`)], width));
}
