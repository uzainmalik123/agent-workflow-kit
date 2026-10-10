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
import { annotateInvocationOutcome } from "./diagnostics.js";
import {
  OpenCodeAdapterError,
  isOpenCodeAdapterError,
  type OpenCodeAdapterErrorCode,
} from "./errors.js";
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
  type OpenCodeRawResult,
  type OpenCodeTransport,
  type StageProgressCallback,
  type StageProgressEvent,
} from "./transport.js";

/**
 * How many *extra* attempts a stage gets when its reply fails the response contract (D-15).
 *
 * The default is not restated anywhere else: the CLI's `--format-retries <n>` documents this value,
 * `0` disables retries entirely, and a caller that supplies nothing gets it. It exists because a
 * single formatting miss — a reply with no fenced JSON block, or the right JSON without the fence —
 * used to kill a whole stage while the recording showed a clean exit 0 (P-14). Retrying does not
 * weaken the contract: every attempt must still satisfy exactly one fenced JSON block and the full
 * validation, and the retry line tells the model exactly what it was rejected for.
 */
export const DEFAULT_FORMAT_RETRIES = 2;

/**
 * The refusals a retry can fix, and the only ones.
 *
 * These three are statements about the *shape* of a reply: it had no fence, it was empty, or it
 * failed validation. A fresh invocation with a rejection notice is a proportionate answer to any of
 * them. Everything else is something else entirely — a timeout or a non-zero exit is a failed run,
 * a mismatched agent or a cancelled transport is a broken run — and re-running those on the theory
 * that the model might format better would hide a real failure behind a loop.
 */
export const RETRYABLE_REPLY_FAILURES: readonly OpenCodeAdapterErrorCode[] = [
  "empty_response",
  "malformed_response",
  "invalid_result",
];

/**
 * The one appended line a retry prompt carries, naming the code the previous reply was refused
 * with. It is a fresh invocation — identical prompt, nothing carried over but this line — so the
 * model is told what went wrong in the only message it will see.
 */
export function formatReplyRejectionNotice(code: string): string {
  return `Your previous reply was rejected: ${code}. Reply with exactly one fenced JSON block and nothing after it.`;
}

/** The prompt for a retry: the same prompt, plus exactly one appended line. */
function promptWithRejectionNotice(prompt: string, code: string): string {
  const base = prompt.endsWith("\n") ? prompt : `${prompt}\n`;

  return `${base}${formatReplyRejectionNotice(code)}\n`;
}

/** The longest excerpt of a rejected reply the failure message quotes, in characters. */
export const REJECTED_REPLY_EXCERPT_MAX_CHARS = 200;

/**
 * The first {@link REJECTED_REPLY_EXCERPT_MAX_CHARS} characters of a reply, with C0, DEL, and C1
 * control characters removed. Written as a scanner rather than a regular expression for the same
 * reason `stripAnsiCodes` is: a literal regex carrying control characters is exactly what a linter
 * should refuse, and the reply is model output — the one string in this system that must never
 * reach a terminal with its escape sequences intact. The scanner also does the bounding, so the
 * cut lands between characters rather than inside one.
 */
function rejectedReplyExcerpt(text: string): string {
  let out = "";
  let length = 0;

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }

    if (length >= REJECTED_REPLY_EXCERPT_MAX_CHARS) {
      break;
    }

    out += character;
    length += 1;
  }

  return out;
}

/**
 * The shape of a rejected reply, as the failure message states it: how many bytes it was, and its
 * first {@link REJECTED_REPLY_EXCERPT_MAX_CHARS} characters with control characters stripped. The
 * byte length is the real one, because the bytes are what the parser was handed; the excerpt is
 * bounded and plain, because it is model output travelling through an error message.
 */
function describeRejectedReply(reply: string): string {
  return (
    `${String(Buffer.byteLength(reply, "utf8"))} bytes; first ` +
    `${String(REJECTED_REPLY_EXCERPT_MAX_CHARS)} characters (control characters stripped): ` +
    JSON.stringify(rejectedReplyExcerpt(reply))
  );
}

/**
 * The refusal a stage ends with once every attempt has been rejected: the same code, the same
 * underlying reason, and — because a bare parse error answers none of the questions a human asks
 * next — how many attempts it took, what the last reply looked like, and where every attempt is
 * recorded.
 */
