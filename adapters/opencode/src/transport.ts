import type {
  FixReturnState,
  StageRole,
  WorkStage,
} from "@agent-workflow-kit/orchestration";

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
}

export interface OpenCodeTransport {
  run(request: OpenCodeTransportRequest): Promise<OpenCodeRawResult>;
}

export const DEFAULT_TIMEOUT_MS = 900_000;
