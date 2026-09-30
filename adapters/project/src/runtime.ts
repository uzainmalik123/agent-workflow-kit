import {
  DEFAULT_RUNTIME_CHECK_TIMEOUT_MS,
  DEFAULT_RUNTIME_READINESS_POLL_MS,
  type RuntimeCheckConfiguration,
  type RuntimeCheckEvidence,
  type RuntimeCheckReason,
  type RuntimeProcessDiagnostics,
  type RuntimeProcessStartCheckConfiguration,
  type RuntimeReadinessEvidence,
  type RuntimeVerificationConfiguration,
  type RuntimeVerificationProvider,
  type RuntimeVerificationRequest,
  type RuntimeVerificationResult,
  type RuntimeVerificationStatus,
  type VerificationCheckStatus,
} from "@agent-workflow-kit/orchestration";
import { performHttpCheck, type HttpCheckOutcome } from "./http-check.js";
import { startChildProcess, type ChildProcessOutcome, type SupervisedChildProcess } from "./process.js";

/**
 * Runtime acceptance verification, performed against a real running process.
 *
 * The lifecycle is the whole design, in this order, because each step exists to stop the next one
 * from reporting something it did not observe:
 *
 * ```
 * 1. start the configured application
 * 2. wait for the configured readiness condition
 * 3. perform the configured checks against the running application
 * 4. collect evidence
 * 5. stop the process
 * 6. escalate the stop if it does not take
 * 7. return what happened
 * ```
 *
 * Step 1 is not a verdict. A process that spawns and exits a millisecond later has started, and a
 * feature is not the fact that something ran: it is what answers. That is why the readiness gate and
 * the checks are separate steps, and why a stage will not report success on startup alone unless the
 * project wrote down that startup is the criterion.
 *
 * Step 2 exists to remove a race. A server that has been spawned is not yet listening, and a check
 * issued in that window measures the boot rather than the feature. The wait is bounded by a declared
 * budget, and it watches the process at the same time, so an application that dies during boot fails
 * in a second with its exit code rather than sitting out the whole timeout.
 *
 * Step 3 is the part a model is not allowed to do. Every check is a request the project wrote down
 * compared against an expected value, so the answer is a fact about the running application rather
 * than an opinion about the source. No output is read and interpreted: a response is matched on its
 * status and, if the project declared one, on a literal body fragment.
 *
 * Steps 5 and 6 are evidence, not housekeeping. Whether the framework stopped the process cleanly, had
 * to kill it, or found it already gone are three different facts about one run, and a verification
 * that leaves a server bound to a port has corrupted whatever runs after it. The stop is
 * unconditional, so a failed check, an unreachable readiness condition, a thrown error, and a clean
 * pass all leave the process stopped, and the runner escalates to `SIGKILL` for a process that ignores
 * `SIGTERM`.
 *
 * There is no browser, no screenshot, and no DOM here, and nothing is discovered. Both absences are
 * deliberate: a browser assertion reports a selector timeout rather than the behaviour that broke, and
 * a discovered port or route is a guess that produces confident evidence about a server nobody meant
 * to check.
 */
