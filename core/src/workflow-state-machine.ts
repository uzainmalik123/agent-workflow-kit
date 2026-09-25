import { WorkflowState } from "./workflow-state.js";

export type WorkflowEvent =
  | "advance"
  | "request_fix"
  | "complete_fix"
  | "fail"
  | "approve_plan"
  | "approve_push";

export type FixReturnState =
  | WorkflowState.PlanReview
  | WorkflowState.CodeReview
  | WorkflowState.ScopeReview
  | WorkflowState.StaticVerification
  | WorkflowState.TestVerification
  | WorkflowState.RuntimeVerification
  | WorkflowState.SecurityReview;

export type TransitionErrorCode = "illegal_transition" | "terminal_state";

export interface TransitionError {
  readonly ok: false;
  readonly code: TransitionErrorCode;
  readonly state: WorkflowState;
  readonly event: WorkflowEvent;
  readonly message: string;
}

export type TransitionResult =
  | {
      readonly ok: true;
      readonly state: WorkflowState;
    }
  | TransitionError;

const nextStateByAdvance: Partial<Record<WorkflowState, WorkflowState>> = {
  [WorkflowState.Draft]: WorkflowState.Grilling,
  [WorkflowState.Grilling]: WorkflowState.SpecReady,
  [WorkflowState.SpecReady]: WorkflowState.Planning,
  [WorkflowState.Planning]: WorkflowState.PlanReview,
  [WorkflowState.PlanReview]: WorkflowState.AwaitingPlanApproval,
  [WorkflowState.Implementing]: WorkflowState.CodeReview,
  [WorkflowState.CodeReview]: WorkflowState.ScopeReview,
  [WorkflowState.ScopeReview]: WorkflowState.StaticVerification,
  [WorkflowState.StaticVerification]: WorkflowState.TestVerification,
  [WorkflowState.TestVerification]: WorkflowState.RuntimeVerification,
  [WorkflowState.RuntimeVerification]: WorkflowState.SecurityReview,
  [WorkflowState.SecurityReview]: WorkflowState.FinalGate,
  [WorkflowState.FinalGate]: WorkflowState.FinalSummary,
  [WorkflowState.FinalSummary]: WorkflowState.AwaitingPushApproval,
  [WorkflowState.Committing]: WorkflowState.Pushing,
  [WorkflowState.Pushing]: WorkflowState.Complete,
};

const fixReturnStateValues = [
  WorkflowState.PlanReview,
  WorkflowState.CodeReview,
  WorkflowState.ScopeReview,
  WorkflowState.StaticVerification,
  WorkflowState.TestVerification,
  WorkflowState.RuntimeVerification,
  WorkflowState.SecurityReview,
] as const satisfies readonly FixReturnState[];

const terminalFailureStates: ReadonlySet<WorkflowState> = new Set([
  WorkflowState.Draft,
  WorkflowState.Grilling,
  WorkflowState.SpecReady,
  WorkflowState.Planning,
  WorkflowState.PlanReview,
  WorkflowState.AwaitingPlanApproval,
  WorkflowState.Implementing,
  WorkflowState.CodeReview,
  WorkflowState.ScopeReview,
  WorkflowState.StaticVerification,
  WorkflowState.TestVerification,
  WorkflowState.RuntimeVerification,
  WorkflowState.Fixing,
  WorkflowState.SecurityReview,
  WorkflowState.FinalGate,
  WorkflowState.FinalSummary,
  WorkflowState.AwaitingPushApproval,
  WorkflowState.Committing,
  WorkflowState.Pushing,
]);

function isFixReturnState(state: WorkflowState): state is FixReturnState {
  return fixReturnStateValues.some((candidate) => candidate === state);
}

function transitionSucceeded(state: WorkflowState): TransitionResult {
  return { ok: true, state };
}

function illegalTransition(state: WorkflowState, event: WorkflowEvent): TransitionResult {
  return {
    ok: false,
    code: "illegal_transition",
    state,
    event,
    message: `Event "${event}" is not legal in state "${state}".`,
  };
}

function terminalStateError(state: WorkflowState, event: WorkflowEvent): TransitionResult {
  return {
    ok: false,
    code: "terminal_state",
    state,
    event,
    message: `State "${state}" is terminal and cannot process event "${event}".`,
  };
}

export class WorkflowStateMachine {
  #state = WorkflowState.Draft;
  #fixReturnState: FixReturnState | undefined;

  get state(): WorkflowState {
    return this.#state;
  }

  transition(event: WorkflowEvent): TransitionResult {
    const currentState = this.#state;

    if (currentState === WorkflowState.Complete || currentState === WorkflowState.Failed) {
      return terminalStateError(currentState, event);
    }

    if (event === "fail") {
      if (!terminalFailureStates.has(currentState)) {
        return illegalTransition(currentState, event);
      }

      this.#state = WorkflowState.Failed;
      this.#fixReturnState = undefined;
      return transitionSucceeded(this.#state);
    }

    if (event === "request_fix") {
      if (!isFixReturnState(currentState)) {
        return illegalTransition(currentState, event);
      }

      this.#fixReturnState = currentState;
      this.#state = WorkflowState.Fixing;
      return transitionSucceeded(this.#state);
    }

    if (event === "complete_fix") {
      const returnState = this.#fixReturnState;

      if (currentState !== WorkflowState.Fixing || returnState === undefined) {
        return illegalTransition(currentState, event);
      }

      this.#state = returnState;
      this.#fixReturnState = undefined;
      return transitionSucceeded(this.#state);
    }

    if (event === "approve_plan") {
      if (currentState !== WorkflowState.AwaitingPlanApproval) {
        return illegalTransition(currentState, event);
      }

      this.#state = WorkflowState.Implementing;
      return transitionSucceeded(this.#state);
    }

    if (event === "approve_push") {
      if (currentState !== WorkflowState.AwaitingPushApproval) {
        return illegalTransition(currentState, event);
      }

      this.#state = WorkflowState.Committing;
      return transitionSucceeded(this.#state);
    }

    const nextState = nextStateByAdvance[currentState];

    if (nextState === undefined) {
      return illegalTransition(currentState, event);
    }

    this.#state = nextState;
    return transitionSucceeded(this.#state);
  }
}
