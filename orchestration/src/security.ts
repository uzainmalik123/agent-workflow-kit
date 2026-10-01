import { resolve } from "node:path";
import type { ReviewFinding, VerificationEvidence } from "@agent-workflow-kit/core";
import { orchestrationError, type OrchestrationError, type OrchestrationErrorCode } from "./errors.js";
import type { StageOutcome } from "./executor.js";
import { isRecord } from "./result-validation.js";
import type { WorkStage } from "./stages.js";
import { DETERMINISTIC_EVIDENCE_KEY } from "./verification.js";
import {
  approvedPathsOf,
  matchesScopePattern,
  WORKSPACE_PROTECTED_PATTERNS,
  type WorkspaceChanges,
} from "./workspace.js";

/**
 * The deterministic security review.
 *
 * The `security_review` stage used to be the one stage in the workflow whose verdict was a model's
 * opinion about a diff: a role was invoked, it read files, and whatever it wrote became the record.
 * This file replaces that with a port the framework owns, in the same shape as the verification port
 * and for the same reason — a verdict that cannot be re-derived from a measurement is not a verdict
 * this framework can act on.
 *
 * The division of authority is the same one the workspace port draws, and it is the reason this is
 * two files rather than one:
 *
 * - The orchestration layer owns *policy*. It knows which paths are protected, which paths the
 *   human-approved plan covers, and what a failure means for the workflow, so it computes the
 *   change-shaped checks itself and validates whatever a provider returns.
 * - An adapter owns *mechanism*. It opens files, and it is the only thing that can. A coding agent
 *   never appears on this path: the provider is constructed by whoever wires the kit up, and a model
 *   response can never become a `SecurityCheckEvidence`.
 *
 * So the security reviewer is not the arbiter. It explains the evidence the framework already holds,
 * and the framework's own checks are merged into the record afterwards and cannot be talked out of
 * them. A review that says "the `.opencode/agent.json` edit was fine" produces prose beside a
 * `protected_configuration_changed` failure the framework measured, and the failure is what routes the
 * feature.
 */

/* -------------------------------------------------------------------------------------------- */
/* The vocabulary                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The three answers the gate can give, and no others.
 *
 * `pass` means every check was decided and nothing was found. `fail` means a check found something and
 * named it. `inconclusive` means a check could not be decided — a file it was told to read was
 * missing, a symlink, or too large — and it is a first-class answer precisely so that it cannot be
 * reported as one of the other two. `inconclusive` is never success; see `applySecurityEvidence`.
 */
export const SECURITY_REVIEW_STATUSES = ["pass", "fail", "inconclusive"] as const;

export type SecurityReviewStatus = (typeof SECURITY_REVIEW_STATUSES)[number];

/** Per-check status. A check is decided, found, or could not be decided — and never anything else. */
export const SECURITY_CHECK_RESULTS = ["passed", "failed", "inconclusive"] as const;

export type SecurityCheckResult = (typeof SECURITY_CHECK_RESULTS)[number];

/**
 * The checks the kit knows how to look for.
 *
 * The names are the contract. A finding that cannot be named is a finding a fixer cannot be told
 * about, and the fixer is what consumes this record, so every check states the shape it detects
 * rather than the category it belongs to. An adapter may support a subset and is required to say so
 * by reporting the rest as `inconclusive` rather than omitting them.
 */
export const SECURITY_CHECKS = [
  "hardcoded_secret",
  "credential_file",
  "unexpected_executable",
  "package_manager_hook",
  "shell_execution",
  "command_restriction_weakened",
  "permission_broadening",
  "protected_configuration_changed",
  "dependency_configuration_out_of_scope",
] as const;

export type SecurityCheckId = (typeof SECURITY_CHECKS)[number];

/**
 * The checks the framework computes, from facts it already holds.
 *
 * These are the two that need no file read, because both are questions about *which paths changed*
 * and the change set is a framework measurement. Keeping them here is what makes them survive a
 * provider: a provider that returned a clean bill of health for a change set containing
 * `.agentflow/plan.json` would be reporting a pass the framework never asked it to give and would not
 * accept. `applySecurityPolicy` runs after the provider returns, and its verdicts are merged in
 * unconditionally.
 */
export const FRAMEWORK_SECURITY_CHECKS: readonly SecurityCheckId[] = [
  "protected_configuration_changed",
  "dependency_configuration_out_of_scope",
];

/** The checks a provider computes, by reading the files it was told about. */
export const PROVIDER_SECURITY_CHECKS: readonly SecurityCheckId[] = [
  "hardcoded_secret",
  "credential_file",
  "unexpected_executable",
  "package_manager_hook",
  "shell_execution",
  "command_restriction_weakened",
  "permission_broadening",
];

/**
 * A plain-language description of what each check detects, carried in the record.
 *
 * A `reason` on a finding is written for a fixer, and a fixer that has never heard of a check name
 * cannot act on one. The descriptions are here rather than in a prompt so that they travel with the
 * persisted evidence: a human reading `security_review.json` in six months gets the same sentence the
 * fixer did.
 */
