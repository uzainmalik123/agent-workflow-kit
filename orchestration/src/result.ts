import type {
  FixReturnState,
  ReviewFinding,
  VerificationEvidence,
  WorkflowEvent,
  WorkflowState,
} from "@agent-workflow-kit/core";
import type { FeatureArtifactName, FixAttemptOutcome } from "@agent-workflow-kit/persistence";
import type { OrchestrationError, OrchestrationFailureClass } from "./errors.js";
import type { FinalGateResult } from "./final-gate.js";
import type { FixRejectionCode } from "./fix-policy.js";
import type { HumanAction, StageRole, WorkStage } from "./stages.js";
import type { SecurityReviewEvidence } from "./security.js";
import type { VerificationEvidenceBundle } from "./verification.js";
import type { WorkspaceScopeEvidence } from "./workspace.js";

export const ORCHESTRATION_STATUSES = [
  "created",
  "stage_completed",
  "advanced",
  "fix_requested",
  "awaiting_human",
  "gate_approved",
  "feature_failed",
  "deferred",
  "stage_failed",
  "inconclusive",
  "executor_error",
  "scope_violation",
  "rejected",
  "conflict",
  "persistence_error",
  "terminal",
] as const;

export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number];

/**
 * What the framework decided about one fix attempt, for a result that concerned one.
 *
 * Present when a stage ran a fix or refused to run one, and null otherwise. It exists because the
 * error message has to be written for a person and this is the same decision in a shape a program can
 * branch on: how far into the loop the attempt was, how many the loop was allowed, what the framework
 * concluded, what the fix touched, and — when it refused — every shape of the refusal rather than just
 * the one the error names first.
 */
export interface FixOutcomeSummary {
  readonly originStage: FixReturnState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly outcome: FixAttemptOutcome;
  readonly changedPaths: readonly string[];
  readonly rejectionCodes: readonly FixRejectionCode[];
}

export interface OrchestrationResult {
  readonly status: OrchestrationStatus;
  readonly failureClass: OrchestrationFailureClass;
  readonly featureId: string;
  readonly fromState: WorkflowState;
  readonly state: WorkflowState;
  readonly executedStages: readonly WorkStage[];
  readonly stage: WorkStage | null;
  readonly role: StageRole | null;
  readonly event: WorkflowEvent | null;
  readonly committed: boolean;
  readonly artifacts: readonly FeatureArtifactName[];
  readonly action: HumanAction | null;
  readonly fixReturnState: FixReturnState | null;
  readonly findings: readonly ReviewFinding[];
  readonly evidence: readonly VerificationEvidence[];
  /**
   * The deterministic evidence collected for this run, when a verification provider is configured
   * and the stage was a verification stage. Bounded: excerpts only, never a raw transcript.
   */
  readonly verification: VerificationEvidenceBundle | null;
  /**
   * The deterministic security record collected for this run, when the stage was the security review
   * and a provider was configured. Absent from a run that never reached one, which is not the same as
   * an absent provider — that case is refused rather than reported as an absent record.
   */
  readonly security: SecurityReviewEvidence | null;
  /**
   * The deterministic scope record for this run, when the stage ran in an isolated workspace. Path
   * names only, so it is safe to persist, print, and pass to a reviewer as context.
   */
  readonly scope: WorkspaceScopeEvidence | null;
  /**
   * The final gate's answer, when this run was one. Present on a passing `final_gate` run, on a
   * refusing one, and null everywhere else — the field records that the gate ran, so a caller that
   * finds it null knows the question was never put rather than that the answer was yes.
   */
  readonly finalGate: FinalGateResult | null;
  readonly fix: FixOutcomeSummary | null;
  readonly error: OrchestrationError | null;
}

export interface OrchestrationResultInput {
  readonly status: OrchestrationStatus;
  readonly featureId: string;
  readonly fromState: WorkflowState;
  readonly state: WorkflowState;
  readonly executedStages?: readonly WorkStage[];
  readonly stage?: WorkStage | null;
  readonly role?: StageRole | null;
  readonly event?: WorkflowEvent | null;
  readonly committed?: boolean;
  readonly artifacts?: readonly FeatureArtifactName[];
  readonly action?: HumanAction | null;
  readonly fixReturnState?: FixReturnState | null;
  readonly findings?: readonly ReviewFinding[];
  readonly evidence?: readonly VerificationEvidence[];
  readonly verification?: VerificationEvidenceBundle | null;
  readonly security?: SecurityReviewEvidence | null;
  readonly scope?: WorkspaceScopeEvidence | null;
  readonly finalGate?: FinalGateResult | null;
  readonly fix?: FixOutcomeSummary | null;
  readonly error?: OrchestrationError | null;
}

export function buildOrchestrationResult(input: OrchestrationResultInput): OrchestrationResult {
  const error = input.error ?? null;

  return {
    status: input.status,
    failureClass: error === null ? "none" : error.failureClass,
    featureId: input.featureId,
    fromState: input.fromState,
    state: input.state,
    executedStages: input.executedStages ?? [],
    stage: input.stage ?? null,
    role: input.role ?? null,
    event: input.event ?? null,
    committed: input.committed ?? false,
    artifacts: input.artifacts ?? [],
    action: input.action ?? null,
    fixReturnState: input.fixReturnState ?? null,
    findings: input.findings ?? [],
    evidence: input.evidence ?? [],
    verification: input.verification ?? null,
    security: input.security ?? null,
    scope: input.scope ?? null,
    finalGate: input.finalGate ?? null,
    fix: input.fix ?? null,
    error,
  };
}
