/**
 * The project adapter: everything this framework knows how to say about a repository, and the one
 * place that is allowed to run a command in it.
 *
 * The public surface is deliberately small. `discoverProject` reports facts, `loadProjectVerificationConfig`
 * reports declared commands, `ProjectVerificationProvider` implements the orchestration
 * `VerificationProvider` port, and `runChildProcess` is the shared deterministic runner. Nothing here
 * writes to the project, nothing here follows a symbolic link, and nothing here accepts a command
 * that came from a model.
 */
export { ProjectAdapterError, isProjectAdapterError, isDiscoveryRefusal } from "./errors.js";
export type { ProjectAdapterErrorCode, ProjectAdapterErrorOptions } from "./errors.js";

export {
  DEFAULT_CAPTURE_HEAD_CHARS,
  DEFAULT_CAPTURE_TAIL_CHARS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_STREAM_BYTES,
  describeOutcome,
  PROCESS_TERMINATIONS,
  runChildProcess,
} from "./process.js";
export type {
  ChildProcessOutcome,
  ChildProcessRequest,
  ProcessFailureReason,
  ProcessStreamCapture,
  ProcessTermination,
  RunChildProcessOptions,
} from "./process.js";

export {
  assertArgs,
  assertExecutable,
  assertNoCommandShell,
  assertPackageManagerInvocation,
  buildVerificationCommand,
  CAPABILITIES_BY_STAGE,
  capabilityBelongsToStage,
  capabilitiesForStage,
  FORBIDDEN_PACKAGE_MANAGER_COMMANDS,
  FORBIDDEN_PACKAGE_SCRIPTS,
  implicitScriptHook,
  isNodePackageManager,
  PACKAGE_MANAGERS,
} from "./commands.js";
export type { NodePackageManager, PlannedVerificationCommand } from "./commands.js";

export {
  BUILD_SCRIPTS,
  LINT_SCRIPTS,
  TEST_FALLBACK_SCRIPTS,
  TEST_SCRIPTS,
  TYPECHECK_SCRIPTS,
} from "./node-adapter.js";

export { detectFrameworks, FRAMEWORK_DEFINITIONS, parseDeclaredPackageManager } from "./frameworks.js";
export type { FrameworkDefinition } from "./frameworks.js";

export {
  capabilityList,
  discoverProject,
  NODE_LOCKFILES,
  PROJECT_CAPABILITIES,
  PROJECT_ECOSYSTEMS,
  PROJECT_LANGUAGES,
  unmeasurableCapabilities,
} from "./profile.js";
export type {
  ProjectCapability,
  ProjectEcosystem,
  ProjectLanguage,
  ProjectProfile,
} from "./profile.js";

export { loadProjectVerificationConfig, PROJECT_CONFIG_FILENAME, PROJECT_CONFIG_SCHEMA_VERSION } from "./config.js";
export type { ProjectVerificationConfig } from "./config.js";

export {
  DEFAULT_MAX_FINGERPRINT_FILES,
  DEFAULT_MAX_FINGERPRINT_FILE_BYTES,
  FINGERPRINT_IGNORED_DIRECTORIES,
  fingerprintImplementation,
} from "./fingerprint.js";
export type { FingerprintOptions, ImplementationFingerprint } from "./fingerprint.js";

export {
  absentCheck,
  buildBundle,
  commandEvidence,
  describeCommandOutcome,
  outcomeForChecks,
  profileSummary,
  statusForOutcome,
} from "./evidence.js";

export {
  createProjectVerificationProvider,
  ProjectVerificationProvider,
} from "./provider.js";
export type { ProjectVerificationProviderOptions } from "./provider.js";

export { MAX_MANIFEST_BYTES, resolveInsideRoot } from "./fs-safe.js";
