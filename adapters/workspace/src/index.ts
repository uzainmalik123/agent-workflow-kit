export { GitWorkspaceProvider, type GitWorkspaceProviderOptions, defaultCacheRoot } from "./provider.js";
export { WorkspaceAdapterError, WORKSPACE_ADAPTER_ERROR_CODES, type WorkspaceAdapterErrorCode } from "./errors.js";
export { acquireLease, leaseIsHeldByALiveProcess, processIsAlive, releaseLease, DEFAULT_LEASE_TTL_MS } from "./lease.js";
export { parseStatus, trackedStateFrom, type ParsedStatus, type TrackedState } from "./status.js";
export {
  SIDECAR_SUFFIX,
  SIDECAR_VERSION,
  readSidecar,
  sidecarPath,
  writeSidecar,
  type WorkspaceLease,
  type WorkspaceSidecar,
} from "./sidecar.js";
export { assertRepositoryRelative, resolveInside, resolveRealPathInside } from "./paths.js";
export {
  GIT_MAX_OUTPUT_BYTES,
  GIT_TIMEOUT_MS,
  runGit,
  runPublishGit,
  tryGit,
  tryPublishGit,
  type GitOutcome,
  type GitRequest,
  type GitResult,
} from "./git.js";
export { GitFeaturePublisher, PUBLISH_PUSH_TIMEOUT_MS } from "./publisher.js";
