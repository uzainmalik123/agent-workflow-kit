import {
  FEATURE_ARTIFACT_FILENAMES,
  type FeatureArtifactName,
} from "./contracts.js";
import { PersistenceError } from "./errors.js";

const jsonArtifactNames = new Set<FeatureArtifactName>([
  "grill",
  "spec",
  "plan",
  "plan_review",
  "implementation",
  "code_review",
  "scope_review",
  "verification",
  "security_review",
  "final_gate",
  "fixes",
]);

const textArtifactNames = new Set<FeatureArtifactName>(["request", "final_summary"]);

export function isFeatureArtifactName(value: unknown): value is FeatureArtifactName {
  return typeof value === "string" && Object.hasOwn(FEATURE_ARTIFACT_FILENAMES, value);
}

export function isJsonArtifactName(value: FeatureArtifactName): boolean {
  return jsonArtifactNames.has(value);
}

export function isTextArtifactName(value: FeatureArtifactName): boolean {
  return textArtifactNames.has(value);
}

export function serializeArtifact(name: FeatureArtifactName, content: unknown): string {
  if (isTextArtifactName(name)) {
    if (typeof content !== "string") {
      throw new PersistenceError(
        "INVALID_ARTIFACT",
        `Artifact "${name}" must contain text.`,
      );
    }

    return content;
  }

  if (content === undefined || typeof content === "function" || typeof content === "symbol") {
    throw new PersistenceError(
      "INVALID_ARTIFACT",
      `Artifact "${name}" could not be serialized as JSON.`,
    );
  }

  let serialized: unknown;

  try {
    serialized = JSON.stringify(content, null, 2);
  } catch (error) {
    throw new PersistenceError(
      "INVALID_ARTIFACT",
      `Artifact "${name}" could not be serialized as JSON.`,
      { cause: error },
    );
  }

  if (typeof serialized !== "string") {
    throw new PersistenceError(
      "INVALID_ARTIFACT",
      `Artifact "${name}" could not be serialized as JSON.`,
    );
  }

  return `${serialized}\n`;
}

export function parseArtifact(name: FeatureArtifactName, serialized: string): unknown {
  if (isTextArtifactName(name)) {
    return serialized;
  }

  try {
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new PersistenceError(
      "MALFORMED_ARTIFACT",
      `Artifact "${name}" does not contain valid JSON.`,
      { cause: error },
    );
  }
}