export const SECURITY_CHECK_LABELS: Readonly<Record<SecurityCheckId, string>> = {
  hardcoded_secret: "A hard-coded secret, token, password, or private key introduced in a changed file",
  credential_file: "A credential or private-key file added or changed that the approved plan does not describe",
  unexpected_executable: "An executable or script file added or changed that the approved plan does not describe",
  package_manager_hook: "Package-manager configuration that introduces an install hook or an arbitrary command",
  shell_execution: "Shell or process execution introduced where the approved plan did not describe it",
  command_restriction_weakened: "A change that weakens an existing command or path restriction",
  permission_broadening: "A change that broadens filesystem or workflow permissions beyond what the project needs",
  protected_configuration_changed: "A change to acceptance criteria, workflow state, verification configuration, or the framework's own agent configuration",
  dependency_configuration_out_of_scope:
    "A dependency or configuration file changed outside the approved plan's scope",
};

/* -------------------------------------------------------------------------------------------- */
/* Evidence                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export interface SecurityCheckEvidence {
  readonly check: SecurityCheckId;
  readonly result: SecurityCheckResult;
  /**
   * The paths this result is about, and it means one thing in all three statuses so that a reader
   * never has to guess which: the files implicated when `failed`, the files that could not be read
   * when `inconclusive`, and empty when `passed`. A failure with no path is refused by the validator,
   * because a finding nobody can open is not a finding.
   */
  readonly paths: readonly string[];
  /** One deterministic sentence naming what was found and why it matters. Never a transcript. */
  readonly reason: string;
  /**
   * Which half of the framework decided this. Present on the record rather than inferred from the
   * check name so a reader can tell a framework rule from an adapter's measurement without a lookup
   * table, and so a provider that speaks for the framework is refused rather than believed.
   */
  readonly authority: "framework" | "provider";
}

/**
 * Everything one pass of the gate decided, and the state it was decided about.
 *
 * The revision and the workspace fingerprint are the two fields that make this a record rather than
 * an opinion. Security review is a stage a fix loop returns to, so its own output has to prove which
 * tree it looked at: a `pass` for revision 7 cannot decide anything about the tree a fix produced at
 * revision 8, however confidently it is worded.
 */
export interface SecurityReviewEvidence {
  readonly schemaVersion: 1;
  readonly featureId: string;
  readonly stage: WorkStage;
  readonly status: SecurityReviewStatus;
  /** The session revision this evidence was collected for. */
  readonly revision: number;
  /**
   * The framework's own fingerprint over the change set this review is about.
   *
   * This is the framework's measurement, not the provider's. The provider reads the same change set
   * and reports the paths it covered; this is what those paths are re-checked against, and a provider
   * that reported a different tree is caught by `bindSecurityReviewToRequest` rather than by trusting
   * the field it supplied.
   */
  readonly workspaceFingerprint: string;
  readonly projectRoot: string;
  readonly workspaceId: string;
  /** The sorted approved scope the review was measured against, so the record is re-derivable. */
  readonly approvedPatterns: readonly string[];
  /** Every path the change set contained, sorted, so the record names its whole subject. */
  readonly changedPaths: readonly string[];
  readonly checks: readonly SecurityCheckEvidence[];
  readonly collectedAt: string;
}

/**
 * What the gate is asked to decide.
 *
 * Everything the provider needs to look at is here, and nothing it does not. The approved
 * specification, the acceptance criteria, the verification configuration, and the plan's prose are
 * deliberately absent: they are framework-owned inputs, and they reach the gate the only way that
 * gives them force — as the approved path patterns in `approvedPatterns`, which is what
 * `credential_file` and `dependency_configuration_out_of_scope` are decided by. A scanner handed the
 * acceptance criteria could only ignore them, and a scanner that ignores them while appearing to have
 * considered them is worse than one that was never asked.
 *
 * `previousReview` is the exception, and it earns its place: it is the record of what the gate found
 * last time, so a provider can distinguish a finding that is new from one that survived a fix, and
 * the framework can reject an answer that merely restates the previous one.
 */
export interface SecurityReviewRequest {
  readonly featureId: string;
  /** The workflow stage that asked for the review. Always `security_review` today. */
  readonly stage: WorkStage;
  /** The session revision the evidence will belong to, recorded with the evidence. */
  readonly revision: number;
  /**
   * The directory the review may read. Never chosen by an agent: it is the framework's workspace for
   * this stage, which is the user's checkout before approval and an isolated worktree after it.
   */
  readonly projectRoot: string;
  readonly workspaceId: string;
  /** The measured change set, straight from the workspace inspection. */
  readonly changes: WorkspaceChanges;
  /**
   * Every path in `changes`, sorted, as a flat list.
   *
   * Carried alongside the structured form rather than instead of it: the structure is what the
   * framework's own checks and the scope decision need, and a flat list is what an adapter that
   * cannot import this package's workspace module needs in order to know which files to open. The two
   * are the same list — the framework derives this from `changes` and `bindSecurityReviewToRequest`
   * compares the paths a provider reports back against it, so a provider cannot quietly review a
   * subset.
   */
  readonly changedPaths: readonly string[];
  /** The sorted patterns the human-approved plan authorizes. */
  readonly approvedPatterns: readonly string[];
  /** Restated so a provider need not import the policy list to know what it must not bless. */
  readonly protectedPatterns: readonly string[];
  /** The framework's fingerprint over `changes`. */
  readonly workspaceFingerprint: string;
  /** The newest previously recorded review, or null when this is the first one. */
  readonly previousReview: SecurityReviewEvidence | null;
  readonly signal?: AbortSignal | null;
}