export interface ProjectRuntimeVerificationOptions {
  /** Injectable millisecond clock, so evidence timestamps are reproducible in tests. */
  readonly clock?: () => number;
  /**
   * Substitutable process starter. The default is the repository's single process runner in its
   * supervised form, so the runtime path cannot acquire a weaker boundary than the static path.
   */
  readonly start?: (request: Parameters<typeof startChildProcess>[0]) => SupervisedChildProcess;
  /** Substitutable HTTP client, for a test that does not want a socket. */
  readonly httpCheck?: (request: Parameters<typeof performHttpCheck>[0]) => Promise<HttpCheckOutcome>;
  /** Injectable sleep, so a test does not have to wait for a real poll interval. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How often the readiness condition is polled. */
  readonly readinessPollMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What became of the process, for the diagnostics a human reads. */
const NOT_STARTED: RuntimeProcessDiagnostics = {
  startedAt: "",
  stdoutExcerpt: "",
  stderrExcerpt: "",
  outputTruncated: false,
  termination: "not_started",
  exitCode: null,
  signal: null,
  reason: null,
  terminatedByVerification: false,
  escalated: false,
  durationMs: 0,
};

function checkLabel(check: RuntimeCheckConfiguration): string {
  return check.kind === "http" ? `${check.method} ${check.path}` : "process startup";
}

function describeClosure(outcome: ChildProcessOutcome): string {
  if (outcome.termination === "exited") {
    return `exit code ${String(outcome.exitCode)}`;
  }

  return outcome.reason === null ? outcome.termination : `${outcome.termination} (${outcome.reason})`;
}

/** The status a check gets when it never got as far as a comparison. */
function statusForReason(reason: RuntimeCheckReason): VerificationCheckStatus {
  switch (reason) {
    case "readiness_timeout":
    case "deadline_exceeded":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    case "spawn_failed":
      return "blocked";
    case "process_exited":
    case "status_mismatch":
    case "body_absent":
    case "request_failed":
    case "output_ceiling_exceeded":
      return "failed";
    case "not_attempted":
    case "runtime_not_configured":
      return "skipped";
  }
}

/** A check that could not be performed, carrying the reason the run gave instead. */
function unattemptedEvidence(
  check: RuntimeCheckConfiguration,
  reason: RuntimeCheckReason,
  detail: string,
  durationMs: number,
): RuntimeCheckEvidence {
  return {
    id: check.id,
    kind: check.kind,
    label: checkLabel(check),
    status: statusForReason(reason),
    reason,
    detail,
    expectedStatus: check.kind === "http" ? check.expectedStatus : null,
    actualStatus: null,
    bodyMatched: null,
    responseExcerpt: "",
    truncated: false,
    durationMs,
  };
}

/**
 * The comparison for one HTTP check, and nothing else.
 *
 * A response is judged on the status the project expected and, when one was declared, on a literal
 * fragment of the body. There is no scoring, no partial credit, and no reading of the body for
 * sentiment: an expected status with an expected fragment is a complete criterion, and either half
 * failing is the check failing.
 */
function httpEvidence(
  check: Extract<RuntimeCheckConfiguration, { kind: "http" }>,
  outcome: HttpCheckOutcome,
  invocation: string,
): RuntimeCheckEvidence {
  const base = {
    id: check.id,
    kind: check.kind,
    label: checkLabel(check),
    expectedStatus: check.expectedStatus,
    truncated: outcome.truncated,
    durationMs: outcome.durationMs,
  } as const;

  if (!outcome.responded) {
    // An aborted request was abandoned by the caller, not refused by the application. Reporting it as
    // a failed check would file a cancelled run as a defect and send the feature to the fixer for a
    // request that was never completed.
    const cancelled = outcome.failure === "request_aborted";

    return {
      ...base,
      status: cancelled ? "cancelled" : "failed",
      reason: cancelled ? "cancelled" : "request_failed",
      detail: cancelled
        ? `${invocation} was cancelled before it produced a response.`
        : `${invocation} produced no response (${outcome.failure ?? "unknown failure"}) after ${String(outcome.durationMs)}ms.`,
      actualStatus: null,
      bodyMatched: null,
      responseExcerpt: "",
    };
  }

  if (outcome.status !== check.expectedStatus) {
    return {
      ...base,
      status: "failed",
      reason: "status_mismatch",
      detail: `${invocation} returned status ${String(outcome.status)} after ${String(outcome.durationMs)}ms; the configured criterion is status ${String(check.expectedStatus)}.`,
      actualStatus: outcome.status,
      bodyMatched: null,
      responseExcerpt: "",
    };
  }

  if (check.expectedBodyFragment === null) {
    return {
      ...base,
      status: "passed",
      reason: null,
      detail: `${invocation} returned status ${String(outcome.status)} after ${String(outcome.durationMs)}ms, which is the configured criterion.`,
      actualStatus: outcome.status,
      bodyMatched: null,
      responseExcerpt: outcome.truncated ? "" : outcome.bodyExcerpt,
    };
  }

  if (!outcome.bodyExcerpt.includes(check.expectedBodyFragment)) {
    return {
      ...base,
      status: "failed",
      reason: "body_absent",
      detail: `${invocation} returned the expected status ${String(outcome.status)} after ${String(outcome.durationMs)}ms, but the body does not contain the expected fragment.`,
      actualStatus: outcome.status,
      bodyMatched: false,
      responseExcerpt: outcome.bodyExcerpt,
    };
  }

  return {
    ...base,
    status: "passed",
    reason: null,
    detail: `${invocation} returned the expected status ${String(outcome.status)} with the expected body fragment after ${String(outcome.durationMs)}ms.`,
    actualStatus: outcome.status,
    bodyMatched: true,
    responseExcerpt: outcome.bodyExcerpt,
  };
}

interface ReadinessOutcome {
  readonly evidence: RuntimeReadinessEvidence;
  /** The reason no check may be attempted, or `null` when the application is ready. */
  readonly failure: { readonly reason: RuntimeCheckReason; readonly detail: string } | null;
}

/**
 * The project runtime verification provider.
 *
 * It is constructed by the wiring code and handed a request by the framework. A model never appears in
 * it, and a request cannot change what is run: the command, the readiness condition, and the criteria
 * all come from the configuration object, which a model cannot write. A request contributes the
 * revision, the directory, the deadline, and the acceptance criteria as text for a human to read.
 */
export class ProjectRuntimeVerificationProvider implements RuntimeVerificationProvider {
  readonly #clock: () => number;
  readonly #start: (request: Parameters<typeof startChildProcess>[0]) => SupervisedChildProcess;
  readonly #httpCheck: (request: Parameters<typeof performHttpCheck>[0]) => Promise<HttpCheckOutcome>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pollMs: number;

  constructor(options: ProjectRuntimeVerificationOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#start = options.start ?? ((request) => startChildProcess(request, { clock: this.#clock }));
    this.#httpCheck = options.httpCheck ?? performHttpCheck;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#pollMs = options.readinessPollMs ?? DEFAULT_RUNTIME_READINESS_POLL_MS;
  }

  async verify(request: RuntimeVerificationRequest): Promise<RuntimeVerificationResult> {
    const configuration = request.configuration;

    // The absence of a configuration is the one thing this provider refuses to have an opinion about.
    // There is no second source for a command, and inventing one would produce evidence about a server
    // nobody declared.
    if (configuration === null) {
      return {
        status: "inconclusive",
        evidence: [
          {
            id: "runtime",
            kind: "process_start",
            label: "process startup",
            // `skipped` rather than `failed`, and that distinction is the point. Nothing is broken
            // here: the project has not said how its application starts, so the honest record is a
            // criterion that was never put, which the workflow then holds at inconclusive.
            status: "skipped",
            reason: "runtime_not_configured",
            detail: "No runtime verification is configured, so no process was started and no criterion was measured.",
            expectedStatus: null,
            actualStatus: null,
            bodyMatched: null,
            responseExcerpt: "",
            truncated: false,
            durationMs: 0,
          },
        ],
        observations: [
          "No runtime verification is configured, so no process was started and no criterion was measured.",
        ],
        diagnostics: {
          command: null,
          process: { ...NOT_STARTED },
          readiness: {
            url: null,
            reached: false,
            waitedMs: null,
            status: null,
            detail: "No readiness condition is declared, because no runtime configuration exists.",
          },
          elapsedMs: 0,
        },
      };
    }

    return await this.#run(request, configuration);
  }

