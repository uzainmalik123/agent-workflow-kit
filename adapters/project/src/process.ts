import { spawn } from "node:child_process";

/**
 * The one deterministic process runner in this repository.
 *
 * Running a project command executes repository-controlled code, so the properties below are the
 * trust boundary and each one is load-bearing:
 *
 * - an executable plus an argument array, and `shell: false` unconditionally. Nothing in this
 *   repository ever builds a command line by interpolation, so a script name, a feature title, or a
 *   task payload can never become shell syntax;
 * - a fixed working directory, checked by the caller and passed here as data;
 * - a hard byte ceiling per stream that stops a runaway run, and a bounded capture that keeps the
 *   head and the tail of what was produced so evidence stays a fixed size;
 * - a timeout and an `AbortSignal`, both of which terminate the child and are reported as such
 *   rather than as a pass;
 * - an environment that is inherited because a toolchain needs `PATH`, and never described. No
 *   error message, evidence record, or excerpt in this repository contains an environment value, and
 *   an argument list is never repeated into an error message.
 *
 * The runner never throws and never rejects. A non-zero exit, a missing binary, a timeout, and a
 * cancellation are all results, because each of them is evidence a verification stage must be able
 * to record. Turning a result into a refusal is the caller's decision, and the OpenCode adapter's
 * transport refusal is exactly such a decision.
 */
export const DEFAULT_MAX_STREAM_BYTES = 4_000_000;
export const DEFAULT_CAPTURE_HEAD_CHARS = 4_000;
export const DEFAULT_CAPTURE_TAIL_CHARS = 4_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
export const DEFAULT_KILL_GRACE_MS = 5_000;

export const PROCESS_TERMINATIONS = [
  "exited",
  "signalled",
  "timed_out",
  "cancelled",
  "spawn_failed",
  "output_truncated",
] as const;

export type ProcessTermination = (typeof PROCESS_TERMINATIONS)[number];

/** A short, stable reason for a non-exit termination. Never contains an argument or an env value. */
export type ProcessFailureReason =
  | "executable_not_found"
  | "executable_not_executable"
  | "terminated_by_signal"
  | "deadline_exceeded"
  | "aborted"
  | "output_ceiling_exceeded";

export interface ChildProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | null;
  /** Total bytes accepted from each stream before the child is stopped. */
  readonly maxStreamBytes?: number;
  readonly captureHeadChars?: number;
  readonly captureTailChars?: number;
  readonly killGraceMs?: number;
  /** Inherits `process.env` unless this is `false`. Never described in any result. */
  readonly inheritEnv?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessStreamCapture {
  /** At most `captureHeadChars + captureTailChars` characters, with the omission marked. */
  readonly text: string;
  readonly truncated: boolean;
  /** Bytes actually received from the stream. */
  readonly bytes: number;
  readonly omittedBytes: number;
}

export interface ChildProcessOutcome {
  readonly termination: ProcessTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stdout: ProcessStreamCapture;
  readonly stderr: ProcessStreamCapture;
  readonly reason: ProcessFailureReason | null;
}

export interface RunChildProcessOptions {
  /** Injectable millisecond clock, so evidence timestamps are reproducible in tests. */
  readonly clock?: () => number;
}