export interface SecurityReviewProvider {
  review(request: SecurityReviewRequest): Promise<SecurityReviewEvidence>;
}

/* -------------------------------------------------------------------------------------------- */
/* Protected configuration                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * What a security failure may not be talked out of changing.
 *
 * This is the workspace protection list, reused rather than re-listed, and the reuse is the point: a
 * second hand-written copy of it is a second policy to keep in sync, and the failure mode of the two
 * drifting apart is a protected path that one of them believes is ordinary. The list already covers
 * the four things a plan has no business editing — the acceptance criteria and workflow state under
 * `.agentflow/`, the verification and review configuration in `agent-workflow.config.json(c)`, and
 * the framework's own OpenCode configuration under `.opencode/` and `opencode.json(c)`.
 *
 * The review policy itself is deliberately not on the list, because it is not in the tree: it is this
 * framework's code, outside the project the gate is reading, so no change set can contain it. Naming it
 * would imply a file that does not exist and a check that could never fire.
 */
export const SECURITY_PROTECTED_PATTERNS: readonly string[] = [...WORKSPACE_PROTECTED_PATTERNS];

/**
 * The dependency and configuration surface.
 *
 * Path-shaped on purpose, like the verification-surface patterns in the fix policy. The question each
 * of these answers is "does changing this file change what the project's tooling does without the
 * project code changing", and the answer is a list of conventional filenames rather than an analysis.
 * The consequence of a pattern list is stated rather than hidden: a project using a convention that is
 * not here is not protected by *this* check. It is still protected by the approved scope, because a
 * plan that never named the file does not authorize editing it, and a security review runs before
 * anything is restored.
 *
 * The patterns that look like ordinary source files — `Makefile`, `tsconfig.json`, `.gitignore` — are
 * here because they are configuration wearing a familiar name. A plan that legitimately edits one
 * names it in `expectedFiles` and passes, because this check is about changes the plan does not
 * describe, not about which files are sensitive.
 */
export const DEPENDENCY_CONFIGURATION_PATTERNS: readonly string[] = [
  "**/package.json",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/pnpm-lock.yaml",
  "**/pnpm-workspace.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.pnpmfile.cjs",
  "**/requirements.txt",
  "**/requirements-*.txt",
  "**/pyproject.toml",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/poetry.lock",
  "**/setup.py",
  "**/setup.cfg",
  "**/*.gemspec",
  "**/Gemfile",
  "**/Gemfile.lock",
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/gradle.lockfile",
  "**/go.mod",
  "**/go.sum",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/composer.json",
  "**/composer.lock",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/*.dockerfile",
  "**/docker-compose.yml",
  "**/docker-compose.yaml",
  "**/docker-compose.*.yml",
  "**/.github/**",
  "**/.gitlab-ci.yml",
  "**/Jenkinsfile",
  "**/Makefile",
  "**/makefile",
  "**/GNUmakefile",
  "**/*.tf",
  "**/*.tfvars",
  "**/tsconfig.json",
  "**/tsconfig.*.json",
  "**/jsconfig.json",
  "**/.gitignore",
  "**/.gitattributes",
  "**/.gitmodules",
  "**/.dockerignore",
  "**/.eslintignore",
  "**/.prettierignore",
  "**/.editorconfig",
  "**/*.service",
  "**/*.socket",
  "**/*.timer",
];

export function isDependencyConfigurationPath(path: string): boolean {
  return DEPENDENCY_CONFIGURATION_PATTERNS.some((pattern) => matchesScopePattern(pattern, path));
}

function isProtectedBy(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesScopePattern(pattern, path));
}

function isInApprovedScope(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesScopePattern(pattern, path));
}

/* -------------------------------------------------------------------------------------------- */
/* The framework's own checks                                                                     */
/* -------------------------------------------------------------------------------------------- */

export interface SecurityPolicyInput {
  readonly changes: WorkspaceChanges;
  readonly approvedPatterns: readonly string[];
  readonly protectedPatterns: readonly string[];
}

/**
 * The two checks the framework computes for itself, from the change set it already measured.
 *
 * They run after the provider returns and are merged into the record unconditionally, which is what
 * makes them worth the small amount of machinery around them. A provider is substitutable, and a
 * substitutable component that is also the only source of the guarantee is not a guarantee; the whole
 * reason the port is a port is that the framework can be implemented badly, and a check that lives
 * inside the implementation it is supposed to police does not survive that.
 *
 * Protected configuration is checked before the scope decision and is not subject to it. A protected
 * path is outside the approved scope by definition — `approvedScopeFromPlan` drops it from the
 * approved set — so a check that consulted the scope first would find every protected path
 * "in scope" and pass it.
 */
