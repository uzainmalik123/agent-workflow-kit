import type { WorkflowState } from "./workflow-state.js";

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
}

export interface Requirement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
}

export interface Plan {
  readonly featureId: string;
  readonly summary: string;
  readonly steps: readonly string[];
}

export interface ReviewFinding {
  readonly featureId: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
}

export interface VerificationEvidence {
  readonly kind: string;
  readonly description: string;
  readonly reference?: string;
}

export interface VerificationResult {
  readonly requirementId: string;
  readonly acceptanceCriterionId: string;
  readonly status: "passed" | "failed";
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
