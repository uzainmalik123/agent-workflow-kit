import type { WorkflowState } from "./workflow-state.js";

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly verification: string;
}

export interface Requirement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
}

export interface PlanStep {
  readonly id: string;
  readonly description: string;
  readonly requirementIds: readonly string[];
  readonly expectedFiles: readonly string[];
  readonly verification: string;
}

export interface Plan {
  readonly featureId: string;
  readonly summary: string;
  readonly steps: readonly PlanStep[];
}

export interface ReviewFinding {
  readonly featureId: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
}

export type VerificationEvidenceKind = "static" | "test" | "runtime" | "security";

export interface VerificationEvidence {
  readonly kind: VerificationEvidenceKind;
  readonly description: string;
  readonly reference?: string;
}

export interface VerificationResult {
  readonly requirementId: string;
  readonly acceptanceCriterionId: string;
  readonly status: "passed" | "failed" | "inconclusive";
  readonly evidence: readonly VerificationEvidence[];
}

export interface Feature {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly state: WorkflowState;
  readonly requirements: readonly Requirement[];
  readonly plan?: Plan;
}
