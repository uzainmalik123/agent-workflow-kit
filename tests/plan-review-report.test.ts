import {
  formatFindings,
  formatPlanReview,
  PLAN_REVIEW_LINE_LIMIT,
  planReviewReport,
} from "@agent-workflow-kit/orchestration";
import { describe, expect, it } from "vitest";

/**
 * How a stored `plan_review` artifact is read for the human at the gate (D-13).
 *
 * The document is model-authored: no schema defines its shape, so the reader has to be tolerant
 * about what it finds and precise about what it concludes. The two conclusions that matter are the
 * ones the approval gate acts on — a verdict asking for a fix, and a finding at `error` severity —
 * and neither may be invented from a document that said nothing.
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
  });

  it("falls back to `outcome` when the document called its verdict that", () => {
    const report = planReviewReport({ outcome: "needs_fix", findings: [] });

    expect(report.verdict).toBe("needs_fix");
    expect(report.unresolved).toBe(true);
  });

  it("is unresolved when a finding is an error, whatever the verdict says", () => {
    const report = planReviewReport({
      verdict: "success",
      findings: [{ severity: "error", message: "Step STEP-1 has no test" }],
    });

    expect(report.unresolved).toBe(true);
  });

  it("is resolved when the findings stop at warnings", () => {
    const report = planReviewReport({
      verdict: "success",
      findings: [{ severity: "warning", message: "No step names src/app.ts" }],
    });

    expect(report.unresolved).toBe(false);
  });

  it("records nothing from a document that says nothing", () => {
    for (const artifact of [undefined, null, "not json at all", 42, [], { featureId: "F-001" }]) {
      expect(planReviewReport(artifact)).toEqual({
        verdict: null,
        summary: null,
        findings: [],
        unresolved: false,
      });
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
  it("renders nothing when there is nothing to show", () => {
    expect(formatPlanReview(planReviewReport(undefined))).toEqual([]);
    expect(
      formatPlanReview(planReviewReport({ verdict: "success", findings: [] })),
    ).toEqual([]);
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
