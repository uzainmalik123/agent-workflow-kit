import type { VerificationCheckStatus } from "./verification.js";

/**
 * Runtime acceptance verification: does the implemented feature actually work when it is run?
 *
 * The three verification stages are kept apart on purpose. Lint, typecheck, build, and tests are
 * properties of the source, and a passing run of each is strong evidence about code. None of them
 * observes the thing a user would observe: a request arriving, a response leaving, a process staying
 * up. A feature can compile, typecheck, and pass a hundred tests while the route it added returns
 * 404 in the running application, and nothing in the existing stages can tell the difference.
 *
 * This port is that missing observation, and it has one structural rule: the verdict comes from the
 * process and the wire, never from a model. There is no field here an agent can fill in. A
 * `RuntimeVerificationProvider` is constructed by the wiring code from a project's own configuration,
 * starts a real process, waits for a real readiness condition, performs a real check, and reports
 * what the process and the socket actually did. An agent that claims the feature works is a claim
 * about this result, not a substitute for it.
 *
 * The three statuses are not a scale, and the middle one is the point of the design:
 *
 * - `passed` means every configured check was performed and met its criterion;
 * - `failed` means a check was performed and did not meet its criterion, or the configured
 *   application could not be brought up well enough to perform one;
 * - `inconclusive` means no criterion was established either way.
 *
 * `inconclusive` exists because the alternative is a lie. A project that declares no runtime
 * configuration has not verified anything, and recording that as `passed` would make an absent
 * configuration indistinguishable from a working feature. It is also what a framework that cannot
 * answer reports, so "nobody asked" and "the answer is no" both come back as `inconclusive` while
 * only the second is allowed to send a feature back to the fixer.
 */
export const RUNTIME_VERIFICATION_STATUSES = ["passed", "failed", "inconclusive"] as const;

export type RuntimeVerificationStatus = (typeof RUNTIME_VERIFICATION_STATUSES)[number];

/** The deterministic reasons a runtime check reached its status. Never prose. */
export const RUNTIME_CHECK_REASONS = [
  /** The application never answered the readiness condition before its deadline. */
  "readiness_timeout",
  /** The application exited before the readiness condition was met. */
  "process_exited",
  /** The response arrived with a status the check did not expect. */
  "status_mismatch",
  /** The response arrived with the expected status and no expected text. */
  "body_absent",
  /** The request could not be completed: refused, reset, or timed out. */
  "request_failed",
  /** The whole verification exceeded its configured timeout. */
  "deadline_exceeded",
  /** The configured command could not be started at all. */
  "spawn_failed",
  /** The framework cancelled the run. */
  "cancelled",
  /** The process was stopped for exceeding the output ceiling. */
  "output_ceiling_exceeded",
  /** The check was never attempted because an earlier one ended the run. */
  "not_attempted",
  /** No runtime configuration is declared, so nothing was attempted. */
  "runtime_not_configured",
] as const;

export type RuntimeCheckReason = (typeof RUNTIME_CHECK_REASONS)[number];

/** HTTP methods a runtime check may use. */
export const RUNTIME_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export type RuntimeHttpMethod = (typeof RUNTIME_HTTP_METHODS)[number];

/** The kinds of acceptance criterion this milestone can check. */
export const RUNTIME_CHECK_KINDS = ["http", "process_start"] as const;

export type RuntimeCheckKind = (typeof RUNTIME_CHECK_KINDS)[number];

/**
 * One HTTP acceptance criterion.
 *
 * An expected status is required and an expected text fragment is optional, which is the whole
 * surface: a method, a path, a status, and optionally a substring. A substring is the cheapest
 * meaningful assertion about content that is not a browser, and it is deliberately not a regular
 * expression, a JSON path, or a DOM query, because each of those is a language that turns a check
 * into a program whose failure message nobody can act on.
 */
