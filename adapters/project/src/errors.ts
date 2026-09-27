/**
 * Every refusal the project adapter makes is one of these codes.
 *
 * A refusal is never converted into a guess. An unreadable manifest does not become "probably
 * JavaScript", and a repository with no lockfile does not become "probably npm": the adapter either
 * knows a fact or reports that it does not.
 */
export type ProjectAdapterErrorCode =
  | "root_unavailable"
  | "unsafe_path"
  | "manifest_unreadable"
  | "manifest_malformed"
  | "config_invalid"
  | "command_invalid"
  | "command_forbidden"
  | "fingerprint_failed";

export interface ProjectAdapterErrorOptions {
  readonly cause?: unknown;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return typeof cause === "string" ? cause : "an unidentified error occurred";
}

export class ProjectAdapterError extends Error {
  readonly code: ProjectAdapterErrorCode;

  constructor(
    code: ProjectAdapterErrorCode,
    message: string,
    options?: ProjectAdapterErrorOptions,
  ) {
    super(
      options?.cause === undefined ? message : `${message} (${describe(options.cause)})`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );

    this.name = "ProjectAdapterError";
    this.code = code;
  }
}

export function isProjectAdapterError(error: unknown): error is ProjectAdapterError {
  return error instanceof ProjectAdapterError;
}

/** True for the refusals that mean "this project cannot be inspected", as opposed to a defect. */
export function isDiscoveryRefusal(error: unknown): error is ProjectAdapterError {
  return (
    isProjectAdapterError(error) &&
    [
      "root_unavailable",
      "unsafe_path",
      "manifest_unreadable",
      "manifest_malformed",
      "config_invalid",
    ].includes(error.code)
  );
}
