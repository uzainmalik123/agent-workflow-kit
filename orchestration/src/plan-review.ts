import { isRecord } from "./result-validation.js";

/**
 * How long one rendered line may get before it is wrapped.
 *
 * Kept for compatibility with callers that imported it; the renderer no longer
 * truncates. Findings wrap to the terminal width (100 columns when not a TTY)
 * instead, so no finding text is silently lost. The full text was and remains
 * in the stored artifact, which is what approval digests are taken over.
 */
export const PLAN_REVIEW_LINE_LIMIT = 120;

/** Width findings wrap to: the TTY width when available, otherwise 100 columns. */
export function terminalFindingsWidth(): number {
  const stdout = process.stdout as unknown as { columns?: unknown; isTTY?: unknown };
  if (stdout.isTTY === true && typeof stdout.columns === "number" && Number.isFinite(stdout.columns)) {
    return Math.max(40, Math.min(120, Math.floor(stdout.columns)));
  }
  return 100;
}

/**
 * The verdicts that count as a passing review, in their canonical form: lowercase, no separators.
 *
 * One constant, because the approval gate and every test must agree on exactly which words resolve
 * a review. Compared against the normalized verdict (see {@link verdictKey}), so `Pass`, `PASS`,
 * and ` pass ` are all `pass`. Anything else — `needs_fix`, an unknown string, or no verdict at
 * all — leaves the review unresolved (N2, fail closed: P-18).
 */
export const PLAN_REVIEW_RESOLVED_VERDICTS = [
  "pass",
  "passed",
  "approved",
  "ok",
  "success",
] as const;

export type PlanReviewResolvedVerdict =
  (typeof PLAN_REVIEW_RESOLVED_VERDICTS)[number];

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
 * session field carries any of it (D-13). The reading fails closed (N2, P-18): a missing,
 * unparseable, or empty artifact is unresolved, and only a verdict in
 * {@link PLAN_REVIEW_RESOLVED_VERDICTS} with no `error`-severity finding is resolved. A silent
 * document must never read as an approving one.
 */
export interface PlanReviewReport {
  /** The reviewer's verdict as written, or `null` when the document records none. */
  readonly verdict: string | null;
  /** The reviewer's summary sentence as written, or `null`. */
  readonly summary: string | null;
  /** The findings in the order the document listed them. */
  readonly findings: readonly PlanReviewFinding[];
  /**
   * Whether approval should require an explicit acknowledgement: anything but a passing verdict
   * with no `error`-severity finding.
   */
  readonly unresolved: boolean;
  /**
   * Why the review is unresolved, in words for the refusal and the display; `null` when resolved.
   * Unreadable reviews carry exactly `"review could not be read"`; every other reason names the
   * recorded verdict, or its absence.
   */
  readonly reason: string | null;
}

/** The reason an unreadable review carries, shared by the report, the display, and the refusal. */
export const PLAN_REVIEW_UNREADABLE_REASON = "review could not be read";

const EMPTY_REPORT: PlanReviewReport = {
  verdict: null,
  summary: null,
  findings: [],
  unresolved: true,
  reason: PLAN_REVIEW_UNREADABLE_REASON,
};

/**
 * One verdict for the purpose of this reading: lowercase, with every run of spaces, underscores,
 * and hyphens removed. `needs_fix`, `Needs Fix`, and `needs-fix` are one verdict, and `Pass` is
 * `pass` — which is the point, since the resolved set is matched in exactly this form.
 */
function verdictKey(verdict: string): string {
  return verdict.trim().toLowerCase().replace(/[\s_-]+/g, "");
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
 * Nothing here throws and nothing here guesses. A missing artifact, a document without a verdict,
 * and a findings entry without a message are all read as faithfully as they can be — and then the
 * review counts as unresolved unless its verdict is in {@link PLAN_REVIEW_RESOLVED_VERDICTS} and no
 * finding is at `error` severity. The two keys the verdict is read from are `verdict` — what the
 * reviewer's own deliverable calls it — and `outcome`, which catches a reviewer that echoed the
 * response protocol's own field into its document.
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

  if (verdict === null && summary === null && findings.length === 0) {
    return EMPTY_REPORT;
  }

  // Fail closed: an unknown verdict, a missing verdict, and a passing verdict with error-severity
  // findings are all unresolved. Only a known-passing verdict with nothing at `error` resolves.
  if (verdict === null || !isResolvedVerdict(verdict)) {
    return {
      verdict,
      summary,
      findings,
      unresolved: true,
      reason:
        verdict === null
          ? "no passing verdict recorded"
          : `verdict "${verdict}" is not a passing verdict`,
    };
  }

  if (findings.some((finding) => finding.severity === "error")) {
    return {
      verdict,
      summary,
      findings,
      unresolved: true,
      reason: `verdict "${verdict}" with error-severity findings`,
    };
  }

  return { verdict, summary, findings, unresolved: false, reason: null };
}

