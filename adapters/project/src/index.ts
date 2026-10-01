/**
 * The project adapter: everything this framework knows how to say about a repository, and the one
 * place that is allowed to run a command in it.
 *
 * The public surface is deliberately small. `discoverProject` reports facts, `loadProjectVerificationConfig`
 * reports declared commands, `ProjectVerificationProvider` implements the orchestration
 * `VerificationProvider` port, `ProjectRuntimeVerificationProvider` implements the runtime port, and
 * `runChildProcess` and `startChildProcess` are the shared deterministic runners. Nothing here writes to
 * the project, nothing here follows a symbolic link, and nothing here accepts a command that came from a
 * model.
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
  startChildProcess,
} from "./process.js";
export type {
  ChildProcessOutcome,
  ChildProcessRequest,
  ProcessFailureReason,
  ProcessStreamCapture,
  ProcessTermination,
  RunChildProcessOptions,
  SupervisedChildProcess,
  SupervisedChildProcessRequest,
} from "./process.js";

export {
  ALLOWED_PACKAGE_MANAGER_SUBCOMMANDS,
  assertArgs,
  assertExecutable,
  assertNoCommandShell,
  assertPackageManagerInvocation,
  buildVerificationCommand,
  CAPABILITIES_BY_STAGE,
  capabilityBelongsToStage,
  capabilitiesForStage,
  FORBIDDEN_PACKAGE_SCRIPTS,
  implicitScriptHook,
  isNodePackageManager,
  packageManagerScriptOf,
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

export { parseRuntimeVerificationConfiguration } from "./runtime-config.js";

export {
  MAX_RUNTIME_RESPONSE_BYTES,
  performHttpCheck,
  resolveHttpTarget,
} from "./http-check.js";
export type { HttpCheckOutcome, HttpCheckRequest } from "./http-check.js";

export {
  createProjectRuntimeVerificationProvider,
  ProjectRuntimeVerificationProvider,
} from "./runtime.js";
export type { ProjectRuntimeVerificationOptions } from "./runtime.js";

export { runtimeCheckEvidence } from "./runtime-evidence.js";

export {
  DEFAULT_MAX_FINGERPRINT_FILES,
  DEFAULT_MAX_FINGERPRINT_FILE_BYTES,
  FINGERPRINT_IGNORED_DIRECTORIES,
  CONTROL_PLANE_DIRECTORIES,
  fingerprintControlPlane,
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

export {
  createProjectSecurityReviewProvider,
  ProjectSecurityReviewProvider,
  SECURITY_SCAN_CEILING,
} from "./security.js";
export type { ProjectSecurityReviewProviderOptions } from "./security.js";

export { MAX_MANIFEST_BYTES, resolveInsideRoot } from "./fs-safe.js";
