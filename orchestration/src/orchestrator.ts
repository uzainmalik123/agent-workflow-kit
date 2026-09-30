import {
  WorkflowStateMachine,
  type ReviewFinding,
  type WorkflowEvent,
  type WorkflowMachineSnapshot,
  type WorkflowState,
  type WorkspaceBaseline,
} from "@agent-workflow-kit/core";
import {
  FEATURE_ARTIFACT_FILENAMES,
  PersistenceError,
  type FeatureApprovals,
  type FeatureArtifactName,
  type FeatureArtifactWrite,
  type FeatureMutationPlan,
  type FeatureMutationReader,
  type FeatureSession,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { buildPlanApproval, verifyPlanApproval } from "./approval.js";
import { describeError, orchestrationError, type OrchestrationError } from "./errors.js";
import { appendFixHistoryEntry } from "./fix-history.js";
import type { StageArtifactContext, StageExecutionRequest, StageExecutor } from "./executor.js";
import {
  buildOrchestrationResult,
  type OrchestrationResult,
  type OrchestrationResultInput,
  type OrchestrationStatus,
} from "./result.js";
import { isRecord, validateStageExecutionResult } from "./result-validation.js";
import {
  APPROVAL_VERIFIED_STAGES,
  DEFERRED_WORK_STATES,
  humanActionForState,
  isTerminalState,
  outputSpecFor,
  PASSIVE_ADVANCE_STATES,
  resolveStageContextPlan,
  stageForState,
  STAGE_DEFINITIONS,
  type StageContextPlan,
  type WorkStage,
} from "./stages.js";
import {
  approvedScopeFromPlan,
  evaluateWorkspaceIntegrity,
  evaluateWorkspaceScope,
  isProtectedWorkspacePath,
  matchesScopePattern,
  subtractWorkspaceChanges,
  type BaselineCaptureOutcome,
  type OpenWorkspaceOutcome,
  type ProjectWorkspace,
  type ProjectWorkspaceProvider,
  type WorkspaceInspection,
  type WorkspaceScopeEvidence,
  type WorkspaceUnauthorizedPath,
} from "./workspace.js";
import {
  applyDeterministicEvidence,
  bindVerificationEvidenceToRequest,
  mergeDeterministicEvidence,
  validateVerificationEvidenceBundle,
  verificationEvidenceSummaries,
  VERIFICATION_ARTIFACT_NAME,
  VERIFICATION_STAGE_BY_WORK_STAGE,
  type VerificationEvidenceBundle,
  type VerificationProvider,
  type VerificationRequest,
  type VerificationStage,
} from "./verification.js";

export interface CreateFeatureInput {
  readonly featureId: string;
  readonly title: string;
  readonly request?: string;
  readonly slug?: string;
}

export interface WorkflowOrchestratorOptions {
  readonly store: FeatureSessionStore;
  readonly executor: StageExecutor;
  /**
   * Where deterministic verification evidence comes from.
   *
   * Optional only so that a workflow which never reaches a verification stage, and the tests for
   * everything before one, can be built without one. The three verification stages have no model-only
   * mode: reaching one without a provider is a structured `verification_not_configured` refusal that
   * never calls the executor, rather than a stage that passes on an opinion. The provider is
   * constructed by whoever wires the kit up; it is never an agent, and it never receives a command
   * from one.
   */
  readonly verification?: VerificationProvider | null;
  /**
   * The project the verification provider may run commands in. Defaults to `process.cwd()`, and is
   * resolved once at construction so that a bundle for the same directory reaches the identity check
   * in the same form however the caller spelled it. It is handed to the provider as data; no stage,
   * agent, or artifact can change it, and the provider refuses a request for anywhere else.
   */
  readonly projectRoot?: string | null;
  /**
   * The isolated-execution port every post-approval stage runs in.
   *
   * Optional in the type only so that a workflow which never gets past plan approval, and the tests
   * for everything before one, can be built without one. Reaching a post-approval stage without a
   * provider is a structured `workspace_not_configured` refusal before the executor is constructed,
   * for the same reason a verification stage without a provider is refused: the alternative is the
   * behaviour this milestone exists to remove, which is a write-capable stage running in the directory
   * a human is standing in.
   *
   * The provider is constructed by whoever wires the kit up. No stage, agent, or artifact can add one,
   * and none of them can choose a working directory: the orchestrator opens the workspace and passes
   * the resolved path to the executor.
   */
  readonly workspace?: ProjectWorkspaceProvider | null;
}

type ResultExtras = Omit<OrchestrationResultInput, "status" | "state">;

type ContextOutcome =
  | { readonly ok: true; readonly context: readonly StageArtifactContext[] }
  | { readonly ok: false; readonly error: OrchestrationError };

type ComposeOutcome =
  | { readonly ok: true; readonly content: unknown }
  | { readonly ok: false; readonly error: OrchestrationError };

interface CommitInput {
  readonly featureId: string;
  /** The session the caller's decision was based on. Its revision is the optimistic precondition. */
  readonly session: FeatureSession;
  readonly event?: WorkflowEvent;
  readonly prepare?: (reader: FeatureMutationReader) => Promise<FeatureMutationPlan>;
  readonly successStatus: OrchestrationStatus;
  readonly extras: ResultExtras;
}

/** Raised inside a mutation's prepare step so a rejected composition never reaches storage. */
class StageFinalizeError extends Error {
  readonly orchestrationError: OrchestrationError;

  constructor(error: OrchestrationError) {
    super(error.message);
    this.name = "StageFinalizeError";
    this.orchestrationError = error;
  }
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof PersistenceError && error.code === "REVISION_CONFLICT";
}

function isArtifactMissing(error: unknown): boolean {
  return error instanceof PersistenceError && error.code === "ARTIFACT_NOT_FOUND";
}

/**
 * The identity a pre-approval stage runs under. It is not a workspace, and nothing about it should be
 * mistaken for one: no baseline, no lease, and a read-only working directory that is the repository
 * root itself.
 */
const REPOSITORY_WORKSPACE_ID = "repository";

/** A 40-character SHA-1 of a feature id, so a workspace directory is derived rather than spelled. */
export function workspaceIdFor(featureId: string): string {
  return createHash("sha1").update(`agent-workflow-kit/workspace\u0000${featureId}`, "utf8").digest("hex").slice(0, 32);
}

/**
 * The one explanation for a refused baseline, whichever half of the check found it.
 *
 * `disagreement` is set when the capture described itself as clean while naming dirty paths, or as
 * dirty without naming any. That disagreement is itself worth reporting: it is the difference between
 * "you have uncommitted work" and "this adapter cannot be trusted to describe the state of your
 * working tree", and the second is a more serious finding than the first.
 */
function dirtyBaselineError(observedPaths: readonly string[], disagreement = ""): OrchestrationError {
  const state =
    observedPaths.length > 0
      ? `uncommitted work: ${describePaths(observedPaths)}`
      : "an uncommitted working tree it could not enumerate";

  return orchestrationError(
    "workspace_dirty_baseline",
    `The plan cannot be approved on top of ${state}.${disagreement ? ` ${disagreement}` : ""} The approved baseline is the commit the human reviewed, so a worktree created from it would not contain the change under review and no later comparison would describe what was actually approved. Stash or commit the work, or approve the plan from a clean tree. The framework never stashes, resets, or commits on a human's behalf.`,
  );
}

function describePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 10).join(", ");

  return paths.length > 10 ? `${shown} (and ${String(paths.length - 10)} more)` : shown;
}