export interface RuntimeHttpCheckConfiguration {
  readonly kind: "http";
  /** Stable identity of the check, used as the evidence id. */
  readonly id: string;
  readonly method: RuntimeHttpMethod;
  /** The path to request, always beginning with `/`. */
  readonly path: string;
  /**
   * The absolute URL the check is issued against, resolved from the path and the declared readiness
   * URL when the configuration is read.
   *
   * A project states a path, never a host, so a check can only ever reach the one server the project
   * named. That is resolved once, at configuration time, where a path that would escape to another
   * host is refused — and resolving it here rather than per check means the request that runs is the
   * URL that was validated.
   */
  readonly url: string;
  readonly expectedStatus: number;
  /** A fragment the response body must contain, or `null` when only the status matters. */
  readonly expectedBodyFragment: string | null;
  /** Per-check deadline, or `null` to share the stage deadline. */
  readonly timeoutMs: number | null;
}

/**
 * The criterion "the process starts and stays up".
 *
 * It exists because it is the one honest way to assert process startup, and it is never inferred:
 * a project that only cares whether the command starts has to say so, because a command that started
 * and immediately exited is otherwise indistinguishable from a command that worked.
 */
export interface RuntimeProcessStartCheckConfiguration {
  readonly kind: "process_start";
  readonly id: string;
  /** How long the process must remain running for the check to pass. */
  readonly stableMs: number;
}

export type RuntimeCheckConfiguration =
  | RuntimeHttpCheckConfiguration
  | RuntimeProcessStartCheckConfiguration;

/**
 * The readiness condition: the configured signal that the application is up.
 *
 * A URL that answers is the only one this milestone recognises, and it is deliberately narrow. A
 * process that has spawned has not finished booting, and a check issued in that window measures the
 * race rather than the feature. Nothing here looks for a port, reads a manifest, or guesses a route:
 * the URL is stated, and its absence is reported rather than invented.
 */
export interface RuntimeReadinessConfiguration {
  readonly url: string;
  /** How long to wait for the condition, or `null` to share the stage deadline. */
  readonly timeoutMs: number | null;
}

/**
 * Why a readiness URL is also the base for every HTTP check.
 *
 * There is one server in a runtime verification: the one the project started. A second `baseUrl`, or
 * a per-check host, would let one configuration check a server the application does not serve, and a
 * check against a different server is evidence about something other than the feature. So the URL the
 * project declared to wait on is the URL its checks are issued against, and a project whose criteria
 * are HTTP has to declare one.
 */

/**
 * The runtime command, as the framework will run it.
 *
 * An executable plus an argument array, always, and the same structural promise every other command
 * in this framework keeps. There is no field here a model can write, no shell line, and no way to
 * express "install the dependencies first": the command runs or it does not run.
 */
export interface RuntimeCommandConfiguration {
  readonly executable: string;
  readonly args: readonly string[];
  /** The directory the command runs in, already resolved and checked against the project root. */
  readonly cwd: string;
  /** The project script a `run` invocation names, so the implicit-hook policy sees the same fact. */
  readonly script: string | null;
}

/**
 * Everything a project may declare about runtime verification, and nothing else.
 *
 * A `null` configuration means the project declared none, and the framework reports that as
 * `inconclusive` rather than discovering an application and guessing how to exercise it.
 */
export interface RuntimeVerificationConfiguration {
  readonly command: RuntimeCommandConfiguration;
  readonly readiness: RuntimeReadinessConfiguration | null;
  readonly checks: readonly RuntimeCheckConfiguration[];
  /** The whole-run deadline: command startup, readiness, and every check together. */
  readonly timeoutMs: number;
}

/**
 * The verdict for one check, and the facts behind it.
 *
 * The status is a `VerificationCheckStatus` rather than a new vocabulary so that the same record
 * type carries static, test, and runtime evidence: one status scale for the whole framework means a
 * reader learns it once. `expectedStatus` and `actualStatus` are separate fields rather than prose
 * because "expected 200, got 404" is the single most useful sentence in a runtime failure, and a
 * sentence has to be parsed to be checked.
 */