  async #run(
    request: RuntimeVerificationRequest,
    configuration: RuntimeVerificationConfiguration,
  ): Promise<RuntimeVerificationResult> {
    // One budget for the whole run rather than a per-step allowance: a readiness wait that consumed it
    // has nothing left for the checks, and a check issued past the deadline would be measuring a
    // framework that has already decided to stop.
    const budgetMs = Math.min(request.timeoutMs, configuration.timeoutMs);
    const startedAtMs = this.#clock();
    const deadlineMs = startedAtMs + budgetMs;
    const remaining = (): number => Math.max(0, deadlineMs - this.#clock());
    const invocation = `${configuration.command.executable} ${configuration.command.args.join(" ")}`.trim();

    const child = this.#start({
      executable: configuration.command.executable,
      args: configuration.command.args,
      cwd: configuration.command.cwd,
      signal: request.signal ?? null,
    });

    const observations: string[] = [];
    const evidence: RuntimeCheckEvidence[] = [];
    const signal = request.signal ?? null;
    let readiness: ReadinessOutcome;
    let processOutcome: ChildProcessOutcome | null;
    let terminatedByVerification = false;

    try {
      readiness = await this.#awaitReadiness(child, configuration, remaining, signal);
      observations.push(readiness.evidence.detail);

      if (readiness.failure !== null) {
        // No check is attempted, but the run is not inconclusive: the application did not reach the
        // state the project said it would reach, and that is a finding a fixer can act on rather than
        // a question left open.
        for (const check of configuration.checks) {
          evidence.push(
            unattemptedEvidence(check, readiness.failure.reason, `${invocation} ${readiness.failure.detail}`, this.#clock() - startedAtMs),
          );
        }
      } else {
        for (const check of configuration.checks) {
          // Two ways a check may not be issued, in the order they are checked. A cancelled run is
          // abandoned by its caller and says nothing about the check, while an exhausted budget means
          // this framework ran out of time, which is a fact about the run rather than the application.
          const stopped: { reason: RuntimeCheckReason; detail: string } | null =
            signal?.aborted === true
              ? { reason: "cancelled", detail: "Not attempted: the runtime verification was cancelled." }
              : remaining() === 0
                ? {
                    reason: "deadline_exceeded",
                    detail: `Not attempted: the runtime verification exhausted its ${String(budgetMs)}ms budget.`,
                  }
                : null;

          if (stopped !== null) {
            evidence.push(unattemptedEvidence(check, stopped.reason, stopped.detail, 0));
            continue;
          }

          evidence.push(
            check.kind === "http"
              ? await this.#performHttpCheck(child, check, invocation, remaining, signal)
              : await this.#performProcessStartCheck(child, check, invocation),
          );
        }
      }
    } finally {
      // Cleanup is unconditional, and it distinguishes a process the framework stopped from one that
      // was already gone. A process that exited on its own is recorded as its own exit, because
      // claiming a clean shutdown for an application that crashed is exactly the kind of tidy
      // evidence this stage exists to replace.
      const closed = child.peekOutcome();

      if (closed !== null) {
        processOutcome = closed;
      } else {
        terminatedByVerification = true;
        child.terminate("signalled", "terminated_by_signal");
        processOutcome = await child.finished;
      }
    }

    return {
      status: statusForEvidence(evidence),
      evidence,
      observations,
      diagnostics: {
        command: configuration.command,
        process: processDiagnostics(child, processOutcome, startedAtMs, terminatedByVerification, this.#clock()),
        readiness: readiness.evidence,
        elapsedMs: Math.max(0, this.#clock() - startedAtMs),
      },
    };
  }

  /**
   * Waits for the configured readiness condition, watching the process at the same time.
   *
   * Racing the process against the poll is what turns a crash during boot into an immediate, specific
   * failure. Without it the wait would sit out the whole budget against a dead process and then report
   * that the condition was not met, which is true and useless: the interesting fact is the exit code.
   */
  async #awaitReadiness(
    child: SupervisedChildProcess,
    configuration: RuntimeVerificationConfiguration,
    remaining: () => number,
    signal: AbortSignal | null,
  ): Promise<ReadinessOutcome> {
    const readiness = configuration.readiness;

    if (readiness === null) {
      return {
        evidence: {
          url: null,
          // The process was started and the stage still has checks to run, so this is reported as
          // reached with no wait. Nothing is claimed about the application being usable, and the
          // detail says so, because a project that declared no readiness condition has not asked for
          // the boot to be observed.
          reached: true,
          waitedMs: 0,
          status: null,
          detail:
            "No readiness condition is declared, so the checks ran as soon as the process was spawned. A project that wants the boot to be waited out should declare a readiness url.",
        },
        failure: null,
      };
    }

    const waitedFrom = this.#clock();
    const budgetMs = Math.min(readiness.timeoutMs ?? remaining(), remaining());

    while (this.#clock() - waitedFrom < budgetMs) {
      // Cancellation ends the wait rather than being waited out. Sitting out the rest of a readiness
      // budget for a run nobody is going to read is time spent producing a record that gets discarded.
      if (signal?.aborted === true) {
        return {
          evidence: {
            url: readiness.url,
            reached: false,
            waitedMs: this.#clock() - waitedFrom,
            status: null,
            detail: `"${readiness.url}" was not waited for because the run was cancelled.`,
          },
          failure: { reason: "cancelled", detail: "was cancelled before the readiness condition was met." },
        };
      }

      const closed = child.peekOutcome();

      if (closed !== null) {
        return {
          evidence: {
            url: readiness.url,
            reached: false,
            waitedMs: this.#clock() - waitedFrom,
            status: null,
            detail: `The process exited with ${describeClosure(closed)} after ${String(this.#clock() - waitedFrom)}ms, before "${readiness.url}" answered.`,
          },
          failure: {
            reason: "process_exited",
            detail: `exited with ${describeClosure(closed)} after ${String(this.#clock() - waitedFrom)}ms, before the readiness condition was met.`,
          },
        };
      }

      const probe = await this.#httpCheck({
        url: readiness.url,
        method: "GET",
        // A poll that outlives the budget would make the wait longer than the project declared, so
        // each attempt is bounded by whatever is left of it.
        timeoutMs: Math.min(this.#pollMs, Math.max(1, budgetMs - (this.#clock() - waitedFrom))),
        signal: null,
      });

      if (probe.responded) {
        return {
          evidence: {
            url: readiness.url,
            reached: true,
            waitedMs: this.#clock() - waitedFrom,
            status: probe.status,
            detail: `"${readiness.url}" answered with status ${String(probe.status)} after ${String(this.#clock() - waitedFrom)}ms.`,
          },
          failure: null,
        };
      }

      if (remaining() === 0) {
        break;
      }

      await this.#sleep(this.#pollMs);
    }

    return {
      evidence: {
        url: readiness.url,
        reached: false,
        waitedMs: this.#clock() - waitedFrom,
        status: null,
        detail: `"${readiness.url}" did not answer within ${String(budgetMs)}ms.`,
      },
      failure: {
        reason: "readiness_timeout",
        detail: `did not answer "${readiness.url}" within the ${String(budgetMs)}ms readiness budget.`,
      },
    };
  }

