import {
  WorkflowStateMachine,
  type FixReturnState,
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
  type FixAttemptOutcome,
  type FixHistoryEntry,
} from "@agent-workflow-kit/persistence";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { buildPlanApproval, digestArtifactText, verifyPlanApproval } from "./approval.js";
import { buildPushApproval, PUSH_APPROVAL_REVISION_OFFSET } from "./push-approval.js";
import { describeError, orchestrationError, type OrchestrationError } from "./errors.js";
import {
  criterionClaimsFrom,
  criteriaFromSpec,
  evaluateFinalGate,
  recordedFinalGateFrom,
  type FinalGateFixInput,
  type FinalGateResult,
  type FinalGateScopeInput,
  type FinalGateVerificationInput,
} from "./final-gate.js";
import { buildFinalSummary, type FinalSummaryInput } from "./final-summary.js";
import { appendFixHistoryEntry, parseFixHistory } from "./fix-history.js";
import {
  evaluateFixIntegrity,
  failureReasonFrom,
  failureTargetFrom,
  fixAttemptsExhausted,
  fixRejected,
  FIX_PROTECTED_PATTERNS,
  latestFixEntry,
  latestRecordedEvidence,
  nextFixAttempt,
  resolveMaxFixAttempts,
  staleVerificationEvidence,
  suspectedFilesFrom,
  verificationConfigurationDigest,
  verificationForOrigin,
  workStageForOrigin,
  type FixIntegritySnapshot,
  type FixRejectionCode,
  type FixerInputContract,
} from "./fix-policy.js";
import type { StageArtifactContext, StageExecutionRequest, StageExecutor } from "./executor.js";
import {
  buildOrchestrationResult,
  type OrchestrationResult,
  type OrchestrationResultInput,
  type OrchestrationStatus,
} from "./result.js";
import { isRecord, validateStageExecutionResult } from "./result-validation.js";
import {
  isApprovalVerifiedStage,
  DEFERRED_WORK_STATES,
  fixTriggerArtifact,
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
  approvedPathsOf,
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
  applySecurityEvidence,
  applySecurityPolicy,
  bindSecurityReviewToRequest,
  latestRecordedSecurityReview,
  mergeSecurityPolicyChecks,
  mergeSecurityReviewEvidence,
  securityEvidenceSummaries,
  SECURITY_PROTECTED_PATTERNS,
  SECURITY_REVIEW_ARTIFACT_NAME,
  staleSecurityReview,
  validateSecurityReviewEvidence,
  type SecurityReviewEvidence,
  type SecurityReviewProvider,
  type SecurityReviewRequest,
} from "./security.js";
import {
  applyDeterministicEvidence,
  bindVerificationEvidenceToRequest,
  mergeDeterministicEvidence,
  validateVerificationEvidenceBundle,
  verificationEvidenceSummaries,
  VERIFICATION_ARTIFACT_NAME,
  VERIFICATION_STAGE_BY_WORK_STAGE,
  VERIFICATION_WORK_STAGES,
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
   * Where deterministic security review evidence comes from.
   *
   * Optional only so that a workflow which never reaches the security review, and the tests for
   * everything before one, can be built without one. The stage has no model-only mode: reaching it
   * without a provider is a structured `security_not_configured` refusal that never calls the
   * executor, for the same reason a verification stage without a provider is refused. A stage whose
   * only evidence is a model's description of a scan nobody performed is the behaviour this option
   * exists to remove.
   *
   * The provider is constructed by whoever wires the kit up. It is never an agent, and it never
   * receives a check, a path, or a verdict from one. The framework's own two change-shaped checks do
   * not come from here at all: they are computed from the measured change set and merged into the
   * record after the provider returns, so a provider that answered for them would be refused rather
   * than believed.
   */
  readonly security?: SecurityReviewProvider | null;
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
  /**
   * How many times one fix loop may run before the framework stops and escalates.
   *
   * Defaults to `MAX_FIX_ATTEMPTS`. It is a construction option rather than a project setting because
   * it is a statement about the workflow's own tolerance for an unrepairable defect, not about the
   * project: a project cannot raise its own limit past the point where a failing loop looks like
   * progress, and no project can lower it to zero, which would make every defect unfixable. A value
   * that is not a positive integer is ignored in favour of the default, so a malformed configuration
   * behaves exactly like no configuration and never refuses every repair.
   */
  readonly maxFixAttempts?: number | null;
}

type ResultExtras = Omit<OrchestrationResultInput, "status" | "state">;

type ContextOutcome =
  | { readonly ok: true; readonly context: readonly StageArtifactContext[] }
  | { readonly ok: false; readonly error: OrchestrationError };

type ComposeOutcome =
  | { readonly ok: true; readonly content: unknown }
  | { readonly ok: false; readonly error: OrchestrationError };

type FinalGateOutcome =
  | { readonly ok: true; readonly result: FinalGateResult }
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

/**
 * Everything the framework decided about one fix attempt before the fixer was invoked.
 *
 * Captured up front for three reasons that all have the same shape: the attempt has to be counted
 * before it runs, the acceptance criteria have to be hashed before anything can rewrite them, and the
 * fixer has to be handed a contract that describes the failure as it stood rather than as the fixer
 * will describe it afterwards. `allowed` is false when the loop has already spent every attempt it
 * was given, and a guard that is not allowed is escalated rather than handed to an executor.
 */
interface FixGuard {
  readonly originStage: FixReturnState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly allowed: boolean;
  readonly contract: FixerInputContract;
  readonly before: FixIntegritySnapshot;
}

type FixPreparation =
  | { readonly ok: true; readonly guard: FixGuard }
  | { readonly ok: false; readonly error: OrchestrationError };

/** What the framework measured after a fix ran, for the comparison and the history record. */
interface FixMeasurement {
  readonly after: FixIntegritySnapshot;
  readonly inspection: WorkspaceInspection;
  readonly changedPaths: readonly string[];
}

/**
 * The framework's own account of one fix attempt, carried into the history write.
 *
 * Everything here was measured by the framework rather than taken from the fixer's report, which is
 * what makes the entry worth keeping. The report is stored alongside it as a claim; this is the
 * finding. The accepted path uses `outcome: "accepted"` and a null summary, and the escalation path
 * uses the rejection's own explanation, so a reader can tell the two apart without interpreting
 * prose.
 */
