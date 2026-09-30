/**
 * The one failure type this adapter raises on its own behalf.
 *
 * Every refusal the adapter decides for itself carries one of these codes. A refusal is not an
 * exception thrown at a caller who is expected to recover: the point of the codes is that whoever
 * reads the result can tell the difference between "this repository is not one I can work in" and
 * "this workspace's bookkeeping is wrong" without reading a message and guessing. Both stop the work.
 */
export const WORKSPACE_ADAPTER_ERROR_CODES = [
  "not_a_repository",
  "git_unavailable",
  "unsafe_path",
  "path_escapes_workspace",
  "symlink_refused",
  "cache_root_inside_repository",
  "metadata_corrupt",
  "metadata_missing",
  "workspace_registered_elsewhere",
  "workspace_occupied",
  "lease_held",
  "lease_not_owned",
  "git_failed",
] as const;

export type WorkspaceAdapterErrorCode = (typeof WORKSPACE_ADAPTER_ERROR_CODES)[number];

export class WorkspaceAdapterError extends Error {
  readonly code: WorkspaceAdapterErrorCode;

  constructor(code: WorkspaceAdapterErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceAdapterError";
    this.code = code;
  }
}
