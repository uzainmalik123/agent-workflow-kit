import type { ReviewFinding, VerificationEvidence } from "@agent-workflow-kit/core";
import type { OrchestrationErrorCode } from "./errors.js";
import type { StageOutcome } from "./executor.js";
import { isRecord } from "./result-validation.js";
import type { WorkStage } from "./stages.js";

/**
 * The deterministic verification port.
 *
 * A verification stage produces two independent things, and this file is where they are kept apart:
 *
 * - hard evidence, produced by running framework-selected project commands and reading process exit
 *   status. This is authoritative.
 * - an interpretation, produced by the `verifier` stage executor from that evidence. This is useful
 *   and is never authoritative.
 *
 * The orchestration layer owns the port and the shape of the evidence. A project adapter implements
 * the port, so a coding agent never appears on this path: the provider is constructed by whoever
 * wires the kit up, and an agent response can never become a `VerificationCommand`.
 */
export const VERIFICATION_STAGES = ["static", "test", "runtime"] as const;

export type VerificationStage = (typeof VERIFICATION_STAGES)[number];

/** The deterministic verdict for a whole stage, derived only from process results. */
export const VERIFICATION_OUTCOMES = ["passed", "failed", "blocked", "deferred"] as const;

export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/** Per-check status. Never inferred from output text: only from the runner's own state. */
export const VERIFICATION_CHECK_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "blocked",
  "timed_out",
  "cancelled",
] as const;

export type VerificationCheckStatus = (typeof VERIFICATION_CHECK_STATUSES)[number];

/** The checks the kit knows how to look for. An adapter may support a subset and say so. */
export const VERIFICATION_CAPABILITIES = ["lint", "typecheck", "test", "build", "runtime"] as const;

export type VerificationCapability = (typeof VERIFICATION_CAPABILITIES)[number];

/**
 * How a capability relates to this project.
 *
 * `not_applicable` and `unavailable` are different on purpose: the first means the ecosystem cannot
 * have the check (no type system in plain JavaScript), the second means it could and this project
 * does not provide it. Neither is a pass, and neither invents a command.
 */