function emptyInspection(workspace: ProjectWorkspace, fallbackCollectedAt: string): WorkspaceInspection {
  return {
    workspaceId: workspace.workspaceId,
    changes: { modified: [], added: [], deleted: [], renamed: [], untracked: [] },
    gitState: workspace.gitState ?? { headCommit: "", stagedPaths: [] },
    fingerprint: createHash("sha256").update("empty", "utf8").digest("hex"),
    collectedAt: workspace.baseline?.capturedAt ?? fallbackCollectedAt,
  };
}

/**
 * Builds the deterministic scope record. Every field is either derived from the plan or measured by
 * the provider, so two readers looking at the same workspace and the same plan see the same record.
 */
function buildScopeEvidence(
  session: FeatureSession,
  stage: WorkStage,
  workspace: ProjectWorkspace,
  baseline: WorkspaceBaseline | null,
  inspection: WorkspaceInspection,
  enforcement: {
    readonly restored: readonly string[];
    readonly removed: readonly string[];
    readonly unsafePaths: readonly string[];
    readonly recordedAt: string;
    /** Whether the tree was actually inspected; see `WorkspaceScopeEvidence.measured`. */
    readonly measured: boolean;
  },
  approvedPatterns: readonly string[] = [],
): WorkspaceScopeEvidence {
  const observed = [
    ...inspection.changes.modified,
    ...inspection.changes.added,
    ...inspection.changes.deleted,
    ...inspection.changes.untracked,
    ...inspection.changes.renamed.flatMap((rename) => [rename.from, rename.to]),
  ];

  const unauthorized = observed.filter(
    (path) => isProtectedWorkspacePath(path) || !approvedPatterns.some((pattern) => matchesScopePattern(pattern, path)),
  );

  return {
    schemaVersion: 1,
    featureId: session.featureId,
    stage,
    sessionRevision: session.revision,
    workspaceId: workspace.workspaceId,
    workingDirectory: workspace.workingDirectory,
    baselineCommit: baseline?.baselineCommit ?? null,
    approvedPatterns,
    observedPaths: [...new Set(observed)].sort(),
    unauthorizedPaths: [...new Set(unauthorized)].sort(),
    protectedPathsTouched: [...new Set(unauthorized.filter(isProtectedWorkspacePath))].sort(),
    restoredPaths: [...enforcement.restored].sort(),
    removedPaths: [...enforcement.removed].sort(),
    unsafePaths: [...enforcement.unsafePaths].sort(),
    fingerprint: inspection.fingerprint,
    headCommit: inspection.gitState.headCommit,
    stagedPaths: [...inspection.gitState.stagedPaths].sort(),
    recordedAt: enforcement.recordedAt,
    measured: enforcement.measured,
  };
}

/**
 * The run status for a refused scope check.
 *
 * A repository whose HEAD moved or whose index was written is not a scope violation, and reporting it
 * as one would point whoever reads the result at the wrong cause. The two are different failures with
 * different remedies: one is about what the stage touched, the other about the thing the comparison
 * was supposed to be relative to.
 */
function scopeStatus(error: OrchestrationError): OrchestrationStatus {
  switch (error.code) {
    case "scope_violation":
    case "scope_restoration_unsafe":
      return "scope_violation";
    default:
      return "rejected";
  }
}

function snapshotsMatch(
  left: WorkflowMachineSnapshot,
  right: WorkflowMachineSnapshot,
): boolean {
  return left.state === right.state && left.fixReturnState === right.fixReturnState;
}

/** The snapshot a legal event produces, used to recognise a committed-but-reported failure. */
function previewMachine(
  session: FeatureSession,
  event: WorkflowEvent,
): { readonly ok: true; readonly snapshot: WorkflowMachineSnapshot } | { readonly ok: false; readonly error: OrchestrationError } {
  const machine = new WorkflowStateMachine(session.machine);
  const preview = machine.transition(event);

  if (!preview.ok) {
    return {
      ok: false,
      error: orchestrationError("illegal_transition", preview.message),
    };
  }

  return { ok: true, snapshot: machine.snapshot };
}

export class WorkflowOrchestrator {
  readonly #store: FeatureSessionStore;
  readonly #executor: StageExecutor;
  readonly #verification: VerificationProvider | null;
  readonly #projectRoot: string;
  readonly #workspace: ProjectWorkspaceProvider | null;

  constructor(options: WorkflowOrchestratorOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
    this.#verification = options.verification ?? null;
    this.#projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.#workspace = options.workspace ?? null;
  }

  get store(): FeatureSessionStore {
    return this.#store;
  }

  async createFeature(input: CreateFeatureInput): Promise<OrchestrationResult> {
    const createInput =
      input.slug === undefined
        ? { featureId: input.featureId, title: input.title }
        : { featureId: input.featureId, title: input.title, slug: input.slug };

    let session = await this.#store.create(createInput);

    if (input.request !== undefined) {
      session = await this.#store.writeArtifact(session.featureId, "request", input.request);
    }

    const state = session.machine.state;

    return buildOrchestrationResult({
      status: "created",
      featureId: session.featureId,
      fromState: state,
      state,
      artifacts: input.request === undefined ? [] : ["request"],
    });
  }

