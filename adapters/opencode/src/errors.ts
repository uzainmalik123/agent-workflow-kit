export type OpenCodeAdapterErrorCode =
  | "unknown_role"
  | "role_mismatch"
  | "transport_failed"
  | "transport_timeout"
  | "transport_cancelled"
  | "non_zero_exit"
  | "output_truncated"
  | "empty_response"
  | "malformed_response"
  | "invalid_result"
  | "unsafe_output_path"
  | "project_plugin_detected"
  | "opencode_configuration_tampered";

export interface OpenCodeAdapterErrorOptions {
  readonly cause?: unknown;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (typeof cause === "string") {
    return cause;
  }

  return "an unidentified error occurred";
}

/**
 * Every refusal in this adapter is one of these. The adapter never converts a refusal into a
 * workflow result: the orchestrator receives a thrown error and reports an executor failure
 * instead of a stage outcome the agent invented.
 */
export class OpenCodeAdapterError extends Error {
  readonly code: OpenCodeAdapterErrorCode;

  constructor(
    code: OpenCodeAdapterErrorCode,
    message: string,
    options?: OpenCodeAdapterErrorOptions,
  ) {
    super(
      options?.cause === undefined ? message : `${message} (${describe(options.cause)})`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );

    this.name = "OpenCodeAdapterError";
    this.code = code;
  }
}

export function isOpenCodeAdapterError(error: unknown): error is OpenCodeAdapterError {
  return error instanceof OpenCodeAdapterError;
}
