import { spawn } from "node:child_process";
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
  /** Inherit `process.env`. Defaults to true; a provider credential is needed for a real run. */
  readonly inheritEnv?: boolean;
  /** Extra environment entries, merged over the inherited environment. Never logged. */
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Names the run in a failure message without ever including the argument list. */
  readonly label: string;
}

export interface RunProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function excerpt(text: string, limit: number): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return "";
  }

  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}… (truncated)`;
}

function nonZeroExitError(
  code: ProcessFailureCode | "non_zero_exit",
  label: string,
  exitCode: number,
  stderr: string,
  stderrExcerptLimit: number,
): OpenCodeAdapterError {
  const detail = excerpt(stderr, stderrExcerptLimit);

  return new OpenCodeAdapterError(
    code,
    `${label} exited with code ${String(exitCode)}.${detail === "" ? "" : ` stderr: ${detail}`}`,
  );
}

/**
 * Runs a child process and returns its streams.
 *
 * Safety properties, all of them load-bearing, and shared by the transport, the capability probe,
 * and the configuration smoke test so none of them can grow a weaker path:
 *
 * - arguments are passed as an array and `shell` is explicitly false, so no feature title, user
 *   request, or artifact content is ever interpreted by a shell;
 * - the environment is inherited only because a provider credential is required, and it is never
 *   echoed into a result, a log line, or an error message;
 * - stdout and stderr are captured separately, each with a byte cap that stops a runaway run;
 * - a timeout or an abort terminates the child and rejects, it never resolves with partial output;
 * - a non-zero exit is reported with the exit code and a bounded stderr excerpt, and the argument
 *   list, which for a stage run contains the prompt, is never included in the message.
 *
 * A refusal always throws. The caller decides what a zero exit code means for its own command.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stderrExcerptLimit = options.stderrExcerptLimit ?? DEFAULT_STDERR_EXCERPT_LIMIT;

  if (options.signal?.aborted === true) {
    return Promise.reject(
      new OpenCodeAdapterError("transport_cancelled", `${options.label} was cancelled before it started.`),
    );
  }

  return new Promise<RunProcessResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let stopReason: OpenCodeAdapterError | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.inheritEnv === false
        ? { env: { ...options.env } }
        : { env: { ...process.env, ...options.env } }),
    });

    const clearTimers = (): void => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const stop = (error: OpenCodeAdapterError): void => {
      if (stopReason !== null) {
        return;
      }

      stopReason = error;
      clearTimers();

      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      stop(
        new OpenCodeAdapterError(
          "transport_timeout",
          `${options.label} exceeded its ${String(options.timeoutMs)}ms budget.`,
        ),
      );
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const onAbort = (): void => {
      stop(new OpenCodeAdapterError("transport_cancelled", `${options.label} was cancelled.`));
      child.kill("SIGTERM");
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const detach = (): void => {
      clearTimeout(timer);
      clearTimers();
      options.signal?.removeEventListener("abort", onAbort);
    };

    const capture = (stream: "stdout" | "stderr", chunk: string): void => {
      capturedBytes += Buffer.byteLength(chunk, "utf8");

      if (stream === "stdout") {
        stdout += chunk;
      } else {
        stderr += chunk;
      }

      if (capturedBytes > maxOutputBytes) {
        stop(
          new OpenCodeAdapterError(
            "output_truncated",
            `${options.label} produced more than ${String(maxOutputBytes)} bytes and was stopped.`,
          ),
        );
        child.kill("SIGTERM");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      capture("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      capture("stderr", chunk);
    });

    child.on("error", (error: Error) => {
      detach();

      reject(
        stopReason ??
          new OpenCodeAdapterError("transport_failed", `Unable to start ${options.label}.`, { cause: error }),
      );
    });

    child.on("close", (code: number | null) => {
      detach();

      if (stopReason !== null) {
        reject(stopReason);
        return;
      }

      const exitCode = code ?? 1;

      if (exitCode !== 0) {
        reject(nonZeroExitError("non_zero_exit", options.label, exitCode, stderr, stderrExcerptLimit));
        return;
      }

      resolve({ exitCode, stdout, stderr });
    });
  });
}
