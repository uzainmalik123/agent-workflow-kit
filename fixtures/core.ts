import {
  WorkflowState,
  type AcceptanceCriterion,
  type Feature,
  type Plan,
  type Requirement,
  type ReviewFinding,
  type VerificationEvidence,
  type VerificationResult,
} from "@agent-workflow-kit/core";

export const acceptanceCriterionFixture = {
  id: "AC-1",
  description: "The workflow state is exposed as a stable enum value.",
} satisfies AcceptanceCriterion;

export const requirementFixture = {
  id: "REQ-1",
  title: "Expose workflow states",
  description: "The core defines states without implementing transitions.",
  acceptanceCriteria: [acceptanceCriterionFixture],
} satisfies Requirement;

export const planFixture = {
  featureId: "FEATURE-1",
  summary: "Add the foundational workflow vocabulary.",
  steps: ["Define the core contracts.", "Validate the public data shapes."],
} satisfies Plan;

export const featureFixture = {
  id: "FEATURE-1",
  title: "Foundational workflow model",
  description: "Provides the initial agent-independent domain contracts.",
  state: WorkflowState.Planning,
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
  kind: "unit-test",
  description: "Core contract tests completed successfully.",
  reference: "tests/core-contracts.test.ts",
} satisfies VerificationEvidence;

export const verificationResultFixture = {
  requirementId: requirementFixture.id,
  acceptanceCriterionId: acceptanceCriterionFixture.id,
  status: "passed",
  evidence: [verificationEvidenceFixture],
} satisfies VerificationResult;
