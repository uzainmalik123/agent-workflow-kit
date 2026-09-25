import {
  WorkflowState,
  WorkflowStateMachine,
  type FixReturnState,
  type WorkflowEvent,
  type WorkflowMachineSnapshot,
} from "@agent-workflow-kit/core";
import { describe, expect, it } from "vitest";

const successTransitions = [
  [WorkflowState.Draft, "advance", WorkflowState.Grilling],
  [WorkflowState.Grilling, "advance", WorkflowState.SpecReady],
  [WorkflowState.SpecReady, "advance", WorkflowState.Planning],
  [WorkflowState.Planning, "advance", WorkflowState.PlanReview],
  [WorkflowState.PlanReview, "advance", WorkflowState.AwaitingPlanApproval],
  [WorkflowState.AwaitingPlanApproval, "approve_plan", WorkflowState.Implementing],
  [WorkflowState.Implementing, "advance", WorkflowState.CodeReview],
  [WorkflowState.CodeReview, "advance", WorkflowState.ScopeReview],
  [WorkflowState.ScopeReview, "advance", WorkflowState.StaticVerification],
  [WorkflowState.StaticVerification, "advance", WorkflowState.TestVerification],
  [WorkflowState.TestVerification, "advance", WorkflowState.RuntimeVerification],
  [WorkflowState.RuntimeVerification, "advance", WorkflowState.SecurityReview],
  [WorkflowState.SecurityReview, "advance", WorkflowState.FinalGate],
  [WorkflowState.FinalGate, "advance", WorkflowState.FinalSummary],
  [WorkflowState.FinalSummary, "advance", WorkflowState.AwaitingPushApproval],
  [WorkflowState.AwaitingPushApproval, "approve_push", WorkflowState.Committing],
  [WorkflowState.Committing, "advance", WorkflowState.Pushing],
  [WorkflowState.Pushing, "advance", WorkflowState.Complete],
] as const satisfies readonly (readonly [WorkflowState, WorkflowEvent, WorkflowState])[];

const workflowEvents = [
  "advance",
  "request_fix",
  "complete_fix",
  "fail",
  "approve_plan",
  "approve_push",
] as const satisfies readonly WorkflowEvent[];

const fixReturnStates = [
  WorkflowState.PlanReview,
  WorkflowState.CodeReview,
  WorkflowState.ScopeReview,
  WorkflowState.StaticVerification,
  WorkflowState.TestVerification,
  WorkflowState.RuntimeVerification,
  WorkflowState.SecurityReview,
] as const satisfies readonly FixReturnState[];

const illegalTransition = Symbol("illegal transition");
const enterFixing = Symbol("enter fixing");
const returnFromFixing = Symbol("return from fixing");

type TransitionExpectation =
  | WorkflowState
  | typeof illegalTransition
  | typeof enterFixing
  | typeof returnFromFixing;

