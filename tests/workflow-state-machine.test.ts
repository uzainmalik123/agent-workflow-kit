import {
  WorkflowState,
  WorkflowStateMachine,
  type FixReturnState,
  type WorkflowEvent,
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

const nonTerminalStates = Object.values(WorkflowState).filter(
  (state) => state !== WorkflowState.Complete && state !== WorkflowState.Failed,
);

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

function expectTerminalStateError(
  machine: WorkflowStateMachine,
  event: WorkflowEvent,
): void {
  const state = machine.state;

  expect(machine.transition(event)).toEqual({
    ok: false,
    code: "terminal_state",
    state,
    event,
    message: `State "${state}" is terminal and cannot process event "${event}".`,
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

  it.each(nonTerminalStates)("allows explicit terminal failure from %s", (state) => {
    const machine = machineAt(state);

    expect(machine.transition("fail")).toEqual({ ok: true, state: WorkflowState.Failed });
    expect(machine.state).toBe(WorkflowState.Failed);
  });

  it.each(workflowEvents)("does not leave complete with event %s", (event) => {
    expectTerminalStateError(machineAt(WorkflowState.Complete), event);
  });

  it.each(workflowEvents)("does not leave failed with event %s", (event) => {
    expectTerminalStateError(machineAt(WorkflowState.Failed), event);
  });

  it("advances only one intended stage at a time", () => {
    const representativeSteps = [
      [WorkflowState.Draft, WorkflowState.Grilling],
      [WorkflowState.Planning, WorkflowState.PlanReview],
      [WorkflowState.Implementing, WorkflowState.CodeReview],
    ] as const satisfies readonly (readonly [WorkflowState, WorkflowState])[];

    for (const [state, nextState] of representativeSteps) {
      const machine = machineAt(state);
      expect(machine.transition("advance")).toEqual({ ok: true, state: nextState });
    }
  });

  it.each([
    [WorkflowState.Planning, "approve_push"],
    [WorkflowState.Implementing, "approve_push"],
    [WorkflowState.CodeReview, "approve_push"],
    [WorkflowState.ScopeReview, "approve_push"],
    [WorkflowState.StaticVerification, "approve_push"],
    [WorkflowState.TestVerification, "approve_push"],
    [WorkflowState.RuntimeVerification, "approve_push"],
    [WorkflowState.SecurityReview, "approve_push"],
    [WorkflowState.FinalGate, "approve_push"],
    [WorkflowState.FinalSummary, "approve_push"],
  ] as const satisfies readonly (readonly [WorkflowState, WorkflowEvent])[])(
    "rejects an approval bypass from %s",
    (state, event) => {
      expectIllegalTransition(machineAt(state), event);
    },
  );
});
