import { createOpenCodeCliTransport, createOpenCodeStageExecutor } from "@agent-workflow-kit/opencode";
import type { StageProgressCallback } from "@agent-workflow-kit/opencode";
import { createWorkflowOrchestrator } from "@agent-workflow-kit/orchestration";
import type { WorkflowOrchestrator, WorkflowOrchestratorOptions } from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import type { FeatureSessionStore } from "@agent-workflow-kit/persistence";
import { createProjectSecurityReviewProvider, createProjectVerificationProvider } from "@agent-workflow-kit/project";
import { GitFeaturePublisher, GitWorkspaceProvider } from "@agent-workflow-kit/workspace";
import { describeVersionProbe, preflightOpenCode } from "./preflight.js";

export type OrchestratorStackOptions = Omit<WorkflowOrchestratorOptions, "store" | "projectRoot">;

export interface OrchestratorStack {
  readonly orchestrator: WorkflowOrchestrator;
  readonly store: FeatureSessionStore;
  /**
   * Checked before the first stage of a `run`, when the stack needs a runtime the workflow itself
   * does not know about. Absent for a stack built for tests, so a test never probes a binary it is
   * not using; present for the real stack, so a missing `opencode` is a failed command rather than a
   * failed stage.
   */
  readonly preflight?: () => Promise<string>;
}

/**
 * A stack from already-constructed parts.
 *
 * This is the dependency-injection seam: the CLI's commands take a stack factory, tests hand it one
 * built from the fake executor and fake providers under `fixtures/`, and the default is
 * {@link createRealStack}. No fake lives behind a default.
 */
export function createOrchestratorStack(
  repoRoot: string,
  options: OrchestratorStackOptions,
): OrchestratorStack {
  const store = createFeatureSessionStore(repoRoot);
  const orchestrator = createWorkflowOrchestrator({ ...options, store, projectRoot: repoRoot });

  return { orchestrator, store };
}

export interface RealStackOptions {
  /**
   * The model the OpenCode adapter asks for. `null` omits `--model` from the invocation, which is
   * how OpenCode's own configured default is left to decide the model.
   */
  readonly model?: string | null;
  /**
   * Live progress from every stage the real executor runs. Absent means no progress at all: the
   * executor emits nothing, the transport observes nothing, and the run is exactly the one it was
   * before progress existed.
   */
  readonly onProgress?: StageProgressCallback;
  /**
   * The per-stage budget in milliseconds. Absent means the adapter's own default, `DEFAULT_TIMEOUT_MS`
   * — 900 seconds — which is also the value the CLI's `--stage-timeout <seconds>` documents.
   */
  readonly stageTimeoutMs?: number;
  /**
   * How many extra attempts a stage gets when its reply fails the response contract. Absent means
   * the adapter's own default, `DEFAULT_FORMAT_RETRIES` — 2 — which is also the value the CLI's
   * `--format-retries <n>` documents; `0` disables retries.
   */
  readonly formatRetries?: number;
}

/**
 * The product stack: every port the orchestrator can reach, wired to the real adapter.
 *
 * The wiring is the same one `tests/publishing-integration.test.ts` proves — real store, real
 * executor, real workspace, real verification, real security review, real publisher — with the
 * repository the command was run in as the one input that differs per project:
 *
 * - the session store lives under the repository's `.agentflow/`;
 * - the executor is bound to the repository and spawns the `opencode` found on `PATH`;
 * - verification and security review scan the tree the orchestrator opened for the stage, which is
 *   the checkout before plan approval and the isolated worktree after it;
 * - worktrees are created under the user cache directory, never inside the repository.
 *
 * Nothing here decides a transition, approves a gate, or interprets a stage: it only constructs the
 * ports `createWorkflowOrchestrator` accepts.
 */
export function createRealStack(repoRoot: string, options: RealStackOptions = {}): OrchestratorStack {
  const store = createFeatureSessionStore(repoRoot);

  // No `command` option: the transport's default is `opencode`, resolved from `PATH` at spawn time,
  // which is the binary a user gets by installing OpenCode however they already have it.
  const transport = createOpenCodeCliTransport();
  const executor = createOpenCodeStageExecutor({
    transport,
    projectRoot: repoRoot,
    model: options.model ?? null,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.stageTimeoutMs === undefined ? {} : { timeoutMs: options.stageTimeoutMs }),
    ...(options.formatRetries === undefined ? {} : { formatRetries: options.formatRetries }),
  });

  const workspace = new GitWorkspaceProvider();

  // The orchestrator names the tree each request belongs to — the checkout before approval, the
  // worktree after — and the resolver is what lets one provider serve both while still checking
  // every request against the directory its own wiring answered with.
  const verification = createProjectVerificationProvider({
    projectRoot: repoRoot,
    resolveRunRoot: (request) => request.projectRoot,
  });
  const security = createProjectSecurityReviewProvider({
    projectRoot: repoRoot,
    resolveRoot: (request) => request.projectRoot,
  });

  const orchestrator = createWorkflowOrchestrator({
    store,
    executor,
    verification,
    security,
    workspace,
    publisher: new GitFeaturePublisher(),
    projectRoot: repoRoot,
  });

  return {
    orchestrator,
    store,
    preflight: async () => describeVersionProbe(await preflightOpenCode()),
  };
}