export function applySecurityPolicy(
  input: SecurityPolicyInput,
): readonly SecurityCheckEvidence[] {
  const observed = approvedPathsOf(input.changes);
  const protectedTouched = observed
    .filter((path) => isProtectedBy(path, input.protectedPatterns))
    .sort();

  // A protected path is excluded from the second check rather than reported by both. It is already a
  // failure, and `dependency_configuration_out_of_scope` has a better reason to give: a config file
  // the plan did not describe is a change a human has to adjudicate, while a protected path is a
  // change that is refused on sight.
  const outOfScopeConfiguration = observed
    .filter((path) => !isProtectedBy(path, input.protectedPatterns))
    .filter((path) => isDependencyConfigurationPath(path))
    .filter((path) => !isInApprovedScope(path, input.approvedPatterns))
    .sort();

  return [
    {
      check: "protected_configuration_changed",
      result: protectedTouched.length === 0 ? "passed" : "failed",
      paths: protectedTouched,
      reason:
        protectedTouched.length === 0
          ? "No framework-controlled path is present in the change set."
          : [
              `The change set contains ${String(protectedTouched.length)} framework-controlled path(s): ${protectedTouched.join(", ")}.`,
              "These files hold the acceptance criteria, the workflow state, the verification and review configuration, and the framework's own agent configuration, so a change to any of them is a change to the rules the work is judged by rather than to the work.",
              "Nothing is restored on your behalf: the file is the evidence a human is about to read.",
            ].join(" "),
      authority: "framework",
    },
    {
      check: "dependency_configuration_out_of_scope",
      result: outOfScopeConfiguration.length === 0 ? "passed" : "failed",
      paths: outOfScopeConfiguration,
      reason:
        outOfScopeConfiguration.length === 0
          ? "Every dependency or configuration file in the change set is inside the approved scope."
          : [
              `The change set contains ${String(outOfScopeConfiguration.length)} dependency or configuration file(s) the approved plan does not describe: ${outOfScopeConfiguration.join(", ")}.`,
              input.approvedPatterns.length === 0
                ? "The approved plan names no paths at all, so nothing was authorized to change."
                : `The approved scope is ${input.approvedPatterns.join(", ")}.`,
              "Changing what the project's tooling installs or runs is outside the scope of a feature plan, whatever the code change looks like. Scope is never widened automatically: a human has to amend and re-approve the plan.",
            ].join(" "),
      authority: "framework",
    },
  ];
}

/* -------------------------------------------------------------------------------------------- */
/* Validation                                                                                     */
/* -------------------------------------------------------------------------------------------- */

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** A reason is one sentence of explanation, not a place to put a file's contents. */
export const MAX_SECURITY_REASON_CHARS = 2_000;

/** A check record is evidence. More paths than this is a scan that lost its own subject. */
export const MAX_SECURITY_PATHS = 500;

export type SecurityEvidenceValidation =
  | { readonly ok: true; readonly evidence: SecurityReviewEvidence }
  | { readonly ok: false; readonly code: OrchestrationErrorCode; readonly message: string };

function invalid(message: string): SecurityEvidenceValidation {
  return { ok: false, code: "security_evidence_invalid", message };
}

/**
 * A different refusal from `invalid()`: the record is well formed and is not this request's. An
 * operator needs to tell "the provider emitted nonsense" apart from "the provider answered a
 * different question", because the second is a wiring or caching bug rather than a corrupt payload.
 */
function mismatched(message: string): SecurityEvidenceValidation {
  return { ok: false, code: "security_evidence_mismatch", message };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function pathList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return null;
    }
  }

  return value as readonly string[];
}

function sortedPaths(value: readonly string[]): readonly string[] {
  return [...value].sort();
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const a = sortedPaths(left);
  const b = sortedPaths(right);

  return a.every((entry, index) => entry === b[index]);
}

function validateCheck(value: unknown): SecurityCheckEvidence | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!oneOf(SECURITY_CHECKS, value["check"])) {
    return null;
  }

  if (!oneOf(SECURITY_CHECK_RESULTS, value["result"])) {
    return null;
  }

  const paths = pathList(value["paths"]);

  if (paths === null || paths.length > MAX_SECURITY_PATHS) {
    return null;
  }

  const reason = value["reason"];

  if (typeof reason !== "string" || reason.length === 0 || reason.length > MAX_SECURITY_REASON_CHARS) {
    return null;
  }

  if (value["authority"] !== "framework" && value["authority"] !== "provider") {
    return null;
  }

  return {
    check: value["check"],
    result: value["result"],
    paths: sortedPaths(paths),
    reason,
    authority: value["authority"],
  };
}

/**
 * Derives the status a set of checks actually supports.
 *
 * `fail` outranks `inconclusive`, which outranks `pass`, and the order is not a preference. A record
 * that both found something and could not decide something else is a `fail`: a known finding is a
 * known finding no matter what else was left unmeasured, and reporting it as inconclusive would hand a
 * confirmed problem to a human who has to go looking for it.
 */
function deriveStatus(
  checks: readonly SecurityCheckEvidence[],
): SecurityReviewStatus {
  if (checks.some((check) => check.result === "failed")) {
    return "fail";
  }

  if (checks.some((check) => check.result === "inconclusive")) {
    return "inconclusive";
  }

  return "pass";
}

/**
 * The status a set of checks supports, exported so a provider derives its own verdict the same way
 * the validator checks it.
 *
 * The rule lives here rather than in each implementation because the validator has to be able to
 * reject a record whose status does not follow from its checks, and a rule that is only stated in the
 * validator is a rule every implementation has to guess at and every one of them can get wrong in the
 * direction that matters. `fail` outranks `inconclusive` outranks `pass`: a known finding is a known
 * finding no matter what else was left unmeasured, and reporting that as inconclusive would hand a
 * confirmed problem to a human who then has to go looking for it.
 */
export function deriveSecurityStatus(
  checks: readonly SecurityCheckEvidence[],
): SecurityReviewStatus {
  return deriveStatus(checks);
}

