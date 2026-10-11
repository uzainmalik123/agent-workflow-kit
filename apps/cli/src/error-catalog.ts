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
 * path and `agentflow status <id>`. Lines are wrapped (never truncated) and control characters
 * are stripped.
 *
 * Sources (read, not assumed):
 * - CAPABILITY_REASONS: orchestration/src/verification.ts:66-78; usages in
 *   adapters/project/src/node-adapter.ts:80-142, adapters/project/src/profile.ts:162-213,
 *   adapters/project/src/provider.ts:131-170.
 * - OpenCode codes: adapters/opencode/src/errors.ts:1-15; transport_timeout +
 *   non_zero_exit in adapters/opencode/src/process.ts:86-189 and
 *   adapters/opencode/src/executor.ts:424-429; empty/malformed/invalid in
 *   adapters/opencode/src/executor.ts:432-465 and
 *   adapters/opencode/src/response-protocol.ts:64-152; opencode_configuration_tampered in
 *   adapters/opencode/src/configuration-integrity.ts and runtime-config.ts:579.
 * - Orchestration/CLI codes: apps/cli/src/commands.ts:1013-1031 (run loop statuses),
 *   orchestration/src/errors.ts (illegal_transition, approval_evidence_missing,
 *   workspace_not_configured, fix_*), orchestration/src/fix-policy.ts:397-423 (fix_*),
 *   adapters/workspace/src/provider.ts:138-150 (tracked_workspace_dirty),
 *   orchestration/README.md:253/279/341 (illegal_transition, approval_evidence_missing,
 *   workspace_not_configured).
 */

export const CAPABILITY_REASON_CODES = [
  "detected",
  "script_absent",
  "configured",
  "language_without_typecheck",
  "ecosystem_unsupported",
  "not_configured",
  "dependency_missing",
  "package_manager_unknown",
  "runtime_deferred",
] as const;

export type CapabilityReasonCode = (typeof CAPABILITY_REASON_CODES)[number];

export const OPENCODE_ERROR_CODES = [
  "transport_timeout",
  "non_zero_exit",
  "empty_response",
  "malformed_response",
  "invalid_result",
  "opencode_configuration_tampered",
] as const;

export type OpenCodeErrorCode = (typeof OPENCODE_ERROR_CODES)[number];

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

export type OrchestrationStatusCode = (typeof ORCHESTRATION_STATUS_CODES)[number];

export const ALL_CATALOG_CODES = [
  ...CAPABILITY_REASON_CODES,
  ...OPENCODE_ERROR_CODES,
  ...ORCHESTRATION_STATUS_CODES,
] as const;

export type CatalogCode = (typeof ALL_CATALOG_CODES)[number];

export interface CatalogContext {
  readonly featureId?: string;
  /** Human-readable detail from the check/error, when one was recorded. */
  readonly detail?: string | null;
  /** File or folder path where the evidence lives, when the caller knows it. */
  readonly evidencePath?: string | null;
  /** Capability or check id, for verification messages. */
  readonly checkId?: string | null;
}

interface CatalogEntry {
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly evidence: string;
  readonly next: string;
}

function statusOf(context: CatalogContext): string {
  return context.featureId === undefined ? "agentflow status <id>" : `agentflow status ${context.featureId}`;
}

function evidenceOf(context: CatalogContext, fallback: string): string {
  return context.evidencePath ?? fallback;
}

function withDetail(base: string, context: CatalogContext): string {
  if (context.detail === undefined || context.detail === null || context.detail.trim() === "") {
    return base;
  }
  return `${base} Detail recorded: ${stripControlCharacters(context.detail)}`;
}

/**
 * The catalog. Every code maps to a builder so a new code without a message fails the
 * exhaustive test. For codes whose real cause is not understood from the source, the `why`
 * says so instead of inventing one (per Task S.3).
 */
