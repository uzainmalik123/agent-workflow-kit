import {
  WorkflowStateMachine,
  type WorkflowEvent,
  type WorkflowMachineSnapshot,
  type WorkflowState,
} from "@agent-workflow-kit/core";
import {
  FEATURE_ARTIFACT_FILENAMES,
  PersistenceError,
  type FeatureArtifactName,
  type FeatureSession,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { describeError, orchestrationError, type OrchestrationError } from "./errors.js";
import type {
  StageArtifactContext,
  StageArtifactOutput,
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

type PersistOutcome =
  | {
      readonly ok: true;
      readonly session: FeatureSession;
      readonly artifacts: readonly FeatureArtifactName[];
    }
  | { readonly ok: false; readonly result: OrchestrationResult };

function isArtifactMissing(error: unknown): boolean {
  return error instanceof PersistenceError && error.code === "ARTIFACT_NOT_FOUND";
}

function snapshotsMatch(
  left: WorkflowMachineSnapshot,
  right: WorkflowMachineSnapshot,
): boolean {
  return left.state === right.state && left.fixReturnState === right.fixReturnState;
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
      return this.#applyEvent(featureId, session, "advance", "advanced", base);
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
    return this.#applyGate(featureId, "approve_plan", "gate_approved");
  }

  async approvePush(featureId: string): Promise<OrchestrationResult> {
    return this.#applyGate(featureId, "approve_push", "gate_approved");
  }

  async failFeature(featureId: string): Promise<OrchestrationResult> {
    return this.#applyGate(featureId, "fail", "feature_failed");
  }

  async #applyGate(
    featureId: string,
    event: "approve_plan" | "approve_push" | "fail",
    status: OrchestrationStatus,
  ): Promise<OrchestrationResult> {
    const session = await this.#store.load(featureId);
    const base: ResultExtras = { featureId, fromState: session.machine.state };

    return this.#applyEvent(featureId, session, event, status, base);
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

    let current: FeatureSession;

    try {
      current = await this.#store.load(featureId);
    } catch (error) {
      return this.#result({
        ...reported,
        status: "persistence_error",
        state: fromState,
        error: orchestrationError(
          "persistence_failed",
          `Unable to reload the authoritative session: ${describeError(error)}`,
        ),
      });
    }

    if (!snapshotsMatch(current.machine, session.machine)) {
      return this.#result({
        ...reported,
        status: "rejected",
        state: current.machine.state,
        error: orchestrationError(
          "state_conflict",
          `The session moved to "${current.machine.state}" while stage "${stage}" was executing.`,
        ),
      });
    }

    const persisted = await this.#persistArtifacts(featureId, current, stage, outcome.artifacts, reported);

    if (!persisted.ok) {
      return persisted.result;
    }

    if (outcome.outcome === "inconclusive") {
      return this.#result({
        ...reported,
        status: "inconclusive",
        state: fromState,
        artifacts: persisted.artifacts,
      });
    }

    return this.#applyEvent(
      featureId,
      persisted.session,
      outcome.outcome === "needs_fix" ? "request_fix" : definition.successEvent,
      outcome.outcome === "needs_fix" ? "fix_requested" : "stage_completed",
      { ...reported, artifacts: persisted.artifacts },
    );
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

  async #persistArtifacts(
    featureId: string,
    session: FeatureSession,
    stage: WorkStage,
    artifacts: readonly StageArtifactOutput[],
    extra: ResultExtras,
  ): Promise<PersistOutcome> {
    let current = session;
    const persisted: FeatureArtifactName[] = [];

    for (const artifact of artifacts) {
      const composed = await this.#composeArtifactContent(
        featureId,
        stage,
        artifact.name,
        artifact.content,
      );

      if (!composed.ok) {
        return {
          ok: false,
          result: this.#result({
            ...extra,
            status: "rejected",
            state: current.machine.state,
            artifacts: persisted,
            error: composed.error,
          }),
        };
      }

      try {
        current = await this.#store.writeArtifact(featureId, artifact.name, composed.content);
      } catch (error) {
        return {
          ok: false,
          result: this.#result({
            ...extra,
            status: "persistence_error",
            state: current.machine.state,
            artifacts: persisted,
            error: orchestrationError(
              "persistence_failed",
              `Unable to persist artifact "${artifact.name}": ${describeError(error)}`,
            ),
          }),
        };
      }

      persisted.push(artifact.name);
    }

    return { ok: true, session: current, artifacts: persisted };
  }

  async #composeArtifactContent(
    featureId: string,
    stage: WorkStage,
    name: FeatureArtifactName,
    content: unknown,
  ): Promise<ComposeOutcome> {
    const spec = outputSpecFor(stage, name);

    if (spec.envelopeKey === null) {
      return { ok: true, content };
    }

    let existing: unknown;

    try {
      existing = await this.#store.readArtifact(featureId, name);
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
      return { ok: true, content: { [spec.envelopeKey]: content } };
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

    return { ok: true, content: { ...existing, [spec.envelopeKey]: content } };
  }

  async #applyEvent(
    featureId: string,
    session: FeatureSession,
    event: WorkflowEvent,
    successStatus: OrchestrationStatus,
    extra: ResultExtras,
  ): Promise<OrchestrationResult> {
    const fromState = session.machine.state;
    const machine = new WorkflowStateMachine(session.machine);
    const preview = machine.transition(event);

    if (!preview.ok) {
      return this.#result({
        ...extra,
        status: "rejected",
        state: fromState,
        event,
        error: orchestrationError("illegal_transition", preview.message),
      });
    }

    const expected = machine.snapshot;

    try {
      const applied = await this.#store.transition(featureId, event);

      if (!applied.ok) {
        return this.#result({
          ...extra,
          status: "rejected",
          state: fromState,
          event,
          error: orchestrationError("illegal_transition", applied.message),
        });
      }
    } catch (error) {
      return this.#recoverTransition(featureId, fromState, expected, event, error, extra);
    }

    return this.#result({
      ...extra,
      status: successStatus,
      state: expected.state,
      fixReturnState: expected.fixReturnState ?? null,
      committed: true,
      event,
    });
  }

  async #recoverTransition(
    featureId: string,
    fromState: WorkflowState,
    expected: WorkflowMachineSnapshot,
    event: WorkflowEvent,
    failure: unknown,
    extra: ResultExtras,
  ): Promise<OrchestrationResult> {
    let observed: FeatureSession;

    try {
      observed = await this.#store.load(featureId);
    } catch (error) {
      return this.#result({
        ...extra,
        status: "persistence_error",
        state: fromState,
        event,
        error: orchestrationError(
          "persistence_verification_failed",
          `Transition "${event}" failed (${describeError(failure)}) and the session could not be reloaded: ${describeError(error)}`,
        ),
      });
    }

    const committed = snapshotsMatch(observed.machine, expected);

    return this.#result({
      ...extra,
      status: "persistence_error",
      state: observed.machine.state,
      event,
      committed,
      error: orchestrationError(
        committed ? "persistence_transition_committed" : "persistence_transition_not_committed",
        committed
          ? `Transition "${event}" committed before reporting failed; the session is now in "${observed.machine.state}" and the event was not retried.`
          : `Transition "${event}" did not commit; the session remains in "${observed.machine.state}".`,
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