  async #performHttpCheck(
    child: SupervisedChildProcess,
    check: Extract<RuntimeCheckConfiguration, { kind: "http" }>,
    invocation: string,
    remaining: () => number,
    signal: AbortSignal | null,
  ): Promise<RuntimeCheckEvidence> {
    const outcome = await this.#httpCheck({
      url: check.url,
      method: check.method,
      timeoutMs: Math.min(check.timeoutMs ?? DEFAULT_RUNTIME_CHECK_TIMEOUT_MS, Math.max(1, remaining())),
      signal,
    });

    // A response that arrived as the process was dying is not evidence about the application, so a
    // process that has closed since the check began overrides the status the socket reported.
    const closed = child.peekOutcome();

    if (closed !== null) {
      return unattemptedEvidence(
        check,
        "process_exited",
        `${invocation} cannot be believed: the process exited with ${describeClosure(closed)} while the check was in flight.`,
        outcome.durationMs,
      );
    }

    return httpEvidence(check, outcome, invocation);
  }

  async #performProcessStartCheck(
    child: SupervisedChildProcess,
    check: RuntimeProcessStartCheckConfiguration,
    invocation: string,
  ): Promise<RuntimeCheckEvidence> {
    const startedAt = this.#clock();
    let closed: ChildProcessOutcome | null = null;

    while (this.#clock() - startedAt < check.stableMs) {
      const settled = child.peekOutcome();

      if (settled !== null) {
        closed = settled;
        break;
      }

      await this.#sleep(Math.min(this.#pollMs, check.stableMs - (this.#clock() - startedAt)));
    }

    const durationMs = this.#clock() - startedAt;

    if (closed !== null) {
      return {
        id: check.id,
        kind: check.kind,
        label: checkLabel(check),
        status: "failed",
        reason: "process_exited",
        detail: `${invocation} exited with ${describeClosure(closed)} after ${String(durationMs)}ms, so it did not stay up for the ${String(check.stableMs)}ms the criterion requires.`,
        expectedStatus: null,
        actualStatus: null,
        bodyMatched: null,
        responseExcerpt: "",
        truncated: false,
        durationMs,
      };
    }

    return {
      id: check.id,
      kind: check.kind,
      label: checkLabel(check),
      status: "passed",
      reason: null,
      detail: `${invocation} stayed running for the ${String(check.stableMs)}ms the criterion requires.`,
      expectedStatus: null,
      actualStatus: null,
      bodyMatched: null,
      responseExcerpt: "",
      truncated: false,
      durationMs,
    };
  }
}