function entryFor(code: string, context: CatalogContext): CatalogEntry {
  const status = statusOf(context);
  switch (code) {
    case "detected":
      return {
        what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} is applicable and will run`,
        why: "the project manifest declares the script for this capability, so the framework selected it",
        fix: "No fix is needed. To change what runs, edit the script in package.json or declare the command in agent-workflow.config.json",
        evidence: evidenceOf(context, "package.json"),
        next: status,
      };
    case "script_absent":
      return {
        what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} was skipped because the project declares nothing for it`,
        why: withDetail(
          "the manifest declares no script for this capability, so there is nothing the framework could run without inventing a command",
          context,
        ),
        fix: 'To verify this capability, add the script to package.json (for example "lint": "eslint .") or declare the command in agent-workflow.config.json under verification.static or verification.test',
        evidence: evidenceOf(context, "package.json"),
        next: status,
      };
    case "configured":
      return {
        what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} refers to project configuration`,
        why: "cause not determined: the \"configured\" reason code is listed in CAPABILITY_REASONS but no detection path in adapters/project sets it as a capability reason, so its real project state is not understood from the source",
        fix: "Inspect package.json and agent-workflow.config.json to see what the project declares for this capability",
        evidence: evidenceOf(context, "agent-workflow.config.json"),
        next: status,
      };
    case "language_without_typecheck":
      return {
        what: `Typecheck was recorded as not applicable`,
        why: "the project declares no TypeScript configuration (tsconfig.json) and no typescript dependency, so the language has no type system to check",
        fix: "No fix is needed for a JavaScript project. To add typechecking, add typescript to devDependencies and a typecheck script, for example npm install --save-dev typescript",
        evidence: evidenceOf(context, "package.json"),
        next: status,
      };
    case "ecosystem_unsupported":
      return {
        what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} is unsupported for this ecosystem`,
        why: "the project was recognised as python, rust, java, or unknown from its markers, and this milestone has no adapter that infers commands for it",
        fix: "Declare the command in agent-workflow.config.json, for example { \"schemaVersion\": 1, \"verification\": { \"static\": [{ \"id\": \"lint\", \"capability\": \"lint\", \"executable\": \"ruff\", \"args\": [\"check\"] }] } }",
        evidence: evidenceOf(context, "agent-workflow.config.json"),
        next: status,
      };
    case "not_configured":
      return {
        what: `Verification could not be measured for${context.checkId === undefined || context.checkId === null ? " this capability" : ` "${context.checkId}"`}`,
        why: withDetail(
          "the project could not be inspected (unreadable manifest or unsafe path), so no capability could be classified; the refusal code is in the recorded detail",
          context,
        ),
        fix: "Make package.json readable and not a symlink, then re-run. Check the detail for the refusal code (root_unavailable, manifest_malformed, config_invalid)",
        evidence: evidenceOf(context, "package.json"),
        next: status,
      };
    case "dependency_missing":
      return {
        what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} is blocked because dependencies are not installed`,
        why: "the project has no node_modules directory, so a script invoked through the package manager cannot run; nothing is installed automatically",
        fix: "Install dependencies with the project manager, for example pnpm install (or npm install, yarn install, bun install to match the lockfile)",
        evidence: evidenceOf(context, "package.json"),
        next: status,
      };
    case "package_manager_unknown":
      return {
        what: `Verification check${context.checkId === undefined || context.checkId === null ? "" : ` "${context.checkId}"`} is blocked because the package manager is unknown`,
        why: withDetail(
          "this project has no lockfile and no `packageManager` field in package.json, so the framework cannot tell which manager (pnpm, npm, yarn, bun) would run the declared script",
          context,
        ),
        fix: "Commit a lockfile (for example npm install --package-lock-only) or set the manager in package.json (for example \"packageManager\": \"pnpm@12.9.1\"), or declare the check as a bare tool in agent-workflow.config.json so no manager is needed",
        evidence: evidenceOf(context, "package.json"),
        next: status,
      };
    case "runtime_deferred":
      return {
        what: "Runtime verification was deferred because nothing was declared to run",
        why: "a manifest cannot say how an application starts and this framework never infers one, so no runtime command was planned",
        fix: "Declare the runtime in agent-workflow.config.json under verification.runtime with a command, a readiness url, and checks",
        evidence: evidenceOf(context, "agent-workflow.config.json"),
        next: status,
      };
    case "transport_timeout":
      return {
        what: "The OpenCode stage run timed out",
        why: withDetail(
          "the opencode child process exceeded its per-stage time budget and was killed; the budget is the shared runner deadline",
          context,
        ),
        fix: "Re-run with a larger budget, for example agentflow run <id> --stage-timeout 1800, or reduce what the stage is asked to do",
        evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
        next: status,
      };
    case "non_zero_exit":
      return {
        what: "The OpenCode run exited with a non-zero code",
        why: withDetail(
          "the opencode CLI process itself failed before any reply could be judged; this is a failed run, not a rejected reply, and it is never retried as a format issue",
          context,
        ),
        fix: "Read the recording manifest stderr excerpt, then re-run agentflow run <id>; if the binary is missing, install OpenCode V2",
        evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
        next: status,
      };
    case "empty_response":
      return {
        what: "The OpenCode run returned no response text",
        why: "the agent process exited 0 but produced an empty reply, so there is no fenced JSON block to judge; empty replies are retried up to 2 times",
        fix: "Re-run agentflow run <id>; if it repeats, inspect the recording stdout.txt for what the model actually emitted",
        evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
        next: status,
      };
    case "malformed_response":
      return {
        what: "The OpenCode reply was rejected as malformed",
        why: withDetail(
          "the reply had no fenced JSON block, an unclosed fence, invalid JSON, or a missing required field; the contract requires exactly one fenced JSON object",
          context,
        ),
        fix: "No manual fix is needed for one miss: the stage is retried up to 2 times with a rejection notice. Re-run agentflow run <id> if all attempts were rejected",
        evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
        next: status,
      };
    case "invalid_result":
      return {
        what: "The OpenCode reply failed validation",
        why: withDetail(
          "the fenced JSON parsed but carried a workflow control field or failed the stage result schema; an agent may not choose transitions or approvals",
          context,
        ),
        fix: "No manual fix is needed for one miss: the stage is retried up to 2 times. Re-run agentflow run <id> if all attempts were rejected",
        evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
        next: status,
      };
    case "opencode_configuration_tampered":
      return {
        what: "The OpenCode run was refused because framework configuration was tampered with",
        why: withDetail(
          "a generated agent file or a repository OpenCode boundary (permission, plugin, tool, or instruction source) failed integrity: missing, malformed, or crossed by the repository",
          context,
        ),
        fix: "Do not hand-edit generated agent files. Re-run agentflow run <id> to regenerate them outside the repository, and remove any repository .opencode plugin or agent id that shadows a framework profile",
        evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
        next: status,
      };
    case "scope_violation":
      return {
        what: "The stage was refused for writing outside the approved scope",
        why: withDetail(
          "the measured change set contains paths the approved plan never named in steps[].expectedFiles, or paths the framework protects",
          context,
        ),
        fix: "Run git status to list the paths, restrict the stage to the approved files, or amend the plan and re-approve it",
        evidence: evidenceOf(context, ".agentflow/features/<id>/"),
        next: status,
      };
    case "executor_error":
      return {
        what: "The stage executor threw instead of returning a result",
        why: withDetail(
          "the adapter refused or the transport failed (timeout, non-zero exit, tampered config); the workflow records no stage opinion for this run",
          context,
        ),
        fix: "Read the recording folder named on stderr, then re-run agentflow run <id>",
        evidence: evidenceOf(context, ".agentflow/recordings/<id>/<stage>/"),
        next: status,
      };
    case "stage_failed":
      return {
        what: "The stage reported failure",
        why: withDetail(
          "the executor completed the stage and the stage itself reported failed with findings",
          context,
        ),
        fix: "Read the findings with the status command, repair the defect, then re-run agentflow run <id>",
        evidence: evidenceOf(context, ".agentflow/features/<id>/"),
        next: status,
      };
    case "inconclusive":
      return {
        what: "The workflow is inconclusive at this stage and could not conclude",
        why: withDetail(
          "the stage committed no event and carried no error object; typically deferred verification (nothing declared to run) or an unmeasured check",
          context,
        ),
        fix: "Declare what is missing (verification command or runtime config) or read the stage evidence, then re-run agentflow run <id>",
        evidence: evidenceOf(context, ".agentflow/features/<id>/"),
        next: status,
      };
    case "illegal_transition":
      return {
        what: "The requested event is not legal in the current workflow state",
        why: "the state machine refused the transition (for example approving a push while still planning); only the machine decides what an event means",
        fix: "Run agentflow status <id> to see the current state, then use the command the Next line recommends",
        evidence: evidenceOf(context, ".agentflow/features/<id>/session.json"),
        next: status,
      };
    case "approval_evidence_missing":
      return {
        what: "The approval gate is missing the evidence it must freeze",
        why: "an approved artifact (plan, spec, gate result, or fingerprint) is absent or unreadable at the gate",
        fix: "Run agentflow run <id> until the producing stage completes, then re-approve",
        evidence: evidenceOf(context, ".agentflow/features/<id>/"),
        next: status,
      };
    case "tracked_workspace_dirty":
      return {
        what: "The plan cannot be approved on top of uncommitted tracked work",
        why: withDetail(
          "the baseline capture found staged or unstaged tracked changes; the approved baseline must be the commit the human reviewed",
          context,
        ),
        fix: "Run git status to list the work, then run git stash or git commit to reach a clean tree before approving",
        evidence: evidenceOf(context, ".agentflow/features/<id>/session.json"),
        next: status,
      };
    case "workspace_not_configured":
      return {
        what: "The orchestrator has no workspace provider configured",
        why: "a post-approval stage or fix needs an isolated worktree to measure, but the orchestrator was built without one; through the CLI this is a wiring defect, not a project defect",
        fix: "Re-run with the product stack (createRealStack wires GitWorkspaceProvider); if this persists, report the wiring and re-run agentflow status <id>",
        evidence: evidenceOf(context, ".agentflow/features/<id>/session.json"),
        next: status,
      };
    case "fix_attempts_exhausted":
      return {
        what: "The fix loop has used all of its automatic attempts",
        why: "the fixer could not repair the defect within 5 attempts (MAX_FIX_ATTEMPTS); the framework never runs one more than the limit allows",
        fix: "Repair the defect by hand, or amend the approved plan or spec, then start from the human gate",
        evidence: evidenceOf(context, ".agentflow/features/<id>/"),
        next: status,
      };
    case "fix_target_modified":
      return {
        what: "A fix attempt was rejected for changing what it is judged by",
        why: "the fix changed the digest of the approved spec, plan, or plan review; the fixer may change the implementation and nothing else",
        fix: "Restore the approved files, amend the plan or spec as a human, and re-approve before fixing",
        evidence: evidenceOf(context, ".agentflow/features/<id>/"),
        next: status,
      };
    case "fix_outside_approved_scope":
      return {
        what: "A fix attempt was rejected for writing outside the approved scope",
        why: "the fix changed paths the approved plan does not describe in steps[].expectedFiles; scope is never widened automatically",
        fix: "Undo the out-of-scope paths or amend and re-approve the plan, then re-run",
        evidence: evidenceOf(context, ".agentflow/features/<id>/"),
        next: status,
      };
    default:
      return {
        what: "The command could not conclude",
        why: "cause not determined",
        fix: "Re-run the command; if it repeats, inspect the evidence path below",
        evidence: evidenceOf(context, ".agentflow/features/<id>/"),
        next: status,
      };
  }
}

function isCatalogCode(code: string): code is CatalogCode {
  return (ALL_CATALOG_CODES as readonly string[]).includes(code);
}

/** Strips C0, DEL, and C1 control characters so model or tool text can reach a terminal. */
export function stripControlCharacters(text: string): string {
  let out = "";
  for (const character of text) {
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
 */
export function formatCatalogCode(code: string, context: CatalogContext = {}, width = 100): readonly string[] {
  const known = isCatalogCode(code);
  const entry = known ? entryFor(code, context) : entryFor("unknown", context);
  const first = `${entry.what} (${code}). Why: ${entry.why}. Fix: ${entry.fix}. Evidence: ${entry.evidence}. Next: ${entry.next}.`;
  return wrapLines([stripControlCharacters(first)], width);
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
