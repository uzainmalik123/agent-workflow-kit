import { isRecord } from "./result-validation.js";

/**
 * How long one rendered line may get before it is cut.
 *
 * A finding is model-authored text printed into a terminal: unbounded, it can run off the screen or
 * push everything a human needs above it out of view. One line per finding, capped here, keeps a
 * review scannable. The full text is never lost — it is still in the stored artifact, which is what
 * approval digests are taken over.
 */
export const PLAN_REVIEW_LINE_LIMIT = 120;

/**
 * One finding as the plan review recorded it.
 *
 * `severity` stays a plain string rather than the `info | warning | error` union the response
 * contract asks for, because this reads a document a model wrote, not a response the framework
 * validated: a severity the contract never allowed is still something a human should read, and
 * inventing a legal one for it would hide that the reviewer stepped outside the contract. Only
 * exactly `error` is treated as blocking, which is the severity the contract defines as the top one.
 *
 * `filePath` and `line` are nullable rather than optional so a reader can format a finding without
 * testing for absence twice, and so the shape is stable whichever of them the reviewer happened to
 * write.
 */
export interface PlanReviewFinding {
  readonly severity: string;
  readonly message: string;
  readonly filePath: string | null;
  readonly line: number | null;
}

/**
 * The structural shape {@link formatFindings} renders, wide enough for both a finding read back from
 * a stored review and one still on an orchestration result.
 */
export interface ReportedFinding {
  readonly severity: string;
  readonly message: string;
  readonly filePath?: string | null;
  readonly line?: number | null;
}

/**
 * The plan review as the human at the gate reads it: the verdict, the findings, and whether anything
 * is still unresolved.
 *
 * Every field is derived from the stored `plan_review` artifact — the review is already one of the
 * three digests plan approval freezes, so the bytes this reads are the bytes approval accepts. No
 * session field carries any of it (D-13), which is why the reading is tolerant: the artifact's shape
 * is whatever the reviewer wrote, and a document that says nothing yields an empty report rather
 * than a failure.
 */
export interface PlanReviewReport {
  /** The reviewer's verdict as written, or `null` when the document records none. */
  readonly verdict: string | null;
  /** The reviewer's summary sentence as written, or `null`. */
  readonly summary: string | null;
  /** The findings in the order the document listed them. */
  readonly findings: readonly PlanReviewFinding[];
  /**
   * Whether approval should require an explicit acknowledgement: the verdict asks for a fix, or any
   * finding is reported at `error` severity.
   */
  readonly unresolved: boolean;
}

const EMPTY_REPORT: PlanReviewReport = {
  verdict: null,
  summary: null,
  findings: [],
  unresolved: false,
};