/**
 * The verdict, and it is a function of the checks.
 *
 * Every check that ran has to have passed, and a check that could not run has a status of its own, so
 * there is no path from "the criteria were not met" to a pass. `inconclusive` is reserved for a run
 * that produced no evidence at all, which in practice means no configuration was declared: the one
 * case where the honest answer is that nothing was measured.
 */
function statusForEvidence(evidence: readonly RuntimeCheckEvidence[]): RuntimeVerificationStatus {
  if (evidence.length === 0) {
    return "inconclusive";
  }

  return evidence.every((check) => check.status === "passed") ? "passed" : "failed";
}

function processDiagnostics(
  child: SupervisedChildProcess,
  outcome: ChildProcessOutcome | null,
  startedAtMs: number,
  terminatedByVerification: boolean,
  now: number,
): RuntimeProcessDiagnostics {
  if (outcome === null) {
    return {
      ...NOT_STARTED,
      startedAt: child.startedAt,
      stdoutExcerpt: child.stdoutCapture().text,
      stderrExcerpt: child.stderrCapture().text,
      durationMs: Math.max(0, now - startedAtMs),
    };
  }

  return {
    startedAt: outcome.startedAt,
    stdoutExcerpt: outcome.stdout.text,
    stderrExcerpt: outcome.stderr.text,
    outputTruncated: outcome.stdout.truncated || outcome.stderr.truncated,
    termination: outcome.termination,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    reason: outcome.reason,
    terminatedByVerification,
    // `SIGKILL` after a `SIGTERM` is the escalation, and it is recorded rather than hidden: a
    // process that had to be killed did not shut down cleanly, whatever the exit status says.
    escalated: outcome.signal === "SIGKILL",
    durationMs: outcome.durationMs,
  };
}

export function createProjectRuntimeVerificationProvider(
  options: ProjectRuntimeVerificationOptions = {},
): ProjectRuntimeVerificationProvider {
  return new ProjectRuntimeVerificationProvider(options);
}