interface FixAttemptContext {
  readonly attempt: number;
  readonly originStage: FixReturnState;
  readonly outcome: FixAttemptOutcome;
  readonly failureSummary: string | null;
  readonly implementationFingerprint: string | null;
  readonly changedPaths: readonly string[];
  readonly integrity: FixIntegritySnapshot;
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
 * Why the final gate refused, in the words the person reading the failure will get.
 *
 * Written from the gate's own structured result rather than from the facts that produced it, so the
 * error and the `finalGate` field cannot disagree: this message quotes the gate's own blocker, and
 * that blocker is also the one the route was taken from. The route is named in full because "route"
 * on its own tells a reader nothing — what matters is which stage's evidence would have to be redone.
 */
function finalGateRefusalMessage(gate: FinalGateResult): string {
  const first = gate.blockers[0];

  if (first === undefined) {
    return `The final gate could not certify this feature: ${gate.verification} verification, ${gate.security} security, ${gate.scope} scope, ${gate.approval} approval. Nothing was executed and the session stayed in "final_gate".`;
  }

  const others = gate.blockers.length - 1;

  return `The final gate refused to certify this feature, and "final_gate" was not executed: ${first.message}${
    others > 0 ? ` ${String(others)} further blocker(s) are recorded on the result: ${gate.blockers.slice(1).map((blocker) => blocker.code).join(", ")}.` : ""
  } Route: ${first.route}. Nothing was written and the session stayed in "final_gate".`;
}

/**
 * One recorded fix attempt, reduced to the facts the final gate decides freshness from.
 *
 * `maxAttempts` is the session's current limit rather than a value from the entry, because the entry
 * does not carry one: the gate asks "did the loop still have room left when it spent its last
 * attempt", and the answer is about the policy in force now. The attempt number is the entry's own.
 */
function finalGateFixInput(entry: FixHistoryEntry | null, maxAttempts: number): FinalGateFixInput | null {
  if (entry === null) {
    return null;
  }

  return {
    originStage: entry.fixReturnState,
    attempt: entry.attempt,
    maxAttempts,
    recordedAt: entry.recordedAt,
    revisionBefore: entry.revisionBefore,
  };
}

/**
 * Whether the checks recorded after a fix are the checks that fix was measured against.
 *
 * The fix guard hashed the verification configuration before it ran, because that is the point at
 * which "unchanged since the failure" is a fact. Comparing the newest bundle's configuration against
 * that hash asks the complementary question: whether the evidence now describes the same checks. A
 * difference means the command set moved under the repair, so a passing run proves something other
 * than what the repair was asked to satisfy.
 *
 * A side that cannot be computed compares as "no change". The configuration digest is null when the
 * stage recorded no bundle, and a fix that never had one to hash has nothing to compare — refusing on
 * that absence would block a feature for a repair to a stage the gate is not judging.
 */
function verificationConfigurationChanged(
  verification: unknown,
  workStage: WorkStage,
  entry: FixHistoryEntry | null,
): boolean {
  const recorded = entry?.integrity.verificationConfigSha256 ?? null;

  if (recorded === null) {
    return false;
  }

  const newest = verificationConfigurationDigest(verification, workStage);

  return newest !== null && newest !== recorded;
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
  readonly #security: SecurityReviewProvider | null;
  readonly #projectRoot: string;
  readonly #workspace: ProjectWorkspaceProvider | null;
  readonly #maxFixAttempts: number;

  constructor(options: WorkflowOrchestratorOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
    this.#verification = options.verification ?? null;
    this.#security = options.security ?? null;
    this.#projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.#workspace = options.workspace ?? null;
    this.#maxFixAttempts = resolveMaxFixAttempts(options.maxFixAttempts);
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

        const approvals: FeatureApprovals = {
          plan: approval.record,
          push: session.approvals.push,
        };

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

  /**
   * Records the human's publishing approval, or refuses to.
   *
   * This is the last boundary the framework owns, and the only one that is about the human rather than
   * about the work. `approve_plan` says "build this"; this says "publish this", and the second cannot
   * be inferred from the first: a plan that was approved is a plan nobody has yet seen implemented, and
   * an implementation that passed the gate is a tree nobody has yet been asked about. So this method
   * records something, refuses loudly when it cannot, and never treats a missing approval as a
   * provisional one — a session in `awaiting_push_approval` with no record in it is a session that has
   * not been approved, and the state machine will say so.
   *
   * The checks, in order, are all about whether the evidence is still current:
   *
   * - The recorded gate must exist and be readable. A summary composed from a document the framework
   *   cannot parse is a summary of nothing, and this milestone deliberately persists the gate so that
   *   there is something to refuse.
   * - The session revision must be exactly two past the gate's. That is the distance a summary written
   *   from that gate is recorded at, and any other distance means something was recorded in between.
   * - The tree must fingerprint the way it did when the gate passed. The fingerprint is measured here,
   *   through the same workspace and the same provider the gate measured through, rather than copied
   *   from the gate — a check that cannot fail is not a check.
   * - No approval may already exist. A second approval would be recorded against evidence the first one
   *   did not cover, which is exactly the claim this record exists to prevent.
   *
   * `options.actor` is recorded verbatim when given. Nothing derives it, and nothing requires it: an
   * unnamed approver is a real situation, and a name written by the framework would be worse than none.
   */
  async approvePush(
    featureId: string,
    options?: { readonly actor?: string | null },
  ): Promise<OrchestrationResult> {
    const session = await this.#store.load(featureId);
    const base: ResultExtras = { featureId, fromState: session.machine.state };
    const actor = options?.actor ?? null;

    // The state is asked before the evidence is read, not after. Which state the session is in decides
    // whether an approval is a thing that can exist at all, and that question is the workflow
    // machine's to answer; a session sitting in `planning` has not earned a publishing approval by any
    // amount of good evidence, so the refusal names the illegal transition rather than the first piece
    // of missing evidence it happened to find.
    const preview = previewMachine(session, "approve_push");

    if (!preview.ok) {
      return this.#result({
        ...base,
        status: "rejected",
        state: session.machine.state,
        event: "approve_push",
        error: preview.error,
      });
    }

    if (session.approvals.push !== null) {
      return this.#result({
        ...base,
        status: "rejected",
        state: session.machine.state,
        error: orchestrationError(
          "push_approval_already_granted",
          `Feature "${featureId}" already records a publishing approval at revision ${String(session.approvals.push.approvedRevision)}, so it cannot be approved again.`,
        ),
      });
    }

    const gate = await this.#readRecordedFinalGate(session);

    if (!gate.ok) {
      return this.#result({ ...base, status: "rejected", state: session.machine.state, error: gate.error });
    }

    if (gate.result.status !== "passed") {
      return this.#result({
        ...base,
        status: "rejected",
        state: session.machine.state,
        error: orchestrationError(
          "final_gate_blocked",
          finalGateRefusalMessage(gate.result),
        ),
      });
    }

    // The measurement is the expensive part and the only part that can be done outside the mutation, so
    // it happens before the lock is taken and is re-checked inside it. The workspace is opened here for
    // the same reason `approvePlan` captures a baseline before its commit: a provider call must never
    // be made while the per-feature lock is held.
    const measured = await this.#measureForPushApproval(session);

    if (!measured.ok) {
      return this.#result({ ...base, status: "rejected", state: session.machine.state, error: measured.error });
    }

    try {
      return await this.#commit({
        featureId,
        session,
        event: "approve_push",
        successStatus: "gate_approved",
        extras: base,
        prepare: async (reader) => {
          const reverified = await this.#readRecordedFinalGate(reader.session);

          if (!reverified.ok) {
            throw new StageFinalizeError(reverified.error);
          }

          const current = recordedFinalGateFrom(await reader.readArtifact("final_gate"));

          if (!current.ok || current.result.revision !== reverified.result.revision) {
            throw new StageFinalizeError(
              current.ok
                ? orchestrationError(
                    "push_approval_stale",
                    `The recorded final gate moved from revision ${String(reverified.result.revision)} to ${String(current.result.revision)} while the approval was in flight.`,
                  )
                : orchestrationError("final_gate_not_recorded", `The recorded final gate could not be read: ${current.reason}.`),
            );
          }

          const approval = await buildPushApproval(reader, {
            gate: current.result,
            gateSha256: digestArtifactText(await reader.readArtifactText("final_gate") ?? ""),
            fingerprint: measured.fingerprint,
            actor,
          });

          if (!approval.ok) {
            throw new StageFinalizeError(approval.error);
          }

          const approvals: FeatureApprovals = {
            plan: reader.session.approvals.plan,
            push: approval.record,
          };

          return { approvals };
        },
      });
    } finally {
      await this.#closeWorkspace(measured.workspace);
    }
  }

  /**
   * The gate as it is recorded on disk, for a stage or an approval that must be able to point at one.
   *
   * Reads the persisted artifact rather than re-evaluating anything. That is the distinction this
   * milestone turns on: a re-evaluation would be a fresh opinion, and an opinion produced at approval
   * time would approve whatever the framework happened to think then, rather than what the gate
   * certified while the work was in front of the human. The refusal names the reason the document could
   * not be used, because "no gate" and "a gate that cannot be read" are different operator problems and
   * only one of them is fixed by running the gate again.
   */
  async #readRecordedFinalGate(
    session: FeatureSession,
  ): Promise<
    | { readonly ok: true; readonly result: FinalGateResult }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    const featureId = session.featureId;

    let value: unknown;

    try {
      value = await this.#store.readArtifact(featureId, "final_gate");
    } catch (error) {
      if (isArtifactMissing(error)) {
        return {
          ok: false,
          error: orchestrationError(
            "final_gate_not_recorded",
            `No final gate result is recorded for feature "${featureId}". The gate must pass and be recorded before a summary can be written or an approval given.`,
          ),
        };
      }

      return {
        ok: false,
        error: orchestrationError(
          "persistence_failed",
          `The recorded final gate could not be read: ${describeError(error)}`,
        ),
      };
    }

    const recorded = recordedFinalGateFrom(value);

    if (!recorded.ok) {
      return {
        ok: false,
        error: orchestrationError(
          "final_gate_not_recorded",
          `The recorded final gate for "${featureId}" cannot be used: ${recorded.reason}.`,
        ),
      };
    }

    if (recorded.result.featureId !== featureId) {
      return {
        ok: false,
        error: orchestrationError(
          "final_gate_not_recorded",
          `The recorded final gate belongs to "${recorded.result.featureId}", not to "${featureId}".`,
        ),
      };
    }

    return { ok: true, result: recorded.result };
  }

  /**
   * Reads the tree the way the gate read it, so the two can be compared.
   *
   * The workspace is opened through the provider rather than measured in the operator's checkout, for
   * the reason every post-approval stage opens one: the approved work lives in the worktree forked
   * from the approved commit, and the fingerprint the gate recorded is a digest of the change set in
   * that worktree. Measuring anywhere else would produce a different number for a tree nobody approved,
   * and the refusal would fire on every call.
   *
   * The workspace is closed by the caller, which holds it across the commit so that the lease covers
   * the whole approval rather than only the measurement.
   */
  async #measureForPushApproval(
    session: FeatureSession,
  ): Promise<
    | {
        readonly ok: true;
        readonly workspace: ProjectWorkspace;
        readonly fingerprint: string;
      }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    const opened = await this.#openWorkspace(session, "final_summary");

    if (!opened.ok) {
      return { ok: false, error: opened.error };
    }

    if (opened.baseline === null) {
      // Unreachable for a post-approval stage, and treated as a refusal rather than as a downgrade: the
      // fingerprint a gate records is only meaningful against the worktree it forked, and a measurement
      // taken without a baseline would be of a different tree.
      await this.#closeWorkspace(opened.workspace);

      return {
        ok: false,
        error: orchestrationError(
          "workspace_unavailable",
          "The publishing approval could not be bound to an approved baseline, so the tree it would approve cannot be identified.",
        ),
      };
    }

    const inspection = await this.#inspect(session, opened.workspace, "final_summary");

    if (!inspection.ok) {
      await this.#closeWorkspace(opened.workspace);

      return {
        ok: false,
        error: orchestrationError(
          "workspace_unavailable",
          `The working tree could not be read to decide whether the publishing approval is still current: ${inspection.message}`,
        ),
      };
    }

    if (inspection.inspection.fingerprint.length === 0) {
      await this.#closeWorkspace(opened.workspace);

      return {
        ok: false,
        error: orchestrationError(
          "push_approval_stale",
          "The working tree produced no fingerprint, so it cannot be compared with the one the final gate decided against.",
        ),
      };
    }

    return {
      ok: true,
      workspace: opened.workspace,
      fingerprint: inspection.inspection.fingerprint,
    };
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
    initialExtras: ResultExtras,
    definition: (typeof STAGE_DEFINITIONS)[WorkStage],
    contextPlan: StageContextPlan,
    workspace: ProjectWorkspace,
    baseline: WorkspaceBaseline | null,
  ): Promise<OrchestrationResult> {
    // Reassigned once, by the final gate below, when the gate passes: a passing gate is part of what
    // this stage did, so its answer belongs on the result rather than in a variable that only the
    // refusing branches could see.
    let base: ResultExtras = initialExtras;

    // Set only when a gate passed and the stage that ran it is going to be committed, and read in the
    // `prepare` below to write `final-gate.json`. A gate that passed but whose stage then failed or was
    // sent back to the fixer records nothing, because a recorded verdict nobody is about to act on is
    // not the verdict the next stage should find.
    let recordedGate: FinalGateResult | null = null;

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

    // The security gate is collected immediately after the verification evidence and before anything
    // else, for the same reason: it describes the tree as the stage is about to see it, and the only
    // project code that runs in this method is the verification provider's, which a previous stage
    // already had reasons to trust. It runs in the stage's own directory, reads the same change set
    // the scope check will judge, and its record is the one the fixer is later given.
    const security = await this.#collectSecurityReview(session, stage, workspace);

    if (!security.ok) {
      return this.#result({ ...base, status: "rejected", state: fromState, error: security.error });
    }

    // The final gate runs here: after this run's deterministic evidence and before the agent that
    // would write the summary is involved at all. Position is the whole argument. A gate invoked after
    // the summarizer had written its artifact would be a reviewer of prose; invoked before, it is the
    // last thing that can say no, and it says it by not running the stage.
    //
    // A refusal is not a failure of the feature and not a mutation of the session. Nothing is
    // committed, the state stays in `FinalGate`, and `executedStages` stays empty, because no stage
    // opinion was recorded: the whole content of the refusal is that the recorded evidence was not
    // good enough, which is a fact about what came before rather than something this stage produced.
    // The route in the result names where that repair belongs; there is no transition back from here,
    // so the gate reports the earlier stage rather than pretending to move to it.
    if (stage === "final_gate") {
      const gate = await this.#evaluateFinalGate(session, stage, workspace, baseline);

      if (!gate.ok) {
        return this.#result({ ...base, status: "rejected", state: fromState, error: gate.error });
      }

      if (gate.result.status !== "passed") {
        return this.#result({
          ...base,
          status: gate.result.status === "failed" ? "stage_failed" : "inconclusive",
          state: fromState,
          finalGate: gate.result,
          error: orchestrationError("final_gate_blocked", finalGateRefusalMessage(gate.result)),
        });
      }

      base = { ...base, finalGate: gate.result };
    }

    const context = await this.#gatherContext(featureId, contextPlan);

    if (!context.ok) {
      return this.#result({ ...base, status: "rejected", state: fromState, error: context.error });
    }

    // The fix guard is built before the request exists, so the fixer is handed the failure as it stood
    // and the attempt is counted before anything runs. A guard that finds the loop out of attempts
    // stops here rather than before the executor: the attempt number has to come from the recorded
    // history, which needs the workspace this stage runs in.
    let fix: FixGuard | null = null;

    if (stage === "fixing") {
      const originStage = session.machine.fixReturnState;

      if (originStage === undefined) {
        return this.#result({
          ...base,
          status: "rejected",
          state: fromState,
          error: orchestrationError(
            "inconsistent_fix_state",
            "The persisted session is fixing without a recorded fix return state, so there is no failure to repair and no origin to return to.",
          ),
        });
      }

      const prepared = await this.#prepareFix(session, originStage);

      if (!prepared.ok) {
        return this.#result({ ...base, status: "rejected", state: fromState, error: prepared.error });
      }

      if (!prepared.guard.allowed) {
        return await this.#escalateFix(
          session,
          { ...base, verification: evidence.bundle, security: security.evidence },
          prepared.guard,
          null,
          fixAttemptsExhausted(originStage, prepared.guard.attempt, prepared.guard.maxAttempts),
        );
      }

      // A fix whose effect nobody measures cannot be accepted into the audit trail, and "nobody looked"
      // is not the same as "nothing changed". The refusal is explicit and named here rather than left to
      // surface later as a fix report the framework cannot attach a measurement to.
      if (this.#workspace === null) {
        return this.#result({
          ...base,
          status: "rejected",
          state: fromState,
          verification: evidence.bundle,
          security: security.evidence,
          error: orchestrationError(
            "workspace_not_configured",
            `Stage "fixing" would run for "${originStage}" with no workspace provider, so nothing could measure what the repair changed. A repair the framework cannot measure is not a repair the workflow can accept, so it is refused here instead of being recorded as one that changed nothing.`,
          ),
        });
      }

      fix = prepared.guard;
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
      security: security.evidence,
      fix: fix?.contract ?? null,
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

    // The fix guard runs before the scope check, and that order is the whole point of not restoring
    // anything. Both would refuse a fix that wrote outside its authority, but scope enforcement puts
    // the workspace back to the approved baseline while it does it — which would quietly repair the
    // very evidence the workflow has just escalated a human to. A rejected fix is left as the fixer
    // wrote it, and a fix that passed the guard is in scope by construction, so nothing a passing
    // attempt could contain reaches the restoring branch.
    let measured: WorkspaceInspection | null = null;
    let fixAttempt: FixAttemptContext | null = null;

    if (fix !== null && this.#workspace !== null) {
      const observed = await this.#inspect(session, workspace, stage);

      if (!observed.ok) {
        return this.#result({
          ...base,
          executedStages: [stage],
          status: "rejected",
          state: fromState,
          verification: evidence.bundle,
          security: security.evidence,
          error: orchestrationError(
            "workspace_unavailable",
            `The workspace could not be read to decide whether fix attempt ${String(fix.attempt)} was acceptable: ${observed.message}`,
          ),
        });
      }

      measured = observed.inspection;

      const after = await this.#measureFixIntegrity(session, fix.originStage);

      if (!after.ok) {
        return this.#result({
          ...base,
          executedStages: [stage],
          status: "rejected",
          state: fromState,
          verification: evidence.bundle,
          security: security.evidence,
          error: after.error,
        });
      }

      // What counts as the fix's changes is decided by what the stage was given, not by which inspection
      // looks convenient. After approval the stage owns a worktree, so the difference between the tree
      // as it was and the tree as it is is the fix and nothing else. Before approval the stage is pointed
      // at a human's checkout that may already have contained uncommitted work, and the difference is
      // still the only honest answer: attributing the human's dirt to the fix would have the audit trail
      // blame a fixer for edits it did not make, and would fail the feature over them.
      const attemptChanges =
        before === null
          ? observed.inspection.changes
          : subtractWorkspaceChanges(before.changes, observed.inspection.changes);

      const changedPaths = approvedPathsOf(attemptChanges);

      const verdict = evaluateFixIntegrity({
        featureId,
        originStage: fix.originStage,
        attempt: fix.attempt,
        approvedPatterns: fix.contract.approvedScope,
        changes: attemptChanges,
        before: fix.before,
        after: after.snapshot,
      });

      if (!verdict.ok) {
        return await this.#escalateFix(
          session,
          { ...base, executedStages: [stage], verification: evidence.bundle },
          fix,
          { after: after.snapshot, inspection: observed.inspection, changedPaths },
          fixRejected(verdict.rejections),
          verdict.rejections.map((rejection) => rejection.code),
        );
      }

      fixAttempt = {
        attempt: fix.attempt,
        originStage: fix.originStage,
        outcome: "accepted",
        failureSummary: null,
        implementationFingerprint: fix.contract.implementationFingerprint,
        changedPaths,
        integrity: after.snapshot,
      };
    }

    // The summary is composed from a measurement, so the stage takes its own reading of the tree and
    // hands the same one to the scope check below rather than paying for a second provider call. It is
    // taken after the executor ran, for the same reason the fix path takes its reading there: a
    // measurement taken before would attribute the framework's own writes to nobody and the agent's to
    // nothing, and the freshness check below has to compare the gate's fingerprint against the tree as
    // it is at the moment the summary is written.
    let summaryMeasurement: WorkspaceInspection | null = null;

    if (stage === "final_summary" && this.#workspace !== null) {
      const observed = await this.#inspect(session, workspace, stage);

      if (!observed.ok) {
        return this.#result({
          ...base,
          executedStages: [stage],
          status: "rejected",
          state: fromState,
          error: orchestrationError(
            "workspace_unavailable",
            `The working tree could not be read to write the final summary: ${observed.message}`,
          ),
        });
      }

      summaryMeasurement = observed.inspection;
      measured = observed.inspection;
    }

    // The scope check runs for a stage that returned and for a stage that threw, because a transport
    // failure, a timeout, or a model that abandoned the run halfway are precisely the runs that leave a
    // half-written file behind. Its verdict outranks the executor's: a stage that changed a path no
    // human approved has not produced a result, whatever it managed to say before or after doing it.
    const scope = await this.#enforceScope(session, stage, workspace, baseline, before, measured);

    if (!scope.ok) {
      return this.#result({
        ...base,
        executedStages: [stage],
        status: scopeStatus(scope.error),
        state: fromState,
        verification: evidence.bundle,
        security: security.evidence,
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
        security: security.evidence,
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
        security: security.evidence,
        scope: scope.evidence,
        error: orchestrationError(validation.code, validation.message),
      });
    }

    const outcome = validation.result;
    // Hard evidence is applied here, in two directions. A stage whose deterministic checks did not
    // pass cannot be reported as a success: a verifier that says "success" about a failing lint run is
    // overruled by the exit code, and the stage enters the fix loop. And a runtime stage that measured
    // nothing cannot be reported as a success either, which holds the stage inconclusive rather than
    // pretending the acceptance criteria were met.
    const applied =
      evidence.bundle === null
        ? ({ outcome: outcome.outcome, override: "none", findings: [] } as const)
        : applyDeterministicEvidence(evidence.bundle, outcome.outcome, featureId);

    // The security record is applied on top of that, and after it rather than beside it, for one
    // reason: it is the narrower question. Verification asks whether the project works; security asks
    // whether the change that made it work is one that should exist. A stage whose change is refused on
    // security grounds cannot be repaired by fixing a failing test, so the security verdict is the one
    // that has to survive, and composing the two outcomes in this order keeps a `needs_fix` a
    // `needs_fix` whichever of them asked for it.
    const appliedSecurity =
      security.evidence === null
        ? ({ outcome: applied.outcome, override: "none", findings: [] } as const)
        : applySecurityEvidence(security.evidence, applied.outcome, featureId);

    // The two applications compose into one, and the resolution order matters in exactly one case: a
    // stage that has both records. Where only one exists, whichever it is decides alone — so the record
    // that is absent must not silently become the decision, which is why the absent case resolves to the
    // verification application rather than to the raw outcome.
    const resolved = security.evidence === null ? applied : appliedSecurity;
    const effective = resolved.override === "none" ? outcome : { ...outcome, outcome: resolved.outcome };
    const extraFindings: readonly ReviewFinding[] = [...applied.findings, ...appliedSecurity.findings];
    const reported: ResultExtras = {
      ...base,
      executedStages: [stage],
      findings: [...outcome.findings, ...extraFindings],
      evidence: [
        ...outcome.evidence,
        ...(evidence.bundle === null ? [] : verificationEvidenceSummaries(evidence.bundle)),
        ...(security.evidence === null ? [] : securityEvidenceSummaries(security.evidence)),
      ],
      verification: evidence.bundle,
      security: security.evidence,
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

    // Only a stage that is actually committing a success records its gate. A stage that sent itself
    // back to the fixer keeps the tree moving, and a verdict about the tree it started from is not the
    // verdict the next run should find waiting for it.
    if (effective.outcome === "success" && stage === "final_gate") {
      recordedGate = base.finalGate ?? null;
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
            fixAttempt,
          );

          if (!composed.ok) {
            throw new StageFinalizeError(composed.error);
          }

          artifacts.push({
            name: artifact.name,
            content:
              // Only two artifacts carry a framework-owned record. Merging one into whatever else the
              // stage produced would put this attempt's measurements into an unrelated document, and
              // the next attempt would append to the wrong place.
              artifact.name === VERIFICATION_ARTIFACT_NAME
                ? mergeDeterministicEvidence(composed.content, stage, evidence.bundle)
                : artifact.name === SECURITY_REVIEW_ARTIFACT_NAME
                  ? mergeSecurityReviewEvidence(composed.content, security.evidence)
                  : composed.content,
          });
        }

        // The passing gate is persisted in the same mutation that moves the session past it, so a session
        // in `final_summary` always finds a verdict to read and a session in `final_gate` never has one
        // written for a decision that did not commit. Written as the whole result rather than a summary
        // of it because the summary stage and the approval both need the revision and the fingerprint
        // out of it, and a reduced copy would be a second thing to keep in step with the first.
        if (recordedGate !== null) {
          artifacts.push({ name: "final_gate", content: recordedGate });
        }

        // The summary is composed here, inside the mutation that records it, from the artifacts this
        // commit is about to replace rather than from copies read earlier. That is what makes it a
        // reading of the recorded state: there is no window in which the summary describes artifacts
        // that the same mutation then changed.
        if (stage === "final_summary") {
          const summary = await this.#composeFinalSummary(
            reader,
            summaryMeasurement,
            scope.evidence,
          );

          if (!summary.ok) {
            throw new StageFinalizeError(summary.error);
          }

          artifacts.push({ name: "final_summary", content: summary.document });
        }

        return { artifacts };
      },
    });
  }

  /**
   * The document a human is asked to read before approving publishing.
   *
   * Three things are refused here, and each is a case where a summary would be a lie rather than an
   * early draft:
   *
   * - No usable recorded gate. Without one there is no verdict to report and no evidence to be fresh
   *   against, so the stage is refused instead of writing a summary of the artifacts that happen to be
   *   on disk.
   * - A session revision that is not `gate.revision + 2`. The gate was decided against one revision,
   *   its own commit became the next, and this summary is the commit after that. A summary at any other
   *   revision was written from a different set of artifacts than the ones this commit is recording.
   * - A working tree whose fingerprint has moved since the gate measured it. A summary that lists
   *   changed files is a claim about specific paths in a specific tree; when the tree has moved, those
   *   lines are stale before anybody reads them, so the summary is not written at all rather than
   *   written wrong.
   *
   * Everything it does read comes from `reader`, so the composition is derived from the persisted
   * records at their current revision rather than from values carried across the mutation.
   */
  async #composeFinalSummary(
    reader: FeatureMutationReader,
    inspection: WorkspaceInspection | null,
    scope: WorkspaceScopeEvidence | null,
  ): Promise<
    | { readonly ok: true; readonly document: string }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    const session = reader.session;
    const gate = await this.#readRecordedFinalGate(session);

    if (!gate.ok) {
      return { ok: false, error: gate.error };
    }

    if (gate.result.status !== "passed") {
      return {
        ok: false,
        error: orchestrationError(
          "final_gate_blocked",
          `The recorded final gate is "${gate.result.status}", not "passed", so no summary of certified work can be written.`,
        ),
      };
    }

    const expectedRevision = gate.result.revision + PUSH_APPROVAL_REVISION_OFFSET;

    if (reader.nextRevision !== expectedRevision) {
      return {
        ok: false,
        error: orchestrationError(
          "final_gate_evidence_stale",
          `The recorded final gate was decided at revision ${String(gate.result.revision)}, so the summary written from it belongs at revision ${String(expectedRevision)}; this stage would record it at revision ${String(reader.nextRevision)}. Something was recorded between the gate and the summary, so the summary would not describe the artifacts this commit is writing.`,
        ),
      };
    }

    if (inspection === null) {
      return {
        ok: false,
        error: orchestrationError(
          "final_gate_evidence_stale",
          "The final summary needs a measured change set and none was taken, so its changed-files and plan-step sections would be empty rather than accurate.",
        ),
      };
    }

    if (inspection.fingerprint !== gate.result.fingerprint) {
      return {
        ok: false,
        error: orchestrationError(
          "final_gate_evidence_stale",
          `The working tree now fingerprints as ${inspection.fingerprint}, but the recorded final gate was decided against ${gate.result.fingerprint}. A summary written now would describe a tree the gate never certified, so none was written. Re-run the final gate and then the summary.`,
        ),
      };
    }

    const fixes = await this.#readFixHistory(session.featureId);

    if (!fixes.ok) {
      return { ok: false, error: fixes.error };
    }

    const approved = await this.#readApprovedScope(session);

    if (!approved.ok) {
      return { ok: false, error: approved.error };
    }

    const input: FinalSummaryInput = {
      featureId: session.featureId,
      title: session.title,
      revision: reader.nextRevision,
      fingerprint: inspection.fingerprint,
      spec: await this.#readOptionalArtifactContent(session.featureId, "spec"),
      plan: await this.#readOptionalArtifactContent(session.featureId, "plan"),
      gate: gate.result,
      security: await this.#readOptionalArtifactContent(
        session.featureId,
        SECURITY_REVIEW_ARTIFACT_NAME,
      ),
      fixes: fixes.entries,
      changes: inspection.changes,
      scope: {
        measured: scope?.measured ?? false,
        approvedPatterns: scope?.approvedPatterns ?? approved.patterns,
        unauthorizedPaths: scope?.unauthorizedPaths ?? [],
      },
    };

    return { ok: true, document: buildFinalSummary(input) };
  }

  /**
   * One artifact's parsed content, or null when it does not exist.
   *
   * Null rather than a refusal, because every artifact the summary reads is one the stage's context
   * plan already required to exist; this is the second read, not the first, and its job is to give the
   * renderer something to work with. A summary that states "not recorded" for a section is more honest
   * than a stage that refuses to run over a document the gate has already ruled on.
   */
  async #readOptionalArtifactContent(
    featureId: string,
    name: FeatureArtifactName,
  ): Promise<unknown> {
    const read = await this.#readOptionalArtifact(featureId, name);

    return read.ok ? read.value : null;
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
    const approvalVerified = isApprovalVerifiedStage(stage, session.approvals.plan !== null);

    if (!approvalVerified) {
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

    // Reached only for a stage that is approval-verified, which is what makes the root disqualifying.
    if (resolve(opened.workspace.workingDirectory) === this.#projectRoot) {
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
    measured: WorkspaceInspection | null = null,
  ): Promise<
    | { readonly ok: true; readonly evidence: WorkspaceScopeEvidence | null }
    | { readonly ok: false; readonly error: OrchestrationError; readonly evidence: WorkspaceScopeEvidence | null }
  > {
    if (this.#workspace === null) {
      return { ok: true, evidence: null };
    }

    // A caller that already inspected the tree for its own decision hands the reading over rather than
    // paying for a second one. It is the same reading either way: the provider is asked once, and both
    // decisions are made about that one tree, which is the property `WorkspaceInspection` exists for.
    const inspection =
      measured === null ? await this.#inspect(session, workspace, stage) : { ok: true as const, inspection: measured };

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

    // The security review is the one stage whose whole job is to look at changes it is not allowed to
    // make itself, so restoring them before anyone reads them would destroy the evidence it exists to
    // produce. Protected paths are therefore excluded from the set handed to the restore below when
    // this is the security review, and only then.
    //
    // This is deliberately not a widening of scope: it subtracts from what gets restored rather than
    // adding to what is allowed, and every other stage restores these paths exactly as before. The gate
    // is also not the only thing standing between a protected edit and a feature. Two others hold
    // independently of it, which is why this is a carve-out with a stated downside rather than an
    // opening: every stage other than this one refuses to write a protected path in the first place,
    // and the framework-owned `protected_configuration_changed` check is merged into the record after
    // the provider returns, so the edit still fails the stage. What this changes is only that the
    // failure arrives as a security finding naming the path, instead of a silent restore that leaves
    // the reviewer describing a clean tree.
    const protectedUnauthorized =
      stage === "security_review"
        ? verdict.unauthorized.filter((entry) =>
            SECURITY_PROTECTED_PATTERNS.some((pattern) => matchesScopePattern(entry.path, pattern)),
          )
        : [];
    const restorable = verdict.unauthorized.filter(
      (entry) => !protectedUnauthorized.some((held) => held.path === entry.path),
    );
    const enforced = await this.#restore(workspace, restorable, stage);

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

    if (protectedUnauthorized.length > 0) {
      return {
        ok: false,
        evidence: record,
        error: orchestrationError(
          "scope_violation",
          `Stage "${stage}" changed protected path(s): ${protectedUnauthorized.map((entry) => entry.path).join(", ")}. The security review exists to report exactly this, so the changes were left in place to be read rather than restored; the record names them, and the stage result was discarded. ${
            enforced.enforcement.restored.length > 0 || enforced.enforcement.removed.length > 0
              ? `The other unauthorized path(s) were returned to the approved baseline: ${[...enforced.enforcement.restored, ...enforced.enforcement.removed].join(", ")}.`
              : "No other unauthorized path(s) were present."
          } A protected configuration change is not made approvable by amending the plan; a human has to decide whether the edit should exist at all.`,
        ),
      };
    }

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

  /** Reads an artifact that is allowed to be absent, distinguishing absence from failure. */
  async #readOptionalArtifact(
    featureId: string,
    name: FeatureArtifactName,
  ): Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    try {
      return { ok: true, value: await this.#store.readArtifact(featureId, name) };
    } catch (error) {
      if (isArtifactMissing(error)) {
        return { ok: true, value: undefined };
      }

      return {
        ok: false,
        error: orchestrationError(
          "persistence_failed",
          `The "${name}" artifact could not be read while preparing the fix: ${describeError(error)}`,
        ),
      };
    }
  }

  /** The recorded fix history for a feature, or the failure to read it. */
  async #readFixHistory(
    featureId: string,
  ): Promise<
    | { readonly ok: true; readonly entries: readonly FixHistoryEntry[] }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    let raw: unknown;

    try {
      raw = await this.#store.readArtifact(featureId, "fixes");
    } catch (error) {
      if (isArtifactMissing(error)) {
        return { ok: true, entries: [] };
      }

      return {
        ok: false,
        error: orchestrationError(
          "persistence_failed",
          `The fix history could not be read while preparing a fix: ${describeError(error)}`,
        ),
      };
    }

    return parseFixHistory(raw);
  }

  /**
   * Hashes what a fix must leave alone, from the persisted artifacts rather than from the working tree.
   *
   * Persisted is the right source for every one of these. The spec and the plan are the approved
   * statements of what the feature is and what the work is, and they live in the session store rather
   * than in the repository, so reading them is what it means to check them: no working-tree path can
   * stand in for them, and a fixer that reached the repository to change one would have to change the
   * store through the session API, which is not a path it has.
   *
   * The verification digest comes from the evidence the failing stage's own run recorded, which is the
   * only place the command set the provider actually used is written down. Its absence is a null rather
   * than a failure: a review-stage fix has no deterministic surface, and refusing one for that would
   * break the loop this milestone is hardening rather than harden it.
   */
  async #measureFixIntegrity(
    session: FeatureSession,
    originStage: FixReturnState,
  ): Promise<
    | { readonly ok: true; readonly snapshot: FixIntegritySnapshot }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    const featureId = session.featureId;
    const stage = workStageForOrigin(originStage);

    // Read one at a time rather than as a batch, because each read is a condition on continuing and
    // there is no operation here that would be faster in parallel. A digest of three of the four
    // surfaces would be worse than no digest at all: it would compare equal on both sides while
    // describing less than it claims to, which is how a guard stops meaning anything.
    const spec = await this.#readArtifactDigest(featureId, "spec");

    if (!spec.ok) {
      return spec;
    }

    const plan = await this.#readArtifactDigest(featureId, "plan");

    if (!plan.ok) {
      return plan;
    }

    const planReview = await this.#readArtifactDigest(featureId, "plan_review");

    if (!planReview.ok) {
      return planReview;
    }

    const verification = await this.#readOptionalArtifact(featureId, "verification");

    if (!verification.ok) {
      return verification;
    }

    return {
      ok: true,
      snapshot: {
        specSha256: spec.digest,
        planSha256: plan.digest,
        planReviewSha256: planReview.digest,
        verificationConfigSha256:
          stage === null ? null : verificationConfigurationDigest(verification.value, stage),
      },
    };
  }

  /**
   * The digest of an approved artifact, computed exactly as the plan-approval check computes it.
   *
   * Reusing `digestArtifactText` over the artifact's own text rather than hashing the parsed value is
   * what makes these two mechanisms one mechanism instead of two that look alike. The approval record
   * holds digests of text, so a fix guard that digested parsed values would produce different digests
   * for identical content, and the two could not be compared, correlated, or explained side by side.
   */
  async #readArtifactDigest(
    featureId: string,
    name: FeatureArtifactName,
  ): Promise<
    | { readonly ok: true; readonly digest: string | null }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    try {
      return { ok: true, digest: digestArtifactText(await this.#store.readArtifactText(featureId, name)) };
    } catch (error) {
      if (isArtifactMissing(error)) {
        return { ok: true, digest: null };
      }

      return {
        ok: false,
        error: orchestrationError(
          "persistence_failed",
          `The "${name}" artifact could not be read while hashing what a fix must leave alone: ${describeError(error)}`,
        ),
      };
    }
  }

  /**
   * Builds the guard for the fix attempt about to run: the count, the frozen digests, and the contract.
   *
   * The attempt number comes from the durable history rather than from the session, because the session
   * only knows the current state and a fix loop that failed four times looks identical to one about to
   * try. Counting the recorded entries is what makes the limit mean what it says across process
   * restarts and across every stage that has sent the workflow here.
   */
  async #prepareFix(session: FeatureSession, originStage: FixReturnState): Promise<FixPreparation> {
    const featureId = session.featureId;
    const history = await this.#readFixHistory(featureId);

    if (!history.ok) {
      return history;
    }

    const attempt = nextFixAttempt(history.entries, originStage);
    const stage = workStageForOrigin(originStage);

    const before = await this.#measureFixIntegrity(session, originStage);

    if (!before.ok) {
      return before;
    }

    const scope = await this.#readApprovedScope(session);

    if (!scope.ok) {
      return scope;
    }

    const trigger = await this.#readOptionalArtifact(featureId, fixTriggerArtifact(originStage));

    if (!trigger.ok) {
      return trigger;
    }

    const artifact = trigger.value;
    const target = stage === null ? null : failureTargetFrom(artifact, stage);
    const evidence = stage === null ? null : latestRecordedEvidence(artifact, stage);
    // For a fix loop triggered by the security gate, this is the record that decided the failure, and
    // `evidence` is null for the same reason `security` is null everywhere else: the two artifacts are
    // written by different stages and a loop has exactly one origin. Reading both would mean the fixer
    // was handed two records and had to guess which one the stage had actually failed on.
    const security =
      workStageForOrigin(originStage) === "security_review" ? latestRecordedSecurityReview(artifact) : null;

    const contract: FixerInputContract = {
      featureId,
      failedStage: originStage,
      failedVerification: verificationForOrigin(originStage),
      target,
      deterministicEvidence: evidence,
      securityEvidence: security,
      failureReason: failureReasonFrom(originStage, evidence, target, security),
      suspectedFiles: stage === null ? [] : suspectedFilesFrom(artifact, stage, security),
      approvedScope: scope.patterns,
      revision: session.revision,
      implementationFingerprint: evidence?.implementationFingerprint ?? null,
      attempt,
      maxAttempts: this.#maxFixAttempts,
      protectedPaths: FIX_PROTECTED_PATTERNS,
    };

    return {
      ok: true,
      guard: {
        originStage,
        attempt,
        maxAttempts: this.#maxFixAttempts,
        allowed: attempt <= this.#maxFixAttempts,
        contract,
        before: before.snapshot,
      },
    };
  }

  /**
   * Records the attempt, fails the feature, and reports why — in that order and in one mutation.
   *
   * The record is written first because it is the part a human needs and the part that is lost the
   * moment the feature is failed. The workspace is not touched: the rejection is the finding, and a
   * framework that restored the files would be deleting it while explaining that it kept it.
   *
   * The entry is written with an explicit origin rather than read from the session, because the `fail`
   * event clears the recorded return state in the same commit and the history has to say which stage
   * the refused loop was repairing.
   */
  async #escalateFix(
    session: FeatureSession,
    extras: ResultExtras,
    guard: FixGuard,
    measurement: FixMeasurement | null,
    error: OrchestrationError,
    rejectionCodes: readonly FixRejectionCode[] = [],
  ): Promise<OrchestrationResult> {
    const changedPaths = measurement?.changedPaths ?? [];
    const summary = `${error.message} (${JSON.stringify({
      attempt: guard.attempt,
      ofMax: guard.maxAttempts,
      originStage: guard.originStage,
      changedPaths,
      rejectionCodes,
    })})`;

    return this.#commit({
      featureId: session.featureId,
      session,
      event: "fail",
      successStatus: "feature_failed",
      extras: {
        ...extras,
        error: { ...error, message: summary },
        fix: {
          originStage: guard.originStage,
          attempt: guard.attempt,
          maxAttempts: guard.maxAttempts,
          outcome: "rejected",
          changedPaths,
          rejectionCodes,
        },
      },
      prepare: async (reader) => {
        const appended = await appendFixHistoryEntry(reader, {
          attempt: guard.attempt,
          fixReturnState: guard.originStage,
          outcome: "rejected",
          failureSummary: summary,
          revisionBefore: reader.session.revision,
          implementationFingerprint: guard.contract.implementationFingerprint,
          changedPaths,
          integrity: measurement?.after ?? guard.before,
          report: null,
        });

        if (!appended.ok) {
          throw new StageFinalizeError(appended.error);
        }

        return { artifacts: [{ name: "fixes", content: appended.document }] };
      },
    });
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

    // Binding proves the bundle belongs to this revision. It cannot prove the run happened after the
    // last fix, because a provider that cached one bundle and restamped it would produce a bundle that
    // binds correctly and is older than the fix. This stage exists to re-test a repair, so evidence
    // gathered before that repair cannot decide whether it worked — and a stage that accepted it would
    // report the repair as verified by the failure it was supposed to fix.
    const history = await this.#readFixHistory(session.featureId);

    if (!history.ok) {
      return { ok: false, error: history.error };
    }

    const lastFix = latestFixEntry(history.entries, stage);

    if (lastFix !== null) {
      const stale = staleVerificationEvidence(bound.bundle, lastFix);

      if (stale !== null) {
        return { ok: false, error: stale };
      }
    }

    return { ok: true, bundle: bound.bundle };
  }

  /**
   * Asks the deterministic security provider for this stage's record and refuses one it cannot verify.
   *
   * The shape of this is the verification provider's, and deliberately so: there is no fallback path,
   * because a security review reached without a provider is a stage whose only evidence is a model's
   * description of a scan nobody performed. A provider failure, a malformed record, a record that
   * contradicts its own checks, and a well-formed record for a different tree are all the same answer,
   * which is no.
   *
   * Four things happen after the provider returns, in this order, and the order is the point:
   *
   * 1. It is validated, so a corrupt or self-contradictory record never reaches the executor.
   * 2. It is bound to this request — revision, root, workspace, change-set fingerprint, and the exact
   *    path list — so a record about some other tree cannot be applied to this one.
   * 3. The framework's own two change-shaped checks are merged in. They are computed here, from the
   *    change set the workspace provider just measured, and they are not negotiable by anything the
   *    provider said. This is why a protected-path change is a failure even if a provider declared
   *    every one of its own checks passed.
   * 4. Freshness against the last recorded fix is checked, so a cached answer restamped with the
   *    current revision cannot decide whether a repair worked.
   *
   * The change set is measured here rather than reused from a later inspection because the review has
   * to describe the tree the stage is about to read, and the stage has not run yet: taking a reading
   * after the model has had the files would be a review of what the model did rather than of what it
   * was asked to do.
   */
  async #collectSecurityReview(
    session: FeatureSession,
    stage: WorkStage,
    workspace: ProjectWorkspace,
  ): Promise<
    | { readonly ok: true; readonly evidence: SecurityReviewEvidence | null }
    | { readonly ok: false; readonly error: OrchestrationError }
  > {
    if (stage !== "security_review") {
      return { ok: true, evidence: null };
    }

    if (this.#security === null) {
      return {
        ok: false,
        error: orchestrationError(
          "security_not_configured",
          `The "${stage}" stage requires a security review provider and none is configured, so there is no deterministic record of the change to review. It is refused rather than passed on the reviewer's word.`,
        ),
      };
    }

    const inspected = await this.#inspect(session, workspace, stage);

    if (!inspected.ok) {
      return {
        ok: false,
        error: orchestrationError(
          "workspace_unavailable",
          `The change set to review could not be measured for stage "${stage}": ${inspected.message}`,
        ),
      };
    }

    const scope = await this.#readApprovedScope(session);

    if (!scope.ok) {
      return { ok: false, error: scope.error };
    }

    // The previously recorded review is read so the provider can tell a new finding from one that
    // survived a fix, and so the record itself can be read as a series rather than a single answer.
    // An absent artifact is the ordinary first-run case, not an error.
    const previous = await this.#readOptionalArtifact(session.featureId, SECURITY_REVIEW_ARTIFACT_NAME);

    if (!previous.ok) {
      return { ok: false, error: previous.error };
    }

    const request: SecurityReviewRequest = {
      featureId: session.featureId,
      stage,
      revision: session.revision,
      projectRoot: workspace.workingDirectory,
      workspaceId: workspace.workspaceId,
      changes: inspected.inspection.changes,
      changedPaths: approvedPathsOf(inspected.inspection.changes),
      approvedPatterns: scope.patterns,
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
      workspaceFingerprint: inspected.inspection.fingerprint,
      previousReview: latestRecordedSecurityReview(previous.value),
    };

    let raw: unknown;

    try {
      raw = await this.#security.review(request);
    } catch (error) {
      return {
        ok: false,
        error: orchestrationError(
          "security_provider_failed",
          `The security review provider failed for stage "${stage}": ${describeError(error)}`,
        ),
      };
    }

    const validated = validateSecurityReviewEvidence(raw);

    if (!validated.ok) {
      return { ok: false, error: orchestrationError(validated.code, validated.message) };
    }

    const bound = bindSecurityReviewToRequest(validated.evidence, request);

    if (!bound.ok) {
      return { ok: false, error: orchestrationError(bound.code, bound.message) };
    }

    const merged = mergeSecurityPolicyChecks(
      bound.evidence,
      applySecurityPolicy({
        changes: inspected.inspection.changes,
        approvedPatterns: scope.patterns,
        protectedPatterns: SECURITY_PROTECTED_PATTERNS,
      }),
    );

    const history = await this.#readFixHistory(session.featureId);

    if (!history.ok) {
      return { ok: false, error: history.error };
    }

    const lastFix = latestFixEntry(history.entries, stage);

    if (lastFix !== null) {
      const stale = staleSecurityReview(merged, lastFix);

      if (stale !== null) {
        return { ok: false, error: stale };
      }
    }

    return { ok: true, evidence: merged };
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

  /**
   * Reads everything the final gate decides from, and asks it.
   *
   * This is the only place in the framework that decides whether a feature may be summarized, and it
   * is deliberately the only one that does no work of its own: every input is read from an artifact the
   * framework already wrote, or measured from the tree the gate is standing in. Nothing is re-run. That
   * restriction is what makes the gate's answer worth having — a fourth verification stage would have
   * none of the freshness guarantees the first three have, and a gate that re-ran the tests it is
   * judging would be able to overwrite the record it exists to check.
   *
   * The one exception is the scope measurement, which is taken fresh rather than read, because no
   * artifact holds it: `scope_review` writes a model's document, and the framework's own scope evidence
   * lives on the stage result rather than in the store. Measuring it here is also what makes "the tree
   * moved since the last check" a finding the gate can report instead of one nobody looks for.
   *
   * Every read is sequential because each is a condition on the next, and the persistence failures are
   * returned rather than folded into a verdict: a store that cannot be read is an operational problem,
   * not evidence that the feature is unready, and calling it the second would send a feature back for
   * work it does not need.
   */
  async #evaluateFinalGate(
    session: FeatureSession,
    stage: WorkStage,
    workspace: ProjectWorkspace,
    baseline: WorkspaceBaseline | null,
  ): Promise<FinalGateOutcome> {
    const featureId = session.featureId;

    const spec = await this.#readOptionalArtifact(featureId, "spec");

    if (!spec.ok) {
      return spec;
    }

    const verification = await this.#readOptionalArtifact(featureId, VERIFICATION_ARTIFACT_NAME);

    if (!verification.ok) {
      return verification;
    }

    const security = await this.#readOptionalArtifact(featureId, SECURITY_REVIEW_ARTIFACT_NAME);

    if (!security.ok) {
      return security;
    }

    const fixes = await this.#readFixHistory(featureId);

    if (!fixes.ok) {
      return fixes;
    }

    const approved = await this.#readApprovedScope(session);

    if (!approved.ok) {
      return approved;
    }

    const stages: FinalGateVerificationInput[] = [];

    for (const workStage of VERIFICATION_WORK_STAGES) {
      const verificationStage = VERIFICATION_STAGE_BY_WORK_STAGE[workStage];

      if (verificationStage === undefined) {
        continue;
      }

      const entry = latestFixEntry(fixes.entries, workStage);

      stages.push({
        stage: workStage,
        verification: verificationStage,
        bundle: latestRecordedEvidence(verification.value, workStage),
        fix: finalGateFixInput(entry, this.#maxFixAttempts),
        configurationChanged: verificationConfigurationChanged(verification.value, workStage, entry),
        claims: criterionClaimsFrom(verification.value, workStage),
      });
    }

    const scope = await this.#measureFinalGateScope(session, stage, workspace, baseline, approved.patterns);
    const securityEvidence = latestRecordedSecurityReview(security.value);

    return {
      ok: true,
      result: evaluateFinalGate({
        featureId,
        state: session.machine.state,
        revision: session.revision,
        fingerprint: scope.fingerprint ?? "",
        criteria: criteriaFromSpec(spec.value),
        verification: stages,
        security: {
          evidence: securityEvidence,
          fix: finalGateFixInput(latestFixEntry(fixes.entries, "security_review"), this.#maxFixAttempts),
        },
        scope,
        // The approval freeze was re-verified in `#runStage` before this method was reached, and a
        // missing or invalidated approval was refused there rather than passed on. The gate still
        // takes the fact as an input rather than assuming it, so that a caller assembling the input
        // itself — and so that the check is a fact about the input instead of a fact about this
        // method's position in the call chain.
        approval: {
          status: "intact",
          reason: "The plan-approval digests were re-verified against the persisted artifacts before this stage ran.",
        },
        fix: {
          attempts: fixes.entries.length,
          latest: finalGateFixInput(fixes.entries.at(-1) ?? null, this.#maxFixAttempts),
        },
      }),
    };
  }

  /**
   * The framework's own scope measurement, taken while the gate runs.
   *
   * Read-only on purpose, and that is the difference from `#enforceScope`: enforcement restores the
   * paths nobody approved, which is right for a stage that is about to write and wrong for a gate that
   * is about to refuse. A gate that deleted the evidence of a scope violation while explaining it
   * would leave the next run with nothing to find. So the paths are named in the result instead.
   */
  async #measureFinalGateScope(
    session: FeatureSession,
    stage: WorkStage,
    workspace: ProjectWorkspace,
    baseline: WorkspaceBaseline | null,
    approvedPatterns: readonly string[],
  ): Promise<FinalGateScopeInput> {
    const inspection = await this.#inspect(session, workspace, stage);

    if (!inspection.ok) {
      return {
        basis: "unmeasurable",
        insideApprovedScope: false,
        integrityOk: false,
        fingerprint: null,
        unauthorizedPaths: [],
        reason: inspection.message,
      };
    }

    // No adapter means the stages ran in the human's own checkout, where the framework writes nothing
    // of its own and therefore has no change set that could be outside the approved scope. This is a
    // supported configuration rather than a finding, so it does not block.
    if (this.#workspace === null) {
      return {
        basis: "not_measured",
        insideApprovedScope: true,
        integrityOk: true,
        fingerprint: inspection.inspection.fingerprint,
        unauthorizedPaths: [],
        reason:
          "No isolated-workspace adapter is configured, so the framework has no change set of its own to judge against the approved scope.",
      };
    }

    if (baseline === null) {
      return {
        basis: "unmeasurable",
        insideApprovedScope: false,
        integrityOk: false,
        fingerprint: inspection.inspection.fingerprint,
        unauthorizedPaths: [],
        reason:
          "The workspace has no captured baseline, so no later comparison describes the approved starting point.",
      };
    }

    const integrity = evaluateWorkspaceIntegrity(inspection.inspection, baseline);
    const verdict = evaluateWorkspaceScope(inspection.inspection, { approvedPatterns });

    return {
      basis: "measured",
      insideApprovedScope: verdict.ok,
      integrityOk: integrity.ok,
      fingerprint: inspection.inspection.fingerprint,
      unauthorizedPaths: verdict.ok ? [] : verdict.unauthorized.map((entry) => entry.path),
      reason: !integrity.ok
        ? integrity.reason
        : verdict.ok
          ? `The change set is fingerprinted ${inspection.inspection.fingerprint} and touches nothing the approved plan does not describe.`
          : `The change set touches ${String(verdict.unauthorized.length)} path(s) the approved plan does not describe.`,
    };
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
    fix: FixAttemptContext | null = null,
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

      // Every field of the entry is the framework's, so a missing one is a bug in the framework and not
      // a missing input to be defaulted. An entry assembled from stand-ins — attempt one, no changed
      // paths, no integrity digests — would read in the history exactly like a real first attempt that
      // changed nothing, and the one record a human relies on after a repair is the record that would
      // be fabricated. Refusing to write it is the only outcome that stays honest.
      if (fix === null) {
        return {
          ok: false,
          error: orchestrationError(
            "inconsistent_fix_state",
            `Stage "${stage}" reported a fix report but the orchestrator has no measured attempt to attach it to, so nothing was written. A fix history entry is assembled by the framework alone and is never defaulted into existence.`,
          ),
        };
      }

      // The fixer's own output is the `report` field of an entry the framework writes. The attempt
      // number, the revisions, the changed paths, the integrity digests, and the outcome are the
      // framework's, and a fixer cannot supply any of them: it has no slot for them, no way to compute
      // them, and no reason to be believed about them. The report is kept because a human reading the
      // history wants to know what was attempted, and it is stored as a claim rather than as the
      // finding, because that is what it is.
      const appended = await appendFixHistoryEntry(reader, {
        attempt: fix.attempt,
        fixReturnState,
        outcome: fix.outcome,
        failureSummary: fix.failureSummary,
        revisionBefore: reader.session.revision,
        implementationFingerprint: fix.implementationFingerprint,
        changedPaths: fix.changedPaths,
        integrity: fix.integrity,
        report: content,
      });

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
