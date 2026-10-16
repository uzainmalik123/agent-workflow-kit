import { WorkflowState } from "@agent-workflow-kit/core";
import type { FeatureSession } from "@agent-workflow-kit/persistence";

/**
 * The one recommended next step for a feature: a single command plus a one-line reason.
 *
 * `command` is `"done"` when there is nothing left to run for this feature id (the terminal
 * states); the reason then says how to start another feature instead.
 */
export interface NextStep {
  readonly command: string;
  readonly reason: string;
}

/** Options for {@link nextStep} beyond the session itself. */
export interface NextStepOptions {
  /**
   * Whether the stored `plan_review` artifact is unresolved (no passing verdict, an
   * `error`-severity finding, or unreadable). Only read at `awaiting_plan_approval`, where it
   * decides whether the recommended approval carries `--accept-findings`.
   *
   * Absent means unknown, which reads as unresolved: fail closed, like the approval gate itself
   * (N2, P-18) — an approval recommended without the flag over a review nobody read would be the
   * gate passing silently.
   */
  readonly planReviewUnresolved?: boolean;
  /**
   * Whether the recorded final gate carries a runtime gap that publishing must acknowledge (D-23).
   * Only read at `awaiting_push_approval`, where it decides whether the recommended approval carries
   * `--accept-unverified runtime`.
   *
   * Absent means unknown, which reads as a gap for the same reason `planReviewUnresolved` reads as
   * unresolved: the flag is accepted, and refused, exactly when the gap is real, so recommending it
   * over a gap-free session cannot grant anything — and recommending it over an unreadable gate
   * keeps the hint on the match with what the approval itself will require (P-18, fail closed).
   */
  readonly unverifiedRuntime?: boolean;
}

/**
 * The single recommended command for a feature's current state, with a one-line reason.
 *
 * Pure: it reads the session (state, feature id, approvals) and the review flag, and nothing
 * else. Every one of the 21 `WorkflowState` values is mapped, and the `default` arm throws so a
 * newly added state fails the exhaustiveness test until it is mapped here.
 *
 * Legality against the state machine (`core/src/workflow-state-machine.ts`) and the orchestrator
 * (`orchestration/src/orchestrator.ts` `runNext`):
 *
 * - The 17 machine-driven states (draft, grilling, spec_ready, planning, plan_review,
 *   implementing, code_review, scope_review, static/dynamic/runtime verification, fixing,
 *   security_review, final_gate, final_summary, committing, pushing) map to `agentflow run`:
 *   `runNext` performs exactly one step for each — a passive `advance` for draft/spec_ready, a
 *   work stage for the rest, `publishFeature` for committing/pushing — and `run` loops until a
 *   human gate or a terminal state. Nothing else the CLI offers advances these states.
 * - `awaiting_plan_approval` maps to `agentflow status` first because the human must read the
 *   stored plan review before deciding; only `approve_plan` (or `fail` via abandon) is legal
 *   there, and `run` just reports `awaiting_human` again.
 * - `awaiting_push_approval` maps to `agentflow status` first because the human must read the
 *   final summary before deciding; only `approve_push` (or `fail`) is legal there, and the
 *   commit/push itself still needs a later `run`.
 * - `complete` and `failed` are terminal: the machine refuses every event there, so the answer
 *   is `done`, with the reason saying how to start another feature (and, for `failed`, that a
 *   failed feature cannot be resumed — there is no event that leaves `failed`).
 */
export function nextStep(session: FeatureSession, options: NextStepOptions = {}): NextStep {
  const featureId = session.featureId;
  const state = session.machine.state;
  const unresolved = options.planReviewUnresolved ?? true;

  switch (state) {
    case WorkflowState.Draft:
    case WorkflowState.Grilling:
    case WorkflowState.SpecReady:
    case WorkflowState.Planning:
    case WorkflowState.PlanReview:
    case WorkflowState.Implementing:
    case WorkflowState.CodeReview:
    case WorkflowState.ScopeReview:
    case WorkflowState.StaticVerification:
    case WorkflowState.TestVerification:
    case WorkflowState.RuntimeVerification:
    case WorkflowState.Fixing:
    case WorkflowState.SecurityReview:
    case WorkflowState.FinalGate:
    case WorkflowState.FinalSummary:
      return {
        command: `agentflow run ${featureId}`,
        reason: `State "${state}" is machine-driven; 'agentflow run ${featureId}' advances it until the next human gate.`,
      };
    case WorkflowState.Committing:
    case WorkflowState.Pushing:
      return {
        command: `agentflow run ${featureId}`,
        reason: `State "${state}" publishes under 'agentflow run ${featureId}', which commits and pushes without further approval.`,
      };
    case WorkflowState.AwaitingPlanApproval:
      return {
        command: `agentflow status ${featureId}`,
        reason: unresolved
          ? `Review the plan, then run 'agentflow approve plan ${featureId} --accept-findings' (the stored review is unresolved) or 'agentflow abandon ${featureId} --reason "..."' to end the feature.`
          : `Review the plan, then run 'agentflow approve plan ${featureId}' or 'agentflow abandon ${featureId} --reason "..."' to end the feature.`,
      };
    case WorkflowState.AwaitingPushApproval: {
      // D-23: the hint names the acknowledgment exactly when the recorded gate carries the gap, so
      // the recommended command is the command the approval will actually accept.
      const gap = options.unverifiedRuntime ?? true;

      return {
        command: `agentflow status ${featureId}`,
        reason: gap
          ? `Read the final summary, then run 'agentflow approve push ${featureId} --accept-unverified runtime' (the recorded gate names runtime verification: not performed) followed by 'agentflow run ${featureId}' to commit and push.`
          : `Read the final summary, then run 'agentflow approve push ${featureId}' followed by 'agentflow run ${featureId}' to commit and push.`,
      };
    }
    case WorkflowState.Complete:
      return {
        command: "done",
        reason: `Feature ${featureId} is complete; start another with 'agentflow start --feature-id <new-id> --title "<title>"'.`,
      };
    case WorkflowState.Failed:
      return {
        command: "done",
        reason: `Feature ${featureId} is in terminal state "failed" and cannot be resumed; start a new feature with 'agentflow start --feature-id <new-id> --title "<title>"'.`,
      };
    default: {
      const unmapped: never = state;
      throw new Error(`nextStep: unmapped workflow state "${String(unmapped)}".`);
    }
  }
}

/** Renders a step as the single `Next:` line the commands print. */
export function formatNext(step: NextStep): string {
  return `Next: ${step.command} - ${step.reason}`;
}
