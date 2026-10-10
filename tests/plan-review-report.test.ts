import {
  formatFindings,
  formatPlanReview,
  PLAN_REVIEW_LINE_LIMIT,
  PLAN_REVIEW_RESOLVED_VERDICTS,
  PLAN_REVIEW_UNREADABLE_REASON,
  planReviewReport,
} from "@agent-workflow-kit/orchestration";
import { describe, expect, it } from "vitest";

/**
 * How a stored `plan_review` artifact is read for the human at the gate (D-13, N2).
 *
 * The document is model-authored: no schema defines its shape, so the reader has to be tolerant
 * about what it finds and fail closed about what it concludes (P-18). Only a verdict in
 * PLAN_REVIEW_RESOLVED_VERDICTS with no `error`-severity finding is resolved; everything else —
 * including a document that says nothing at all — is unresolved, because a silent document must
 * never read as an approving one.
 */

describe("reading a stored plan review", () => {
  it("reads the verdict, the summary, and the findings as written", () => {
    const report = planReviewReport({
      verdict: "needs_fix",
      summary: "The plan leaves the migration untested.",
      findings: [
        { severity: "error", message: "Step STEP-1 has no test" },
        { severity: "warning", message: "No step names src/app.ts", filePath: "src/app.ts", line: 12 },
        { severity: "info", message: "Consider splitting step 1" },
      ],
    });

    expect(report.verdict).toBe("needs_fix");
    expect(report.summary).toBe("The plan leaves the migration untested.");
    expect(report.findings).toHaveLength(3);
    expect(report.findings[1]).toEqual({
      severity: "warning",
      message: "No step names src/app.ts",
      filePath: "src/app.ts",
      line: 12,
    });
    expect(report.unresolved).toBe(true);
    expect(report.reason).toContain("needs_fix");
  });

  it("falls back to `outcome` when the document called its verdict that", () => {
    const report = planReviewReport({ outcome: "needs_fix", findings: [] });

    expect(report.verdict).toBe("needs_fix");
    expect(report.unresolved).toBe(true);
    expect(report.reason).toContain("needs_fix");
  });

  it("is unresolved when a finding is an error, whatever the verdict says", () => {
    const report = planReviewReport({
      verdict: "success",
      findings: [{ severity: "error", message: "Step STEP-1 has no test" }],
    });

    expect(report.unresolved).toBe(true);
    expect(report.reason).toContain("success");
  });

  it("is resolved when the findings stop at warnings", () => {
    const report = planReviewReport({
      verdict: "success",
      findings: [{ severity: "warning", message: "No step names src/app.ts" }],
    });

    expect(report.unresolved).toBe(false);
    expect(report.reason).toBeNull();
  });

  it("accepts exactly the exported resolved verdicts, case- and separator-insensitively", () => {
    expect([...PLAN_REVIEW_RESOLVED_VERDICTS]).toEqual([
      "pass",
      "passed",
      "approved",
      "ok",
      "success",
    ]);

    for (const verdict of ["pass", "Pass", "PASS", " pass ", "passed", "approved", "ok", "success"]) {
      const report = planReviewReport({ verdict, findings: [] });
      expect(report.unresolved).toBe(false);
      expect(report.reason).toBeNull();
    }
  });

  it("is unresolved for any other verdict, including unknown strings", () => {
    for (const verdict of ["needs_fix", "looks fine", "maybe", ""]) {
      const report = planReviewReport({ verdict, findings: [] });

      expect(report.unresolved).toBe(true);

      if (verdict === "") {
        // An empty verdict is no verdict: the report is empty and unreadable.
        expect(report.reason).toBe(PLAN_REVIEW_UNREADABLE_REASON);
      } else {
        expect(report.reason).toContain(verdict);
      }
    }
  });

  it("fails closed on a missing, unparseable, or empty artifact", () => {
    for (const artifact of [undefined, null, "not json at all", 42, [], { featureId: "F-001" }, {}]) {
      const report = planReviewReport(artifact);

      expect(report).toEqual({
        verdict: null,
        summary: null,
        findings: [],
        unresolved: true,
        reason: PLAN_REVIEW_UNREADABLE_REASON,
      });
      expect(report.reason).toBe("review could not be read");
    }
  });

  it("drops findings it cannot read and keeps the ones it can", () => {
    const report = planReviewReport({
      verdict: "needs_fix",
      findings: [
        "a bare string",
        { severity: "error" },
        { message: "" },
        { message: 42 },
        { message: "Kept", severity: "ERROR" },
        { message: "Kept with a location", filePath: "src/app.ts", line: "twelve" },
      ],
    });

    expect(report.findings).toEqual([
      { severity: "error", message: "Kept", filePath: null, line: null },
      { severity: "info", message: "Kept with a location", filePath: "src/app.ts", line: null },
    ]);
    expect(report.unresolved).toBe(true);
  });

  it("reads the document out of the artifact bytes as readily as out of the parsed object", () => {
    const report = planReviewReport(
      JSON.stringify({ verdict: "needs_fix", findings: [{ message: "Step STEP-1 has no test" }] }),
    );

    expect(report.verdict).toBe("needs_fix");
    expect(report.findings).toHaveLength(1);
  });
});