export const CAPABILITY_STATUSES = [
  "applicable",
  "not_applicable",
  "unsupported",
  "unavailable",
  "blocked",
] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** A stable, machine-readable reason for a capability status. */
export const CAPABILITY_REASONS = [
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

export type CapabilityReason = (typeof CAPABILITY_REASONS)[number];

export interface CapabilityDetection {
  readonly capability: VerificationCapability;
  readonly status: CapabilityStatus;
  readonly reason: CapabilityReason;
  /** The project script or configured command that would satisfy this capability, when there is one. */
  readonly script: string | null;
  /** One deterministic sentence explaining the status. */
  readonly detail: string;
}

export interface ProjectProfileSummary {
  readonly ecosystem: string;
  readonly language: string;
  /** The manager the commands will be run with, from the lockfile. */
  readonly packageManager: string | null;
  /** The manager the manifest declares, which is a fallback and may disagree with the lockfile. */
  readonly declaredPackageManager: string | null;
  readonly dependenciesInstalled: boolean;
  readonly frameworks: readonly string[];
  readonly capabilities: readonly CapabilityDetection[];
}

export interface VerificationCommandEvidence {
  readonly id: string;
  readonly kind: VerificationStage;
  readonly capability: VerificationCapability;
  readonly capabilityStatus: CapabilityStatus;
  readonly label: string;
  /** `null` when no command ran, which is the normal case for a skipped or blocked check. */
  readonly executable: string | null;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly script: string | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly status: VerificationCheckStatus;
  readonly reason: string | null;
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
  readonly truncated: boolean;
  /** The session revision this evidence was collected for. */
  readonly revision: number;
  /** A digest of the working tree the command saw, so old evidence cannot prove new code. */
  readonly implementationFingerprint: string;
}

export interface VerificationEvidenceBundle {
  readonly verification: VerificationStage;
  readonly outcome: VerificationOutcome;
  readonly revision: number;
  readonly implementationFingerprint: string;
  readonly collectedAt: string;
  readonly projectRoot: string;
  readonly project: ProjectProfileSummary;
  readonly checks: readonly VerificationCommandEvidence[];
}

export interface VerificationRequest {
  readonly featureId: string;
  /** The workflow stage that asked for the evidence. */
  readonly stage: WorkStage;
  readonly verification: VerificationStage;
  /** The session revision the evidence will belong to, recorded with the evidence. */
  readonly revision: number;
  /** The project the commands may run in. Never chosen by an agent. */
  readonly projectRoot: string;
  readonly signal?: AbortSignal | null;
}

export interface VerificationProvider {
  collect(request: VerificationRequest): Promise<VerificationEvidenceBundle>;
}

/** The three verification stages, and nothing else, get deterministic evidence. */
export const VERIFICATION_STAGE_BY_WORK_STAGE: Readonly<
  Partial<Record<WorkStage, VerificationStage>>
> = {
  static_verification: "static",
  test_verification: "test",
  runtime_verification: "runtime",
};

export const VERIFICATION_WORK_STAGES: readonly WorkStage[] = [
  "static_verification",
  "test_verification",
  "runtime_verification",
];

/** Bounded evidence only. A provider that returns a transcript is refused, not truncated by us. */
export const MAX_EVIDENCE_EXCERPT_CHARS = 20_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const NON_PASSING_STATUSES: ReadonlySet<VerificationCheckStatus> = new Set<VerificationCheckStatus>([
  "failed",
  "blocked",
  "timed_out",
  "cancelled",
]);

export type VerificationBundleValidation =
  | { readonly ok: true; readonly bundle: VerificationEvidenceBundle }
  | { readonly ok: false; readonly code: OrchestrationErrorCode; readonly message: string };

function invalid(message: string): VerificationBundleValidation {
  return { ok: false, code: "verification_evidence_invalid", message };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isBoundedExcerpt(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_EVIDENCE_EXCERPT_CHARS;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function optionalStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateCapabilityDetections(value: unknown): readonly CapabilityDetection[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const detections: CapabilityDetection[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }

    if (!oneOf(VERIFICATION_CAPABILITIES, entry["capability"])) {
      return null;
    }

    if (!oneOf(CAPABILITY_STATUSES, entry["status"])) {
      return null;
    }

    if (!oneOf(CAPABILITY_REASONS, entry["reason"])) {
      return null;
    }

    if (!optionalString(entry["script"]) || typeof entry["detail"] !== "string") {
      return null;
    }

    detections.push({
      capability: entry["capability"],
      status: entry["status"],
      reason: entry["reason"],
      script: entry["script"],
      detail: entry["detail"],
    });
  }

  return detections;
}

function validateCheck(value: unknown): VerificationCommandEvidence | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value["id"] !== "string" || value["id"].length === 0) {
    return null;
  }

  if (!oneOf(VERIFICATION_STAGES, value["kind"])) {
    return null;
  }

  if (!oneOf(VERIFICATION_CAPABILITIES, value["capability"])) {
    return null;
  }

  if (!oneOf(CAPABILITY_STATUSES, value["capabilityStatus"])) {
    return null;
  }

  if (typeof value["label"] !== "string" || !optionalString(value["executable"])) {
    return null;
  }

  if (!optionalStringArray(value["args"])) {
    return null;
  }

  if (typeof value["cwd"] !== "string" || value["cwd"].length === 0) {
    return null;
  }

  if (!optionalString(value["script"])) {
    return null;
  }

  if (!isTimestamp(value["startedAt"]) || !isCount(value["durationMs"])) {
    return null;
  }

  const exitCode = value["exitCode"];

  if (exitCode !== null && !isCount(exitCode)) {
    return null;
  }

  if (!optionalString(value["signal"]) || !oneOf(VERIFICATION_CHECK_STATUSES, value["status"])) {
    return null;
  }

  if (!optionalString(value["reason"])) {
    return null;
  }

  if (!isBoundedExcerpt(value["stdoutExcerpt"]) || !isBoundedExcerpt(value["stderrExcerpt"])) {
    return null;
  }

  if (typeof value["truncated"] !== "boolean" || !isCount(value["revision"])) {
    return null;
  }

  const fingerprint = value["implementationFingerprint"];

  if (typeof fingerprint !== "string" || !SHA256_PATTERN.test(fingerprint)) {
    return null;
  }

  return {
    id: value["id"],
    kind: value["kind"],
    capability: value["capability"],
    capabilityStatus: value["capabilityStatus"],
    label: value["label"],
    executable: value["executable"],
    args: value["args"],
    cwd: value["cwd"],
    script: value["script"],
    startedAt: value["startedAt"],
    durationMs: value["durationMs"],
    exitCode,
    signal: value["signal"],
    status: value["status"],
    reason: value["reason"],
    stdoutExcerpt: value["stdoutExcerpt"],
    stderrExcerpt: value["stderrExcerpt"],
    truncated: value["truncated"],
    revision: value["revision"],
    implementationFingerprint: fingerprint,
  };
}