/**
 * Validates the record a provider returned before the framework believes any of it.
 *
 * The port is substitutable, so the orchestration layer checks it rather than trusting it. The
 * structural rules matter for the persisted artifact. The two semantic rules matter more:
 *
 * - A provider may not speak for the framework. Every check it reports must be its own and must be
 *   marked as its own, so it cannot report `protected_configuration_changed` as passed. The framework
 *   appends its own verdicts afterwards, and this is what stops a provider from having already
 *   answered for them.
 * - A status has to be the one the checks support. The record cannot claim `pass` while one of its
 *   own checks is `inconclusive`, and cannot claim `inconclusive` while one of them is `failed`; both
 *   are the same mistake in opposite directions, which is a provider that cannot be believed about
 *   either.
 */
export function validateSecurityReviewEvidence(raw: unknown): SecurityEvidenceValidation {
  return validateSecurityRecord(raw, "provider");
}

/**
 * Validates a record the framework itself wrote, read back off disk.
 *
 * The same shape with one difference, and the difference is the whole point of the split: a stored
 * record carries the framework's own checks as well as the provider's, because that is what was
 * merged into it before it was written. Authority is still checked — a stored record claiming a
 * provider check as the framework's is as inconsistent as one claiming a framework check as the
 * provider's — but both halves are legitimate here, and refusing them would make every persisted
 * record unreadable and hand the fixer nothing to work from.
 */
export function validateStoredSecurityReview(raw: unknown): SecurityEvidenceValidation {
  return validateSecurityRecord(raw, "artifact");
}

/** Which half of the record is allowed to speak, and therefore which half it may contain. */
type SecurityRecordSource = "provider" | "artifact";

function validateSecurityRecord(raw: unknown, source: SecurityRecordSource): SecurityEvidenceValidation {
  if (!isRecord(raw)) {
    return invalid("A security review evidence record must be an object.");
  }

  if (raw["schemaVersion"] !== 1) {
    return invalid("A security review evidence record must declare schemaVersion 1.");
  }

  if (typeof raw["featureId"] !== "string" || raw["featureId"].length === 0) {
    return invalid("A security review evidence record must name the feature it was collected for.");
  }

  if (raw["stage"] !== "security_review") {
    return invalid('A security review evidence record must belong to the "security_review" stage.');
  }

  if (!oneOf(SECURITY_REVIEW_STATUSES, raw["status"])) {
    return invalid("A security review evidence record must be pass, fail, or inconclusive.");
  }

  if (!isCount(raw["revision"])) {
    return invalid("A security review evidence record must carry the session revision it was collected for.");
  }

  if (!isFingerprint(raw["workspaceFingerprint"])) {
    return invalid("A security review evidence record must carry a SHA-256 workspace fingerprint.");
  }

  if (typeof raw["projectRoot"] !== "string" || raw["projectRoot"].length === 0) {
    return invalid("A security review evidence record must carry the project root it reviewed.");
  }

  if (typeof raw["workspaceId"] !== "string" || raw["workspaceId"].length === 0) {
    return invalid("A security review evidence record must carry the workspace it reviewed.");
  }

  const approvedPatterns = pathList(raw["approvedPatterns"]);

  if (approvedPatterns === null || approvedPatterns.length > MAX_SECURITY_PATHS) {
    return invalid("A security review evidence record must list the approved scope it was measured against.");
  }

  const changedPaths = pathList(raw["changedPaths"]);

  if (changedPaths === null || changedPaths.length > MAX_SECURITY_PATHS) {
    return invalid("A security review evidence record must list the changed paths it reviewed.");
  }

  const rawChecks = raw["checks"];

  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    return invalid("A security review evidence record must carry at least one check.");
  }

  const checks: SecurityCheckEvidence[] = [];
  const seen = new Set<SecurityCheckId>();

  for (const entry of rawChecks) {
    const check = validateCheck(entry);

    if (check === null) {
      return invalid("A security review check is not a valid evidence record.");
    }

    if (seen.has(check.check)) {
      return invalid(`A security review repeats the check "${check.check}".`);
    }

    // Authority has to be the one that owns the check, in both directions. A provider cannot answer
    // for the framework's checks, and a stored record cannot relabel a provider's finding as the
    // framework's own, which would let a scan result read as a policy result.
    const frameworkCheck = FRAMEWORK_SECURITY_CHECKS.includes(check.check);

    if (frameworkCheck !== (check.authority === "framework")) {
      return invalid(
        frameworkCheck
          ? `A security review reported "${check.check}" as a provider check. The framework decides ${FRAMEWORK_SECURITY_CHECKS.join(" and ")} and merges them in itself, so answering for them is refused rather than believed.`
          : `A security review reported "${check.check}", which is not a check a provider decides.`,
      );
    }

    if (source === "provider" && frameworkCheck) {
      return invalid(
        `A security review reported "${check.check}", which is not a check a provider decides. The framework decides ${FRAMEWORK_SECURITY_CHECKS.join(" and ")} and merges them in itself, so answering for them is refused rather than believed.`,
      );
    }

    // A finding with no path is a finding nobody can open, and a pass naming paths is a pass about
    // something. Neither is an ambiguity worth carrying into a persisted record, so `paths` means
    // implicated-or-unreadable and nothing else, and an empty list is only a `passed` check's.
    if (check.result === "failed" && check.paths.length === 0) {
      return invalid(
        `A security review failed the check "${check.check}" without naming a path, so there is nothing to act on or to re-check.`,
      );
    }

    if (check.result === "passed" && check.paths.length > 0) {
      return invalid(
        `A security review passed the check "${check.check}" while naming ${String(check.paths.length)} path(s). A passed check has nothing to implicate.`,
      );
    }

    seen.add(check.check);
    checks.push(check);
  }

  if (deriveStatus(checks) !== raw["status"]) {
    return invalid(
      `A security review claims "${raw["status"]}" while its own checks support "${deriveStatus(checks)}".`,
    );
  }

  if (!isTimestamp(raw["collectedAt"])) {
    return invalid("A security review evidence record must carry a collection timestamp.");
  }

  return {
    ok: true,
    evidence: {
      schemaVersion: 1,
      featureId: raw["featureId"],
      stage: "security_review",
      status: raw["status"],
      revision: raw["revision"],
      workspaceFingerprint: raw["workspaceFingerprint"],
      projectRoot: raw["projectRoot"],
      workspaceId: raw["workspaceId"],
      approvedPatterns: sortedPaths(approvedPatterns),
      changedPaths: sortedPaths(changedPaths),
      checks,
      collectedAt: raw["collectedAt"],
    },
  };
}