describe("rendering a stored plan review", () => {
  it("renders nothing when the review is resolved with no findings", () => {
    expect(
      formatPlanReview(planReviewReport({ verdict: "success", findings: [] })),
    ).toEqual([]);
    expect(
      formatPlanReview(
        planReviewReport({ verdict: "Pass", findings: [{ severity: "info", message: "Nice" }] }),
      ),
    ).not.toEqual([]);
  });

  it("renders the unreadable reason instead of nothing", () => {
    expect(formatPlanReview(planReviewReport(undefined))).toEqual([
      "Plan review: review could not be read",
    ]);
    expect(formatPlanReview(planReviewReport({}))).toEqual([
      "Plan review: review could not be read",
    ]);
  });

  it("renders the verdict, the summary, and every finding on its own line", () => {
    const lines = formatPlanReview(
      planReviewReport({
        verdict: "needs_fix",
        summary: "The plan leaves the migration untested.",
        findings: [
          { severity: "error", message: "Step STEP-1 has no test" },
          { severity: "warning", message: "No step names src/app.ts", filePath: "src/app.ts" },
        ],
      }),
    );

    expect(lines).toEqual([
      "Plan review: needs_fix",
      " The plan leaves the migration untested.",
      " [error] Step STEP-1 has no test",
      " [warning] No step names src/app.ts (src/app.ts)",
    ]);
  });

  it("says so when an unresolved verdict recorded no findings", () => {
    expect(formatPlanReview(planReviewReport({ verdict: "needs_fix" }))).toEqual([
      "Plan review: needs_fix",
      " No findings were recorded.",
    ]);
  });

  it("keeps a finding on one line, with no control character reaching the terminal", () => {
    const [line] = formatFindings([
      {
        severity: "error",
        message: "first line\nsecond line\u001b[31mred\u0007",
      },
    ]);

    expect(line).toBe(" [error] first line second line [31mred");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\u0007");
  });

  it("cuts a line at the limit rather than letting it run on", () => {
    const [line] = formatFindings([{ severity: "error", message: "x".repeat(400) }]);

    expect(line?.length).toBe(PLAN_REVIEW_LINE_LIMIT);
    expect(line?.endsWith("…")).toBe(true);
  });

  it("carries a finding's file and line when the review recorded them", () => {
    expect(
      formatFindings([
        { severity: "error", message: "No test", filePath: "src/app.ts", line: 12 },
        { severity: "error", message: "No test", filePath: "src/app.ts" },
        { severity: "error", message: "No test" },
      ]),
    ).toEqual([
      " [error] No test (src/app.ts:12)",
      " [error] No test (src/app.ts)",
      " [error] No test",
    ]);
  });
});
