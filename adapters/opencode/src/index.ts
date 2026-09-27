export { OpenCodeAdapterError, isOpenCodeAdapterError } from "./errors.js";
export type { OpenCodeAdapterErrorCode } from "./errors.js";

export { AGENTS_MD_PRECEDENCE, FRAMEWORK_HARD_RULES } from "./hard-rules.js";

export {
  READ_ONLY_ROLES,
  WRITE_CAPABLE_ROLES,
  OPENCODE_ROLES,
  accessForRole,
  agentForRole,
  agentForStage,
  isStageRole,
  isWriteCapableRole,
  roleDefinition,
  roleForAgent,
  roleForStage,
  stagesForRole,
  AGENT_BY_STAGE,
} from "./roles.js";
export type { OpenCodeAccessLevel, OpenCodeRoleDefinition } from "./roles.js";

export {
  DENY_ALL_RULE,
  effectFor,
  isReadOnlyRole,
  matchesResourcePattern,
  operationEffect,
  permissionRulesForRole,
  PROTECTED_PATH_PATTERNS,
  readOnlyRoles,
  READ_ONLY_PERMISSION_RULES,
  SECRET_PATH_PATTERNS,
  UNIVERSAL_ALLOWED_ACTIONS,
  UNIVERSAL_DENIAL_ACTIONS,
  WRITE_CAPABLE_PERMISSION_RULES,
  writeCapableRoles,
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

export { buildStagePrompt } from "./prompts.js";
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
} from "./transport.js";

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

export {
  advertisesFlag,
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
  DEFAULT_SMOKE_TEST_TIMEOUT_MS,
  describeSmokeTest,
  runOpenCodeConfigSmokeTest,
  verifyRuleset,
} from "./smoke-test.js";
export type {
  OpenCodeSmokeTestAgentReport,
  OpenCodeSmokeTestCheck,
  OpenCodeSmokeTestReport,
  RunOpenCodeConfigSmokeTestOptions,
} from "./smoke-test.js";

export { createOpenCodeStageExecutor, OpenCodeStageExecutor } from "./executor.js";
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
