import { PersistenceError } from "./errors.js";
import {
  FEATURE_ARTIFACT_FILENAMES,
  FEATURE_ARTIFACT_NAMES,
  FEATURE_SESSION_SCHEMA_VERSION,
  type FeatureApprovals,
  type FeatureArtifactName,
  type FeatureArtifactReference,
  type FeatureArtifactReferences,
  type FeatureSession,
  type PlanApprovalRecord,
  type PushApprovalRecord,
} from "./contracts.js";
import { isFeatureId, isCanonicalFeatureSlug } from "./names.js";
import { WorkflowStateMachine, validateWorkspaceBaseline } from "@agent-workflow-kit/core";
import type { WorkflowMachineSnapshot, WorkspaceBaseline } from "@agent-workflow-kit/core";

export interface FeatureSessionValidationContext {
  readonly expectedFeatureId?: string;
  readonly expectedDirectoryName?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validateArtifactReference(
  name: FeatureArtifactName,
  value: unknown,
): FeatureArtifactReference {
  if (!isRecord(value)) {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session artifact reference "${name}" must be an object.`,
    );
  }

  const filename = value["filename"];
  const status = value["status"];
  const updatedAt = value["updatedAt"];

  if (filename !== FEATURE_ARTIFACT_FILENAMES[name]) {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session artifact reference "${name}" has an invalid filename.`,
    );
  }

  if (status !== "missing" && status !== "present") {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session artifact reference "${name}" has an invalid status.`,
    );
  }

  if (updatedAt !== undefined && !isTimestamp(updatedAt)) {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session artifact reference "${name}" has an invalid timestamp.`,
    );
  }

  const validFilename = FEATURE_ARTIFACT_FILENAMES[name];
  const validStatus = status;

  if (updatedAt === undefined) {
    return { filename: validFilename, status: validStatus };
  }

  return { filename: validFilename, status: validStatus, updatedAt };
}

function validateArtifactReferences(value: unknown): FeatureArtifactReferences {
  if (!isRecord(value)) {
    throw new PersistenceError("INVALID_SESSION", "Session artifacts must be an object.");
  }

  const allowedNames = new Set<string>(FEATURE_ARTIFACT_NAMES);
  const unexpectedNames = Object.keys(value).filter((name) => !allowedNames.has(name));

  if (unexpectedNames.length > 0) {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session artifacts contains an unknown artifact: "${unexpectedNames[0] ?? ""}".`,
    );
  }

  const references = {} as Record<FeatureArtifactName, FeatureArtifactReference>;

  for (const name of FEATURE_ARTIFACT_NAMES) {
    references[name] = validateArtifactReference(name, value[name]);
  }

  return references;
}

function validateRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session revision must be a non-negative integer.",
    );
  }

  return value;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function validateSha256(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session ${fieldName} must be a lowercase SHA-256 hex digest.`,
    );
  }

  return value;
}

function validatePlanApproval(value: unknown): PlanApprovalRecord {
  if (!isRecord(value)) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session plan approval must be an object or null.",
    );
  }

  const approvedAt = value["approvedAt"];
  const approvedRevision = value["approvedRevision"];

  if (!isTimestamp(approvedAt)) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session plan approval must contain a valid approvedAt timestamp.",
    );
  }

  if (typeof approvedRevision !== "number" || !Number.isInteger(approvedRevision) || approvedRevision < 0) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session plan approval approvedRevision must be a non-negative integer.",
    );
  }

  const baseline = value["baseline"];

  if (baseline !== undefined && baseline !== null) {
    const validated = validateWorkspaceBaseline(baseline);

    if (!validated.ok) {
      throw new PersistenceError("INVALID_SESSION", `Session plan approval baseline: ${validated.message}`);
    }
  }

  return {
    approvedAt,
    approvedRevision,
    specSha256: validateSha256(value["specSha256"], "plan approval specSha256"),
    planSha256: validateSha256(value["planSha256"], "plan approval planSha256"),
    planReviewSha256: validateSha256(value["planReviewSha256"], "plan approval planReviewSha256"),
    baseline: baseline === undefined || baseline === null ? null : (baseline as WorkspaceBaseline),
  };
}

function validateApprovalRevision(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session push approval ${fieldName} must be a non-negative integer.`,
    );
  }

  return value;
}

function validateFingerprint(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session push approval ${fieldName} must be a non-empty fingerprint.`,
    );
  }

  return value;
}

