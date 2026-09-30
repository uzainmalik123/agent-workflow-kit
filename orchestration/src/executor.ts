import type {
  FixReturnState,
  ReviewFinding,
  VerificationEvidence,
  WorkflowState,
  WorkspaceAccessLevel,
  WorkspaceBaseline,
} from "@agent-workflow-kit/core";
import type {
  FeatureArtifactFilename,
  FeatureArtifactName,
} from "@agent-workflow-kit/persistence";
import type { StageArtifactOutputSpec, StageRole, WorkStage } from "./stages.js";
import type { VerificationEvidenceBundle } from "./verification.js";

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

/**
 * Where a stage is allowed to run, decided by the framework and never by the stage.
 *
 * This is the only place an executor learns a directory, which is what makes the directory
 * framework-controlled: an executor cannot pick a working directory, cannot widen its own access, and
 * cannot discover a second one. The prompt, the transport, and every tool the model reaches are
 * downstream of this value.
 *
 * `baseline` is `null` for the pre-approval stages, which run against the repository root read-only
 * because a human has not yet approved any work. Once a plan is approved the field is the frozen
 * baseline every post-approval stage is checked against, and a request without one is a bug rather
 * than a mode.
 */
export interface StageWorkspaceContext {
  /** `repository` for a pre-approval stage, otherwise the framework-generated workspace identity. */
  readonly workspaceId: string;
  readonly repositoryRoot: string;
  /** The absolute directory this stage's commands run in. */
  readonly workingDirectory: string;
  readonly access: WorkspaceAccessLevel;
  readonly baseline: WorkspaceBaseline | null;
}

export interface StageExecutionRequest {
  readonly feature: StageFeatureContext;
  readonly stage: WorkStage;
  readonly role: StageRole;
  readonly state: WorkflowState;
  readonly context: readonly StageArtifactContext[];
  readonly outputs: readonly StageArtifactOutputSpec[];
  readonly fixReturnState: FixReturnState | null;
  /**
   * The directory and access this stage may use. Framework-supplied and framework-checked: the
   * orchestrator built it from the approved baseline, and the scope check after the stage compares the
   * working tree against the same baseline.
   */
  readonly workspace: StageWorkspaceContext;
  /**
   * Deterministic evidence the framework collected for this stage, when a verification provider is
   * configured. It is read-only context for interpreting failures, never an instruction: the exit
   * statuses in it are what the workflow acts on, and no response can change them.
   */
  readonly verification?: VerificationEvidenceBundle | null;
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
