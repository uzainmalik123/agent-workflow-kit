/* eslint-disable @typescript-eslint/no-deprecated -- this barrel re-exports the deprecated role-keyed names so they stay reachable; each one is marked deprecated at its definition */
export { OpenCodeAdapterError, isOpenCodeAdapterError } from "./errors.js";
export type { OpenCodeAdapterErrorCode } from "./errors.js";

export {
  agentFilePathForProfile,
  agentFilePathForRole,
  assertNoProjectProfileShadow,
  assertNoRepositoryConfigBoundaryCrossing,
  assertOpenCodeConfigurationIntegrity,
  FRAMEWORK_SENSITIVE_CONFIG_FIELDS,
  OPENCODE_AGENT_SOURCE_DIRECTORIES,
  OPENCODE_ALTERNATE_PROJECT_CONFIG_PATHS,
  OPENCODE_CONTROL_PLANE_DIRECTIVES,
  openCodeAgentIdForPath,
} from "./configuration-integrity.js";
export type {
  ConfigurationIntegrityOptions,
  ConfigurationIntegrityProblem,
  ConfigurationIntegrityReason,
} from "./configuration-integrity.js";

export { AGENTS_MD_PRECEDENCE, FRAMEWORK_HARD_RULES } from "./hard-rules.js";

export {
  READ_ONLY_ROLES,
  WRITE_CAPABLE_ROLES,
  AGENT_BY_STAGE,
  OPENCODE_PROFILES,
  OPENCODE_ROLES,
  PROFILE_BY_STAGE,
  accessForRole,
  agentFileNameForProfile,
  agentForProfile,
  agentForRole,
  agentForStage,
  isOpenCodeProfile,
  isStageRole,
  isWriteCapableProfile,
  isWriteCapableRole,
  profileForAgent,
  profileForRole,
  profileForStage,
  roleDefinition,
  roleForStage,
  rolesForProfile,
  stagesForRole,
} from "./roles.js";
export type { OpenCodeAccessLevel, OpenCodeProfile, OpenCodeRoleDefinition } from "./roles.js";

export {
  DENY_ALL_RULE,
  effectFor,
  isReadOnlyProfile,
  isReadOnlyRole,
  matchesResourcePattern,
  operationEffect,
  permissionRulesForProfile,
  permissionRulesForRole,
  readOnlyRoles,
  writeCapableRoles,
  FRAMEWORK_OWNED_EDIT_PATTERNS,
  PROTECTED_PATH_PATTERNS,
  READ_ONLY_PERMISSION_RULES,
  SECRET_PATH_PATTERNS,
  SHELL_ALLOWLIST,
  UNIVERSAL_ALLOWED_ACTIONS,
  UNIVERSAL_DENIAL_ACTIONS,
  WRITE_CAPABLE_PERMISSION_RULES,
} from "./permissions.js";
export type {
  OpenCodePermissionEffect,
  OpenCodePermissionRule,
  OpenCodePermissionRuleset,
} from "./permissions.js";

export {
  AGENT_MODE,
  HARD_RULES_HEADING,
  agentFileName,
  OPENCODE_AGENT_DIRECTORY,
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_PROJECT_CONFIG_PATH,
  renderAgentMarkdown,
  renderOpenCodeProjectConfig,
  renderOpenCodeProjectFiles,
  renderRoleInstructions,
  renderRoleInstructionsForRole,
  writeOpenCodeProjectFiles,
} from "./agents.js";
export type {
  GeneratedOpenCodeFile,
  OpenCodeFileWriteOutcome,
  OpenCodeFileWriteResult,
  WriteOpenCodeProjectFilesOptions,
} from "./agents.js";

export { PLAN_EXAMPLE, RESPONSE_FENCE_REMINDER, buildStagePrompt } from "./prompts.js";
export type { BuildStagePromptInput } from "./prompts.js";

