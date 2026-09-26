import {
  WorkflowStateMachine,
  type WorkflowEvent,
  type WorkflowMachineSnapshot,
  type WorkflowState,
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
import { buildPlanApproval, verifyPlanApproval } from "./approval.js";
import { describeError, orchestrationError, type OrchestrationError } from "./errors.js";
import { appendFixHistoryEntry } from "./fix-history.js";
import type {
  StageArtifactContext,
  StageExecutionRequest,
  StageExecutor,
} from "./executor.js";
import {
  buildOrchestrationResult,
  type OrchestrationResult,
  type OrchestrationResultInput,
  type OrchestrationStatus,
} from "./result.js";
import { isRecord, validateStageExecutionResult } from "./result-validation.js";
import {
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

export interface CreateFeatureInput {
  readonly featureId: string;
  readonly title: string;
  readonly request?: string;
  readonly slug?: string;
}

export interface WorkflowOrchestratorOptions {
  readonly store: FeatureSessionStore;
  readonly executor: StageExecutor;
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

  constructor(options: WorkflowOrchestratorOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
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
    return this.#applyGate(featureId, "approve_plan", "gate_approved", true);
  }

  async approvePush(featureId: string): Promise<OrchestrationResult> {
    return this.#applyGate(featureId, "approve_push", "gate_approved", false);
  }

  async failFeature(featureId: string): Promise<OrchestrationResult> {
    return this.#applyGate(featureId, "fail", "feature_failed", false);
  }

  async #applyGate(
    featureId: string,
    event: "approve_plan" | "approve_push" | "fail",
    status: OrchestrationStatus,
    freezePlan: boolean,
  ): Promise<OrchestrationResult> {
    const session = await this.#store.load(featureId);
    const base: ResultExtras = { featureId, fromState: session.machine.state };

    return this.#commit({
      featureId,
      session,
      event,
      successStatus: status,
      extras: base,
      ...(!freezePlan
        ? {}
        : {
            prepare: async (reader: FeatureMutationReader) => {
              const approval = await buildPlanApproval(reader);

              if (!approval.ok) {
                throw new StageFinalizeError(approval.error);
              }

              const approvals: FeatureApprovals = { plan: approval.record };
              return { approvals };
            },
          }),
    });
  }

  async #runStage(session: FeatureSession, stage: WorkStage): Promise<OrchestrationResult> {
    const featureId = session.featureId;
    const fromState = session.machine.state;
    const definition = STAGE_DEFINITIONS[stage];
    const base: ResultExtras = {
      featureId,
      fromState,
      stage,
      role: definition.role,
      executedStages: [stage],
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
    };

    let raw: unknown;

    try {
      raw = await this.#executor.execute(request);
    } catch (error) {
      return this.#result({
        ...base,
        status: "executor_error",
        state: fromState,
        error: orchestrationError(
          "executor_threw",
          `Stage executor threw: ${describeError(error)}`,
        ),
      });
    }

    const validation = validateStageExecutionResult(raw, request);

    if (!validation.ok) {
      return this.#result({
        ...base,
        status: "rejected",
        state: fromState,
        error: orchestrationError(validation.code, validation.message),
      });
    }

    const outcome = validation.result;
    const reported: ResultExtras = { ...base, findings: outcome.findings, evidence: outcome.evidence };

    if (outcome.outcome === "failed") {
      return this.#result({
        ...reported,
        status: "stage_failed",
        state: fromState,
        error: orchestrationError(
          "stage_reported_failure",
          `Stage "${stage}" reported failure: ${outcome.summary ?? "no summary was provided"}.`,
        ),
      });
    }

    // Finalization is the only mutation a stage result can cause. It runs without any lock held
    // while the executor works, and the store re-checks the revision inside the lock, so a stale
    // result can neither write its artifacts nor apply its event to a later state.
    return this.#commit({
      featureId,
      session,
      ...(outcome.outcome === "inconclusive"
        ? {}
        : { event: outcome.outcome === "needs_fix" ? "request_fix" : definition.successEvent }),
      successStatus:
        outcome.outcome === "needs_fix"
          ? "fix_requested"
          : outcome.outcome === "inconclusive"
            ? "inconclusive"
            : "stage_completed",
      extras: reported,
      prepare: async (reader) => {
        const reverified = await verifyPlanApproval(reader, stage, fromState);

        if (!reverified.ok) {
          throw new StageFinalizeError(reverified.error);
        }

        const artifacts: FeatureArtifactWrite[] = [];

        for (const artifact of outcome.artifacts) {
          const composed = await this.#composeArtifactContent(
            reader,
            stage,
            artifact.name,
            artifact.content,
          );

          if (!composed.ok) {
            throw new StageFinalizeError(composed.error);
          }

          artifacts.push({ name: artifact.name, content: composed.content });
        }

        return { artifacts };
      },
    });
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
