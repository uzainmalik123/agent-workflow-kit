import {
  type StageExecutionRequest,
  type StageExecutionResult,
  type StageExecutor,
} from "@agent-workflow-kit/orchestration";
import { assertOpenCodeConfigurationIntegrity } from "./configuration-integrity.js";
import { OpenCodeAdapterError, isOpenCodeAdapterError } from "./errors.js";
import {
  assertNoProjectLocalPlugins,
  type FindProjectLocalPluginsOptions,
} from "./plugin-preflight.js";
import { buildStagePrompt } from "./prompts.js";
import {
  loadProjectInstructions,
  type LoadProjectInstructionsOptions,
  type ProjectInstructions,
} from "./project-instructions.js";
import { parseStageResponse } from "./response-protocol.js";
import { agentForRole, agentForStage } from "./roles.js";
import { DEFAULT_TIMEOUT_MS, type OpenCodeTransport } from "./transport.js";

export interface OpenCodeStageExecutorOptions {
  readonly transport: OpenCodeTransport;
  /** The repository the agent runs in, and the only project the adapter knows about. */
  readonly workingDirectory: string;
  readonly model?: string | null;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | null;
  /**
   * Repository guidance, overriding the file lookup. Always subordinate to the framework rules.
   */
  readonly projectInstructions?: ProjectInstructions | null;
  /**
   * Reads `AGENTS.md` from the working directory when guidance is not supplied explicitly. A
   * missing file is not an error: most projects have none, and the adapter simply sends no
   * repository instructions. An unreadable or unsafe one is a refusal, not a silent downgrade.
   */
  readonly loadProjectInstructionsFromDisk?: boolean;
  readonly projectInstructionsOptions?: LoadProjectInstructionsOptions;
  /**
   * Stops the project-local plugin preflight's ancestor walk, for a workspace parent above the
   * project. See {@link FindProjectLocalPluginsOptions}.
   */
  readonly pluginPreflightOptions?: FindProjectLocalPluginsOptions;
  /**
   * Skips the project-local plugin preflight. Off by default and not a hardening option: the check
   * is what stops a repository that ships its own OpenCode plugin, whose chosen plugin id can match
   * the trusted `opencode.*` namespace, from running a workflow stage at all. It exists so a test
   * that is not about plugin isolation does not have to create a filesystem.
   */
  readonly skipPluginPreflight?: boolean;
}

/**
 * The OpenCode implementation of the orchestration `StageExecutor` port.
 *
 * ```
 * StageExecutionRequest
 *   -> project-local plugin preflight   (refuse repository plugin code, before anything runs)
 *   -> configuration integrity          (refuse a tampered agent file or opencode.json)
 *   -> prompt and agent id            (deterministic, orchestrator-routed context only)
 *   -> OpenCodeTransport              (substitutable; the real one spawns the CLI)
 *   -> structured response parsing     (a fenced JSON payload, never prose)
 *   -> StageExecutionResult
 * ```
 *
 * The adapter translates and refuses. It never decides a workflow transition, never approves a
 * gate, and never turns an unusable agent response into a stage outcome: a transport failure, a
 * timeout, a non-zero exit, malformed output, a mismatched feature or stage, a forbidden artifact
 * name, a smuggled workflow field, or repository-supplied OpenCode plugin code is thrown as an
 * `OpenCodeAdapterError` so the orchestrator reports an executor failure instead of trusting the
 * agent.
 *
 * The two preflight checks answer different questions and neither substitutes for the other. The plugin
 * preflight asks whether the repository ships OpenCode code at all. The configuration integrity check
 * asks whether the framework's own OpenCode configuration is still the framework's, which is the
 * question a repository answers by editing a generated file rather than by adding a plugin.
 */
export class OpenCodeStageExecutor implements StageExecutor {
  readonly #transport: OpenCodeTransport;
  readonly #options: OpenCodeStageExecutorOptions;

  constructor(options: OpenCodeStageExecutorOptions) {
    this.#transport = options.transport;
    this.#options = options;
  }

  async execute(request: StageExecutionRequest): Promise<StageExecutionResult> {
    const agent = agentForStage(request.stage);

    if (agentForRole(request.role) !== agent) {
      throw new OpenCodeAdapterError(
        "role_mismatch",
        `Stage "${request.stage}" runs as agent "${agent}", but the request asked for role "${request.role}".`,
      );
    }

    // Before the transport is touched, and before anything is read out of the repository, because
    // the thing being refused is code the repository would hand to OpenCode. The generated
    // `plugins` configuration is not a substitute for this: it matches plugin ids, and a repository
    // picks the id of its own plugin.
    if (this.#options.skipPluginPreflight !== true) {
      await assertNoProjectLocalPlugins(
        this.#options.workingDirectory,
        this.#options.pluginPreflightOptions,
      );
    }

    // Before the prompt is built and before the transport is touched. A generated agent file is not
    // project implementation and is deliberately outside the implementation fingerprint, so the
    // verification path has nothing to compare it against; this is the only place that does, and the
    // only place where a file rewritten by a command that exited 0 is noticed before a model reads it.
    await assertOpenCodeConfigurationIntegrity({
      workingDirectory: this.#options.workingDirectory,
      role: request.role,
    });

    const prompt = buildStagePrompt({
      request,
      projectInstructions: await this.#projectInstructions(),
    });

    const raw = await this.#invoke(agent, prompt, request);

    if (raw.agent !== agent) {
      throw new OpenCodeAdapterError(
        "transport_failed",
        `The OpenCode transport answered for agent "${raw.agent}" but was asked to run "${agent}".`,
      );
    }

    if (raw.exitCode !== 0) {
      throw new OpenCodeAdapterError(
        "non_zero_exit",
        `The OpenCode run for agent "${agent}" exited with code ${String(raw.exitCode)}.`,
      );
    }

    if (raw.text.trim().length === 0) {
      throw new OpenCodeAdapterError(
        "empty_response",
        `The OpenCode run for agent "${agent}" returned no response text.`,
      );
    }

    return parseStageResponse(raw.text, request);
  }

  async #projectInstructions(): Promise<ProjectInstructions | null> {
    if (this.#options.projectInstructions !== undefined) {
      return this.#options.projectInstructions;
    }

    if (this.#options.loadProjectInstructionsFromDisk === false) {
      return null;
    }

    return loadProjectInstructions(
      this.#options.workingDirectory,
      this.#options.projectInstructionsOptions,
    );
  }

  async #invoke(
    agent: string,
    prompt: string,
    request: StageExecutionRequest,
  ): Promise<Awaited<ReturnType<OpenCodeTransport["run"]>>> {
    try {
      return await this.#transport.run({
        agent,
        prompt,
        workingDirectory: this.#options.workingDirectory,
        featureId: request.feature.featureId,
        stage: request.stage,
        role: request.role,
        fixReturnState: request.fixReturnState,
        model: this.#options.model ?? null,
        timeoutMs: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: this.#options.signal ?? null,
      });
    } catch (error) {
      if (isOpenCodeAdapterError(error)) {
        throw error;
      }

      throw new OpenCodeAdapterError(
        "transport_failed",
        `The OpenCode transport failed while running agent "${agent}".`,
        { cause: error },
      );
    }
  }
}

export function createOpenCodeStageExecutor(
  options: OpenCodeStageExecutorOptions,
): OpenCodeStageExecutor {
  return new OpenCodeStageExecutor(options);
}