  async runNext(featureId: string): Promise<OrchestrationResult> {
    const session = await this.#store.load(featureId);
    const fromState = session.machine.state;
    const base: ResultExtras = { featureId, fromState };

    if (isTerminalState(fromState)) {
      return this.#result({ ...base, status: "terminal", state: fromState });
    }

    const action = humanActionForState(fromState);

    if (action !== undefined) {
      return this.#result({ ...base, status: "awaiting_human", state: fromState, action });
    }

    if (DEFERRED_WORK_STATES.has(fromState)) {
      return this.#result({
        ...base,
        status: "deferred",
        state: fromState,
        error: orchestrationError(
          "git_integration_deferred",
          `State "${fromState}" has no orchestrated work stage until Git integration is implemented.`,
        ),
      });
    }

    if (PASSIVE_ADVANCE_STATES.has(fromState)) {
      return this.#commit({
        featureId,
        session,
        event: "advance",
        successStatus: "advanced",
        extras: base,
      });
    }

    const stage = stageForState(fromState);

    if (stage === undefined) {
      return this.#result({
        ...base,
        status: "rejected",
        state: fromState,
        error: orchestrationError(
          "unhandled_state",
          `State "${fromState}" has no orchestrated work stage.`,
        ),
      });
    }

    return this.#runStage(session, stage);
  }

  async approvePlan(featureId: string): Promise<OrchestrationResult> {
    const session = await this.#store.load(featureId);
    const base: ResultExtras = { featureId, fromState: session.machine.state };

    // The baseline is read here, outside the mutation and outside any lock, because it costs a Git
    // process and a lock must never be held across one. It is not a race that matters: the commit that
    // records it is revision-guarded, and every post-approval stage re-checks the repository's HEAD
    // against the recorded baseline before it runs, so a repository that moved between this read and
    // that commit is refused at the next stage rather than quietly used as a base.
    const capture = await this.#captureBaseline(session);

    if (!capture.ok) {
      return this.#result({ ...base, status: "rejected", state: session.machine.state, error: capture.error });
    }

    return this.#commit({
      featureId,
      session,
      event: "approve_plan",
      successStatus: "gate_approved",
      extras: base,
      prepare: async (reader: FeatureMutationReader) => {
        const approval = await buildPlanApproval(
          reader,
          capture.baseline === null ? null : {
            ...capture.baseline,
            approvedRevision: reader.nextRevision,
          },
        );

        if (!approval.ok) {
          throw new StageFinalizeError(approval.error);
        }

        const approvals: FeatureApprovals = { plan: approval.record };
        return { approvals };
      },
    });
  }

  /**
   * Reads the repository's starting point for the approval that is about to be recorded.
   *
   * A refusal here is the end of the approval, not a note attached to it. A dirty tracked working
   * tree is the case that matters: the human is approving work against files that are not the files a
   * worktree would be created from, so the baseline would describe a tree nobody reviewed, and every
   * later comparison would be against the wrong thing. Stashing, committing, or resetting the
   * operator's uncommitted work to make room for an approval is not a decision this framework takes
   * on someone's behalf, so the approval is refused and the dirty paths are named.
   *
   * Untracked and ignored files do not make a tree dirty. `.agentflow/` is this framework's own state
   * and is normally untracked or ignored, so refusing on it would mean no project could ever use the
   * workflow.
   */
  async #captureBaseline(
    session: FeatureSession,
  ): Promise<
    | { readonly ok: true; readonly baseline: WorkspaceBaseline | null }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    if (this.#workspace === null) {
      return { ok: true, baseline: null };
    }

    let capture: BaselineCaptureOutcome;

    try {
      capture = await this.#workspace.captureBaseline(this.#projectRoot);
    } catch (error) {
      return {
        ok: false,
        error: orchestrationError(
          "workspace_unavailable",
          `The repository state could not be read for the plan approval: ${describeError(error)}`,
        ),
      };
    }

    if (!capture.ok) {
      const observed = capture.capture;
      const observedPaths = observed === null ? [] : [...new Set([...observed.stagedPaths, ...observed.unstagedPaths])].sort();

      if (observed !== null && (observedPaths.length > 0 || !observed.clean)) {
        // The adapter refused because it found uncommitted tracked work, and said which work. That is
        // the same finding this module reaches on its own from a capture that claims to be clean, so it
        // is reported under the same code and the same explanation: one condition, one record, and a
        // reader who is told the repository was merely "unavailable" would learn nothing from it.
        return {
          ok: false,
          error: dirtyBaselineError(observedPaths, capture.message),
        };
      }

      return {
        ok: false,
        error: orchestrationError("workspace_unavailable", `The plan cannot be approved: ${capture.message}`),
      };
    }

    // The provider's own verdict is not the last word on whether a tree is clean, because the same
    // message carries the measurement that verdict was derived from. An adapter that reports `clean`
    // alongside a non-empty path list has contradicted itself, and an adapter whose path listing is
    // incomplete would produce exactly that shape by accident. Either way the only authority on
    // "the human's working tree has no uncommitted tracked work" is this rule, applied to the paths.
    const observedPaths = [...new Set([...capture.capture.stagedPaths, ...capture.capture.unstagedPaths])].sort();

    if (observedPaths.length > 0 || !capture.capture.clean) {
      return { ok: false, error: dirtyBaselineError(observedPaths) };
    }

    return {
      ok: true,
      baseline: {
        repositoryRoot: capture.capture.repositoryRoot,
        baselineCommit: capture.capture.headCommit,
        approvedRevision: session.revision + 1,
        workspaceId: workspaceIdFor(session.featureId),
        capturedAt: capture.capture.capturedAt,
      },
    };
  }

  async approvePush(featureId: string): Promise<OrchestrationResult> {
    return this.#applyGate(featureId, "approve_push", "gate_approved");
  }

  async failFeature(featureId: string): Promise<OrchestrationResult> {
    return this.#applyGate(featureId, "fail", "feature_failed");
  }

  async #applyGate(
    featureId: string,
    event: "approve_push" | "fail",
    status: OrchestrationStatus,
  ): Promise<OrchestrationResult> {
    const session = await this.#store.load(featureId);
    const base: ResultExtras = { featureId, fromState: session.machine.state };

    return this.#commit({
      featureId,
      session,
      event,
      successStatus: status,
      extras: base,
    });
  }

  async #runStage(session: FeatureSession, stage: WorkStage): Promise<OrchestrationResult> {
    const featureId = session.featureId;
    const fromState = session.machine.state;
    const definition = STAGE_DEFINITIONS[stage];
    // `executedStages` is not in this base on purpose. It is added at each point where the stage
    // executor was actually involved, because a stage that was refused before the executor ran has
    // not been executed, and a result that listed it would claim an opinion was recorded when the
    // whole point of the refusal is that none was.
    const base: ResultExtras = {
      featureId,
      fromState,
      stage,
      role: definition.role,
      executedStages: [],
    };
    const contextPlan = resolveStageContextPlan(stage, session.machine.fixReturnState);

    if (contextPlan === null) {
      return this.#result({
        ...base,
        status: "rejected",
        state: fromState,
        error: orchestrationError(
          "inconsistent_fix_state",
          "The persisted session is fixing without a recorded fix return state.",
        ),
      });
    }

    const approval = await this.#verifyApproval(featureId, stage, fromState);

    if (!approval.ok) {
      return this.#result({ ...base, status: "rejected", state: fromState, error: approval.error });
    }

    // The isolated workspace is opened before anything else in the stage happens, and the lease it
    // takes is held until the final mutation has been attempted. Everything that follows — reading
    // context, running the agent, running verification commands, checking scope, writing artifacts —
    // happens inside that lease, so two runs of the same feature cannot interleave their writes and no
    // other feature is blocked by a run in a different worktree.
    const opened = await this.#openWorkspace(session, stage);

    if (!opened.ok) {
      return this.#result({ ...base, status: "rejected", state: fromState, error: opened.error });
    }

    const { workspace, baseline } = opened;

    try {
      return await this.#runStageInWorkspace(session, stage, base, definition, contextPlan, workspace, baseline);
    } finally {
      // Only a workspace the provider opened gets closed. A pre-approval stage runs in the human's own
      // checkout, which was never opened through the port, so there is no lease to release and nothing
      // to clean up — and an adapter asked to close a directory it does not own should not have to
      // guess what that means.
      if (baseline !== null) {
        await this.#closeWorkspace(workspace);
      }
    }
  }

  async #runStageInWorkspace(
    session: FeatureSession,
    stage: WorkStage,
    base: ResultExtras,
    definition: (typeof STAGE_DEFINITIONS)[WorkStage],
    contextPlan: StageContextPlan,
    workspace: ProjectWorkspace,
    baseline: WorkspaceBaseline | null,
  ): Promise<OrchestrationResult> {
    const featureId = session.featureId;
    const fromState = session.machine.state;

    // Deterministic evidence is collected here, after the plan-approval freeze has been re-verified
    // and before the agent is involved at all. This is the only point at which project code runs, and
    // running it is a consequence of the human having approved work in this repository. It runs in the
    // same directory the stage runs in, so the evidence describes the tree the agent is about to read.
    const evidence = await this.#collectVerification(
      session,
      stage,
      workspace.workingDirectory,
      workspace.workspaceId,
    );

    if (!evidence.ok) {
      return this.#result({ ...base, status: "rejected", state: fromState, error: evidence.error });
    }

    const context = await this.#gatherContext(featureId, contextPlan);

    if (!context.ok) {
      return this.#result({ ...base, status: "rejected", state: fromState, error: context.error });
    }

    const request: StageExecutionRequest = {
      feature: {
        featureId,
        title: session.title,
        slug: session.slug,
        state: fromState,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      stage,
      role: definition.role,
      state: fromState,
      context: context.context,
      outputs: definition.outputs,
      fixReturnState: stage === "fixing" ? (session.machine.fixReturnState ?? null) : null,
      verification: evidence.bundle,
      workspace: {
        workspaceId: workspace.workspaceId,
        repositoryRoot: workspace.repositoryRoot,
        workingDirectory: workspace.workingDirectory,
        access: workspace.access.level,
        baseline,
      },
    };

    // For a pre-approval stage this is the "before" half of the write check, and it is taken here, as
    // late as possible before the executor: deterministic evidence and context gathering run first, so
    // anything the framework itself did in the tree is not attributed to the agent.
    let before: WorkspaceInspection | null = null;

    if (baseline === null && this.#workspace !== null) {
      const opening = await this.#inspect(session, workspace, stage);

      if (!opening.ok) {
        return this.#result({
          ...base,
          status: "rejected",
          state: fromState,
          error: orchestrationError("workspace_unavailable", opening.message),
        });
      }

      before = opening.inspection;
    }

    let raw: unknown;
    let executorFailure: OrchestrationError | null = null;

    try {
      raw = await this.#executor.execute(request);
    } catch (error) {
      executorFailure = orchestrationError("executor_threw", `Stage executor threw: ${describeError(error)}`);
    }

    // The scope check runs for a stage that returned and for a stage that threw, because a transport
    // failure, a timeout, or a model that abandoned the run halfway are precisely the runs that leave a
    // half-written file behind. Its verdict outranks the executor's: a stage that changed a path no
    // human approved has not produced a result, whatever it managed to say before or after doing it.
    const scope = await this.#enforceScope(session, stage, workspace, baseline, before);

    if (!scope.ok) {
      return this.#result({
        ...base,
        executedStages: [stage],
        status: scopeStatus(scope.error),
        state: fromState,
        verification: evidence.bundle,
        scope: scope.evidence,
        error: scope.error,
      });
    }

    if (executorFailure !== null) {
      return this.#result({
        ...base,
        executedStages: [stage],
        status: "executor_error",
        state: fromState,
        verification: evidence.bundle,
        scope: scope.evidence,
        error: executorFailure,
      });
    }

    const validation = validateStageExecutionResult(raw, request);

    if (!validation.ok) {
      return this.#result({
        ...base,
        executedStages: [stage],
        status: "rejected",
        state: fromState,
        verification: evidence.bundle,
        scope: scope.evidence,
        error: orchestrationError(validation.code, validation.message),
      });
    }

    const outcome = validation.result;
    // Hard evidence is applied here, and only in one direction: a stage whose deterministic checks
    // did not pass cannot be reported as a success. A verifier that says "success" about a failing
    // lint run is overruled by the exit code, and the stage enters the fix loop instead.
    const applied =
      evidence.bundle === null
        ? ({ outcome: outcome.outcome, override: "none", findings: [] } as const)
        : applyDeterministicEvidence(evidence.bundle, outcome.outcome, featureId);
    const effective =
      applied.override === "none" ? outcome : { ...outcome, outcome: applied.outcome };
    const extraFindings: readonly ReviewFinding[] = applied.findings;
    const reported: ResultExtras = {
      ...base,
      executedStages: [stage],
      findings: [...outcome.findings, ...extraFindings],
      evidence:
        evidence.bundle === null
          ? outcome.evidence
          : [...outcome.evidence, ...verificationEvidenceSummaries(evidence.bundle)],
      verification: evidence.bundle,
      scope: scope.evidence,
    };

    if (effective.outcome === "failed") {
      return this.#result({
        ...reported,
        status: "stage_failed",
        state: fromState,
        error: orchestrationError(
          "stage_reported_failure",
          `Stage "${stage}" reported failure: ${effective.summary ?? "no summary was provided"}.`,
        ),
      });
    }

    // Finalization is the only mutation a stage result can cause. It runs without any lock held
    // while the executor works, and the store re-checks the revision inside the lock, so a stale
    // result can neither write its artifacts nor apply its event to a later state.
    return this.#commit({
      featureId,
      session,
      ...(effective.outcome === "inconclusive"
        ? {}
        : { event: effective.outcome === "needs_fix" ? "request_fix" : definition.successEvent }),
      successStatus:
        effective.outcome === "needs_fix"
          ? "fix_requested"
          : effective.outcome === "inconclusive"
            ? "inconclusive"
            : "stage_completed",
      extras: reported,
      prepare: async (reader) => {
        const reverified = await verifyPlanApproval(reader, stage, fromState);

        if (!reverified.ok) {
          throw new StageFinalizeError(reverified.error);
        }

        const artifacts: FeatureArtifactWrite[] = [];

        for (const artifact of effective.artifacts) {
          const composed = await this.#composeArtifactContent(
            reader,
            stage,
            artifact.name,
            artifact.content,
          );

          if (!composed.ok) {
            throw new StageFinalizeError(composed.error);
          }

          artifacts.push({
            name: artifact.name,
            content:
              // Only the verification artifact carries evidence. Merging it into whatever else the
              // stage produced would put one attempt's exit codes into an unrelated document, and the
              // next attempt would append to the wrong place.
              artifact.name === VERIFICATION_ARTIFACT_NAME
                ? mergeDeterministicEvidence(composed.content, stage, evidence.bundle)
                : composed.content,
          });
        }

        return { artifacts };
      },
    });
  }

  /**
   * Resolves the directory a stage may work in, and takes the lease that makes it exclusive.
   *
   * The pre-approval stages — grilling, planning, plan review — are the only ones that run against the
   * repository root, read-only, because they exist to produce the plan a human has not approved yet.
   * Everything else needs a workspace provider, and reaching a post-approval stage without one is
   * refused here rather than downgraded to the repository root.
   *
   * The baseline comes from the approval checkpoint, not from the repository. That is the whole point:
   * a repository whose HEAD moved since approval is refused, and a repository whose recorded baseline
   * no longer matches its own canonical root is refused, so a worktree is never silently created from
   * whatever the repository happens to be pointing at now.
   */
  async #openWorkspace(
    session: FeatureSession,
    stage: WorkStage,
  ): Promise<
    | { readonly ok: true; readonly workspace: ProjectWorkspace; readonly baseline: WorkspaceBaseline | null }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    if (!APPROVAL_VERIFIED_STAGES.has(stage)) {
      // Before a human approves a plan there is nothing to fork a worktree from, so the stage reads
      // the human's own checkout under a read-only workspace. The baseline and the opening Git state
      // are null rather than stand-ins: no commit was approved, and a placeholder here would let a
      // later check compare this run against a commit nobody agreed to. What a pre-approval stage *is*
      // held to is not writing anything at all, which `#enforceScope` measures directly by comparing
      // the tree before the stage with the tree after it.
      return {
        ok: true,
        baseline: null,
        workspace: {
          workspaceId: REPOSITORY_WORKSPACE_ID,
          repositoryRoot: this.#projectRoot,
          workingDirectory: this.#projectRoot,
          access: { level: "read_only" },
          baseline: null,
          gitState: null,
        },
      };
    }

    if (this.#workspace === null) {
      return {
        ok: false,
        error: orchestrationError(
          "workspace_not_configured",
          `Stage "${stage}" runs against an approved plan and needs an isolated workspace, but no workspace provider is configured. It is refused rather than run in the repository root, where a write would land in a human's working tree.`,
        ),
      };
    }

    const baseline = session.approvals.plan?.baseline ?? null;

    if (baseline === null) {
      return {
        ok: false,
        error: orchestrationError(
          "workspace_baseline_missing",
          `Stage "${stage}" runs against an approved plan, but the approval carries no repository baseline, so there is nothing to create an isolated workspace from. Re-approving the plan records one; the framework never reconstructs a baseline from the current working tree.`,
        ),
      };
    }

    if (resolve(baseline.repositoryRoot) !== this.#projectRoot) {
      return {
        ok: false,
        error: orchestrationError(
          "workspace_baseline_missing",
          `The approval baseline names repository "${baseline.repositoryRoot}", but this orchestrator is bound to "${this.#projectRoot}". A workspace is never created for a repository the session was not approved in.`,
        ),
      };
    }

    let opened: OpenWorkspaceOutcome;

    try {
      opened = await this.#workspace.open({
        featureId: session.featureId,
        baseline,
        access: STAGE_DEFINITIONS[stage].access,
      });
    } catch (error) {
      return {
        ok: false,
        error: orchestrationError(
          "workspace_unavailable",
          `The isolated workspace for stage "${stage}" could not be opened: ${describeError(error)}`,
        ),
      };
    }

    if (!opened.ok) {
      return {
        ok: false,
        error: orchestrationError(
          opened.code === "lease_unavailable" ? "workspace_lease_unavailable" : "workspace_unavailable",
          `The isolated workspace for stage "${stage}" is unavailable: ${opened.message}`,
        ),
      };
    }

    if (resolve(opened.workspace.workingDirectory) === this.#projectRoot && APPROVAL_VERIFIED_STAGES.has(stage)) {
      return {
        ok: false,
        error: orchestrationError(
          "workspace_unavailable",
          `The workspace provider returned the repository root as the working directory for a post-approval stage, which is exactly the isolation this stage requires.`,
        ),
      };
    }

    // A provider that answers a post-approval open without a baseline has not said which commit it
    // detached from, and the one thing this whole path exists to guarantee is that it is the approved
    // commit. Guessing from the workspace's HEAD would take the guarantee away at its only point.
    //
    // Both refusals below close the workspace first. The provider has already taken a lease by the time
    // it answers, and a lease this process holds while refusing the stage would keep the next run out
    // of a workspace nobody is using.
    if (opened.workspace.baseline === null) {
      await this.#closeWorkspace(opened.workspace);

      return {
        ok: false,
        error: orchestrationError(
          "workspace_unavailable",
          `The workspace provider opened a workspace for stage "${stage}" without reporting the baseline it was created from, so the framework cannot confirm it is the approved commit ${baseline.baselineCommit}.`,
        ),
      };
    }

    if (opened.workspace.baseline.baselineCommit !== baseline.baselineCommit) {
      await this.#closeWorkspace(opened.workspace);

      return {
        ok: false,
        error: orchestrationError(
          "workspace_unavailable",
          `The workspace provider opened a workspace from commit ${opened.workspace.baseline.baselineCommit} while the approval baseline is ${baseline.baselineCommit}.`,
        ),
      };
    }

    return { ok: true, workspace: opened.workspace, baseline };
  }

  /**
   * Releases the lease. It runs in a `finally`, so a stage that threw, a scope violation, or a
   * rejected finalization all give the workspace back rather than stranding it until the lease times
   * out. A failure to release is swallowed here on purpose: the stage's own outcome is already
   * decided, and a lease that outlives its owner is recoverable by timeout, whereas a thrown release
   * would replace a real result with a bookkeeping error.
   */
  async #closeWorkspace(workspace: ProjectWorkspace): Promise<void> {
    if (this.#workspace === null) {
      return;
    }

    try {
      await this.#workspace.close(workspace);
    } catch {
      // Intentionally ignored; see above.
    }
  }

  /**
   * Holds a pre-approval stage to the one rule that applies to it: it reads, it does not write.
   *
   * There is no approved baseline yet, so this cannot be a comparison against a commit. It is a
   * comparison against the tree as it stood immediately before the executor ran, and the difference is
   * what this stage did. Two deliberate asymmetries follow from the workspace being a human's checkout:
   *
   * - The approved set is empty. A plan's `expectedFiles` describe what a human might authorize; until
   *   one does, they authorize nothing, so a pre-approval stage that writes inside the pattern it
   *   planned is still a write to the human's tree.
   * - Nothing is restored. Returning a path to its baseline content in a checkout the framework does not
   *   own would mean overwriting or deleting a human's uncommitted work on the agent's word. So the
   *   violation is reported, the stage's result is discarded, and the tree is left exactly as the agent
   *   left it for the human to look at.
   */
  #enforcePreApprovalWrites(
    session: FeatureSession,
    stage: WorkStage,
    workspace: ProjectWorkspace,
    before: WorkspaceInspection | null,
    after: WorkspaceInspection,
  ): {
    readonly ok: true;
    readonly evidence: WorkspaceScopeEvidence;
  } | {
    readonly ok: false;
    readonly error: OrchestrationError;
    readonly evidence: WorkspaceScopeEvidence;
  } {
    if (before === null) {
      return {
        ok: true,
        evidence: buildScopeEvidence(session, stage, workspace, null, after, {
          restored: [],
          removed: [],
          unsafePaths: [],
          recordedAt: after.collectedAt,
          measured: false,
        }, []),
      };
    }

    const delta = subtractWorkspaceChanges(before.changes, after.changes);
    const observed: WorkspaceInspection = { ...after, changes: delta };
    const verdict = evaluateWorkspaceScope(observed, { approvedPatterns: [] });

    const evidence = buildScopeEvidence(session, stage, workspace, null, observed, {
      restored: [],
      removed: [],
      unsafePaths: [],
      recordedAt: after.collectedAt,
      measured: true,
    }, []);

    if (verdict.ok) {
      return { ok: true, evidence };
    }

    return {
      ok: false,
      evidence,
      error: orchestrationError(
        "scope_violation",
        `Stage "${stage}" wrote ${verdict.unauthorized.map((entry) => entry.path).join(", ")} in a checkout that no human has approved work in. The stage result was discarded and the files were left untouched: reverting a path in someone's working tree would overwrite uncommitted work that the framework cannot tell apart from the agent's.`,
      ),
    };
  }

  /**
   * Compares what the stage did against what the human approved, and puts back what it should not
   * have done.
   *
   * The order of the two decisions is deliberate. Git integrity is checked first, because a workspace
   * whose HEAD moved is in a state no amount of file restoration makes coherent: a commit means the
   * history the human never approved exists, and quietly reverting files on top of it would leave
   * something that looks repaired and is not. That case stops and reports.
   *
   * A scope violation is then enforced rather than reported: each unauthorized path is returned to its
   * baseline content, or removed if it did not exist at the baseline, and each action is recorded. The
   * stage's result is discarded either way, because a stage that had to be cleaned up cannot be
   * believed about anything else it said.
   */
  async #enforceScope(
    session: FeatureSession,
    stage: WorkStage,
    workspace: ProjectWorkspace,
    baseline: WorkspaceBaseline | null,
    before: WorkspaceInspection | null,
  ): Promise<
    | { readonly ok: true; readonly evidence: WorkspaceScopeEvidence | null }
    | { readonly ok: false; readonly error: OrchestrationError; readonly evidence: WorkspaceScopeEvidence | null }
  > {
    if (this.#workspace === null) {
      return { ok: true, evidence: null };
    }

    const inspection = await this.#inspect(session, workspace, stage);

    if (!inspection.ok) {
      return {
        ok: false,
        evidence: null,
        error: orchestrationError("workspace_unavailable", inspection.message),
      };
    }

    if (baseline === null) {
      return this.#enforcePreApprovalWrites(session, stage, workspace, before, inspection.inspection);
    }

    // The approved set is read first because the evidence record has to carry it either way: a scope
    // record that lists what was observed without listing what was approved cannot be re-derived by
    // anyone reading it later.
    const scope = await this.#readApprovedScope(session);

    if (!scope.ok) {
      return { ok: false, evidence: null, error: scope.error };
    }

    const evidence = buildScopeEvidence(session, stage, workspace, baseline, inspection.inspection, {
      restored: [],
      removed: [],
      unsafePaths: [],
      recordedAt: inspection.inspection.collectedAt,
      measured: true,
    }, scope.patterns);

    const integrity = evaluateWorkspaceIntegrity(inspection.inspection, baseline);

    if (!integrity.ok) {
      return {
        ok: false,
        evidence,
        error: orchestrationError("repository_state_changed", integrity.reason),
      };
    }

    const verdict = evaluateWorkspaceScope(inspection.inspection, {
      approvedPatterns: scope.patterns,
    });

    if (verdict.ok) {
      return { ok: true, evidence };
    }

    const enforced = await this.#restore(workspace, verdict.unauthorized, stage);

    if (!enforced.ok) {
      return {
        ok: false,
        evidence,
        error: orchestrationError("workspace_unavailable", enforced.message),
      };
    }

    const record = buildScopeEvidence(session, stage, workspace, baseline, inspection.inspection, {
      restored: enforced.enforcement.restored,
      removed: enforced.enforcement.removed,
      unsafePaths: enforced.enforcement.unsafePaths,
      recordedAt: enforced.enforcement.enforcedAt,
      measured: true,
    }, scope.patterns);

    if (enforced.enforcement.unsafePaths.length > 0) {
      return {
        ok: false,
        evidence: record,
        error: orchestrationError(
          "scope_restoration_unsafe",
          `Stage "${stage}" changed ${String(verdict.unauthorized.length)} path(s) the approved plan does not describe, and the framework refused to touch ${enforced.enforcement.unsafePaths.join(", ")} because it could not prove the action was safe inside the workspace. The workspace is left as it is for a human to inspect; no artifact from this stage was recorded.`,
        ),
      };
    }

    if (enforced.enforcement.enforcementErrors.length > 0) {
      return {
        ok: false,
        evidence: record,
        error: orchestrationError(
          "scope_violation",
          `Stage "${stage}" changed path(s) the approved plan does not describe, and restoring them did not fully succeed: ${enforced.enforcement.enforcementErrors.join("; ")}. The workspace needs a human.`,
        ),
      };
    }

    return {
      ok: false,
      evidence: record,
      error: orchestrationError(
        "scope_violation",
        `Stage "${stage}" changed path(s) outside the approved scope: ${verdict.unauthorized.map((entry) => entry.path).join(", ")}. ${
          enforced.enforcement.restored.length > 0 || enforced.enforcement.removed.length > 0
            ? "The framework returned them to the approved baseline and discarded the stage result."
            : "The framework could not restore them and the stage result was discarded."
        } Scope is never widened automatically: a human has to amend and re-approve the plan, or the changes have to be undone.`,
      ),
    };
  }

  async #inspect(
    session: FeatureSession,
    workspace: ProjectWorkspace,
    stage: WorkStage,
  ): Promise<
    | { readonly ok: true; readonly inspection: WorkspaceInspection }
    | { readonly ok: false; readonly message: string }
  > {
    const provider = this.#workspace;

    if (provider === null) {
      return { ok: true, inspection: emptyInspection(workspace, session.createdAt) };
    }

    let inspected;

    try {
      inspected = await provider.inspect({ workspace });
    } catch (error) {
      return {
        ok: false,
        message: `The workspace could not be inspected for stage "${stage}": ${describeError(error)}`,
      };
    }

    if (!inspected.ok) {
      return {
        ok: false,
        message: `The workspace could not be inspected for stage "${stage}": ${inspected.message}`,
      };
    }

    return { ok: true, inspection: inspected.inspection };
  }

  async #restore(
    workspace: ProjectWorkspace,
    paths: readonly WorkspaceUnauthorizedPath[],
    stage: WorkStage,
  ): Promise<
    | {
        readonly ok: true;
        readonly enforcement: {
          readonly restored: readonly string[];
          readonly removed: readonly string[];
          readonly unsafePaths: readonly string[];
          readonly enforcementErrors: readonly string[];
          readonly enforcedAt: string;
        };
      }
    | { readonly ok: false; readonly message: string }
  > {
    const provider = this.#workspace;

    if (provider === null) {
      return {
        ok: false,
        message: `Stage "${stage}" reported out-of-scope changes and no workspace provider is available to restore them.`,
      };
    }

    let enforced;

    try {
      enforced = await provider.enforceScope({ workspace, paths });
    } catch (error) {
      return {
        ok: false,
        message: `Out-of-scope changes from stage "${stage}" could not be restored: ${describeError(error)}`,
      };
    }

    if (!enforced.ok) {
      return {
        ok: false,
        message: `Out-of-scope changes from stage "${stage}" could not be restored: ${enforced.message}`,
      };
    }

    return { ok: true, enforcement: enforced.enforcement };
  }

  /** The approved path set, derived from the plan artifact the human approved. */
  async #readApprovedScope(
    session: FeatureSession,
  ): Promise<
    | { readonly ok: true; readonly patterns: readonly string[] }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    let plan: unknown;

    try {
      plan = await this.#store.readArtifact(session.featureId, "plan");
    } catch (error) {
      if (isArtifactMissing(error)) {
        return { ok: true, patterns: [] };
      }

      return {
        ok: false,
        error: orchestrationError(
          "persistence_failed",
          `The approved plan could not be read to determine the allowed scope: ${describeError(error)}`,
        ),
      };
    }

    return approvedScopeFromPlan(plan);
  }

  /**
   * Asks the deterministic provider for this stage's evidence and refuses a bundle it cannot verify.
   *
   * There is no fallback path. A verification stage reached without a provider is refused here,
   * before the executor exists, because the alternative is the behaviour this milestone exists to
   * remove: a stage whose only evidence is a model's description of a run nobody performed. A
   * provider failure, a malformed bundle, a bundle that contradicts itself, and a well-formed bundle
   * belonging to a different stage, revision, or repository are all the same kind of answer, which is
   * no: an unverifiable verification is not a passing verification, and it is never downgraded to an
   * opinion.
   */
  async #collectVerification(
    session: FeatureSession,
    stage: WorkStage,
    projectRoot: string,
    workspaceId: string,
  ): Promise<
    | { readonly ok: true; readonly bundle: VerificationEvidenceBundle | null }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    const verification: VerificationStage | undefined = VERIFICATION_STAGE_BY_WORK_STAGE[stage];

    if (verification === undefined) {
      return { ok: true, bundle: null };
    }

    if (this.#verification === null) {
      return {
        ok: false,
        error: orchestrationError(
          "verification_not_configured",
          `The "${stage}" stage requires a verification provider and none is configured, so there is no process result to verify it against. It is refused rather than passed on the verifier's word.`,
        ),
      };
    }

    const request: VerificationRequest = {
      featureId: session.featureId,
      stage,
      verification,
      revision: session.revision,
      projectRoot,
      workspaceId,
    };

    let raw: unknown;

    try {
      raw = await this.#verification.collect(request);
    } catch (error) {
      return {
        ok: false,
        error: orchestrationError(
          "verification_provider_failed",
          `The verification provider failed for stage "${stage}": ${describeError(error)}`,
        ),
      };
    }

    const validated = validateVerificationEvidenceBundle(raw);

    if (!validated.ok) {
      return { ok: false, error: orchestrationError(validated.code, validated.message) };
    }

    // Identity, not shape. A bundle that is internally perfect and belongs to a superseded revision
    // is exactly the thing that must not reach the verifier, so this runs before the executor is
    // called and before anything is written.
    const bound = bindVerificationEvidenceToRequest(validated.bundle, request);

    if (!bound.ok) {
      return { ok: false, error: orchestrationError(bound.code, bound.message) };
    }

    return { ok: true, bundle: bound.bundle };
  }

  async #verifyApproval(
    featureId: string,
    stage: WorkStage,
    state: WorkflowState,
  ): Promise<ComposeOutcome> {
    try {
      const context = await this.#store.readContext(featureId);
      const verification = await verifyPlanApproval(context, stage, state);

      return verification.ok ? { ok: true, content: undefined } : { ok: false, error: verification.error };
    } catch (error) {
      return {
        ok: false,
        error: orchestrationError(
          "persistence_failed",
          `Unable to verify the plan approval: ${describeError(error)}`,
        ),
      };
    }
  }

  async #gatherContext(
    featureId: string,
    plan: StageContextPlan,
  ): Promise<ContextOutcome> {
    const groups: readonly (readonly [readonly FeatureArtifactName[], boolean])[] = [
      [plan.required, true],
      [plan.optional, false],
    ];
    const context: StageArtifactContext[] = [];

    for (const [names, required] of groups) {
      for (const name of names) {
        let content: unknown;

        try {
          content = await this.#store.readArtifact(featureId, name);
        } catch (error) {
          if (isArtifactMissing(error)) {
            if (required) {
              return {
                ok: false,
                error: orchestrationError(
                  "missing_context_artifact",
                  `Required context artifact "${name}" is not available.`,
                ),
              };
            }

            continue;
          }

          return {
            ok: false,
            error: orchestrationError(
              "persistence_failed",
              `Unable to read context artifact "${name}": ${describeError(error)}`,
            ),
          };
        }

        context.push({ name, filename: FEATURE_ARTIFACT_FILENAMES[name], content });
      }
    }

    return { ok: true, context };
  }

  async #composeArtifactContent(
    reader: FeatureMutationReader,
    stage: WorkStage,
    name: FeatureArtifactName,
    content: unknown,
  ): Promise<ComposeOutcome> {
    const spec = outputSpecFor(stage, name);

    if (spec.kind === "history") {
      const fixReturnState = reader.session.machine.fixReturnState;

      if (fixReturnState === undefined) {
        return {
          ok: false,
          error: orchestrationError(
            "inconsistent_fix_state",
            "A fix report cannot be recorded without a recorded fix return state.",
          ),
        };
      }

      const appended = await appendFixHistoryEntry(reader, fixReturnState, content);
      return appended.ok ? { ok: true, content: appended.document } : { ok: false, error: appended.error };
    }

    if (spec.kind === "document") {
      return { ok: true, content };
    }

    let existing: unknown;

    try {
      existing = await reader.readArtifact(name);
    } catch (error) {
      if (!isArtifactMissing(error)) {
        return {
          ok: false,
          error: orchestrationError(
            "persistence_failed",
            `Unable to read the "${name}" envelope: ${describeError(error)}`,
          ),
        };
      }

      existing = undefined;
    }

    if (existing === undefined) {
      return { ok: true, content: { [spec.envelopeKey as string]: content } };
    }

    if (!isRecord(existing)) {
      return {
        ok: false,
        error: orchestrationError(
          "unmergeable_artifact",
          `Artifact "${name}" does not hold a stage envelope and cannot be extended.`,
        ),
      };
    }

    return { ok: true, content: { ...existing, [spec.envelopeKey as string]: content } };
  }

  /**
   * The single mutation path. Every authoritative change flows through here so a stale caller is
   * rejected before it can write an artifact or move the workflow, and so a reported failure can
   * always be classified against the revision the caller expected to produce.
   */
  async #commit(input: CommitInput): Promise<OrchestrationResult> {
    const { featureId, session, event, extras } = input;
    const baseRevision = session.revision;
    const expectedRevision = baseRevision + 1;
    const baseMachine = session.machine;
    let expected: WorkflowMachineSnapshot | null = null;

    if (event !== undefined) {
      const preview = previewMachine(session, event);

      if (!preview.ok) {
        return this.#result({
          ...extras,
          status: "rejected",
          state: baseMachine.state,
          event,
          error: preview.error,
        });
      }

      expected = preview.snapshot;
    }

    try {
      const outcome = await this.#store.mutate(featureId, {
        expectedRevision: baseRevision,
        prepare: async (reader) => {
          const prepared = input.prepare === undefined ? {} : await input.prepare(reader);
          return event === undefined ? prepared : { ...prepared, event };
        },
      });

      if (event !== undefined) {
        if (outcome.transition === null) {
          throw new PersistenceError("INVALID_EVENT", "Workflow event is not recognized.");
        }

        if (!outcome.transition.ok) {
          return this.#result({
            ...extras,
            status: "rejected",
            state: baseMachine.state,
            event,
            error: orchestrationError("illegal_transition", outcome.transition.message),
          });
        }
      }

      return this.#result({
        ...extras,
        status: input.successStatus,
        state: outcome.session.machine.state,
        fixReturnState: outcome.session.machine.fixReturnState ?? null,
        committed: true,
        artifacts: outcome.artifacts,
        event: event ?? null,
      });
    } catch (error) {
      if (error instanceof StageFinalizeError) {
        return this.#result({
          ...extras,
          status: "rejected",
          state: baseMachine.state,
          event: event ?? null,
          error: error.orchestrationError,
        });
      }

      if (isRevisionConflict(error)) {
        return this.#conflictResult(featureId, baseMachine.state, event, extras, error);
      }

      return this.#recoverMutation(
        featureId,
        baseRevision,
        expectedRevision,
        baseMachine,
        expected,
        event,
        extras,
        error,
      );
    }
  }

  /**
   * A conflict is recoverable and never re-executes anything: the caller is told to run
   * `runNext` again, which will pick up whatever the winning mutation left behind.
   */
  async #conflictResult(
    featureId: string,
    fromState: WorkflowState,
    event: WorkflowEvent | undefined,
    extras: ResultExtras,
    failure: unknown,
  ): Promise<OrchestrationResult> {
    let state = fromState;

    try {
      state = (await this.#store.load(featureId)).machine.state;
    } catch {
      // Reporting the state the caller started from is still correct and never guesses.
    }

    return this.#result({
      ...extras,
      status: "conflict",
      state,
      event: event ?? null,
      committed: false,
      error: orchestrationError(
        "revision_conflict",
        `Another mutation changed this feature while the stage result was in flight (${describeError(failure)}); nothing was written and no stage was re-executed.`,
      ),
    });
  }

  async #recoverMutation(
    featureId: string,
    baseRevision: number,
    expectedRevision: number,
    baseMachine: WorkflowMachineSnapshot,
    expected: WorkflowMachineSnapshot | null,
    event: WorkflowEvent | undefined,
    extras: ResultExtras,
    failure: unknown,
  ): Promise<OrchestrationResult> {
    let observed: FeatureSession;

    try {
      observed = await this.#store.load(featureId);
    } catch (error) {
      return this.#result({
        ...extras,
        status: "persistence_error",
        state: baseMachine.state,
        event: event ?? null,
        error: orchestrationError(
          "persistence_verification_failed",
          `The mutation failed (${describeError(failure)}) and the session could not be reloaded: ${describeError(error)}`,
        ),
      });
    }

    const committed =
      expected !== null &&
      observed.revision === expectedRevision &&
      snapshotsMatch(observed.machine, expected);

    if (committed) {
      return this.#result({
        ...extras,
        status: "persistence_error",
        state: observed.machine.state,
        event: event ?? null,
        committed: true,
        error: orchestrationError(
          "persistence_transition_committed",
          `The mutation committed at revision ${String(observed.revision)} before reporting failed; the event was not retried.`,
        ),
      });
    }

    const unchanged =
      observed.revision === baseRevision && snapshotsMatch(observed.machine, baseMachine);

    if (unchanged) {
      return this.#result({
        ...extras,
        status: "persistence_error",
        state: observed.machine.state,
        event: event ?? null,
        committed: false,
        error: orchestrationError(
          "persistence_transition_not_committed",
          `The mutation did not commit; the feature is still at revision ${String(observed.revision)} in "${observed.machine.state}" and the stage stays retryable.`,
        ),
      });
    }

    return this.#result({
      ...extras,
      status: "persistence_error",
      state: observed.machine.state,
      event: event ?? null,
      committed: false,
      error: orchestrationError(
        "persistence_transition_superseded",
        `The mutation failed and the feature has already advanced to revision ${String(observed.revision)} in "${observed.machine.state}", so another mutation won the race.`,
      ),
    });
  }

  #result(input: OrchestrationResultInput): OrchestrationResult {
    return buildOrchestrationResult(input);
  }
}

export function createWorkflowOrchestrator(
  options: WorkflowOrchestratorOptions,
): WorkflowOrchestrator {
  return new WorkflowOrchestrator(options);
}
