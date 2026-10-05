import { buildStageRunEnvironment } from "./environment.js";
import { OpenCodeAdapterError } from "./errors.js";
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_STDERR_EXCERPT_LIMIT,
  runProcess,
  type RunProcessResult,
} from "./process.js";
import { OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE } from "./runtime-config.js";
import {
  type OpenCodeRawResult,
  type OpenCodeTransport,
  type OpenCodeTransportRequest,
} from "./transport.js";

export const DEFAULT_OPENCODE_COMMAND = "opencode";

/**
 * The response formats this adapter asks the CLI for.
 *
 * `text` is our name for the CLI's `default` format, which writes the assistant's completed text
 * parts to stdout and sends headers, tool output, and permission warnings to stderr. `json` is the
 * CLI's raw NDJSON event stream. The CLI accepts `default` and `json`; it has never accepted `text`.
 */
export type OpenCodeResponseFormat = "text" | "json";

export type OpenCodeCliFormat = "default" | "json";

/** Maps this adapter's response format onto the value the current CLI accepts. */
export function toCliFormat(format: OpenCodeResponseFormat): OpenCodeCliFormat {
  return format === "json" ? "json" : "default";
}

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
  /**
   * Extra environment entries, merged over the inherited environment and then scrubbed. Never logged.
   * The scrub runs last, so an entry here cannot reintroduce a variable that can inject a different
   * OpenCode configuration or permission policy.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * `--auto` approves anything not explicitly denied. Off by default: it is dangerous. A generated
   * role denies what it must not do, so approving the remainder is not needed to let it work.
   */
  readonly autoApprove?: boolean;
}

export interface OpenCodeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * The invocation surface, kept as small as the contract allows:
 *
 * ```text
 * opencode run --standalone --agent <agent> --format <default|json> [--model …] [prompt]
 * ```
 *
 * The working directory is not a flag. V2 dropped `--dir` and takes the repository from the child
 * process's own working directory, which `runProcess` already sets to the stage's repository, so
 * config and agent discovery resolve against the project the stage is meant to be working on rather
 * than against whatever directory the adapter happened to be launched from.
 *
 * `--standalone` is not optional. Each stage is an independent run that reuses no OpenCode session,
 * and a private server per run is what makes that true: there is no background service whose
 * already-loaded configuration, cached agents, or warmed state could carry over from an earlier
 * stage or from an unrelated project. It is also the only isolation this CLI offers now that
 * `--pure` is gone, so a run that silently fell back to the shared service would inherit whatever
 * that service had loaded.
 *
 * There is no session continuation, no `--server`, and no `--auto`. One stage run is one fresh
 * session, and nothing about the previous stage's session is reused.
 */
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
  // Use `--` immediately after `run` to separate the parent command's options from the subcommand.
  // OpenCode's argument parser (yargs) requires this to correctly parse the `run` subcommand's options.
  args.push("--");
  args.push("--standalone");
  args.push("--agent", request.agent);
  args.push("--format", toCliFormat(options?.responseFormat ?? "text"));

  const model = options?.model === undefined ? request.model : options.model;

  if (model !== null && model.length > 0) {
    args.push("--model", model);
  }

  if (options?.autoApprove === true) {
    args.push("--auto");
  }

  // Use `--prompt` flag for the prompt text.
  args.push("--prompt", request.prompt);

  return { command, args, cwd: request.workingDirectory };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ParsedEventStream {
  /** Completed assistant text parts, in the order the CLI emitted them. Empty if there were none. */
  readonly text: string;
  /** How many completed text parts were found. Zero means the stream carried no answer at all. */
  readonly textParts: number;
  /** A session or prompt error the CLI reported in the stream. */
  readonly error: string | null;
  /** Event type names seen, for diagnostics. */
  readonly eventTypes: readonly string[];
  /** Lines that looked like events but could not be parsed. */
  readonly malformedLines: number;
}

/**
 * Reads the `opencode run --format json` NDJSON stream.
 *
 * The current runner writes one JSON object per line, each carrying `type`, `timestamp`,
 * `sessionID`, and a payload: `part` for `step_start`, `step_finish`, `text`, `reasoning`, and
 * `tool_use`, and `error` for `error`. A `text` event is only emitted once the part is complete,
 * and an assistant answer can span several text parts, so the parts are concatenated in order
 * instead of taking the last one.
 *
 * The stream is a transport detail, and this is the only place that knows its shape. An event type
 * this reader does not recognize is counted and contributes nothing: it is never read as workflow
 * output, and the raw line is never handed on as a fallback. A stream with no text part therefore
 * produces no text at all, and the transport turns that into a failure rather than guessing, which
 * is what keeps a malformed or unexpected stream from being read as a stage result.
 */