export {
  DEFAULT_MAX_PROJECT_INSTRUCTION_CHARS,
  loadProjectInstructions,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "./project-instructions.js";
export type {
  LoadProjectInstructionsOptions,
  ProjectInstructions,
} from "./project-instructions.js";

export {
  assertNoProjectLocalPlugins,
  describeProjectLocalPluginFindings,
  EXECUTABLE_PLUGIN_ENTRY_NAMES,
  EXECUTABLE_PLUGIN_EXTENSIONS,
  findProjectLocalPlugins,
  findRepositoryRoot,
  PROJECT_LOCAL_PLUGIN_DIRECTORIES,
  REPOSITORY_ROOT_MARKER,
} from "./plugin-preflight.js";
export type {
  FindProjectLocalPluginsOptions,
  OpenCodeProjectPluginFinding,
  OpenCodeProjectPluginFindingKind,
} from "./plugin-preflight.js";

export {
  extractStructuredResponse,
  parseStageResponse,
  RESPONSE_PROTOCOL_VERSION,
  STRUCTURED_RESPONSE_FIELDS,
  STRUCTURED_RESPONSE_FIELD_LIST,
  WORKFLOW_CONTROL_FIELDS,
} from "./response-protocol.js";

export { DEFAULT_TIMEOUT_MS } from "./transport.js";
export type {
  OpenCodeRawResult,
  OpenCodeTransport,
  OpenCodeTransportRequest,
  StageProgressCallback,
  StageProgressEvent,
} from "./transport.js";

export {
  createActivityRelay,
  createLineBuffer,
  extractToolUseLine,
  stripAnsiCodes,
  PROGRESS_LINE_MAX_CHARS,
  TOOL_USE_MARKERS,
} from "./progress.js";
export type { ActivityRelay, LineBuffer } from "./progress.js";

export {
  buildOpenCodeInvocation,
  createOpenCodeCliTransport,
  extractResponseText,
  OpenCodeCliTransport,
  parseEventStream,
  toCliFormat,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_OPENCODE_COMMAND,
  DEFAULT_STDERR_EXCERPT_LIMIT,
} from "./cli-transport.js";
export type {
  OpenCodeCliFormat,
  OpenCodeCliTransportOptions,
  OpenCodeInvocation,
  OpenCodeResponseFormat,
  ParsedEventStream,
} from "./cli-transport.js";
export type { ProcessOutcomeObservation } from "./process.js";

export {
  annotateInvocationOutcome,
  describeRecordingError,
  INVOCATION_MANIFEST_FILENAME,
  INVOCATION_SEGMENT_MAX_LENGTH,
  INVOCATION_STDERR_FILENAME,
  INVOCATION_STDOUT_FILENAME,
  OPENCODE_RECORDINGS_DIRECTORY,
  recordStageInvocation,
  safeRecordingSegment,
  stageRecordingFolder,
} from "./diagnostics.js";
export type {
  InvocationOutcomeAnnotation,
  RecordedInvocation,
  StageInvocationIdentity,
  StageInvocationRecording,
} from "./diagnostics.js";

export {
  advertisesFlag,
  DEBUG_AGENTS_COMMAND,
  DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
  describeCapabilities,
  missingRunCapabilities,
  parseMajorVersion,
  probeOpenCodeCapabilities,
  REQUIRED_RUN_FLAGS,
  TARGET_OPENCODE_MAJOR,
} from "./capabilities.js";
export type { OpenCodeCapabilities, ProbeOpenCodeCapabilitiesOptions } from "./capabilities.js";

export {
  buildStageRunEnvironment,
  isScrubbedEnvironmentName,
  OPENCODE_CONFIG_INJECTION_VARIABLES,
  OPENCODE_CONFIG_SUPPRESSING_VARIABLES,
  OPENCODE_SCRUBBED_PREFIXES,
  OPENCODE_SCRUBBED_VARIABLES,
  OPENCODE_SMOKE_TEST_FORCED_ENVIRONMENT,
} from "./environment.js";
export type { StageRunEnvironment, StageRunEnvironmentOptions } from "./environment.js";

export {
  DEFAULT_AGENT_LISTING_READY_TIMEOUT_MS,
  DEFAULT_AGENT_LISTING_TIMEOUT_MS,
  DEFAULT_SMOKE_TEST_TIMEOUT_MS,
  describeSmokeTest,
  parseAgentListing,
  runOpenCodeConfigSmokeTest,
  verifyRuleset,
} from "./smoke-test.js";
export type {
  OpenCodeListedAgent,
  OpenCodeSmokeTestAgentReport,
  OpenCodeSmokeTestCheck,
  OpenCodeSmokeTestReport,
  RunOpenCodeConfigSmokeTestOptions,
} from "./smoke-test.js";

export {
  createOpenCodeStageExecutor,
  DEFAULT_FORMAT_RETRIES,
  formatReplyRejectionNotice,
  OpenCodeStageExecutor,
  REJECTED_REPLY_EXCERPT_MAX_CHARS,
  RETRYABLE_REPLY_FAILURES,
} from "./executor.js";
export type { OpenCodeStageExecutorOptions } from "./executor.js";

export {
  ARTIFACT_TRACKING_MODES,
  DEFAULT_ARTIFACT_TRACKING_MODE,
  DEFAULT_GITIGNORE_LINES,
  INSTALL_POLICY_DECISION,
  RUNTIME_GENERATED_ENTRIES,
  VERSION_CONTROLLED_ENTRIES,
  VENDORED_FRAMEWORK_PATHS,
} from "./install-policy.js";
export type { ArtifactTrackingMode, InstallPolicyEntry } from "./install-policy.js";

export {
  assertOpenCodeRuntimeConfigIntegrity,
  createOpenCodeRuntimeConfig,
  defaultRuntimeConfigDirectory,
  isInsideRepository,
  OPENCODE_RUNTIME_AGENT_DIRECTORY,
  OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE,
  OPENCODE_RUNTIME_DIRECTORY_NAME,
  removeOpenCodeRuntimeConfig,
  renderOpenCodeRuntimeConfigFiles,
  runtimeAgentFileForProfile,
  type CreateRuntimeConfigOptions,
  type OpenCodeRuntimeConfig,
} from "./runtime-config.js";
