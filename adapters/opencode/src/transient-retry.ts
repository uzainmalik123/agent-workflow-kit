/**
 * The bounded retry for transient provider failures (Task Y, P-33; decision D-24).
 *
 * A free provider drops connections: in F-002, OpenCode exited 1 with `ECONNRESET` on its stderr
 * twice, and both times the stage died with `executor_error` after hundreds of seconds of work.
 * This module is the adapter hardening that answers it, in the same spirit as the reply retry
 * (D-15): a failure that a fresh invocation can plausibly survive is retried, every attempt is
 * recorded, and the contract is unchanged — an attempt that succeeds must still satisfy the full
 * response protocol.
 *
 * Detection is substring matching against one exported constant,
 * {@link TRANSIENT_PROVIDER_PATTERNS}, applied to the error message case-insensitively. The message
 * of a non-zero exit carries the child's bounded stderr excerpt, which is where these names appear.
 * Classification is ordered so that the answer never depends on the order of the patterns:
 *
 * 1. a message naming credit, billing, free-tier, or authentication trouble is never retried;
 * 2. a `429` (or "too many requests") is retried once — the backoff, once;
 * 3. a message naming a transient network or provider failure (connection reset, DNS, socket,
 *    HTTP 502/503/504, an overloaded provider) is retried with the backoff;
 * 4. any other HTTP 4xx status is never retried;
 * 5. anything else is `unknown`, and unknown errors are not retried.
 *
 * What is deliberately outside this module's reach: a stage that hit its `--stage-timeout` budget
 * (`transport_timeout`) is a failed run, not a slow one, and is never retried here; a reply the
 * response contract refused belongs to the reply retry (D-15) and is never re-retried here; and a
 * scope violation is decided by the orchestrator, never by this adapter, so it cannot reach this
 * loop at all.
 */

/** How many *extra* invocations a stage gets on a transient provider failure. */
export const DEFAULT_TRANSIENT_RETRIES = 2;

/**
 * The backoff before each retry, in milliseconds: 15 seconds, then 45. A retry count beyond the
 * list's length repeats the last backoff.
 */
export const TRANSIENT_RETRY_BACKOFF_MS: readonly number[] = [15_000, 45_000];

/**
 * The one detection-pattern constant. Every pattern is matched case-insensitively against the
 * failure message; `transientHttpStatus` and `neverRetryHttpStatus` are matched as standalone
 * status words, so a duration such as "after 5043ms" is not an HTTP 504.
 */
export const TRANSIENT_PROVIDER_PATTERNS = {
  /**
   * The provider's own accounting and identity failures. A retry would spend another invocation on
   * an account that cannot run one, so these are never retried, whatever else the message says.
   */
  neverRetrySubstrings: [
    "credit",
    "billing",
    "freetiererror",
    "unauthorized",
    "authentication",
    "invalid api key",
  ] as readonly string[],
  /** HTTP 4xx other than 429, matched as a standalone status word. */
  neverRetryHttpStatus: /\b4\d{2}\b/u,
  /** Transient network and provider failures, retried with the backoff. */
  transientSubstrings: [
    "econnreset",
    "etimedout",
    "eai_again",
    "socket hang up",
    "connection lost",
    "http 502",
    "http 503",
    "http 504",
    "overloaded",
  ] as readonly string[],
  /** HTTP 5xx gateway failures, matched as standalone status words ("502 Bad Gateway"). */
  transientHttpStatus: /\b50[234]\b/u,
  /** 429 is the one 4xx that a wait can fix; it gets the backoff once. */
  retryOnceSubstrings: ["429", "too many requests"] as readonly string[],
};

/** What the detector decided about one failure message. */
export type TransientFailureVerdict =
  /** Retried with the backoff, up to the configured retry budget. */
  | "transient"
  /** Retried at most once (a `429`). */
  | "retry_once"
  /** Recognized as a permanent failure; never retried. */
  | "never"
  /** Not recognized; never retried. */
  | "unknown";

/**
 * Classifies one failure message. The order is the point: a message that names both a transient
 * failure and an accounting failure is an accounting failure, and a `429` inside a longer message
 * is a rate limit before it is anything else.
 */
export function classifyProviderFailure(message: string): TransientFailureVerdict {
  const text = message.toLowerCase();

  for (const pattern of TRANSIENT_PROVIDER_PATTERNS.neverRetrySubstrings) {
    if (text.includes(pattern)) {
      return "never";
    }
  }

  for (const pattern of TRANSIENT_PROVIDER_PATTERNS.retryOnceSubstrings) {
    if (text.includes(pattern)) {
      return "retry_once";
    }
  }

  for (const pattern of TRANSIENT_PROVIDER_PATTERNS.transientSubstrings) {
    if (text.includes(pattern)) {
      return "transient";
    }
  }

  if (TRANSIENT_PROVIDER_PATTERNS.transientHttpStatus.test(text)) {
    return "transient";
  }

  if (TRANSIENT_PROVIDER_PATTERNS.neverRetryHttpStatus.test(text)) {
    return "never";
  }

  return "unknown";
}

/** The backoff before the given 1-based retry number, repeating the last backoff if the list is shorter. */
export function transientBackoffMs(retry: number): number {
  const last = TRANSIENT_RETRY_BACKOFF_MS.at(-1) ?? 0;
  const delay = TRANSIENT_RETRY_BACKOFF_MS[retry - 1];
  return delay ?? last;
}
