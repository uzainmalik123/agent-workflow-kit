import { STAGE_DEFINITIONS, PLAN_REVIEW_RESOLVED_VERDICTS, planReviewReport } from "@agent-workflow-kit/orchestration";
import { PLAN_EXAMPLE, PLAN_REVIEW_EXAMPLE, buildStagePrompt, roleDefinition } from "@agent-workflow-kit/opencode";
import { describe, expect, it } from "vitest";
import { testWorkspaceContext } from "../fixtures/workspace.js";

/**
 * Task R.4 (P-23, D-18 option 1): the plan-review artifact contract.
 *
 * `PLAN_REVIEW_EXAMPLE` is the single constant both sides read, the same pattern
 * as `PLAN_EXAMPLE`: `buildStagePrompt` renders it verbatim into the plan reviewer's
 * prompt, and this file feeds the same object to `planReviewReport`. If the prompt
 * stops showing the keys the gate reads — or the gate stops reading the keys the
 * prompt shows — an assertion below fails instead of a model writing a review the
 * gate reports as "No findings were recorded".
 */

const created = "2026-04-05T06:07:08.000Z";

function reviewPrompt(): string {
  const definition = STAGE_DEFINITIONS.plan_review;
  return buildStagePrompt({
    request: {
      feature: {
        featureId: "F-001",
        title: "Multiply helper",
        slug: "multiply-helper",
        state: definition.state,
        createdAt: created,
        updatedAt: created,
      },
      stage: "plan_review",
      role: definition.role,
      state: definition.state,
      context: [],
      outputs: definition.outputs,
      fixReturnState: null,
      verification: null,
      fix: null,
      workspace: testWorkspaceContext(),
    },
    projectInstructions: null,
  });
}

describe("plan review example and gate reading", () => {
  it("reads the example correctly as needs_fix, with its findings", () => {
    const report = planReviewReport(PLAN_REVIEW_EXAMPLE);
    expect(report.verdict).toBe("needs_fix");
    expect(report.summary).toBe(PLAN_REVIEW_EXAMPLE.summary);
    expect(report.findings).toHaveLength(PLAN_REVIEW_EXAMPLE.findings.length);
    expect(report.findings[0]).toMatchObject({
      severity: "warning",
      filePath: "src/multiply.mjs",
      line: 12,
    });
    expect(report.unresolved).toBe(true);
  });

  it("reads the example correctly as pass, with its findings", () => {
    const report = planReviewReport({ ...PLAN_REVIEW_EXAMPLE, verdict: "pass" });
    expect(report.verdict).toBe("pass");
    expect(report.findings).toHaveLength(PLAN_REVIEW_EXAMPLE.findings.length);
    expect(report.unresolved).toBe(false);
    expect(report.reason).toBeNull();
  });

  it("agrees with PLAN_REVIEW_RESOLVED_VERDICTS on both verdicts", () => {
    expect([...PLAN_REVIEW_RESOLVED_VERDICTS]).toContain("pass");
    expect([...PLAN_REVIEW_RESOLVED_VERDICTS]).not.toContain("needs_fix");
    expect(planReviewReport({ ...PLAN_REVIEW_EXAMPLE, verdict: "pass" }).unresolved).toBe(false);
    expect(planReviewReport(PLAN_REVIEW_EXAMPLE).unresolved).toBe(true);
  });

  it("shows that exact example in the plan-review prompt and only there", () => {
    const prompt = reviewPrompt();
    expect(prompt).toContain("## Plan review artifact shape");
    expect(prompt).toContain(JSON.stringify(PLAN_REVIEW_EXAMPLE, null, 2));
    // The planner example is a different contract and must not leak here.
    expect(prompt).not.toContain(JSON.stringify(PLAN_EXAMPLE, null, 2));
  });

  it("requires verdict, summary, and findings in the reviewer role text", () => {
    const definition = roleDefinition("plan_reviewer");
    const roleText = [...definition.responsibilities, ...definition.prohibited, ...definition.deliverables].join("\n");
    expect(roleText).toContain("`verdict`");
    expect(roleText).toContain("`pass`");
    expect(roleText).toContain("`needs_fix`");
    expect(roleText).toContain("`summary`");
    expect(roleText).toContain("`findings`");
    expect(roleText).toContain("`filePath`");
    expect(roleText).toContain("`line`");
  });
});
