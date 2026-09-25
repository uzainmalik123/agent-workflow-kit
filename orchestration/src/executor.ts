import type {
  FixReturnState,
  ReviewFinding,
  VerificationEvidence,
  WorkflowState,
} from "@agent-workflow-kit/core";
import type {
  FeatureArtifactFilename,
  FeatureArtifactName,
} from "@agent-workflow-kit/persistence";
import type { StageArtifactOutputSpec, StageRole, WorkStage } from "./stages.js";

export const STAGE_OUTCOMES = ["success", "needs_fix", "failed", "inconclusive"] as const;

export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export function isStageOutcome(value: unknown): value is StageOutcome {
  return typeof value === "string" && STAGE_OUTCOMES.some((outcome) => outcome === value);
}

export interface StageFeatureContext {
  readonly featureId: string;
  readonly title: string;
  readonly slug: string;
  readonly state: WorkflowState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StageArtifactContext {
  readonly name: FeatureArtifactName;
  readonly filename: FeatureArtifactFilename;
  readonly content: unknown;
}

export interface StageExecutionRequest {
  readonly feature: StageFeatureContext;
  readonly stage: WorkStage;
  readonly role: StageRole;
  readonly state: WorkflowState;
  readonly context: readonly StageArtifactContext[];
  readonly outputs: readonly StageArtifactOutputSpec[];
  readonly fixReturnState: FixReturnState | null;
}

export interface StageArtifactOutput {
  readonly name: FeatureArtifactName;
  readonly content: unknown;
}

export interface StageExecutionResult {
  readonly outcome: StageOutcome;
  readonly featureId: string;
  readonly stage: WorkStage;
  readonly artifacts: readonly StageArtifactOutput[];
  readonly findings: readonly ReviewFinding[];
  readonly evidence: readonly VerificationEvidence[];
  readonly summary: string | null;
}

export interface StageExecutor {
  execute(request: StageExecutionRequest): Promise<StageExecutionResult>;
}
