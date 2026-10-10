import type {
  FixReturnState,
  StageRole,
  WorkStage,
} from "@agent-workflow-kit/orchestration";

/**
 * Live progress from one stage run.
 *
 * Optional everywhere it appears: a caller that does not supply a callback gets exactly the
 * behaviour it had before these events existed. Nothing here changes a request, a response, a
 * recording, or a stage result — the events are observations of a run that is already happening,
 * and the printing decision belongs to whoever supplied the callback (the CLI prints to stderr).
 *
 * They live beside the transport request because both ends of the wire — the executor, which owns
 * the stage's lifetime, and the transport, which can see the child's output as it arrives — emit
 * into the same callback.
 */
export type StageProgressEvent =
  /** The executor has begun a stage, before any preflight or prompt work. */
  | { readonly type: "stage_started"; readonly stage: WorkStage }
  /** One tool-use line, already stripped of escapes and bounded, as it arrived from the child. */
  | { readonly type: "activity"; readonly stage: WorkStage; readonly line: string }
  /**
   * A reply was refused by the response contract and the stage is being retried: `code` is the
   * refusal (`malformed_response`, `empty_response`, `invalid_result`), `retry` is which retry this
   * is (1-based), `maxRetries` is how many the adapter is allowed. Emitted only for those three
   * refusals — a timeout or a non-zero exit is a failed run, not a rejected reply, and is never
   * announced as a retry because it never causes one.
   */
  | {
      readonly type: "format_retry";
      readonly stage: WorkStage;
      readonly code: string;
      readonly retry: number;
      readonly maxRetries: number;
    }
  /** The stage returned or threw. Emitted for every stage, success or failure alike. */
  | { readonly type: "stage_finished"; readonly stage: WorkStage; readonly elapsedMs: number }
  /**
   * The stage failed: it threw, or it reported `outcome: "failed"`. `recordingFolder` is the
   * absolute directory that stage's invocation recordings land in — which for a write stage is
   * under the workspace cache, and is otherwise the last place a user would think to look.
   */
  | {
      readonly type: "stage_failed";
      readonly stage: WorkStage;
      readonly elapsedMs: number;
      readonly recordingFolder: string;
    };

export type StageProgressCallback = (event: StageProgressEvent) => void;

/**
 * How this adapter asks OpenCode to run a role.
 *
 * The executor depends on this port rather than on a child process, so the exact invocation is a
 * detail of the transport: tests substitute a fake, and a different OpenCode deployment - a
 * server, an SDK, a remote agent - can be added without touching the executor or the prompt
 * boundary.
 */
export interface OpenCodeTransportRequest {
  /** The OpenCode agent id, which is also the generated agent file stem. */
  readonly agent: string;
  /** The fully built stage prompt. Passed as a single argument, never as shell text. */
  readonly prompt: string;
  readonly workingDirectory: string;
  /**
   * The framework-owned OpenCode configuration directory that defines {@link agent}.
   *
   * It is outside the target repository, so the run reads its permissions from here while the process
   * working directory stays the project. A transport that spawns the CLI passes it as
   * `OPENCODE_CONFIG_DIR`; the two are deliberately separate settings, because "where the code is" and
   * "which configuration runs the agent" are different questions and V2 takes them from different
   * places.
   */
  readonly runtimeConfigDirectory: string | null;
  /**
   * Workflow identity of the run. This is metadata for the transport - for logging, rate limiting,
   * or labelling a run - and it is never part of the agent's message. Only `prompt` reaches the
   * model, and the adapter has already decided the stage before the transport is called.
   */
  readonly featureId: string;
  readonly stage: WorkStage;
  readonly role: StageRole;
  readonly fixReturnState: FixReturnState | null;
  readonly model: string | null;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | null;
  /**
   * Live progress from this run, or nothing when the caller does not want any.
   *
   * The transport emits `activity` events only. `stage_started`, `stage_finished`, and
   * `stage_failed` belong to the executor, which is the layer that knows when a stage began and
   * how long it took; a transport that emitted them could report a start it did not cause.
   */
  readonly onProgress?: StageProgressCallback;
}

/**
 * The untranslated result of one agent run. This is deliberately not a workflow result: parsing it
 * into `StageExecutionResult` is the adapter's job, and a raw result that cannot be parsed is
 * never treated as success.
 */
export interface OpenCodeRawResult {
  readonly agent: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The agent's response text, as extracted from the transport's own output format. */
  readonly text: string;
  /**
   * The absolute path of this run's `invocation.json`, or `null` when nothing was recorded.
   *
   * Whether the reply *parses* is knowledge the transport does not have: parsing happens after the
   * run returns, in the executor. This path is the seam that lets the executor write that verdict
   * into the recording the transport already wrote, so a reply the contract refused is visible in
   * the recording instead of looking like the clean exit 0 it was.
   */
  readonly recordingManifestPath?: string | null;
}

export interface OpenCodeTransport {
  run(request: OpenCodeTransportRequest): Promise<OpenCodeRawResult>;
}

/**
 * The default per-stage budget: 900 000 ms — **900 seconds, fifteen minutes** — set here and nowhere
 * else. The executor uses it when no `timeoutMs` is supplied, and the CLI's `--stage-timeout
 * <seconds>` converts to milliseconds against this same value, so the help text and the behaviour
 * cannot drift apart.
 *
 * It is deliberately larger than five minutes: a planning stage has been observed to run for 836
 * seconds and still succeed, and a budget shorter than the work it is meant to allow would turn a
 * slow-but-good stage into a `transport_timeout`. The budget is enforced by the shared runner's
 * deadline, which terminates the child and is reported as `transport_timeout` with the elapsed
 * time — never as a partial result.
 */
export const DEFAULT_TIMEOUT_MS = 900_000;
