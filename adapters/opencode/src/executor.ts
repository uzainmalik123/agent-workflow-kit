import { resolve } from "node:path";
import {
  type StageExecutionRequest,
  type StageExecutionResult,
  type StageExecutor,
} from "@agent-workflow-kit/orchestration";
import {
  assertNoProjectProfileShadow,
  assertNoRepositoryConfigBoundaryCrossing,
} from "./configuration-integrity.js";
import { OpenCodeAdapterError, isOpenCodeAdapterError } from "./errors.js";
import { stageRecordingFolder } from "./diagnostics.js";
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
import { createOpenCodeRuntimeConfig, type OpenCodeRuntimeConfig } from "./runtime-config.js";
import {
  agentForProfile,
  profileForRole,
  profileForStage,
  type OpenCodeProfile,
} from "./roles.js";
import {
  DEFAULT_TIMEOUT_MS,
  type OpenCodeTransport,
  type StageProgressCallback,
  type StageProgressEvent,
} from "./transport.js";

export interface OpenCodeStageExecutorOptions {
  readonly transport: OpenCodeTransport;
  /**
   * The repository this adapter is bound to, and the only project it knows about.
   *
   * It is deliberately not the directory a stage runs in. That comes from every request's
   * `workspace`, which the framework fills from the workspace it opened, so an adapter constructed
   * once can serve a pre-approval stage in the checkout and a post-approval stage in an isolated
   * worktree of the same repository. The two are still checked against each other on every call, so a
   * request that names a different repository is refused rather than run.
   */
  readonly projectRoot: string;
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
  /**
   * Where the framework-owned OpenCode configuration is written for each stage run.
   *
   * Defaults to a per-repository directory under the platform temporary directory, which is outside
   * the target repository. Override it when the configuration has to live somewhere specific, such as
   * a mounted volume. A path inside the repository is refused rather than used.
   */
  readonly runtimeConfigDirectory?: string;
  /**
   * Live progress from every stage this executor runs, or nothing when no callback is supplied.
   *
   * The executor emits `stage_started`, `stage_finished`, and `stage_failed` — it is the layer that
   * knows when a stage began and how long it took — and forwards its own callback to the transport
   * so the transport can emit `activity` lines as the child produces them. It changes no request, no
   * response, no recording, and no stage result: a callback that throws is caught here rather than
   * allowed to fail a stage that was otherwise fine.
   */
  readonly onProgress?: StageProgressCallback;
}

/**
 * The OpenCode implementation of the orchestration `StageExecutor` port.
 *
 * ```
 * StageExecutionRequest
 *   -> project-local plugin preflight   (refuse repository plugin code, before anything runs)
 *   -> profile shadow check             (refuse a repository definition of a framework profile id)
 *   -> prompt and profile             (deterministic, orchestrator-routed context only)
 *   -> framework runtime configuration (the two profiles, written outside the repository)
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
 * preflight asks whether the repository ships OpenCode code at all. The profile shadow check asks
 * whether the repository defines an agent id that the framework is about to hand to `--agent`, which
 * is the question a repository answers by adding a definition rather than by adding a plugin.
 *
 * The framework's own configuration no longer lives in the repository, so there is no generated
 * project file here to verify. `configuration-integrity.ts` still exists and still checks a
 * project-local installation, because that installation is still valid for anyone who generated it;
 * this milestone stops depending on it rather than removing it.
 */
export class OpenCodeStageExecutor implements StageExecutor {
  readonly #transport: OpenCodeTransport;
  readonly #options: OpenCodeStageExecutorOptions;
  readonly #projectRoot: string;

  constructor(options: OpenCodeStageExecutorOptions) {
    this.#transport = options.transport;
    this.#options = options;
    this.#projectRoot = resolve(options.projectRoot);
  }

  /** The repository this adapter is bound to. */
  get projectRoot(): string {
    return this.#projectRoot;
  }

  async execute(request: StageExecutionRequest): Promise<StageExecutionResult> {
    const startedAtMs = Date.now();
    this.#emit({ type: "stage_started", stage: request.stage });

    try {
      const result = await this.#runStage(request);
      const elapsedMs = Date.now() - startedAtMs;
      this.#emit({ type: "stage_finished", stage: request.stage, elapsedMs });

      // A stage that answered "failed" ran to completion and reported its own failure, which is a
      // different shape from a throw but the same question for a human reading the output: where is
      // what it actually did.
      if (result.outcome === "failed") {
        this.#emit({
          type: "stage_failed",
          stage: request.stage,
          elapsedMs,
          recordingFolder: this.#recordingFolderFor(request),
        });
      }

