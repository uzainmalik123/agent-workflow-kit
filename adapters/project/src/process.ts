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
 *
 * There is one spawn implementation, and there are two ways to hold on to it. `runChildProcess`
 * starts a command, waits for it to finish, and returns its outcome; a verification command is
 * defined by the fact that it finishes. `startChildProcess` starts the same command and hands back a
 * handle for a process that is *meant* to keep running, which is what a runtime verification needs:
 * the application it starts has to be reachable, probed, and then stopped. Both go through the same
 * launch, the same bounded captures, the same `shell: false`, the same first-forced-termination rule,
 * and the same outcome type, so a second, weaker process path cannot exist here. What a supervised
 * process adds is a way to signal a process that has not exited yet, and nothing else.
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

/**
 * A process the framework started and is still holding.
 *
 * A verification command is run to completion, so nothing needs a handle to one. An application is
 * not: it has to be started, observed while it runs, and then stopped, and the stopping is part of the
 * evidence rather than a detail of the harness. This is the same process the runner would have
 * started, with the deadline left to the caller because a server that is meant to stay up has no
 * command timeout.
 */
export interface SupervisedChildProcess {
  readonly startedAt: string;
  /** Resolves when the process has closed. Never rejects, for the same reason `runChildProcess` never does. */
  readonly finished: Promise<ChildProcessOutcome>;
  /** The bounded capture of stdout as it stands right now, for a human reading a live process. */
  readonly stdoutCapture: () => ProcessStreamCapture;
  readonly stderrCapture: () => ProcessStreamCapture;
  /**
   * The outcome if the process has already closed, and `null` while it is still running.
   *
   * This exists because "has it closed yet?" cannot be answered by racing `finished` against a
   * sentinel: whichever promise settled first wins the race, and a sentinel that is already settled
   * wins it every time, which reports a running process as closed. The handle knows whether it has
   * settled, so it answers directly rather than guessing with a race.
   */
  readonly peekOutcome: () => ChildProcessOutcome | null;
  /**
   * Asks the process to stop: `SIGTERM`, then `SIGKILL` after the grace period.
   *
   * The first request wins, so a process that is already being stopped for another reason is not
   * reclassified by a later call, and a process that has already exited is not an error. The caller
   * supplies the termination it wants recorded, because "the verification stopped this" and "this
   * died on its own" are different facts about the same exit code.
   */
  readonly terminate: (termination?: ProcessTermination, reason?: ProcessFailureReason) => void;
}

/**
 * A request for a process that is expected to keep running.
 *
 * `ChildProcessRequest` without a `timeoutMs`: the deadline belongs to whoever understands what the
 * process is for, and a framework default here would either cut a slow boot short or hang on a
 * process that never becomes ready. The abort signal is still honoured, because cancellation is not
 * the same thing as a deadline and must work without one.
 */
export type SupervisedChildProcessRequest = Omit<ChildProcessRequest, "timeoutMs"> & {
  /**
   * Whether a stop signal is delivered to the process group rather than to the child alone.
   *
   * A dev server is very often a wrapper: `pnpm dev` runs a script that runs a program, so signalling
   * the child can leave the program running and the port bound after the framework has recorded a
   * clean shutdown. The child is therefore started in its own group and the group is signalled, which
   * is the only way the caller can actually clean up what it started. POSIX only: Windows has no
   * process groups to signal this way, so there the default is the child alone, which is no worse than
   * the alternative and never signals a group the framework did not create.
   */
  readonly killProcessGroup?: boolean;
};

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

interface LaunchOptions {
  readonly clock: () => number;
  readonly maxStreamBytes: number;
  readonly killGraceMs: number;
  /** The whole-command deadline, or `null` for a process that is meant to keep running. */
  readonly deadlineMs: number | null;
  readonly killProcessGroup: boolean;
}

interface ForcedTermination {
  readonly termination: ProcessTermination;
  readonly reason: ProcessFailureReason;
}

interface LaunchedChild {
  readonly startedAtMs: number;
  readonly stdout: BoundedCapture;
  readonly stderr: BoundedCapture;
  readonly finished: Promise<ChildProcessOutcome>;
  readonly peekOutcome: () => ChildProcessOutcome | null;
  readonly terminate: (termination: ProcessTermination, reason: ProcessFailureReason) => void;
  readonly forcedTermination: () => ForcedTermination | null;
}

/** Whether a process group can be signalled at all on this platform. */
const groupsAreSignalled = process.platform !== "win32";

/**
 * Starts a process and hands back the handles for watching it and for stopping it.
 *
 * This is the one `spawn` call in this repository, and every property of the boundary lives here: no
 * shell, a working directory passed as data, bounded captures, a byte ceiling that stops a runaway
 * rather than growing this process, a signal that terminates instead of reporting, and an outcome that
 * is always a value. The two public entry points below differ only in whether they wait, so neither
 * can become the weaker of the two.
 */