function appendTail(tail: string, chunk: string, limit: number): string {
  const combined = tail + chunk;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

/**
 * A fixed-size window over one stream: the first `head` characters and the last `tail` characters.
 * The middle is counted, not stored, so the memory a hostile or runaway command can force this
 * process to hold is bounded no matter how much it writes.
 */
class BoundedCapture {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = "";
  #tail = "";
  #bytes = 0;

  constructor(headLimit: number, tailLimit: number) {
    this.#headLimit = headLimit;
    this.#tailLimit = tailLimit;
  }

  get byteCount(): number {
    return this.#bytes;
  }

  write(chunk: string): void {
    this.#bytes += Buffer.byteLength(chunk, "utf8");

    if (this.#head.length < this.#headLimit) {
      const room = this.#headLimit - this.#head.length;
      this.#head += chunk.slice(0, room);

      if (chunk.length > room) {
        this.#tail = appendTail(this.#tail, chunk.slice(room), this.#tailLimit);
      }

      return;
    }

    this.#tail = appendTail(this.#tail, chunk, this.#tailLimit);
  }

  capture(): ProcessStreamCapture {
    const kept = this.#head.length + this.#tail.length;
    const truncated = kept < this.#bytes;

    if (this.#tail.length === 0) {
      return { text: this.#head, truncated, bytes: this.#bytes, omittedBytes: Math.max(0, this.#bytes - kept) };
    }

    const omitted = Math.max(0, this.#bytes - kept);
    const marker = `\n… ${String(omitted)} bytes omitted …\n`;

    return {
      text: `${this.#head}${marker}${this.#tail}`,
      truncated,
      bytes: this.#bytes,
      omittedBytes: omitted,
    };
  }
}

function spawnFailureReason(code: string | undefined): ProcessFailureReason {
  return code === "EACCES" || code === "EPERM" ? "executable_not_executable" : "executable_not_found";
}

/**
 * Runs one command to completion and describes exactly what happened.
 *
 * The first forced termination wins, so a command that is aborted and then exceeds its deadline is
 * reported as cancelled, and a command that is stopped for producing too much output keeps that as
 * its reason rather than acquiring whichever event arrived second.
 */
export function runChildProcess(
  request: ChildProcessRequest,
  options: RunChildProcessOptions = {},
): Promise<ChildProcessOutcome> {
  const clock = options.clock ?? Date.now;
  const maxStreamBytes = request.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const killGraceMs = request.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const stdout = new BoundedCapture(
    request.captureHeadChars ?? DEFAULT_CAPTURE_HEAD_CHARS,
    request.captureTailChars ?? DEFAULT_CAPTURE_TAIL_CHARS,
  );
  const stderr = new BoundedCapture(
    request.captureHeadChars ?? DEFAULT_CAPTURE_HEAD_CHARS,
    request.captureTailChars ?? DEFAULT_CAPTURE_TAIL_CHARS,
  );

  if (request.signal?.aborted === true) {
    return Promise.resolve(outcome("cancelled", null, null, 0, 0, stdout, stderr, "aborted"));
  }

  return new Promise<ChildProcessOutcome>((resolve) => {
    const startedAtMs = clock();
    let forced: { readonly termination: ProcessTermination; readonly reason: ProcessFailureReason } | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(request.inheritEnv === false
        ? { env: { ...request.env } }
        : { env: { ...process.env, ...request.env } }),
    });

    const clearTimers = (): void => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const force = (termination: ProcessTermination, reason: ProcessFailureReason): void => {
      if (forced !== null) {
        return;
      }

      forced = { termination, reason };
      clearTimers();
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, killGraceMs);
    };

    const timer = setTimeout(() => {
      force("timed_out", "deadline_exceeded");
      child.kill("SIGTERM");
    }, request.timeoutMs);

    const onAbort = (): void => {
      force("cancelled", "aborted");
      child.kill("SIGTERM");
    };

    request.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (
      termination: ProcessTermination,
      exitCode: number | null,
      signal: string | null,
      reason: ProcessFailureReason | null,
    ): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      clearTimers();
      request.signal?.removeEventListener("abort", onAbort);
      resolve(
        outcome(
          termination,
          exitCode,
          signal,
          Math.max(0, clock() - startedAtMs),
          startedAtMs,
          stdout,
          stderr,
          reason,
        ),
      );
    };

    const account = (capture: BoundedCapture): void => {
      if (forced !== null) {
        return;
      }

      if (capture.byteCount > maxStreamBytes) {
        force("output_truncated", "output_ceiling_exceeded");
        child.kill("SIGTERM");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.write(chunk);
      account(stdout);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.write(chunk);
      account(stderr);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      // A spawn failure can arrive without a `close`, so the outcome is settled here as well.
      finish("spawn_failed", null, null, spawnFailureReason(error.code));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (forced !== null) {
        finish(forced.termination, code, signal, forced.reason);
        return;
      }

      if (code === null) {
        finish("signalled", null, signal, "terminated_by_signal");
        return;
      }

      finish("exited", code, signal, null);
    });
  });
}

function outcome(
  termination: ProcessTermination,
  exitCode: number | null,
  signal: string | null,
  durationMs: number,
  startedAtMs: number,
  stdout: BoundedCapture,
  stderr: BoundedCapture,
  reason: ProcessFailureReason | null,
): ChildProcessOutcome {
  return {
    termination,
    exitCode,
    signal,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs,
    stdout: stdout.capture(),
    stderr: stderr.capture(),
    reason,
  };
}

/**
 * Bounded one-line summary of a run, for a message that must not become a transcript. The argument
 * list is deliberately absent: a framework command never carries a secret, and the rule that no
 * error message echoes arguments is worth more than the convenience of repeating them.
 */
export function describeOutcome(outcomeValue: ChildProcessOutcome): string {
  if (outcomeValue.termination === "exited") {
    return `exited with code ${String(outcomeValue.exitCode)}`;
  }

  return outcomeValue.reason === null
    ? outcomeValue.termination
    : `${outcomeValue.termination} (${outcomeValue.reason})`;
}