export function parseEventStream(stdout: string): ParsedEventStream {
  const parts: string[] = [];
  const eventTypes: string[] = [];
  let error: string | null = null;
  let malformedLines = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    if (!trimmed.startsWith("{")) {
      malformedLines += 1;
      continue;
    }

    let event: unknown;

    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      malformedLines += 1;
      continue;
    }

    if (!isRecord(event)) {
      malformedLines += 1;
      continue;
    }

    const type = event["type"];

    if (typeof type === "string") {
      eventTypes.push(type);
    }

    if (type === "error") {
      error = describeStreamError(event["error"]) ?? "OpenCode reported a session error.";
      continue;
    }

    if (type !== "text") {
      continue;
    }

    const part = event["part"];

    if (!isRecord(part) || part["type"] !== "text") {
      continue;
    }

    const text = part["text"];

    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }

  return {
    text: parts.join("\n"),
    textParts: parts.length,
    error,
    eventTypes,
    malformedLines,
  };
}

/**
 * A short, safe description of an unusable stream: which event types appeared and how many lines
 * were unreadable. It carries no model output, so it is safe to log.
 */
function describeStreamShape(stream: ParsedEventStream): string {
  const distinct = [...new Set(stream.eventTypes)];
  const seen = distinct.length === 0 ? "none" : distinct.join(", ");

  return `Event types seen: ${seen}. Unreadable lines: ${String(stream.malformedLines)}.`;
}

function describeStreamError(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value["name"] === "string" ? value["name"] : null;
  const data = value["data"];

  if (isRecord(data) && typeof data["message"] === "string") {
    return data["message"];
  }

  return name;
}

/**
 * Extracts the response text from a completed run.
 *
 * A stream that reported an error yields no text at all, so a failed run can never be mistaken for
 * a successful one that happened to say nothing useful.
 */
export function extractResponseText(stdout: string, format: OpenCodeResponseFormat): string {
  if (format === "json") {
    return parseEventStream(stdout).text.trim();
  }

  return stdout.trim();
}

/**
 * Runs the real OpenCode CLI.
 *
 * The process itself is spawned by `runProcess`, which owns the no-shell, timeout, cancellation, and
 * output-cap guarantees. On top of that this transport treats a reported stream error as a failure
 * even when the CLI exited zero, so a session that died mid-answer cannot be reported as a stage
 * result.
 */
export class OpenCodeCliTransport implements OpenCodeTransport {
  readonly #options: OpenCodeCliTransportOptions;

  constructor(options?: OpenCodeCliTransportOptions) {
    this.#options = options ?? {};
  }

  async run(request: OpenCodeTransportRequest): Promise<OpenCodeRawResult> {
    const invocation = buildOpenCodeInvocation(request, this.#options);
    const maxOutputBytes = this.#options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stderrExcerptLimit = this.#options.stderrExcerptLimit ?? DEFAULT_STDERR_EXCERPT_LIMIT;
    const format = this.#options.responseFormat ?? "text";
    const label = `The OpenCode run for agent "${request.agent}"`;
    // `OPENCODE_CONFIG_DIR` is scrubbed from the inherited and caller-supplied environment, because
    // letting either choose which configuration directory runs the agent is exactly what the scrub
    // exists to prevent. It is then forced to the framework's own runtime directory, after the scrub,
    // so the value that survives is the one this run decided.
    const forced =
      request.runtimeConfigDirectory === null
        ? {}
        : { [OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE]: request.runtimeConfigDirectory };

    const environment = buildStageRunEnvironment({
      ...(this.#options.inheritEnv === false ? { base: {} } : {}),
      ...(this.#options.env === undefined ? {} : { overrides: this.#options.env }),
      forced,
    });

    let result: RunProcessResult;

    try {
      result = await runProcess(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        timeoutMs: request.timeoutMs,
        maxOutputBytes,
        stderrExcerptLimit,
        ...(this.#options.killGraceMs === undefined ? {} : { killGraceMs: this.#options.killGraceMs }),
        // The environment is fully materialized here and passed without inheritance, so the scrub is
        // the last word on what the child sees rather than a step the spawn helper may undo.
        inheritEnv: false,
        env: environment.env,
        ...(request.signal == null ? {} : { signal: request.signal }),
        label,
      });
    } catch (error) {
      if (error instanceof OpenCodeAdapterError) {
        throw error;
      }

      throw new OpenCodeAdapterError("transport_failed", `${label} failed.`, { cause: error });
    }

    if (format === "json") {
      const stream = parseEventStream(result.stdout);

      if (stream.error !== null) {
        throw new OpenCodeAdapterError(
          "transport_failed",
          `${label} reported an error in its event stream: ${stream.error}`,
        );
      }

      if (stream.textParts === 0) {
        throw new OpenCodeAdapterError(
          "transport_failed",
          `${label} produced no assistant text in its event stream, so there is no answer to parse.`,
          { cause: describeStreamShape(stream) },
        );
      }
    }

    return {
      agent: request.agent,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      text: extractResponseText(result.stdout, format),
    };
  }
}

export function createOpenCodeCliTransport(
  options?: OpenCodeCliTransportOptions,
): OpenCodeCliTransport {
  return new OpenCodeCliTransport(options);
}

export { DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_STDERR_EXCERPT_LIMIT };
