import { WorkflowState } from "@agent-workflow-kit/core";
import { describe, expect, it } from "vitest";
import {
  acceptanceCriterionFixture,
  featureFixture,
  planFixture,
  planStepFixture,
  requirementFixture,
  reviewFindingFixture,
  verificationEvidenceFixture,
  verificationResultFixture,
  verificationResultFixtures,
} from "../fixtures/core.js";

describe("WorkflowState", () => {
  it("defines the intended workflow lifecycle", () => {
    expect(Object.values(WorkflowState)).toEqual([
      "draft",
      "grilling",
      "spec_ready",
      "planning",
      "plan_review",
      "awaiting_plan_approval",
      "implementing",
      "code_review",
      "scope_review",
      "static_verification",
      "test_verification",
      "runtime_verification",
      "fixing",
      "security_review",
      "final_gate",
      "final_summary",
      "awaiting_push_approval",
      "committing",
      "pushing",
      "complete",
      "failed",
    ]);
  });
});

describe("core data contracts", () => {
  it("connects a feature, requirements, criteria, plan steps, and a plan", () => {
    expect(featureFixture.state).toBe(WorkflowState.PlanReview);
    expect(featureFixture.requirements).toContain(requirementFixture);
    expect(requirementFixture.acceptanceCriteria).toContain(acceptanceCriterionFixture);
    expect(acceptanceCriterionFixture.verification).not.toBe("");
    expect(featureFixture.plan).toBe(planFixture);
    expect(planFixture.featureId).toBe(featureFixture.id);
    expect(planFixture.steps).toContain(planStepFixture);
    expect(planStepFixture.requirementIds).toContain(requirementFixture.id);
    expect(planStepFixture.expectedFiles).not.toHaveLength(0);
  });

  it("connects review findings to features", () => {
    expect(reviewFindingFixture.featureId).toBe(featureFixture.id);
    expect(reviewFindingFixture.severity).toBe("warning");
  });

  it("connects typed evidence to all verification result statuses", () => {
    expect(verificationResultFixture.requirementId).toBe(requirementFixture.id);
    expect(verificationResultFixture.acceptanceCriterionId).toBe(acceptanceCriterionFixture.id);
    expect(verificationResultFixture.evidence).toContain(verificationEvidenceFixture);
    expect(verificationEvidenceFixture.kind).toBe("test");
    expect(verificationResultFixtures.map(({ status }) => status)).toEqual([
      "passed",
      "failed",
      "inconclusive",
    ]);
  });
});
