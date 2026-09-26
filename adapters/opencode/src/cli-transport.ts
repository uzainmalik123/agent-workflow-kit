import { spawn } from "node:child_process";
import { OpenCodeAdapterError } from "./errors.js";
import {
  type OpenCodeRawResult,
  type OpenCodeTransport,
  type OpenCodeTransportRequest,
} from "./transport.js";

export const DEFAULT_OPENCODE_COMMAND = "opencode";
export const DEFAULT_MAX_OUTPUT_BYTES = 4_000_000;
export const DEFAULT_STDERR_EXCERPT_LIMIT = 2_000;
export const DEFAULT_KILL_GRACE_MS = 2_000;

export type OpenCodeResponseFormat = "text" | "json";

export interface OpenCodeCliTransportOptions {
  /** The OpenCode executable. Defaults to `opencode` on `PATH`. */
  readonly command?: string;
  /** Extra arguments inserted before `run`, for example `["--print-logs"]`. */
  readonly extraArgs?: readonly string[];
  readonly model?: string | null;
  /**
   * `text` reads the CLI's formatted answer from stdout. `json` reads the raw event stream. The
   * formatted output is the stable choice and the default.
   */
  readonly responseFormat?: OpenCodeResponseFormat;
  readonly maxOutputBytes?: number;
  readonly stderrExcerptLimit?: number;
  readonly killGraceMs?: number;
  /** Inherit `process.env`. Defaults to true; a provider credential is needed for a real run. */
  readonly inheritEnv?: boolean;
  /** Extra environment entries, merged over the inherited environment. Never logged. */
  readonly env?: Readonly<Record<string, string>>;
  /** `--pure` skips external plugins, so a project plugin cannot alter a role's behaviour. */
  readonly pure?: boolean;
  /** `--auto` approves anything not explicitly denied. Off by default: it is dangerous. */
  readonly autoApprove?: boolean;
}

export interface OpenCodeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function buildOpenCodeInvocation(
  request: OpenCodeTransportRequest,
  options?: OpenCodeCliTransportOptions,
): OpenCodeInvocation {
  if (request.prompt.startsWith("-")) {
    throw new OpenCodeAdapterError(
      "transport_failed",
      `Refusing to run OpenCode: the stage prompt starts with "-" and would be parsed as an option.`,
    );
  }

  const command = options?.command ?? DEFAULT_OPENCODE_COMMAND;
  const args: string[] = [...(options?.extraArgs ?? [])];

  args.push("run");

  if (options?.pure !== false) {
    args.push("--pure");
  }

  args.push("--agent", request.agent);
  args.push("--format", options?.responseFormat ?? "text");

  const model = options?.model === undefined ? request.model : options.model;

  if (model !== null && model.length > 0) {
    args.push("--model", model);
  }

  args.push("--dir", request.workingDirectory);

  if (options?.autoApprove === true) {
    args.push("--auto");
  }

  args.push(request.prompt);

  return { command, args, cwd: request.workingDirectory };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushText(value: unknown, parts: string[]): void {
  if (typeof value === "string" && value.length > 0) {
    parts.push(value);
  }
}

/**
 * Best-effort text extraction from `opencode run --format json`.
 *
 * OpenCode's raw event stream is a transport detail, so this is the single place that knows its
 * shape. An event this reader does not recognize contributes nothing; if nothing is recognized at
 * all the raw output is returned unchanged and the response protocol refuses it, which fails
 * closed rather than guessing.
 */
export function extractEventStreamText(stdout: string): string {
  const parts: string[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("{")) {
      continue;
    }

    let event: unknown;

    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }

    if (!isRecord(event)) {
      continue;
    }

    const part = event["part"];
    const message = event["message"];

    if (isRecord(part)) {
      if (part["type"] === "text") {
        pushText(part["text"], parts);
        continue;
      }
    }

    if (event["type"] === "text") {
      pushText(event["text"], parts);
      continue;
    }

    if (isRecord(message) && message["role"] === "assistant" && Array.isArray(message["content"])) {
      for (const block of message["content"]) {
        if (isRecord(block) && block["type"] === "text") {
          pushText(block["text"], parts);
        }
      }
    }
  }

  return parts.length === 0 ? stdout : parts.join("");
}

