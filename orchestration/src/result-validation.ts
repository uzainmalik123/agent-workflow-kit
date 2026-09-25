import type { ReviewFinding, VerificationEvidence } from "@agent-workflow-kit/core";
import {
  isFeatureArtifactName,
  type FeatureArtifactName,
} from "@agent-workflow-kit/persistence";
import type { OrchestrationErrorCode } from "./errors.js";
import { isStageOutcome, type StageArtifactOutput, type StageExecutionRequest, type StageExecutionResult } from "./executor.js";
import { isWorkStage, STAGE_DEFINITIONS } from "./stages.js";

const RESULT_FIELDS: ReadonlySet<string> = new Set([
  "outcome",
  "featureId",
  "stage",
  "artifacts",
  "findings",
  "evidence",
  "summary",
]);

const WORKFLOW_CONTROL_FIELDS: ReadonlySet<string> = new Set([
  "event",
  "events",
  "workflowEvent",
  "nextState",
  "state",
  "transition",
  "transitions",
  "machine",
  "session",
  "commit",
  "push",
  "approve",
]);

const ARTIFACT_FIELDS: ReadonlySet<string> = new Set(["name", "content"]);

const FINDING_SEVERITIES: ReadonlySet<string> = new Set(["info", "warning", "error"]);

const EVIDENCE_KINDS: ReadonlySet<string> = new Set(["static", "test", "runtime", "security"]);

export type StageResultValidation =
  | { readonly ok: true; readonly result: StageExecutionResult }
  | {
      readonly ok: false;
      readonly code: OrchestrationErrorCode;
      readonly message: string;
    };

type ListValidation =
  | { readonly ok: true; readonly value: readonly unknown[] }
  | { readonly ok: false; readonly message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: OrchestrationErrorCode, message: string): StageResultValidation {
  return { ok: false, code, message };
}

function optionalList(value: unknown): ListValidation {
  if (value === undefined) {
    return { ok: true, value: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, message: "Stage result lists must be arrays." };
  }

  return { ok: true, value };
}

function validateFindings(value: unknown, featureId: string): ListValidation {
  const list = optionalList(value);

  if (!list.ok) {
    return list;
  }

  for (const entry of list.value) {
    if (!isRecord(entry)) {
      return { ok: false, message: "Stage result findings must be objects." };
    }

    if (entry["featureId"] !== featureId) {
      return { ok: false, message: "Every stage finding must reference the executed feature." };
    }

    const severity = entry["severity"];

    if (typeof severity !== "string" || !FINDING_SEVERITIES.has(severity)) {
      return { ok: false, message: "Stage finding severity must be info, warning, or error." };
    }

    const message = entry["message"];

    if (typeof message !== "string" || message.length === 0) {
      return { ok: false, message: "Stage findings must include a non-empty message." };
    }

    const filePath = entry["filePath"];

    if (filePath !== undefined && (typeof filePath !== "string" || filePath.length === 0)) {
      return { ok: false, message: "Stage finding filePath must be a non-empty string." };
    }

    const line = entry["line"];

    if (line !== undefined && (typeof line !== "number" || !Number.isInteger(line))) {
      return { ok: false, message: "Stage finding line must be an integer." };
    }
  }

  return list;
}

function validateEvidence(value: unknown): ListValidation {
  const list = optionalList(value);

  if (!list.ok) {
    return list;
  }

  for (const entry of list.value) {
    if (!isRecord(entry)) {
      return { ok: false, message: "Stage result evidence must be objects." };
    }

    const kind = entry["kind"];

    if (typeof kind !== "string" || !EVIDENCE_KINDS.has(kind)) {
      return { ok: false, message: "Stage evidence kind must be static, test, runtime, or security." };
    }

    const description = entry["description"];

    if (typeof description !== "string" || description.length === 0) {
      return { ok: false, message: "Stage evidence must include a non-empty description." };
    }

    const reference = entry["reference"];

    if (reference !== undefined && (typeof reference !== "string" || reference.length === 0)) {
      return { ok: false, message: "Stage evidence reference must be a non-empty string." };
    }
  }

  return list;
}

