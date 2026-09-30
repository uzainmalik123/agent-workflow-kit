export { GitWorkspaceProvider, type GitWorkspaceProviderOptions } from "./provider.js";
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
export { GIT_MAX_OUTPUT_BYTES, GIT_TIMEOUT_MS, runGit, tryGit, type GitOutcome, type GitResult } from "./git.js";