/**
 * Validates the bundle a provider returned before the framework believes any of it.
 *
 * The port is substitutable, so the orchestration layer checks it rather than trusting it. The
 * structural rules matter for the persisted artifact; the semantic rule at the end matters more:
 * a bundle may not claim `passed` while one of its own checks is failed, blocked, timed out, or
 * cancelled, and a `deferred` bundle may contain nothing but skipped checks.
 */
export function validateVerificationEvidenceBundle(raw: unknown): VerificationBundleValidation {
  if (!isRecord(raw)) {
    return invalid("A verification evidence bundle must be an object.");
  }

  if (!oneOf(VERIFICATION_STAGES, raw["verification"])) {
    return invalid("Verification evidence bundle verification must be static, test, or runtime.");
  }

  if (!oneOf(VERIFICATION_OUTCOMES, raw["outcome"])) {
    return invalid("Verification evidence bundle outcome must be passed, failed, blocked, or deferred.");
  }

  if (!isCount(raw["revision"]) || !isTimestamp(raw["collectedAt"])) {
    return invalid("Verification evidence bundle must carry a revision and a collection timestamp.");
  }

  const fingerprint = raw["implementationFingerprint"];

  if (typeof fingerprint !== "string" || !SHA256_PATTERN.test(fingerprint)) {
    return invalid("Verification evidence bundle must carry a SHA-256 implementation fingerprint.");
  }

  if (typeof raw["projectRoot"] !== "string" || raw["projectRoot"].length === 0) {
    return invalid("Verification evidence bundle must carry the project root it ran in.");
  }

  const project = raw["project"];

  if (!isRecord(project)) {
    return invalid("Verification evidence bundle must carry a project profile summary.");
  }

  if (typeof project["ecosystem"] !== "string" || typeof project["language"] !== "string") {
    return invalid("A project profile summary must name its ecosystem and language.");
  }

  if (!optionalString(project["packageManager"]) || typeof project["dependenciesInstalled"] !== "boolean") {
    return invalid("A project profile summary must name its package manager and dependency state.");
  }

  if (!optionalString(project["declaredPackageManager"])) {
    return invalid("A project profile summary must name the package manager the manifest declares.");
  }

  const frameworks = project["frameworks"];

  if (
    !Array.isArray(frameworks) ||
    !frameworks.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    return invalid("A project profile summary must list detected frameworks as non-empty strings.");
  }

  const capabilities = validateCapabilityDetections(project["capabilities"]);

  if (capabilities === null) {
    return invalid("A project profile summary must classify every capability it reports.");
  }

  const rawChecks = raw["checks"];

  if (!Array.isArray(rawChecks)) {
    return invalid("Verification evidence bundle checks must be an array.");
  }

  const checks: VerificationCommandEvidence[] = [];
  const ids = new Set<string>();

  for (const entry of rawChecks) {
    const check = validateCheck(entry);

    if (check === null) {
      return invalid("A verification evidence check is not a valid evidence record.");
    }

    if (ids.has(check.id)) {
      return invalid(`Verification evidence bundle repeats the check "${check.id}".`);
    }

    if (check.kind !== raw["verification"]) {
      return invalid(`Check "${check.id}" does not belong to the ${raw["verification"]} stage.`);
    }

    ids.add(check.id);
    checks.push(check);
  }

  const outcome = raw["outcome"];
  const notPassing = checks.filter((check) => NON_PASSING_STATUSES.has(check.status));

  if (outcome === "passed" && notPassing.length > 0) {
    return invalid(
      `Verification evidence claims "passed" while check "${notPassing[0]?.id ?? ""}" is ${notPassing[0]?.status ?? "not passing"}.`,
    );
  }

  if (outcome === "failed" && !checks.some((check) => check.status === "failed")) {
    return invalid('Verification evidence claims "failed" without a failed check.');
  }

  if (outcome === "blocked" && !checks.some((check) => check.status === "blocked")) {
    return invalid('Verification evidence claims "blocked" without a blocked check.');
  }

  if (outcome === "deferred" && !checks.every((check) => check.status === "skipped")) {
    return invalid('Verification evidence claims "deferred" without every check being skipped.');
  }

  if ((outcome === "failed" || outcome === "blocked") && checks.length === 0) {
    return invalid("A verification bundle that did not pass must explain itself with at least one check.");
  }

  return {
    ok: true,
    bundle: {
      verification: raw["verification"],
      outcome,
      revision: raw["revision"],
      implementationFingerprint: fingerprint,
      collectedAt: raw["collectedAt"],
      projectRoot: raw["projectRoot"],
      project: {
        ecosystem: project["ecosystem"],
        language: project["language"],
        packageManager: project["packageManager"],
        declaredPackageManager: project["declaredPackageManager"],
        dependenciesInstalled: project["dependenciesInstalled"],
        frameworks: frameworks as readonly string[],
        capabilities,
      },
      checks,
    },
  };
}

