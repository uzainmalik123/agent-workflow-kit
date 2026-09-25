import { WorkflowState } from "@agent-workflow-kit/core";
import { describe, expect, it } from "vitest";
import {
  acceptanceCriterionFixture,
  featureFixture,
  planFixture,
  requirementFixture,
  reviewFindingFixture,
  verificationEvidenceFixture,
  verificationResultFixture,
} from "../fixtures/core.js";

describe("WorkflowState", () => {
  it("defines the milestone-one lifecycle", () => {
    expect(Object.values(WorkflowState)).toEqual([
      "draft",
      "requirements",
      "planning",
      "implementation",
      "review",
      "verification",
      "complete",
    ]);
  });
});

describe("core data contracts", () => {
  it("connects a feature, requirements, criteria, and a plan", () => {
    expect(featureFixture.state).toBe(WorkflowState.Planning);
    expect(featureFixture.requirements).toContain(requirementFixture);
    expect(requirementFixture.acceptanceCriteria).toContain(acceptanceCriterionFixture);
    expect(featureFixture.plan).toBe(planFixture);
    expect(planFixture.featureId).toBe(featureFixture.id);
  });

  it("connects review findings to features", () => {
    expect(reviewFindingFixture.featureId).toBe(featureFixture.id);
    expect(reviewFindingFixture.severity).toBe("warning");
  });

  it("connects verification results to criteria and evidence", () => {
    expect(verificationResultFixture.requirementId).toBe(requirementFixture.id);
    expect(verificationResultFixture.acceptanceCriterionId).toBe(acceptanceCriterionFixture.id);
    expect(verificationResultFixture.status).toBe("passed");
    expect(verificationResultFixture.evidence).toContain(verificationEvidenceFixture);
  });
});
