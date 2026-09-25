import { PersistenceError } from "./errors.js";
import {
  FEATURE_ARTIFACT_FILENAMES,
  FEATURE_ARTIFACT_NAMES,
  FEATURE_SESSION_SCHEMA_VERSION,
  type FeatureArtifactName,
  type FeatureArtifactReference,
  type FeatureArtifactReferences,
  type FeatureSession,
} from "./contracts.js";
import { isFeatureId, isCanonicalFeatureSlug } from "./names.js";
import { WorkflowStateMachine } from "@agent-workflow-kit/core";
import type { WorkflowMachineSnapshot } from "@agent-workflow-kit/core";

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
    createdAt,
    updatedAt,
    machine: validateMachineSnapshot(value["machine"]),
    artifacts: validateArtifactReferences(value["artifacts"]),
  };
}
