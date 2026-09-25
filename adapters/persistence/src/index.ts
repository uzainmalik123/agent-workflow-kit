import { WorkflowStateMachine } from "@agent-workflow-kit/core";
import type { FeatureSession } from "./contracts.js";

export {
  FEATURE_ARTIFACT_FILENAMES,
  FEATURE_ARTIFACT_NAMES,
  FEATURE_SESSION_SCHEMA_VERSION,
  createEmptyArtifactReferences,
} from "./contracts.js";
export type {
  Clock,
  CreateFeatureSessionInput,
  FeatureArtifactFilename,
  FeatureArtifactName,
  FeatureArtifactReference,
  FeatureArtifactReferences,
  FeatureArtifactStatus,
  FeatureEvent,
  FeatureSession,
  FeatureSessionSchemaVersion,
  FeatureSessionUpdate,
  FeatureSessionUpdater,
} from "./contracts.js";
export { PersistenceError } from "./errors.js";
export type { PersistenceErrorCode, PersistenceErrorOptions } from "./errors.js";
export {
  FEATURE_SLUG_MAX_LENGTH,
  assertFeatureId,
  featureDirectoryName,
  formatFeatureDirectoryName,
  isCanonicalFeatureSlug,
  isFeatureId,
  parseFeatureDirectoryName,
  sanitizeFeatureSlug,
} from "./names.js";
export {
  isFeatureArtifactName,
  isJsonArtifactName,
  isTextArtifactName,
  parseArtifact,
  serializeArtifact,
} from "./artifacts.js";
export {
  FeatureSessionStore,
  createFeatureSessionStore,
} from "./session-store.js";
export type {
  FeatureSessionStoreConfig,
  FeatureSessionStoreOptions,
} from "./session-store.js";
export { WorkflowStateMachine } from "@agent-workflow-kit/core";
export type { WorkflowMachineSnapshot } from "@agent-workflow-kit/core";

export function restoreWorkflowStateMachine(session: FeatureSession): WorkflowStateMachine {
  return new WorkflowStateMachine(session.machine);
}
