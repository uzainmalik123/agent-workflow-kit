import type {
  FixReturnState,
  ReviewFinding,
  VerificationEvidence,
  WorkflowEvent,
  WorkflowState,
} from "@agent-workflow-kit/core";
import type { FeatureArtifactName } from "@agent-workflow-kit/persistence";
import type { OrchestrationError, OrchestrationFailureClass } from "./errors.js";
import type { HumanAction, StageRole, WorkStage } from "./stages.js";
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
   * The deterministic scope record for this run, when the stage ran in an isolated workspace. Path
   * names only, so it is safe to persist, print, and pass to a reviewer as context.
   */
  readonly scope: WorkspaceScopeEvidence | null;
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
  readonly scope?: WorkspaceScopeEvidence | null;
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
    scope: input.scope ?? null,
    error,
  };
}