export function extractResponseText(stdout: string, format: OpenCodeResponseFormat): string {
  return (format === "json" ? extractEventStreamText(stdout) : stdout).trim();
}

function excerpt(text: string, limit: number): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return "";
  }

  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}… (truncated)`;
}

/**
 * Runs the real OpenCode CLI.
 *
 * Safety properties, all of them load-bearing:
 *
 * - arguments are passed as an array and `shell` is explicitly false, so no feature title, user
 *   request, or artifact content is ever interpreted by a shell;
 * - the environment is inherited only because a provider credential is required, it is never
 *   echoed into a result, a log line, or an error message;
 * - stdout and stderr are captured separately, each with a byte cap that stops a runaway run;
 * - a timeout or an abort terminates the child and becomes a refusal, not an empty success;
 * - a non-zero exit is a refusal, and the command line, which contains the stage prompt, is never
 *   included in the error.
 */
export class OpenCodeCliTransport implements OpenCodeTransport {
  readonly #options: OpenCodeCliTransportOptions;

  constructor(options?: OpenCodeCliTransportOptions) {
    this.#options = options ?? {};
  }

  async run(request: OpenCodeTransportRequest): Promise<OpenCodeRawResult> {
    const invocation = buildOpenCodeInvocation(request, this.#options);
    const timeoutMs = request.timeoutMs;
    const maxOutputBytes = this.#options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const format = this.#options.responseFormat ?? "text";

    if (request.signal?.aborted === true) {
      throw new OpenCodeAdapterError(
        "transport_cancelled",
        `The OpenCode run for agent "${request.agent}" was cancelled before it started.`,
      );
    }

    return new Promise<OpenCodeRawResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let capturedBytes = 0;
      let stopReason: OpenCodeAdapterError | null = null;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        ...(this.#options.inheritEnv === false
          ? { env: { ...this.#options.env } }
          : { env: { ...process.env, ...this.#options.env } }),
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

        const grace = this.#options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, grace);
      };

      const timer = setTimeout(() => {
        stop(
          new OpenCodeAdapterError(
            "transport_timeout",
            `The OpenCode run for agent "${request.agent}" exceeded its ${String(timeoutMs)}ms budget.`,
          ),
        );
        child.kill("SIGTERM");
      }, timeoutMs);

      const onAbort = (): void => {
        stop(
          new OpenCodeAdapterError(
            "transport_cancelled",
            `The OpenCode run for agent "${request.agent}" was cancelled.`,
          ),
        );
        child.kill("SIGTERM");
      };

      request.signal?.addEventListener("abort", onAbort, { once: true });

      const detach = (): void => {
        clearTimeout(timer);
        clearTimers();
        request.signal?.removeEventListener("abort", onAbort);
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
              `The OpenCode run for agent "${request.agent}" produced more than ${String(maxOutputBytes)} bytes and was stopped.`,
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
            new OpenCodeAdapterError(
              "transport_failed",
              `Unable to start the OpenCode executable for agent "${request.agent}".`,
              { cause: error },
            ),
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
          const detail = excerpt(
            stderr,
            this.#options.stderrExcerptLimit ?? DEFAULT_STDERR_EXCERPT_LIMIT,
          );

          reject(
            new OpenCodeAdapterError(
              "non_zero_exit",
              `The OpenCode run for agent "${request.agent}" exited with code ${String(exitCode)}.${detail === "" ? "" : ` stderr: ${detail}`}`,
            ),
          );
          return;
        }

        resolve({
          agent: request.agent,
          exitCode,
          stdout,
          stderr,
          text: extractResponseText(stdout, format),
        });
      });
    });
  }
}

export function createOpenCodeCliTransport(
  options?: OpenCodeCliTransportOptions,
): OpenCodeCliTransport {
  return new OpenCodeCliTransport(options);
}
