import {
  WorkflowState,
  type AcceptanceCriterion,
  type Feature,
  type Plan,
  type PlanStep,
  type Requirement,
  type ReviewFinding,
  type VerificationEvidence,
  type VerificationResult,
} from "@agent-workflow-kit/core";

export const acceptanceCriterionFixture = {
  id: "AC-1",
  description: "The workflow state is exposed as a stable enum value.",
  verification: "Run the core contract unit tests.",
} satisfies AcceptanceCriterion;

export const requirementFixture = {
  id: "REQ-1",
  title: "Expose workflow states",
  description: "The state machine defines transitions without executing feature work.",
  acceptanceCriteria: [acceptanceCriterionFixture],
} satisfies Requirement;

export const planStepFixture = {
  id: "STEP-1",
  description: "Define the core workflow contracts.",
  requirementIds: [requirementFixture.id],
  expectedFiles: ["core/src/types.ts", "core/src/workflow-state.ts"],
  verification: "Run linting, type checking, and unit tests.",
} satisfies PlanStep;

export const planFixture = {
  featureId: "FEATURE-1",
  summary: "Add the foundational workflow vocabulary.",
  steps: [planStepFixture],
} satisfies Plan;

export const featureFixture = {
  id: "FEATURE-1",
  title: "Foundational workflow model",
  description: "Provides the initial agent-independent domain contracts.",
  state: WorkflowState.PlanReview,
  requirements: [requirementFixture],
  plan: planFixture,
} satisfies Feature;

export const reviewFindingFixture = {
  featureId: featureFixture.id,
  severity: "warning",
  message: "Keep coding-agent concerns outside the core package.",
  filePath: "core/src/types.ts",
  line: 1,
} satisfies ReviewFinding;

export const verificationEvidenceFixture = {
  kind: "test",
  description: "Core contract tests completed successfully.",
  reference: "tests/core-contracts.test.ts",
} satisfies VerificationEvidence;

export const verificationResultFixture = {
  requirementId: requirementFixture.id,
  acceptanceCriterionId: acceptanceCriterionFixture.id,
  status: "passed",
  evidence: [verificationEvidenceFixture],
} satisfies VerificationResult;

export const verificationResultFixtures = [
  verificationResultFixture,
  { ...verificationResultFixture, status: "failed" },
  { ...verificationResultFixture, status: "inconclusive" },
] satisfies readonly VerificationResult[];