function validatePushApproval(value: unknown): PushApprovalRecord {
  if (!isRecord(value)) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session push approval must be an object or null.",
    );
  }

  if (value["decision"] !== "approved") {
    throw new PersistenceError(
      "INVALID_SESSION",
      'Session push approval must record the decision "approved". A refusal is not a record.',
    );
  }

  const approvedAt = value["approvedAt"];

  if (!isTimestamp(approvedAt)) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session push approval must contain a valid approvedAt timestamp.",
    );
  }

  const featureId = value["featureId"];

  if (typeof featureId !== "string" || featureId.length === 0) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session push approval must name the feature it approves.",
    );
  }

  const approvedRevision = validateApprovalRevision(value["approvedRevision"], "approvedRevision");
  const summaryRevision = validateApprovalRevision(value["summaryRevision"], "summaryRevision");
  const finalGateRevision = validateApprovalRevision(value["finalGateRevision"], "finalGateRevision");
  const actor = value["actor"];

  if (actor !== undefined && actor !== null && (typeof actor !== "string" || actor.length === 0)) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session push approval actor must be a non-empty string or null.",
    );
  }

  if (value["finalGateStatus"] !== "passed") {
    throw new PersistenceError(
      "INVALID_SESSION",
      'Session push approval may only record a final gate that "passed".',
    );
  }

  // The working-tree fingerprints are deliberately the two digests here that are not required to be a
  // SHA-256: they are whatever the workspace adapter measures, and this layer does not own that
  // format. They are required to be non-empty because an unmeasured tree is not something an approval
  // can be bound to.
  const workingTreeFingerprint = validateFingerprint(
    value["workingTreeFingerprint"],
    "workingTreeFingerprint",
  );
  const finalGateFingerprint = validateFingerprint(
    value["finalGateFingerprint"],
    "finalGateFingerprint",
  );

  return {
    decision: "approved",
    featureId,
    approvedAt,
    approvedRevision,
    actor: actor === undefined || actor === null ? null : actor,
    summarySha256: validateSha256(value["summarySha256"], "push approval summarySha256"),
    summaryRevision,
    workingTreeFingerprint,
    finalGateStatus: "passed",
    finalGateRevision,
    finalGateFingerprint,
    finalGateSha256: validateSha256(value["finalGateSha256"], "push approval finalGateSha256"),
  };
}

function validateApprovals(value: unknown): FeatureApprovals {
  if (value === undefined) {
    throw new PersistenceError(
      "INVALID_SESSION",
      "Session data must contain approvals.",
    );
  }

  if (!isRecord(value)) {
    throw new PersistenceError("INVALID_SESSION", "Session approvals must be an object.");
  }

  const unexpected = Object.keys(value).filter((key) => key !== "plan" && key !== "push");

  if (unexpected.length > 0) {
    throw new PersistenceError(
      "INVALID_SESSION",
      `Session approvals contains an unknown approval: "${unexpected[0] ?? ""}".`,
    );
  }

  const plan = value["plan"];
  const push = value["push"];

  return {
    plan: plan === undefined || plan === null ? null : validatePlanApproval(plan),
    push: push === undefined || push === null ? null : validatePushApproval(push),
  };
}

function validateMachineSnapshot(value: unknown): WorkflowMachineSnapshot {
  if (!isRecord(value)) {
    throw new PersistenceError(
      "INVALID_WORKFLOW_SNAPSHOT",
      "Session machine must be a workflow snapshot object.",
    );
  }

  try {
    return new WorkflowStateMachine(value as unknown as WorkflowMachineSnapshot).snapshot;
  } catch (error) {
    throw new PersistenceError(
      "INVALID_WORKFLOW_SNAPSHOT",
      "Session machine contains an invalid WorkflowMachineSnapshot.",
      { cause: error },
    );
  }
}

export function parseFeatureSessionDocument(
  value: unknown,
  context: FeatureSessionValidationContext = {},
): FeatureSession {
  if (!isRecord(value)) {
    throw new PersistenceError("MALFORMED_SESSION", "Session data must be a JSON object.");
  }

  if (value["schemaVersion"] === undefined) {
    throw new PersistenceError(
      "MALFORMED_SESSION",
      "Session data must contain schemaVersion.",
    );
  }

  if (value["schemaVersion"] !== FEATURE_SESSION_SCHEMA_VERSION) {
    throw new PersistenceError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "Unsupported session schema version.",
    );
  }

  const featureId = value["featureId"];
  const slug = value["slug"];
  const title = value["title"];
  const createdAt = value["createdAt"];
  const updatedAt = value["updatedAt"];

  if (!isFeatureId(featureId)) {
    throw new PersistenceError(
      "INVALID_FEATURE_ID",
      "Session featureId must match F- followed by at least three digits.",
    );
  }

  if (!isCanonicalFeatureSlug(slug)) {
    throw new PersistenceError(
      "INVALID_SLUG",
      "Session slug is not a canonical sanitized feature slug.",
    );
  }

  if (typeof title !== "string" || title.trim().length === 0) {
    throw new PersistenceError("INVALID_SESSION", "Session title must be a non-empty string.");
  }

  if (!isTimestamp(createdAt)) {
    throw new PersistenceError("INVALID_SESSION", "Session createdAt must be a valid timestamp.");
  }

  if (!isTimestamp(updatedAt)) {
    throw new PersistenceError("INVALID_SESSION", "Session updatedAt must be a valid timestamp.");
  }

  if (context.expectedFeatureId !== undefined && featureId !== context.expectedFeatureId) {
    throw new PersistenceError(
      "FEATURE_MISMATCH",
      `Session featureId "${featureId}" does not match directory feature "${context.expectedFeatureId}".`,
    );
  }

  if (context.expectedDirectoryName !== undefined) {
    const expectedDirectoryName = `${featureId}-${slug}`;

    if (expectedDirectoryName !== context.expectedDirectoryName) {
      throw new PersistenceError(
        "FEATURE_MISMATCH",
        `Session directory metadata does not match feature directory "${context.expectedDirectoryName}".`,
      );
    }
  }

  return {
    schemaVersion: FEATURE_SESSION_SCHEMA_VERSION,
    featureId,
    slug,
    title,
    revision: validateRevision(value["revision"]),
    createdAt,
    updatedAt,
    machine: validateMachineSnapshot(value["machine"]),
    artifacts: validateArtifactReferences(value["artifacts"]),
    approvals: validateApprovals(value["approvals"]),
  };
}
