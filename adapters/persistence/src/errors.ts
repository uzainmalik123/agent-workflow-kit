export type PersistenceErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_FEATURE_ID"
  | "INVALID_SLUG"
  | "UNSAFE_PATH"
  | "IO_ERROR"
  | "FEATURE_NOT_FOUND"
  | "DUPLICATE_FEATURE"
  | "DUPLICATE_FEATURE_DIRECTORY"
  | "MALFORMED_SESSION"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INVALID_SESSION"
  | "INVALID_WORKFLOW_SNAPSHOT"
  | "FEATURE_MISMATCH"
  | "INVALID_ARTIFACT_NAME"
  | "INVALID_ARTIFACT"
  | "ARTIFACT_NOT_FOUND"
  | "MALFORMED_ARTIFACT"
  | "INVALID_EVENT"
  | "MALFORMED_EVENT_LOG"
  | "REVISION_CONFLICT"
  | "LOCK_TIMEOUT";

export interface PersistenceErrorOptions {
  readonly cause?: unknown;
  readonly path?: string;
}

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly path: string | undefined;

  constructor(code: PersistenceErrorCode, message: string, options?: PersistenceErrorOptions) {
    if (options?.cause === undefined) {
      super(message);
    } else {
      super(message, { cause: options.cause });
    }

    this.name = "PersistenceError";
    this.code = code;
    this.path = options?.path;
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (error as { readonly code?: unknown }).code === code;
}