/**
 * Binds a validated record to the request that asked for it.
 *
 * Structural validity is not identity, and for this stage the gap is wider than for verification. A
 * well-formed review is easy to produce for the wrong tree, and a `pass` for the wrong tree is the one
 * answer that has no way of announcing itself. So four things are compared rather than one: the
 * revision, the resolved project root, the workspace identity, and the workspace fingerprint — the
 * last being the measurement that actually says which files were read. `changedPaths` and
 * `approvedPatterns` are compared as sets, which is what makes the fingerprint claim checkable rather
 * than decorative: a record that names one set of paths and is fingerprinted for another cannot be
 * assembled.
 *
 * The project root is compared resolved, because the same directory reaches this code as `/repo` and
 * `/repo/` for the same run. Everything else is compared exactly.
 */
export function bindSecurityReviewToRequest(
  evidence: SecurityReviewEvidence,
  request: SecurityReviewRequest,
): SecurityEvidenceValidation {
  if (evidence.stage !== request.stage) {
    return mismatched(
      `The security provider returned a "${evidence.stage}" record for the "${request.stage}" stage.`,
    );
  }

  if (evidence.revision !== request.revision) {
    const relation = evidence.revision < request.revision ? "an earlier" : "a later";

    return mismatched(
      `The security provider returned a record for ${relation} revision (${String(evidence.revision)}), but this stage is revision ${String(request.revision)}. A review of a different revision cannot describe this session.`,
    );
  }

  if (resolve(evidence.projectRoot) !== resolve(request.projectRoot)) {
    return mismatched(
      `The security provider returned a record for project root "${evidence.projectRoot}", but this stage may only review "${request.projectRoot}".`,
    );
  }

  if (evidence.workspaceId !== request.workspaceId) {
    return mismatched(
      `The security provider returned a record for workspace "${evidence.workspaceId}", but this stage may only review "${request.workspaceId}".`,
    );
  }

  if (evidence.workspaceFingerprint !== request.workspaceFingerprint) {
    return mismatched(
      `The security provider returned a record fingerprinted ${evidence.workspaceFingerprint}, but the change set it was asked to review fingerprints ${request.workspaceFingerprint}. It reviewed a different set of files.`,
    );
  }

  const requested = approvedPathsOf(request.changes);

  if (!samePaths(evidence.changedPaths, requested)) {
    return mismatched(
      `The security provider reported on ${String(evidence.changedPaths.length)} path(s) while the change set it was given holds ${String(requested.length)}. A review of a different change set cannot be the review of this one.`,
    );
  }

  if (!samePaths(evidence.approvedPatterns, request.approvedPatterns)) {
    return mismatched(
      "The security provider recorded a different approved scope than the one the framework derived from the approved plan, so the scope it judged against is not the scope a human approved.",
    );
  }

  return { ok: true, evidence };
}

/**
 * Folds the framework's own checks into a provider's record.
 *
 * The status is recomputed rather than combined, so the persisted record cannot claim a verdict its
 * own check list does not support. A provider that passed every one of its checks and the framework
 * then found a protected path in the change set produces a `fail`, and the reason is in the record
 * with the paths that caused it.
 */