      return result;
    } catch (error) {
      // Finished first, failed second: the stage did end, and then it ended badly. Emitting them in
      // that order keeps two lines reading as one account of one run.
      const elapsedMs = Date.now() - startedAtMs;
      this.#emit({ type: "stage_finished", stage: request.stage, elapsedMs });
      this.#emit({
        type: "stage_failed",
        stage: request.stage,
        elapsedMs,
        recordingFolder: this.#recordingFolderFor(request),
      });
      throw error;
    }
  }

  /**
   * Delivers one progress event, if anybody is listening.
   *
   * A callback that throws is swallowed. Progress is a display of a run that is already happening;
   * a broken writer must not be able to turn a stage that ran fine into an executor failure, which
   * is the same discipline the recorder follows for the same reason.
   */
  #emit(event: StageProgressEvent): void {
    try {
      this.#options.onProgress?.(event);
    } catch {
      // Ignored by design; see the comment above.
    }
  }

  /**
   * The directory this stage's recordings are written into, absolute.
   *
   * Read from the workspace the request names rather than from the directory the run happened in,
   * because it is emitted on the failure path too — where the point is to tell a human where to
   * look, and the request's workspace is the directory the recorder would have used.
   */
  #recordingFolderFor(request: StageExecutionRequest): string {
    return stageRecordingFolder(resolve(request.workspace.workingDirectory), {
      featureId: request.feature.featureId,
      stage: request.stage,
    });
  }

  /**
   * The body of a stage run: every refusal, the prompt, the transport call, and the response parse.
   *
   * Split out from {@link execute} only so that `execute` can bracket it with the progress events
   * that describe it; nothing about the order of the checks below changed when it moved.
   */
  async #runStage(request: StageExecutionRequest): Promise<StageExecutionResult> {
    const profile = profileForStage(request.stage);
    const agent = agentForProfile(profile);
    const workingDirectory = this.#workingDirectoryFor(request);

    // The profile is decided by the stage table, never by the request, so a caller cannot ask a
    // read-only stage to run with the write profile. The role is checked against the same table
    // because it is what the prompt tells the model to be: a role that does not belong to this
    // stage would mean the prompt and the granted capabilities disagree.
    if (profileForRole(request.role) !== profile) {
      throw new OpenCodeAdapterError(
        "role_mismatch",
        `Stage "${request.stage}" runs under the "${profile}" profile, but the request asked for role "${request.role}".`,
      );
    }

    // Before the transport is touched, and before anything is read out of the repository, because
    // the thing being refused is code the repository would hand to OpenCode. The generated
    // `plugins` configuration is not a substitute for this: it matches plugin ids, and a repository
    // picks the id of its own plugin.
    if (this.#options.skipPluginPreflight !== true) {
      await assertNoProjectLocalPlugins(workingDirectory, this.#options.pluginPreflightOptions);
    }

    // A repository may define an agent with a framework profile's id, and the framework passes that
    // id to `--agent`. The profiles now live outside the repository, so this is no longer a check
    // that a generated file is present; it is the check that the repository does not get to decide
    // which definition that id resolves to.
    await assertNoProjectProfileShadow(workingDirectory, profile);
    // The repository is still the process working directory, so OpenCode still loads its
    // configuration. Nothing is required of it any more, but a global permission, plugin, tool, or
    // instruction source in it would still reach the run, so those are still refused.
    await assertNoRepositoryConfigBoundaryCrossing(workingDirectory, profile);

    const prompt = buildStagePrompt({
      request,
      projectInstructions: await this.#projectInstructions(workingDirectory),
    });

    const runtimeConfig = await this.#runtimeConfigFor(workingDirectory);
    const raw = await this.#invoke(agent, profile, prompt, request, workingDirectory, runtimeConfig);

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

  /**
   * The directory this run happens in, and the check that the request belongs to this repository.
   *
   * The workspace context is the framework's, not the agent's: it is filled in by the orchestrator from
   * the isolated worktree it opened, and the repository it names is checked against the one this
   * adapter was built for. An executor that read its directory from anywhere else would be running an
   * agent in a tree the workflow never approved.
   */
  #workingDirectoryFor(request: StageExecutionRequest): string {
    const workspace = request.workspace;

    if (resolve(workspace.repositoryRoot) !== this.#projectRoot) {
      throw new OpenCodeAdapterError(
        "workspace_mismatch",
        `The stage request names repository "${workspace.repositoryRoot}" but this executor is bound to "${this.#projectRoot}".`,
      );
    }

    return resolve(workspace.workingDirectory);
  }

  async #runtimeConfigFor(workingDirectory: string): Promise<OpenCodeRuntimeConfig> {
    return createOpenCodeRuntimeConfig(workingDirectory, {
      ...(this.#options.runtimeConfigDirectory === undefined
        ? {}
        : { directory: this.#options.runtimeConfigDirectory }),
    });
  }

  async #projectInstructions(workingDirectory: string): Promise<ProjectInstructions | null> {
    if (this.#options.projectInstructions !== undefined) {
      return this.#options.projectInstructions;
    }

    if (this.#options.loadProjectInstructionsFromDisk === false) {
      return null;
    }

    return loadProjectInstructions(workingDirectory, this.#options.projectInstructionsOptions);
  }

  /**
   * Runs the transport under an explicit profile.
   *
   * The profile is the transport's `agent`, so the value passed to `--agent` is never derived
   * from the request and never left to OpenCode's default. That matters beyond tidiness: the
   * default agent in a repository can be anything, including one with a wildcard permission, so an
   * invocation that omitted the flag would run with capabilities this framework never granted.
   */
  async #invoke(
    agent: string,
    profile: OpenCodeProfile,
    prompt: string,
    request: StageExecutionRequest,
    workingDirectory: string,
    runtimeConfig: OpenCodeRuntimeConfig,
  ): Promise<Awaited<ReturnType<OpenCodeTransport["run"]>>> {
    try {
      return await this.#transport.run({
        agent: agentForProfile(profile),
        prompt,
        workingDirectory,
        runtimeConfigDirectory: runtimeConfig.directory,
        featureId: request.feature.featureId,
        stage: request.stage,
        role: request.role,
        fixReturnState: request.fixReturnState,
        model: this.#options.model ?? null,
        timeoutMs: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: this.#options.signal ?? null,
        // The transport relays tool-use lines into the same callback the executor reports its own
        // stage events on, so one listener sees one ordered account of the run.
        ...(this.#options.onProgress === undefined ? {} : { onProgress: this.#options.onProgress }),
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