export function validateStageExecutionResult(
  raw: unknown,
  request: StageExecutionRequest,
): StageResultValidation {
  if (!isRecord(raw)) {
    return invalid("executor_malformed_result", "Stage result must be a JSON object.");
  }

  for (const field of Object.keys(raw)) {
    if (WORKFLOW_CONTROL_FIELDS.has(field)) {
      return invalid(
        "executor_workflow_interference",
        `Stage result must not carry the workflow control field "${field}".`,
      );
    }

    if (!RESULT_FIELDS.has(field)) {
      return invalid("executor_malformed_result", `Stage result contains an unknown field "${field}".`);
    }
  }

  const outcome = raw["outcome"];

  if (!isStageOutcome(outcome)) {
    return invalid(
      "executor_malformed_result",
      "Stage result outcome must be success, needs_fix, failed, or inconclusive.",
    );
  }

  const featureId = raw["featureId"];

  if (typeof featureId !== "string" || featureId.length === 0) {
    return invalid("executor_malformed_result", "Stage result featureId must be a non-empty string.");
  }

  if (featureId !== request.feature.featureId) {
    return invalid(
      "executor_result_mismatch",
      `Stage result feature "${featureId}" does not match the orchestrated feature "${request.feature.featureId}".`,
    );
  }

  const stage = raw["stage"];

  if (!isWorkStage(stage)) {
    return invalid("executor_malformed_result", "Stage result stage must be a known work stage.");
  }

  if (stage !== request.stage) {
    return invalid(
      "executor_result_mismatch",
      `Stage result stage "${stage}" does not match the executing stage "${request.stage}".`,
    );
  }

  const definition = STAGE_DEFINITIONS[request.stage];
  const expected = new Set<FeatureArtifactName>(definition.outputs.map((output) => output.name));
  const rawArtifacts = raw["artifacts"];

  if (rawArtifacts !== undefined && !Array.isArray(rawArtifacts)) {
    return invalid("executor_malformed_result", "Stage result artifacts must be an array.");
  }

  const entries = Array.isArray(rawArtifacts) ? rawArtifacts : [];
  const produced = new Set<FeatureArtifactName>();
  const artifacts: StageArtifactOutput[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) {
      return invalid("executor_malformed_result", "Stage result artifact entries must be objects.");
    }

    for (const field of Object.keys(entry)) {
      if (!ARTIFACT_FIELDS.has(field)) {
        return invalid(
          "executor_malformed_result",
          `Stage result artifact contains an unknown field "${field}".`,
        );
      }
    }

    const name = entry["name"];

    if (!isFeatureArtifactName(name)) {
      return invalid(
        "unexpected_artifact",
        "Stage result artifact name is not a controlled artifact name.",
      );
    }

    if (!expected.has(name)) {
      return invalid(
        "unexpected_artifact",
        `Stage "${request.stage}" may not produce the artifact "${name}".`,
      );
    }

    if (produced.has(name)) {
      return invalid("duplicate_artifact", `Stage result repeats the artifact "${name}".`);
    }

    if (entry["content"] === undefined) {
      return invalid(
        "executor_malformed_result",
        `Stage result artifact "${name}" must include content.`,
      );
    }

    produced.add(name);
    artifacts.push({ name, content: entry["content"] });
  }

  if (outcome === "success" || outcome === "needs_fix") {
    for (const output of definition.outputs) {
      if (!produced.has(output.name)) {
        return invalid(
          "missing_required_artifact",
          `Stage "${request.stage}" must produce the artifact "${output.name}".`,
        );
      }
    }
  }

  if (outcome === "failed" && artifacts.length > 0) {
    return invalid("artifacts_not_allowed", "A failed stage must not produce artifacts.");
  }

  if (outcome === "needs_fix" && !definition.fixable) {
    return invalid("illegal_needs_fix", `Stage "${request.stage}" may not request a fix.`);
  }

  const findings = validateFindings(raw["findings"], featureId);

  if (!findings.ok) {
    return invalid("executor_malformed_result", findings.message);
  }

  const evidence = validateEvidence(raw["evidence"]);

  if (!evidence.ok) {
    return invalid("executor_malformed_result", evidence.message);
  }

  const rawSummary = raw["summary"];
  let summary: string | null = null;

  if (rawSummary !== undefined) {
    if (typeof rawSummary !== "string" || rawSummary.length === 0) {
      return invalid("executor_malformed_result", "Stage result summary must be a non-empty string.");
    }

    summary = rawSummary;
  }

  return {
    ok: true,
    result: {
      outcome,
      featureId,
      stage,
      artifacts,
      findings: findings.value as readonly ReviewFinding[],
      evidence: evidence.value as readonly VerificationEvidence[],
      summary,
    },
  };
}