/** `needs_fix`, `Needs Fix`, and `needs fix` are one verdict for the purpose of this reading. */
function verdictKey(verdict: string): string {
  return verdict.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * The document inside the artifact, or `null` when there is nothing to read.
 *
 * A JSON artifact arrives already parsed, but a reviewer that wrote its document as a string — or a
 * caller holding the raw bytes — is read the same way rather than dropped, because the difference
 * between "said nothing" and "was stored oddly" is not one a human should have to care about at an
 * approval gate.
 */
function documentOf(artifact: unknown): Record<string, unknown> | null {
  if (isRecord(artifact)) {
    return artifact;
  }

  if (typeof artifact === "string") {
    try {
      const parsed: unknown = JSON.parse(artifact);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function findingOf(value: unknown): PlanReviewFinding | null {
  if (!isRecord(value)) {
    return null;
  }

  const message = nonEmptyString(value["message"]);

  if (message === null) {
    return null;
  }

  const severity = nonEmptyString(value["severity"])?.toLowerCase() ?? "info";
  const filePath = nonEmptyString(value["filePath"]);
  const line = value["line"];

  return {
    severity,
    message,
    filePath,
    line: typeof line === "number" && Number.isInteger(line) ? line : null,
  };
}

/**
 * Reads the stored plan review for display and for the acknowledgement gate at approval.
 *
 * Nothing here throws and nothing here guesses: a missing artifact, a document without a verdict,
 * and a findings entry without a message all resolve to "recorded nothing". The two keys the verdict
 * is read from are `verdict` — what the reviewer's own deliverable calls it — and `outcome`, which
 * catches a reviewer that echoed the response protocol's own field into its document.
 */
export function planReviewReport(artifact: unknown): PlanReviewReport {
  const document = documentOf(artifact);

  if (document === null) {
    return EMPTY_REPORT;
  }

  const verdict = nonEmptyString(document["verdict"]) ?? nonEmptyString(document["outcome"]);
  const summary = nonEmptyString(document["summary"]);
  const rawFindings = document["findings"];
  const findings =
    rawFindings === undefined || !Array.isArray(rawFindings)
      ? []
      : rawFindings
          .map(findingOf)
          .filter((finding): finding is PlanReviewFinding => finding !== null);
  const unresolved =
    (verdict !== null && verdictKey(verdict) === "needs-fix") ||
    findings.some((finding) => finding.severity === "error");

  if (verdict === null && summary === null && findings.length === 0) {
    return EMPTY_REPORT;
  }

  return { verdict, summary, findings, unresolved };
}

/**
 * Strips what must not reach a terminal and fits the line to the limit.
 *
 * Control characters go first because a model-authored message may carry a newline that would split
 * one finding across lines, or an escape sequence that would rewrite the terminal it is printed on.
 * They are replaced character by character rather than with a `[\u0000-\u001f]` pattern, which this
 * repository's lint refuses to allow anywhere. The clip comes last so it counts the line a human
 * actually sees.
 */
function renderLine(text: string): string {
  const printable = text
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .replace(/ {2,}/g, " ")
    .replace(/\s+$/, "");

  return printable.length <= PLAN_REVIEW_LINE_LIMIT
    ? printable
    : `${printable.slice(0, PLAN_REVIEW_LINE_LIMIT - 1)}…`;
}

function locationOf(finding: ReportedFinding): string {
  if (finding.filePath === null || finding.filePath === undefined) {
    return "";
  }

  return finding.line === null || finding.line === undefined
    ? ` (${finding.filePath})`
    : ` (${finding.filePath}:${String(finding.line)})`;
}

/**
 * Renders findings one line each: severity, message, and location when there is one.
 *
 * Used for the review at the gate and for the findings a failed run reports, which is the same text
 * in both places for the same reason — a finding a human cannot read is a finding they cannot act
 * on. An empty list renders nothing at all, so a caller can print the result unconditionally.
 */
export function formatFindings(findings: readonly ReportedFinding[]): readonly string[] {
  return findings.map((finding) =>
    renderLine(`  [${finding.severity}] ${finding.message}${locationOf(finding)}`),
  );
}

/**
 * Renders a stored review for the human deciding at the gate: a verdict line, the reviewer's own
 * summary, then the findings.
 *
 * An empty report renders nothing, which is what a feature whose review recorded no findings (or no
 * review at all) should print everywhere this is called. A review that is unresolved but recorded no
 * findings still gets its verdict line, because "needs fix, no findings listed" is exactly the kind
 * of answer a human needs to see rather than have silently swallowed.
 */
export function formatPlanReview(report: PlanReviewReport): readonly string[] {
  if (report.findings.length === 0 && !report.unresolved) {
    return [];
  }

  const lines = [
    renderLine(
      report.verdict === null
        ? "Plan review: no verdict recorded"
        : `Plan review: ${report.verdict}`,
    ),
  ];

  if (report.summary !== null) {
    lines.push(renderLine(`  ${report.summary}`));
  }

  if (report.findings.length === 0) {
    lines.push(renderLine(" No findings were recorded."));
    return lines;
  }

  return [...lines, ...formatFindings(report.findings)];
}
