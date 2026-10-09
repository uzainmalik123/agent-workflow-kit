import {
  runChildProcess,
  type ProcessFailureReason,
  type ProcessTermination,
} from "@agent-workflow-kit/project";
import { OpenCodeAdapterError } from "./errors.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 4_000_000;
export const DEFAULT_STDERR_EXCERPT_LIMIT = 2_000;
export const DEFAULT_KILL_GRACE_MS = 2_000;

export type ProcessFailureCode = "transport_timeout" | "transport_cancelled" | "output_truncated";

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly stderrExcerptLimit?: number;
  readonly killGraceMs?: number;
  /**
   * Inherit `process.env`. Defaults to true; a provider credential is needed for a real run.
   *
   * Stated as an explicit request rather than an omission, because the shared runner's own default is
   * now a fixed allowlist. This transport earns that request: the commands it runs are the operator's
   * own OpenCode binary — `run`, `--version`, `--help` — never a command a repository declared, and an
   * agent run cannot authenticate without the credential the host holds.
   */
  readonly inheritEnv?: boolean;
  /** Extra environment entries, merged over the inherited environment. Never logged. */
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Names the run in a failure message without ever including the argument list. */
  readonly label: string;
  /**
   * Observes a stream chunk while the child is still running — see the runner's own field of the
   * same name. Optional, observation only, and it cannot change the result or the refusal.
   */
  readonly onStreamChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Observes the raw child outcome, on success and failure alike, for a caller that records what
   * actually ran. The callback is synchronous and cannot change the outcome: this function keeps
   * sole ownership of the refusal policy, and a failed run still rejects with the same errors.
   */
  readonly onOutcome?: (observation: ProcessOutcomeObservation) => void;
}

export interface RunProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The raw child outcome, as the shared runner saw it, before this function's policy turns it into a
 * result or a refusal.
 *
 * A refusal carries only a bounded stderr excerpt in its message, because a message travels and a
 * prompt is private. A caller that needs the full picture — every byte of both streams, the exit
 * code, how long the child actually ran — gets it here, on success and failure alike.
 */
export interface ProcessOutcomeObservation {
  /** How the child ended: `exited`, `signalled`, `timed_out`, `cancelled`, `spawn_failed`, or `output_truncated`. */
  readonly termination: ProcessTermination;
  /** The exit code when the child exited on its own; `null` for every other termination. */
  readonly exitCode: number | null;
  /** The raw stdout capture, subject to the same caps as a successful result. */
  readonly stdout: string;
  /** The raw stderr capture, subject to the same caps as a successful result. */
  readonly stderr: string;
  /** When the child was spawned, as recorded by the shared runner's clock. */
  readonly startedAt: string;
  /** Wall-clock time from spawn to outcome, as measured by the shared runner. */
  readonly durationMs: number;
}