/** Whether a recorded verdict is one of {@link PLAN_REVIEW_RESOLVED_VERDICTS}. */
function isResolvedVerdict(verdict: string): boolean {
  const key = verdictKey(verdict);
  return PLAN_REVIEW_RESOLVED_VERDICTS.some((accepted) => accepted === key);
}

/**
 * Strips what must not reach a terminal.
 *
 * Control characters go first because a model-authored message may carry a newline that would split
 * one finding across lines, or an escape sequence that would rewrite the terminal it is printed on.
 * They are replaced character by character rather than with a `[\u0000-\u001f]` pattern, which this
 * repository's lint refuses to allow anywhere. Wrapping (not clipping) happens afterwards, so no
 * text is silently lost.
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

  return printable;
}

/**
 * Wraps one printable line to a width with a hanging indent.
 *
 * The first line is emitted as-is; every continuation line starts with four
 * spaces so wrapped findings stay visually attached to the finding they belong
 * to. Words wrap; a single word longer than the width is split rather than
 * pushing the line past the margin. Nothing is truncated.
 */
function wrapHanging(line: string, width: number): readonly string[] {
  const safeWidth = Math.max(40, Math.floor(width));
  if (line.length <= safeWidth) {
    return [line];
  }
  const continuation = "    ";
  const words = line.split(" ").filter((word) => word !== "");
  const lines: string[] = [];
  let current = "";
  const pushCurrent = (): void => {
    if (current === "") {
      return;
    }
    lines.push(lines.length === 0 ? current : `${continuation}${current}`);
    current = "";
  };
  for (const word of words) {
    if (current === "") {
      if (lines.length === 0 && word.length <= safeWidth) {
        current = word;
        continue;
      }
      if (lines.length === 0) {
        // First line: hard-split an over-long opening word.
        let rest = word;
        lines.push(rest.slice(0, safeWidth));
        rest = rest.slice(safeWidth);
        while (rest.length > safeWidth - continuation.length) {
          lines.push(`${continuation}${rest.slice(0, safeWidth - continuation.length)}`);
          rest = rest.slice(safeWidth - continuation.length);
        }
        current = rest;
        continue;
      }
      // Continuation line: hard-split an over-long word.
      let rest = word;
      while (rest.length > safeWidth - continuation.length) {
        lines.push(`${continuation}${rest.slice(0, safeWidth - continuation.length)}`);
        rest = rest.slice(safeWidth - continuation.length);
      }
      current = rest;
      continue;
    }
    const candidate = `${current} ${word}`;
    const limit = lines.length === 0 ? safeWidth : safeWidth - continuation.length;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (lines.length === 0 && word.length <= safeWidth) {
      current = word;
    } else {
      let rest = word;
      while (rest.length > safeWidth - continuation.length) {
        lines.push(`${continuation}${rest.slice(0, safeWidth - continuation.length)}`);
        rest = rest.slice(safeWidth - continuation.length);
      }
      current = rest;
    }
  }
  pushCurrent();
  return lines;
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
 * Renders findings wrapped to the terminal width, never truncated.
 *
 * Used for the review at the gate and for the findings a failed run reports, which is the same text
 * in both places for the same reason — a finding a human cannot read is a finding they cannot act
 * on. An empty list renders nothing at all, so a caller can print the result unconditionally.
 * Each finding may produce several lines: the first carries `  [severity] message`, continuations
 * carry a four-space hanging indent. Control characters are stripped; text is never cut with an
 * ellipsis. `width` defaults to the terminal width (100 columns when not a TTY) and is exposed so
 * tests can pin it.
 */
export function formatFindings(
  findings: readonly ReportedFinding[],
  width: number = terminalFindingsWidth(),
): readonly string[] {
  return findings.flatMap((finding) =>
    wrapHanging(renderLine(`  [${finding.severity}] ${finding.message}${locationOf(finding)}`), width),
  );
}

/**
 * Renders a stored review for the human deciding at the gate: a verdict line, the reviewer's own
 * summary, then the findings.
 *
 * A review that cannot be read renders its reason instead of nothing (N2, fail closed): an empty
 * report is exactly when a human most needs to be told, since the approval gate will refuse without
 * `--accept-findings`. A resolved review with no findings still renders nothing, which is what a
 * feature whose review is clean should print everywhere this is called. A review that is unresolved
 * but recorded no findings still gets its verdict line, because "needs fix, no findings listed" is
 * exactly the kind of answer a human needs to see rather than have silently swallowed.
 */
export function formatPlanReview(report: PlanReviewReport, width: number = terminalFindingsWidth()): readonly string[] {
  if (report.reason === PLAN_REVIEW_UNREADABLE_REASON) {
    return wrapHanging(renderLine(`Plan review: ${PLAN_REVIEW_UNREADABLE_REASON}`), width);
  }

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
    return lines.flatMap((line) => wrapHanging(line, width));
  }

  return [...lines.flatMap((line) => wrapHanging(line, width)), ...formatFindings(report.findings, width)];
}