const transitionMatrix = {
  [WorkflowState.Draft]: {
    advance: WorkflowState.Grilling,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.Grilling]: {
    advance: WorkflowState.SpecReady,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.SpecReady]: {
    advance: WorkflowState.Planning,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.Planning]: {
    advance: WorkflowState.PlanReview,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.PlanReview]: {
    advance: WorkflowState.AwaitingPlanApproval,
    request_fix: enterFixing,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.AwaitingPlanApproval]: {
    advance: illegalTransition,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: WorkflowState.Implementing,
    approve_push: illegalTransition,
  },
  [WorkflowState.Implementing]: {
    advance: WorkflowState.CodeReview,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.CodeReview]: {
    advance: WorkflowState.ScopeReview,
    request_fix: enterFixing,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.ScopeReview]: {
    advance: WorkflowState.StaticVerification,
    request_fix: enterFixing,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.StaticVerification]: {
    advance: WorkflowState.TestVerification,
    request_fix: enterFixing,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.TestVerification]: {
    advance: WorkflowState.RuntimeVerification,
    request_fix: enterFixing,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.RuntimeVerification]: {
    advance: WorkflowState.SecurityReview,
    request_fix: enterFixing,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.Fixing]: {
    advance: illegalTransition,
    request_fix: illegalTransition,
    complete_fix: returnFromFixing,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.SecurityReview]: {
    advance: WorkflowState.FinalGate,
    request_fix: enterFixing,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.FinalGate]: {
    advance: WorkflowState.FinalSummary,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.FinalSummary]: {
    advance: WorkflowState.AwaitingPushApproval,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.AwaitingPushApproval]: {
    advance: illegalTransition,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: WorkflowState.Committing,
  },
  [WorkflowState.Committing]: {
    advance: WorkflowState.Pushing,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.Pushing]: {
    advance: WorkflowState.Complete,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: WorkflowState.Failed,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.Complete]: {
    advance: illegalTransition,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: illegalTransition,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
  [WorkflowState.Failed]: {
    advance: illegalTransition,
    request_fix: illegalTransition,
    complete_fix: illegalTransition,
    fail: illegalTransition,
    approve_plan: illegalTransition,
    approve_push: illegalTransition,
  },
} as const satisfies Record<WorkflowState, Record<WorkflowEvent, TransitionExpectation>>;

const workflowStates = Object.values(WorkflowState);

function machineAt(targetState: WorkflowState): WorkflowStateMachine {
  if (targetState === WorkflowState.Failed) {
    const machine = new WorkflowStateMachine();
    expect(machine.transition("fail")).toEqual({ ok: true, state: WorkflowState.Failed });
    return machine;
  }

  if (targetState === WorkflowState.Fixing) {
    const machine = machineAt(WorkflowState.RuntimeVerification);
    expect(machine.transition("request_fix")).toEqual({ ok: true, state: WorkflowState.Fixing });
    return machine;
  }

  const machine = new WorkflowStateMachine();

  for (const [state, event, nextState] of successTransitions) {
    if (machine.state === targetState) {
      return machine;
    }

    expect(machine.state).toBe(state);
    expect(machine.transition(event)).toEqual({ ok: true, state: nextState });
  }

  if (machine.state === targetState) {
    return machine;
  }

  throw new Error(`Unable to reach workflow state: ${targetState}`);
}

function restoreSnapshot(snapshot: WorkflowMachineSnapshot): WorkflowStateMachine {
  const serializedSnapshot = JSON.stringify(snapshot);
  const parsedSnapshot = JSON.parse(serializedSnapshot) as WorkflowMachineSnapshot;
  return new WorkflowStateMachine(parsedSnapshot);
}

function expectIllegalTransition(
  machine: WorkflowStateMachine,
  event: WorkflowEvent,
): void {
  const state = machine.state;

  expect(machine.transition(event)).toEqual({
    ok: false,
    code: "illegal_transition",
    state,
    event,
    message: `Event "${event}" is not legal in state "${state}".`,
  });
  expect(machine.state).toBe(state);
}

describe("WorkflowStateMachine", () => {
  it("starts in draft", () => {
    expect(new WorkflowStateMachine().state).toBe(WorkflowState.Draft);
  });

  it("allows every main success transition in order", () => {
    const machine = new WorkflowStateMachine();

    for (const [state, event, nextState] of successTransitions) {
      expect(machine.state).toBe(state);
      expect(machine.transition(event)).toEqual({ ok: true, state: nextState });
      expect(machine.state).toBe(nextState);
    }
  });

  it("requires explicit plan approval", () => {
    const machine = machineAt(WorkflowState.AwaitingPlanApproval);

    expectIllegalTransition(machine, "advance");
    expectIllegalTransition(machine, "approve_push");
    expect(machine.transition("approve_plan")).toEqual({
      ok: true,
      state: WorkflowState.Implementing,
    });
    expectIllegalTransition(machine, "approve_plan");
  });

  it("requires explicit push approval", () => {
    const machine = machineAt(WorkflowState.AwaitingPushApproval);

    expectIllegalTransition(machine, "advance");
    expectIllegalTransition(machine, "approve_plan");
    expect(machine.transition("approve_push")).toEqual({
      ok: true,
      state: WorkflowState.Committing,
    });
    expectIllegalTransition(machine, "approve_push");
  });

  it.each(fixReturnStates)("returns from fixing to its recorded state: %s", (returnState) => {
    const machine = machineAt(returnState);

    expect(machine.transition("request_fix")).toEqual({ ok: true, state: WorkflowState.Fixing });
    expectIllegalTransition(machine, "advance");
    expect(machine.transition("complete_fix")).toEqual({ ok: true, state: returnState });
  });

  it("rejects fix completion without recorded context", () => {
    expectIllegalTransition(new WorkflowStateMachine(), "complete_fix");
  });

  describe("transition matrix", () => {
    describe.each(workflowStates)("from %s", (state) => {
      it.each(workflowEvents)("with %s", (event) => {
        const machine = machineAt(state);
        const beforeSnapshot = machine.snapshot;
        const expectation = transitionMatrix[state][event];
        const result = machine.transition(event);

        if (expectation === illegalTransition) {
          const code =
            state === WorkflowState.Complete || state === WorkflowState.Failed
              ? "terminal_state"
              : "illegal_transition";
          const message =
            code === "terminal_state"
              ? `State "${state}" is terminal and cannot process event "${event}".`
              : `Event "${event}" is not legal in state "${state}".`;

          expect(result).toEqual({
            ok: false,
            code,
            state,
            event,
            message,
          });
          expect(machine.snapshot).toEqual(beforeSnapshot);
          return;
        }

        if (expectation === enterFixing) {
          expect(result).toEqual({ ok: true, state: WorkflowState.Fixing });
          expect(machine.snapshot).toEqual({
            state: WorkflowState.Fixing,
            fixReturnState: state,
          });
          return;
        }

        if (expectation === returnFromFixing) {
          const returnState = beforeSnapshot.fixReturnState;

          if (returnState === undefined) {
            throw new Error("Fixing test machine is missing its return state.");
          }

          expect(result).toEqual({ ok: true, state: returnState });
          expect(machine.snapshot).toEqual({ state: returnState });
          return;
        }

        expect(result).toEqual({ ok: true, state: expectation });
        expect(machine.snapshot).toEqual({ state: expectation });
      });
    });
  });

  describe("snapshots", () => {
    it("round trips draft", () => {
      const machine = new WorkflowStateMachine();
      const restored = restoreSnapshot(machine.snapshot);

      expect(machine.snapshot).toEqual({ state: WorkflowState.Draft });
      expect(restored.snapshot).toEqual(machine.snapshot);
    });

    it("round trips an ordinary lifecycle state", () => {
      const machine = machineAt(WorkflowState.SpecReady);
      const restored = restoreSnapshot(machine.snapshot);

      expect(restored.snapshot).toEqual({ state: WorkflowState.SpecReady });
      expect(restored.transition("advance")).toEqual({
        ok: true,
        state: WorkflowState.Planning,
      });
    });

    it("round trips fixing and preserves its return state", () => {
      const machine = machineAt(WorkflowState.RuntimeVerification);

      expect(machine.transition("request_fix")).toEqual({
        ok: true,
        state: WorkflowState.Fixing,
      });

      const restored = restoreSnapshot(machine.snapshot);

      expect(restored.snapshot).toEqual({
        state: WorkflowState.Fixing,
        fixReturnState: WorkflowState.RuntimeVerification,
      });
      expect(restored.transition("complete_fix")).toEqual({
        ok: true,
        state: WorkflowState.RuntimeVerification,
      });
      expect(restored.snapshot).toEqual({ state: WorkflowState.RuntimeVerification });
    });

    it("round trips complete and keeps it terminal", () => {
      const restored = restoreSnapshot(machineAt(WorkflowState.Complete).snapshot);

      expect(restored.snapshot).toEqual({ state: WorkflowState.Complete });
      expect(restored.transition("advance")).toEqual({
        ok: false,
        code: "terminal_state",
        state: WorkflowState.Complete,
        event: "advance",
        message: 'State "complete" is terminal and cannot process event "advance".',
      });
      expect(restored.state).toBe(WorkflowState.Complete);
    });

    it("round trips failed and keeps it terminal", () => {
      const restored = restoreSnapshot(machineAt(WorkflowState.Failed).snapshot);

      expect(restored.snapshot).toEqual({ state: WorkflowState.Failed });
      expect(restored.transition("request_fix")).toEqual({
        ok: false,
        code: "terminal_state",
        state: WorkflowState.Failed,
        event: "request_fix",
        message: 'State "failed" is terminal and cannot process event "request_fix".',
      });
      expect(restored.state).toBe(WorkflowState.Failed);
    });

    it("rejects fixing snapshots without a valid return state", () => {
      const missingReturnState = () => new WorkflowStateMachine({ state: WorkflowState.Fixing });
      const invalidReturnState = () =>
        new WorkflowStateMachine({
          state: WorkflowState.Fixing,
          fixReturnState: WorkflowState.Draft,
        } as unknown as WorkflowMachineSnapshot);

      expect(missingReturnState).toThrow(TypeError);
      expect(missingReturnState).toThrow(
        "Invalid workflow snapshot: fixing requires a valid fix return state.",
      );
      expect(invalidReturnState).toThrow(TypeError);
      expect(invalidReturnState).toThrow(
        "Invalid workflow snapshot: fixing requires a valid fix return state.",
      );
    });

    it("rejects stale fix return state outside fixing", () => {
      const restoreInvalidSnapshot = () =>
        new WorkflowStateMachine({
          state: WorkflowState.SpecReady,
          fixReturnState: WorkflowState.RuntimeVerification,
        });

      expect(restoreInvalidSnapshot).toThrow(TypeError);
      expect(restoreInvalidSnapshot).toThrow(
        "Invalid workflow snapshot: fix return state is only valid while fixing.",
      );
    });

    it("rejects unknown states", () => {
      const restoreInvalidSnapshot = () =>
        new WorkflowStateMachine({
          state: "unknown",
        } as unknown as WorkflowMachineSnapshot);

      expect(restoreInvalidSnapshot).toThrow(TypeError);
      expect(restoreInvalidSnapshot).toThrow(
        "Invalid workflow snapshot: state must be a WorkflowState.",
      );
    });
  });
});