export function excerpt(text: string, limit: number): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return "";
  }

  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}… (truncated)`;
}

const TERMINATION_CODES: Readonly<Record<ProcessTermination, ProcessFailureCode | "non_zero_exit" | "transport_failed">> = {
  exited: "non_zero_exit",
  signalled: "transport_failed",
  timed_out: "transport_timeout",
  cancelled: "transport_cancelled",
  spawn_failed: "transport_failed",
  output_truncated: "output_truncated",
};

function reasonSuffix(reason: ProcessFailureReason | null): string {
  return reason === null ? "" : ` (${reason})`;
}

/**
 * Runs an OpenCode CLI process and refuses anything but a clean exit.
 *
 * This is the transport's own policy on top of the repository's single deterministic runner: a
 * non-zero exit, a timeout, a cancellation, or a process that produced more output than it was allowed
 * is an error, because for an agent run there is no evidence to record and nothing to interpret. The
 * project adapter deliberately treats the same outcomes as results, since a failing lint run is the
 * evidence it exists to collect. The mechanics are shared; the two policies are not.
 *
 * Safety properties inherited from the runner, all of them load-bearing, and shared by the transport,
 * the capability probe, and the configuration smoke test so none of them can grow a weaker path:
 *
 * - arguments are passed as an array and `shell` is explicitly false, so no feature title, user
 *   request, or artifact content is ever interpreted by a shell;
 * - the environment is inherited only because a provider credential is required, and it is never
 *   echoed into a result, a log line, or an error message;
 * - stdout and stderr are captured separately, each with a byte cap that stops a runaway run.
 *   They are *buffers*, not a live view: nothing outside this function sees a byte until the child
 *   exits, which is why a caller that must show progress while the run is happening asks for
 *   `onStreamChunk` — the same chunks, delivered as they arrive, unable to change the capture, the
 *   cap, or the outcome;
 * - a timeout or an abort terminates the child and rejects, it never resolves with partial output;
 * - a non-zero exit is reported with the exit code and a bounded stderr excerpt, and the argument
 *   list, which for a stage run contains the prompt, is never included in the message.
 *
 * A refusal always throws. The caller decides what a zero exit code means for its own command.
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  if (options.signal?.aborted === true) {
    throw new OpenCodeAdapterError("transport_cancelled", `${options.label} was cancelled before it started.`);
  }

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  // A verification command's output is evidence, so the project adapter keeps a bounded head and
  // tail. This one parses its output as a document, so it needs the whole stream: the head window is
  // widened to the byte ceiling and the tail window closed, which still bounds memory at
  // `maxOutputBytes` and still stops a run that exceeds it.
  const outcome = await runChildProcess({
    executable: command,
    args,
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs,
    maxStreamBytes: maxOutputBytes,
    captureHeadChars: maxOutputBytes,
    captureTailChars: 0,
    killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    // The runner hands out an allowlisted environment unless a caller asks for the host by name. This
    // transport asks, so the two documented defaults stay exactly where they were: `runProcess`
    // inherits, `inheritEnv: false` scrubs through `buildStageRunEnvironment` first.
    inheritEnv: options.inheritEnv !== false,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onStreamChunk === undefined ? {} : { onStreamChunk: options.onStreamChunk }),
    signal: options.signal ?? null,
  });

  options.onOutcome?.({
    termination: outcome.termination,
    exitCode: outcome.exitCode,
    stdout: outcome.stdout.text,
    stderr: outcome.stderr.text,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
  });

  if (outcome.termination === "exited" && outcome.exitCode === 0) {
    return { exitCode: 0, stdout: outcome.stdout.text, stderr: outcome.stderr.text };
  }

  const code = TERMINATION_CODES[outcome.termination];
  const detail = excerpt(outcome.stderr.text, options.stderrExcerptLimit ?? DEFAULT_STDERR_EXCERPT_LIMIT);

  if (code === "non_zero_exit") {
    throw new OpenCodeAdapterError(
      code,
      `${options.label} exited with code ${String(outcome.exitCode ?? 1)}.${
        detail === "" ? "" : ` stderr: ${detail}`
      }`,
    );
  }

  if (outcome.termination === "timed_out") {
    throw new OpenCodeAdapterError(
      "transport_timeout",
      `${options.label} exceeded its ${String(options.timeoutMs)}ms budget after ${String(outcome.durationMs)}ms.`,
    );
  }

  if (outcome.termination === "cancelled") {
    throw new OpenCodeAdapterError("transport_cancelled", `${options.label} was cancelled.`);
  }

  if (outcome.termination === "output_truncated") {
    throw new OpenCodeAdapterError(
      "output_truncated",
      `${options.label} produced more than ${String(maxOutputBytes)} bytes and was stopped.`,
    );
  }

  throw new OpenCodeAdapterError(
    "transport_failed",
    `${options.label} did not complete: ${outcome.termination}${reasonSuffix(outcome.reason)}.${
      detail === "" ? "" : ` stderr: ${detail}`
    }`,
  );
}