function replyRejectedError(
  error: OpenCodeAdapterError,
  attempts: number,
  reply: string,
  recordingFolder: string,
): OpenCodeAdapterError {
  return new OpenCodeAdapterError(
    error.code,
    `The OpenCode reply was rejected with "${error.code}" after ${String(attempts)} ` +
      `${attempts === 1 ? "attempt" : "attempts"}: ${error.message} ` +
      `Last reply: ${describeRejectedReply(reply)}. Recording folder: ${recordingFolder}`,
  );
}

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
   * How many extra attempts a stage gets when its reply fails the response contract —
   * `malformed_response`, `empty_response`, or `invalid_result`. Defaults to
   * {@link DEFAULT_FORMAT_RETRIES} when absent; `0` means exactly one attempt. Each retry is a
   * fresh OpenCode invocation with the identical prompt plus one appended rejection line, and
   * every attempt is recorded. Nothing else is retried: a timeout, a non-zero exit, or a
   * transport failure is a failed run, not a rejected reply.
   */
  readonly formatRetries?: number;
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
 *   -> bounded reply retry             (format refusals only; fresh invocation, same prompt plus
 *                                       one rejection line, up to {@link DEFAULT_FORMAT_RETRIES})
 *   -> StageExecutionResult
 * ```
 *
 * The adapter translates and refuses. It never decides a workflow transition, never approves a
 * gate, and never turns an unusable agent response into a stage outcome: a transport failure, a
 * timeout, a non-zero exit, malformed output, a mismatched feature or stage, a forbidden artifact
 * name, a smuggled workflow field, or repository-supplied OpenCode plugin code is thrown as an
 * `OpenCodeAdapterError` so the orchestrator reports an executor failure instead of trusting the
 * agent. The reply retry is the one place a refusal is followed by another invocation, and it is
 * bounded and scoped to the three refusals that are statements about a reply's shape (D-15): the
 * contract every attempt must satisfy is exactly the one that refused the attempt before it.
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
    const formatRetries = options.formatRetries;

    // Refused here rather than clamped: a retry count that is not a whole non-negative number is
    // a caller's bug, and silently rounding it would decide how many model invocations a stage
    // may spend.
    if (formatRetries !== undefined && (!Number.isSafeInteger(formatRetries) || formatRetries < 0)) {
      throw new RangeError(
        `formatRetries must be a non-negative whole number; received ${String(formatRetries)}.`,
      );
    }

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
   * The body of a stage run: every refusal, the prompt, the transport call, the response parse,
   * and the bounded retry of a reply the contract refused.
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
    const maxRetries = this.#formatRetries();

    let attempt = 0;
    let attemptPrompt = prompt;

    for (;;) {
      attempt += 1;

      const raw = await this.#invoke(
        agent,
        profile,
        attemptPrompt,
        request,
        workingDirectory,
        runtimeConfig,
      );

      // An agent mismatch is the transport answering for the wrong capability set, not a reply
      // this model could improve by trying again. Neither is a non-zero exit: the run itself
      // failed, and a retry would re-spend a stage on a process that already said it could not
      // finish.
      if (raw.agent !== agent) {
        throw new OpenCodeAdapterError(
          "transport_failed",
          `The OpenCode transport answered for agent "${raw.agent}" but was asked to run "${agent}".`,
        );
      }

      if (raw.exitCode !== 0) {
        await this.#recordReplyOutcome(raw, attempt, "non_zero_exit");
        throw new OpenCodeAdapterError(
          "non_zero_exit",
          `The OpenCode run for agent "${agent}" exited with code ${String(raw.exitCode)}.`,
        );
      }

      try {
        if (raw.text.trim().length === 0) {
          throw new OpenCodeAdapterError(
            "empty_response",
            `The OpenCode run for agent "${agent}" returned no response text.`,
          );
        }

        const result = parseStageResponse(raw.text, request);

        // The verdict lands in the recording the transport already wrote: a run that exited 0
        // with no error says nothing about whether its reply was usable, which is exactly why a
        // refused reply used to be invisible in the recording table.
        await this.#recordReplyOutcome(raw, attempt, "accepted");

        return result;
      } catch (error) {
        if (!isOpenCodeAdapterError(error)) {
          throw error;
        }

        await this.#recordReplyOutcome(raw, attempt, error.code);

        if (!RETRYABLE_REPLY_FAILURES.includes(error.code)) {
          throw error;
        }

        if (attempt > maxRetries) {
          throw replyRejectedError(
            error,
            attempt,
            raw.text,
            this.#recordingFolderFor(request),
          );
        }

        this.#emit({
          type: "format_retry",
          stage: request.stage,
          code: error.code,
          retry: attempt,
          maxRetries,
        });
        attemptPrompt = promptWithRejectionNotice(prompt, error.code);
      }
    }
  }

  /** The retry budget for replies that failed the response contract. */
  #formatRetries(): number {
    return this.#options.formatRetries ?? DEFAULT_FORMAT_RETRIES;
  }

  /**
   * Writes this attempt's reply verdict into the invocation's own manifest, when the transport
   * recorded one. Best-effort, like the recording itself: a verdict that cannot be written never
   * changes the stage's outcome.
   */
  async #recordReplyOutcome(
    raw: OpenCodeRawResult,
    attempt: number,
    responseOutcome: string,
  ): Promise<void> {
    const manifestPath = raw.recordingManifestPath;

    if (manifestPath === undefined || manifestPath === null) {
      return;
    }

    await annotateInvocationOutcome(manifestPath, { attempt, responseOutcome });
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
