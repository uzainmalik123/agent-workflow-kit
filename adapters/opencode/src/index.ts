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
  effectFor,
  isReadOnlyRole,
  permissionForRole,
  PROTECTED_PATH_RULES,
  readOnlyRoles,
  READ_ONLY_PERMISSION,
  toolDenyListForRole,
  TOOLS_DENIED_FOR_READ_ONLY_ROLES,
  UNIVERSAL_DENIALS,
  WRITE_CAPABLE_PERMISSION,
  writeCapableRoles,
} from "./permissions.js";
export type {
  OpenCodePermissionEffect,
  OpenCodePermissionMap,
  OpenCodePermissionRule,
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
  extractEventStreamText,
  extractResponseText,
  OpenCodeCliTransport,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_OPENCODE_COMMAND,
  DEFAULT_STDERR_EXCERPT_LIMIT,
} from "./cli-transport.js";
export type { OpenCodeCliTransportOptions, OpenCodeInvocation, OpenCodeResponseFormat } from "./cli-transport.js";

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