/**
 * Whether hard evidence forbids a passing verification stage.
 *
 * `deferred` does not block: runtime verification has no deterministic command yet, and pretending a
 * deferred check is a failure would make the workflow unsatisfiable. `failed` and `blocked` both
 * block, because a stage that could not run its own check has not been verified.
 */
export function evidenceBlocksSuccess(bundle: VerificationEvidenceBundle): boolean {
  return bundle.outcome === "failed" || bundle.outcome === "blocked";
}

export type DeterministicEvidenceApplication =
  | {
      readonly outcome: StageOutcome;
      /** `deterministic_failure` when the framework overrode a reported success. */
      readonly override: "none" | "deterministic_failure";
      readonly findings: readonly ReviewFinding[];
    };

/**
 * Applies hard evidence to a verifier result.
 *
 * The only override this performs is the one direction that matters: a stage whose deterministic
 * evidence is failed or blocked cannot be reported as a success, whatever the verifier said. A
 * verifier may still fail, request a fix, or report inconclusive on evidence that did pass, because
 * an interpreter that spots something the process exit code cannot is worth hearing.
 */
export function applyDeterministicEvidence(
  bundle: VerificationEvidenceBundle,
  reported: StageOutcome,
  featureId: string,
): DeterministicEvidenceApplication {
  if (!evidenceBlocksSuccess(bundle) || reported !== "success") {
    return { outcome: reported, override: "none", findings: [] };
  }

  return {
    outcome: "needs_fix",
    override: "deterministic_failure",
    findings: verificationFailureFindings(bundle, featureId),
  };
}

/** Findings a fixer can act on, written by the framework and never by a model. */
export function verificationFailureFindings(
  bundle: VerificationEvidenceBundle,
  featureId: string,
): readonly ReviewFinding[] {
  return bundle.checks
    .filter((check) => NON_PASSING_STATUSES.has(check.status))
    .map((check) => ({
      featureId,
      severity: "error" as const,
      message: [
        `Deterministic ${check.capability} check "${check.id}" is ${check.status}.`,
        check.executable === null
          ? `No command ran: ${check.reason ?? "no reason recorded"}.`
          : `${check.executable} ${check.args.join(" ")} exited with ${String(check.exitCode)}.`,
      ].join(" "),
    }));
}

/**
 * Compact core evidence, so a result and the workflow event log can name each check without
 * carrying the excerpts. The excerpts themselves live in the persisted bundle.
 */
export function verificationEvidenceSummaries(
  bundle: VerificationEvidenceBundle,
): readonly VerificationEvidence[] {
  const kind = bundle.verification;

  return bundle.checks.map((check) => ({
    kind,
    description:
      `${check.id}: ${check.status}` +
      (check.exitCode === null ? "" : ` (exit ${String(check.exitCode)})`) +
      (check.reason === null ? "" : ` [${check.reason}]`),
    reference: `verification-evidence#${kind}.${check.id}`,
  }));
}

/**
 * The key the orchestrator owns inside the controlled verification artifact. Model-authored
 * sections live beside it under their own stage key and are never read as evidence.
 */
export const DETERMINISTIC_EVIDENCE_KEY = "deterministic_evidence";

/**
 * The one controlled artifact deterministic evidence is written into. Named here rather than imported
 * from the persistence package so the mapping from a verification stage to its artifact stays a single
 * decision in the module that owns the evidence.
 */
export const VERIFICATION_ARTIFACT_NAME = "verification";

/**
 * Folds one collected bundle into the controlled verification artifact.
 *
 * Attempts are appended, never replaced: a fix loop leaves a trail of what actually ran, and the
 * freshness fields on each attempt are what stop an earlier result from being read as proof about
 * later code. The model's own section is carried through untouched.
 */
export function mergeDeterministicEvidence(
  composed: unknown,
  stage: WorkStage,
  bundle: VerificationEvidenceBundle | null,
): unknown {
  if (bundle === null || !isRecord(composed)) {
    return composed;
  }

  const existing = composed[DETERMINISTIC_EVIDENCE_KEY];
  const previous: Record<string, unknown> = isRecord(existing) ? existing : {};
  const attempts: unknown = previous[stage];

  return {
    ...composed,
    [DETERMINISTIC_EVIDENCE_KEY]: {
      ...previous,
      [stage]: Array.isArray(attempts) ? [...(attempts as unknown[]), bundle] : [bundle],
    },
  };
}