export function mergeSecurityPolicyChecks(
  evidence: SecurityReviewEvidence,
  policyChecks: readonly SecurityCheckEvidence[],
): SecurityReviewEvidence {
  const checks = [
    ...evidence.checks,
    ...policyChecks.filter((check) => !evidence.checks.some((existing) => existing.check === check.check)),
  ];

  return {
    ...evidence,
    status: deriveStatus(checks),
    checks,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Applying the record                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * Whether the record forbids calling the stage a success.
 *
 * Both non-passing statuses block, and they block differently. A `fail` is something wrong, so it
 * routes the feature to the fixer that exists to repair it. An `inconclusive` is something unmeasured,
 * so it holds the stage for a human instead: sending a fixer a check that could not be decided
 * teaches people to configure the provider just to get past it, and the provider is the framework's
 * own.
 */
export function securityEvidenceBlocksSuccess(evidence: SecurityReviewEvidence): boolean {
  return evidence.status === "fail" || evidence.status === "inconclusive";
}

export type SecurityEvidenceApplication =
  | {
      readonly outcome: StageOutcome;
      /**
       * Which framework rule, if any, overruled the reported outcome.
       *
       * `security_failure` is a stage that cannot pass; `security_inconclusive` is a stage that
       * cannot be called a pass either. They are separate because the second does not send the feature
       * back to the fixer, and a caller reporting on a stage needs to tell "it failed" from "it was not
       * measured".
       */
      readonly override: "none" | "security_failure" | "security_inconclusive";
      readonly findings: readonly ReviewFinding[];
    };

/**
 * Applies the deterministic record to a security reviewer's result.
 *
 * The overrides are the two directions that matter. A stage whose own checks found something cannot
 * be reported as a success, and a stage whose checks could not be decided cannot be either. What a
 * reviewer may still do is fail, request a fix, or report inconclusive on a record that did pass: an
 * interpreter that spots something the checks do not cover is worth hearing, and the framework's
 * guarantee is that nothing it cannot be shown goes through, not that the model is ignored.
 */
export function applySecurityEvidence(
  evidence: SecurityReviewEvidence,
  reported: StageOutcome,
  featureId: string,
): SecurityEvidenceApplication {
  if (evidence.status === "fail" && reported === "success") {
    return {
      outcome: "needs_fix",
      override: "security_failure",
      findings: securityFailureFindings(evidence, featureId),
    };
  }

  if (evidence.status === "inconclusive" && reported === "success") {
    return {
      outcome: "inconclusive",
      override: "security_inconclusive",
      findings: securityInconclusiveFindings(evidence, featureId),
    };
  }

  return { outcome: reported, override: "none", findings: [] };
}

/** Findings a fixer can act on, written by the framework and never by a model. */
export function securityFailureFindings(
  evidence: SecurityReviewEvidence,
  featureId: string,
): readonly ReviewFinding[] {
  return evidence.checks
    .filter((check) => check.result === "failed")
    .map((check) => ({
      featureId,
      severity: "error" as const,
      message: [
        `The deterministic security check "${check.check}" failed.`,
        check.reason,
        `Affected paths: ${check.paths.join(", ")}.`,
        `Decided by the ${check.authority}.`,
        `Bound to revision ${String(evidence.revision)}, workspace fingerprint ${evidence.workspaceFingerprint}.`,
      ].join(" "),
    }));
}

/** What a human needs to know about a stage whose checks could not be decided. */
export function securityInconclusiveFindings(
  evidence: SecurityReviewEvidence,
  featureId: string,
): readonly ReviewFinding[] {
  const undecided = evidence.checks.filter((check) => check.result === "inconclusive");

  return [
    {
      featureId,
      severity: "warning" as const,
      message: [
        "The deterministic security review could not be decided, so the stage cannot be reported as a success.",
        ...undecided.map(
          (check) =>
            `Check "${check.check}" was inconclusive: ${check.reason}${
              check.paths.length === 0 ? "" : ` Unreadable paths: ${check.paths.join(", ")}.`
            }`,
        ),
        "This is not a pass and not a failure: a check the framework could not run is a check nobody has run. Nothing is sent to the fixer, because there is no defect to repair; a human resolves the reading and the stage runs again.",
        `The review is bound to revision ${String(evidence.revision)}, workspace fingerprint ${evidence.workspaceFingerprint}.`,
      ].join(" "),
    },
  ];
}

/**
 * The paths a fixer is told about, from the checks that failed.
 *
 * This is what a fixer reads as "where to look", and it is a fact rather than an interpretation for
 * the same reason an exit code is: the reviewer named a file, and the check recorded why.
 */
export function securityAffectedPaths(evidence: SecurityReviewEvidence): readonly string[] {
  const paths = new Set<string>();

  for (const check of evidence.checks) {
    if (check.result !== "failed") {
      continue;
    }

    for (const path of check.paths) {
      paths.add(path);
    }
  }

  // The same twenty-path ceiling the reviewer's own reported files use. A fix loop that names four
  // hundred files is a fix loop that has been handed the whole change set and told to find the
  // defect, which is the task the gate exists to have already done.
  return [...paths].sort().slice(0, 20);
}

/** One sentence naming the check that decided a failure, for the fixer's input contract. */
export function securityFailureReason(evidence: SecurityReviewEvidence): string {
  const failing = evidence.checks.find((check) => check.result === "failed");

  if (failing === undefined) {
    const undecided = evidence.checks.find((check) => check.result === "inconclusive");

    if (undecided !== undefined) {
      return `The deterministic security check "${undecided.check}" could not be decided, so the "${evidence.stage}" stage could not be reported as a success. ${undecided.reason}`;
    }

    return `The "${evidence.stage}" stage asked for a fix on a record that reported no failed check, so the defect is described in the report routed to this stage.`;
  }

  return [
    `The deterministic security check "${failing.check}" failed.`,
    failing.reason,
    `Affected paths: ${failing.paths.join(", ")}.`,
    `The ${failing.authority} decided it, against the approved scope ${evidence.approvedPatterns.join(", ") || "(which names no paths)"}, at revision ${String(evidence.revision)} and workspace fingerprint ${evidence.workspaceFingerprint}.`,
  ].join(" ");
}

/**
 * Compact core evidence, so a result and the workflow event log can name each check without carrying
 * the paths and reasons. The record itself lives in the persisted artifact.
 */
export function securityEvidenceSummaries(evidence: SecurityReviewEvidence): readonly VerificationEvidence[] {
  return evidence.checks.map((check) => ({
    kind: "security" as const,
    description: `${check.check}: ${check.result}${
      check.paths.length === 0 ? "" : ` (${String(check.paths.length)} path(s))`
    } [${check.authority}]`,
    reference: `security-evidence#security_review.${check.check}`,
  }));
}

/* -------------------------------------------------------------------------------------------- */
/* Freshness and persistence                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * Whether a record was collected before the last fix was recorded.
 *
 * Binding already ties a record to the revision that asked for it, which stops a completed session's
 * review being replayed. It cannot stop a provider that cached one record and restamped it with the
 * current revision, because the restamped record is internally consistent and describes a revision
 * that genuinely is the one running. The collection time is the field that survives that: a cached
 * answer was produced before the fix the stage exists to re-test, and comparing the two timestamps is
 * the difference between "these checks ran against the current tree" and "these checks ran once and
 * their answer was carried forward".
 *
 * This is the same rule, and the same reasoning, as `staleVerificationEvidence`. A security fix loop
 * that accepted a pre-fix review would report a secret as still present after it was removed, or — the
 * worse direction — report a removed secret as still being reviewed by evidence that never saw the
 * removal.
 *
 * Timestamps are compared rather than equal, because a provider with a coarse clock can legitimately
 * report the same instant as the fix it was collected after.
 */
export function staleSecurityReview(
  evidence: SecurityReviewEvidence,
  lastFix: { readonly recordedAt: string; readonly revisionBefore: number },
): OrchestrationError | null {
  const collected = Date.parse(evidence.collectedAt);
  const recorded = Date.parse(lastFix.recordedAt);

  if (!Number.isNaN(collected) && !Number.isNaN(recorded) && collected < recorded) {
    return orchestrationError(
      "stale_security_evidence",
      `The security review for revision ${String(evidence.revision)} was collected at ${evidence.collectedAt}, before the fix recorded at ${lastFix.recordedAt} was applied. It describes the tree the fix was supposed to repair, so it cannot decide whether the repair worked. The security provider decides this, from a review performed after the fix; the framework does not re-stamp an older answer as a newer one.`,
    );
  }

  if (evidence.revision <= lastFix.revisionBefore) {
    return orchestrationError(
      "stale_security_evidence",
      `The security review carries revision ${String(evidence.revision)}, which is not newer than the revision ${String(lastFix.revisionBefore)} the last fix started from, so it describes code that fix had not yet produced.`,
    );
  }

  return null;
}

/**
 * The key the orchestrator owns inside the controlled security review artifact.
 *
 * The same key as deterministic verification, in a different artifact. The security review writes its
 * own document, and reusing the name keeps "the framework's half of this artifact" recognisable to
 * anything that already knows how to read a verification record — while the model's own section still
 * lives beside it under the stage key and is never read as evidence.
 */
export const SECURITY_EVIDENCE_KEY = DETERMINISTIC_EVIDENCE_KEY;

/**
 * The one controlled artifact the security record is written into. Named here rather than imported
 * from the persistence package so the mapping from the gate to its artifact stays a single decision
 * in the module that owns the record.
 */
export const SECURITY_REVIEW_ARTIFACT_NAME = "security_review";

/**
 * Folds one collected record into the controlled security review artifact.
 *
 * Attempts are appended, never replaced, for the same reason they are in the verification artifact: a
 * fix loop leaves a trail of what was actually found, and the revision and fingerprint on each attempt
 * are what stop an earlier verdict being read as the current one.
 */
export function mergeSecurityReviewEvidence(
  composed: unknown,
  evidence: SecurityReviewEvidence | null,
): unknown {
  if (evidence === null || !isRecord(composed)) {
    return composed;
  }

  const existing = composed[SECURITY_EVIDENCE_KEY];
  const previous: Record<string, unknown> = isRecord(existing) ? existing : {};
  const attempts: unknown = previous[evidence.stage];

  return {
    ...composed,
    [SECURITY_EVIDENCE_KEY]: {
      ...previous,
      [evidence.stage]: Array.isArray(attempts) ? [...(attempts as unknown[]), evidence] : [evidence],
    },
  };
}

/**
 * The newest record the framework itself persisted for the security review.
 *
 * Re-validated rather than trusted, because it comes back off disk as `unknown`. A record that no
 * longer validates is reported as no record at all: the weaker consequence is that a fixer is handed
 * less context, and the stronger one would be to treat a corrupt file as a reason to believe a stage
 * was reviewed when the framework cannot show what it was reviewed with.
 */
export function latestRecordedSecurityReview(artifact: unknown): SecurityReviewEvidence | null {
  if (!isRecord(artifact)) {
    return null;
  }

  const evidence = artifact[SECURITY_EVIDENCE_KEY];

  if (!isRecord(evidence)) {
    return null;
  }

  const attempts = evidence["security_review"];

  if (!Array.isArray(attempts) || attempts.length === 0) {
    return null;
  }

  const validated = validateStoredSecurityReview(attempts[attempts.length - 1]);

  return validated.ok ? validated.evidence : null;
}