function launchChild(
  request: Omit<ChildProcessRequest, "timeoutMs">,
  options: LaunchOptions,
): LaunchedChild {
  const { clock, maxStreamBytes, killGraceMs, deadlineMs, killProcessGroup } = options;
  const stdout = new BoundedCapture(
    request.captureHeadChars ?? DEFAULT_CAPTURE_HEAD_CHARS,
    request.captureTailChars ?? DEFAULT_CAPTURE_TAIL_CHARS,
  );
  const stderr = new BoundedCapture(
    request.captureHeadChars ?? DEFAULT_CAPTURE_HEAD_CHARS,
    request.captureTailChars ?? DEFAULT_CAPTURE_TAIL_CHARS,
  );
  const startedAtMs = clock();

  if (request.signal?.aborted === true) {
    // Nothing is started, so there is nothing to wait for and nothing to stop. The result is still a
    // cancellation, because that is the only honest description of a request that arrived already
    // cancelled. The outcome is both the resolved promise and what `peekOutcome` reports, because the
    // process is closed before anyone could ask.
    const cancelled = outcome("cancelled", null, null, 0, 0, stdout, stderr, "aborted");

    return {
      startedAtMs,
      stdout,
      stderr,
      finished: Promise.resolve(cancelled),
      peekOutcome: () => cancelled,
      terminate: () => {},
      forcedTermination: () => null,
    };
  }

  let forced: ForcedTermination | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let settled = false;

  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    ...(killProcessGroup ? { detached: true } : {}),
    ...(request.inheritEnv === false
      ? { env: { ...request.env } }
      : { env: { ...process.env, ...request.env } }),
  });

  /**
   * Stops the process, escalating to `SIGKILL` when it does not go.
   *
   * The escalation is the point rather than a safety net. A `SIGTERM` that is ignored leaves the
   * framework waiting on a process it has already given up on, and a runtime verification that cannot
   * clean up the server it started is worse than one that never started it, because the port stays
   * bound for whatever runs next. Signalling the group rather than the child is what makes that
   * possible for a wrapped command such as a package manager running a dev script.
   */
  const send = (name: NodeJS.Signals): void => {
    if (killProcessGroup && groupsAreSignalled && child.pid !== undefined) {
      try {
        process.kill(-child.pid, name);
        return;
      } catch {
        // The group is already gone, which is the outcome the signal was for. Fall through to the
        // child so a process that exited between the two calls is still stopped directly.
      }
    }

    child.kill(name);
  };

  const clearKillTimer = (): void => {
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
    clearKillTimer();
    killTimer = setTimeout(() => {
      send("SIGKILL");
    }, killGraceMs);
  };

  const terminate = (termination: ProcessTermination, reason: ProcessFailureReason): void => {
    force(termination, reason);
    send("SIGTERM");
  };

  const onAbort = (): void => {
    terminate("cancelled", "aborted");
  };

  request.signal?.addEventListener("abort", onAbort, { once: true });

  let settledOutcome: ChildProcessOutcome | null = null;
  const finished = new Promise<ChildProcessOutcome>((resolve) => {
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

      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }

      clearKillTimer();
      request.signal?.removeEventListener("abort", onAbort);
      settledOutcome = outcome(
        termination,
        exitCode,
        signal,
        Math.max(0, clock() - startedAtMs),
        startedAtMs,
        stdout,
        stderr,
        reason,
      );
      resolve(settledOutcome);
    };

    const account = (capture: BoundedCapture): void => {
      if (forced !== null) {
        return;
      }

      if (capture.byteCount > maxStreamBytes) {
        terminate("output_truncated", "output_ceiling_exceeded");
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

  if (deadlineMs !== null) {
    deadlineTimer = setTimeout(() => {
      terminate("timed_out", "deadline_exceeded");
    }, deadlineMs);
  }

  return {
    startedAtMs,
    stdout,
    stderr,
    finished,
    peekOutcome: () => settledOutcome,
    terminate,
    forcedTermination: () => forced,
  };
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
  return launchChild(request, {
    clock: options.clock ?? Date.now,
    maxStreamBytes: request.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES,
    killGraceMs: request.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    deadlineMs: request.timeoutMs,
    // A command that is expected to finish is stopped on its own, as it always has been. Widening
    // this to the whole group would change which processes a verification stage's timeout reaches,
    // which is a different decision from the one the runtime verifier makes deliberately.
    killProcessGroup: false,
  }).finished;
}

/**
 * Starts a process that is meant to keep running, and keeps the handles needed to observe and stop it.
 *
 * There is no deadline, so the caller owns the lifetime and has to terminate what it started. That is
 * the shape of the operation rather than a caveat: this exists for a server that has to be reachable,
 * and a server's lifetime is bounded by the check that needs it rather than by a constant in this
 * module. The abort signal is honoured, so a caller that is cancelled does not leave a process behind.
 */
export function startChildProcess(
  request: SupervisedChildProcessRequest,
  options: RunChildProcessOptions = {},
): SupervisedChildProcess {
  const launched = launchChild(request, {
    clock: options.clock ?? Date.now,
    maxStreamBytes: request.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES,
    killGraceMs: request.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    deadlineMs: null,
    killProcessGroup: request.killProcessGroup ?? groupsAreSignalled,
  });

  return {
    startedAt: new Date(launched.startedAtMs).toISOString(),
    finished: launched.finished,
    stdoutCapture: (): ProcessStreamCapture => launched.stdout.capture(),
    stderrCapture: (): ProcessStreamCapture => launched.stderr.capture(),
    peekOutcome: launched.peekOutcome,
    terminate: (
      termination: ProcessTermination = "signalled",
      reason: ProcessFailureReason = "terminated_by_signal",
    ): void => {
      launched.terminate(termination, reason);
    },
  };
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