export interface RuntimeCheckEvidence {
  readonly id: string;
  readonly kind: RuntimeCheckKind;
  /** What was asked for, in the check's own terms: `GET /health` or `process_start`. */
  readonly label: string;
  readonly status: VerificationCheckStatus;
  readonly reason: RuntimeCheckReason | null;
  /** One deterministic sentence describing what happened, for a human reading the artifact. */
  readonly detail: string;
  readonly expectedStatus: number | null;
  readonly actualStatus: number | null;
  /** Whether the expected text fragment was found, or `null` when the check did not look for one. */
  readonly bodyMatched: boolean | null;
  /** The bounded capture of the response body that was examined, never the whole body. */
  readonly responseExcerpt: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** What became of the process the framework started. */
export interface RuntimeProcessDiagnostics {
  readonly startedAt: string;
  /** The bounded capture of the application's stdout, recorded once and never a transcript. */
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
  readonly outputTruncated: boolean;
  /** How the process ended, in the runner's own vocabulary. */
  readonly termination: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason: string | null;
  /** Whether the framework asked for the termination, which separates a shutdown from a crash. */
  readonly terminatedByVerification: boolean;
  /** The signal that actually stopped it, so `SIGKILL` after a `SIGTERM` is visible. */
  readonly escalated: boolean;
  /** How long the process lived, from start to its termination. */
  readonly durationMs: number;
}

/** What became of the readiness condition. */
export interface RuntimeReadinessEvidence {
  /** `null` when the project declared no readiness condition. */
  readonly url: string | null;
  readonly reached: boolean;
  /** How long the condition was waited for, or `null` when there was no condition to wait for. */
  readonly waitedMs: number | null;
  /** The status that answered, when something did. */
  readonly status: number | null;
  readonly detail: string;
}

export interface RuntimeVerificationDiagnostics {
  /**
   * The command exactly as it was run, so a reader does not have to reconstruct it.
   *
   * `null` when nothing ran, which is the whole of a result whose configuration was `null`. An empty
   * executable would be a command nobody wrote, and this record exists to say what happened.
   */
  readonly command: RuntimeCommandConfiguration | null;
  readonly process: RuntimeProcessDiagnostics;
  readonly readiness: RuntimeReadinessEvidence;
  /** The whole run, from process start to the last check or the deadline. */
  readonly elapsedMs: number;
}

export interface RuntimeVerificationRequest {
  readonly featureId: string;
  /** The directory the application may be started in. Never chosen by a model. */
  readonly projectRoot: string;
  /** The session revision the result will belong to. */
  readonly revision: number;
  /**
   * The project's explicit runtime configuration, or `null` when it declared none.
   *
   * A `null` here produces `inconclusive`. There is no discovery step behind it: the framework does
   * not look for an application, a port, a browser, or a route, and a project that wants runtime
   * verification says what to run.
   */
  readonly configuration: RuntimeVerificationConfiguration | null;
  /** The whole-run deadline, which the configuration may narrow but never widen. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | null;
}

export interface RuntimeVerificationResult {
  readonly status: RuntimeVerificationStatus;
  readonly evidence: readonly RuntimeCheckEvidence[];
  /**
   * Deterministic statements about the run that are not verdicts.
   *
   * Observations are what happened; they are not a second opinion. They exist so the evidence a
   * reader sees has its context attached: a check that failed because the process exited is a
   * different fact from a check that failed because the status was wrong, and both are the same
   * status in the record above.
   */
  readonly observations: readonly string[];
  readonly diagnostics: RuntimeVerificationDiagnostics;
}

export interface RuntimeVerificationProvider {
  verify(request: RuntimeVerificationRequest): Promise<RuntimeVerificationResult>;
}

/** The default whole-run deadline when a project declares none. */
export const DEFAULT_RUNTIME_TIMEOUT_MS = 60_000;

/** The default per-check deadline when a project declares none. */
export const DEFAULT_RUNTIME_CHECK_TIMEOUT_MS = 10_000;

/** How often a readiness condition is polled. */
export const DEFAULT_RUNTIME_READINESS_POLL_MS = 250;

/**
 * The stable reasons the readiness condition failed, which are the first entries of the check reason
 * vocabulary, re-exported so a caller does not have to string-match to branch on them.
 */
export const READINESS_FAILURE_REASONS: readonly RuntimeCheckReason[] = [
  "readiness_timeout",
  "process_exited",
  "deadline_exceeded",
  "cancelled",
  "request_failed",
];
