import type { FinalGateResult, FinalGateStageResult } from "./final-gate.js";
import type { FixAttemptRecord } from "./fix-history.js";
import { latestRecordedSecurityReview } from "./security.js";
import type { WorkspaceChanges } from "./workspace.js";

/**
 * The final summary.
 *
 * This is the document a human is asked to read before they approve publishing, which is the only
 * reason it exists, and that single purpose decides every property below.
 *
 * - **It is composed here, not written by a model.** The `final_summary` stage declares no output slot
 *   for an agent to fill, and this renderer is what lands in `final-summary.md`. A summary a model
 *   wrote is a second account of the same evidence, and a human approving publishing is entitled to
 *   approve the framework's own reading of its records rather than a paraphrase of them.
 * - **It only states what the artifacts state.** Every line below is read from a recorded artifact or
 *   measured from the tree, and a section whose source is absent says so in those words. Nothing here
 *   infers a verdict the framework did not record, and in particular it never decides that a plan step
 *   is "complete": no stage records that, so the summary reports what the measurement can support —
 *   which of the step's approved files the change set contains — and leaves the judgement to the human.
 * - **It is read-only.** This module takes parsed artifacts and a measured change set and returns a
 *   string. It reads no filesystem, runs no command, consults no provider, and holds no clock, so the
 *   same records always produce the same document and composing one cannot change any of them.
 * - **It is bounded.** A summary that grew without limit would stop being a summary, so every list is
 *   capped and says how many entries it elided rather than silently dropping them.
 */

/** How many entries any one section lists before it reports the remainder as a count. */
export const MAX_SUMMARY_ITEMS = 50;

/** How much of a recorded sentence the summary quotes before it clips it. */
export const MAX_SUMMARY_TEXT = 200;

const NOT_RECORDED = "not recorded";

/**
 * One measured plan step.
 *
 * The three states are measurements, not verdicts: `observed` means every file the approved plan named
 * for this step appears in the measured change set, `partial` means some do, and `unrecorded` means the
 * plan named none. A step whose files are all present is not thereby finished — nothing in the
 * framework's records says so — which is why the summary says which files it saw instead of claiming
 * the work is done.
 */
export const SUMMARY_STEP_STATUSES = ["observed", "partial", "unrecorded"] as const;

export type SummaryStepStatus = (typeof SUMMARY_STEP_STATUSES)[number];

export interface FinalSummaryInput {
  readonly featureId: string;
  readonly title: string;
  /** The session revision this summary is being recorded at. */
  readonly revision: number;
  /**
   * The working-tree fingerprint measured while this summary was composed, or null when no change set
   * could be measured. Null is stated as such rather than rendered as an empty digest, because "the
   * tree could not be measured" and "the tree is the empty digest" are different facts.
   */
  readonly fingerprint: string | null;
  /** The approved specification artifact, parsed. */
  readonly spec: unknown;
  /** The approved plan artifact, parsed. */
  readonly plan: unknown;
  /** The recorded gate result this summary is written from. */
  readonly gate: FinalGateResult;
  /** The recorded security review artifact, parsed, for the check-level result. */
  readonly security: unknown;
  /** The recorded fix history, in order. */
  readonly fixes: readonly FixAttemptRecord[];
  /** The change set measured for this stage, which is what "changed files" means here. */
  readonly changes: WorkspaceChanges;
  readonly scope: {
    /** Whether the framework looked at the tree. False means the lists below are empty by necessity. */
    readonly measured: boolean;
    readonly approvedPatterns: readonly string[];
    readonly unauthorizedPaths: readonly string[];
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Reading the records                                                                            */
/* -------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * One line, one sentence length.
 *
 * Whitespace runs collapse to single spaces so a recorded paragraph becomes a list item rather than
 * four, and the clip is on characters rather than words so the bound is the same whatever the content.
 */
function clip(value: string | null): string {
  if (value === null) {
    return NOT_RECORDED;
  }

  const collapsed = value.replace(/\s+/gu, " ").trim();

  if (collapsed.length === 0) {
    return NOT_RECORDED;
  }

  return collapsed.length > MAX_SUMMARY_TEXT ? `${collapsed.slice(0, MAX_SUMMARY_TEXT - 1)}…` : collapsed;
}

function entries(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

interface SummaryRequirement {
  readonly id: string;
  readonly title: string;
  readonly criteriaCount: number;
}

function requirementsFrom(spec: unknown): readonly SummaryRequirement[] {
  return entries(isRecord(spec) ? spec["requirements"] : null)
    .map((requirement) => {
      const id = textField(requirement["id"]);

      if (id === null) {
        return null;
      }

      return {
        id,
        title: clip(textField(requirement["title"]) ?? textField(requirement["description"])),
        criteriaCount: Array.isArray(requirement["acceptanceCriteria"])
          ? requirement["acceptanceCriteria"].filter(isRecord).length
          : 0,
      };
    })
    .filter((requirement): requirement is SummaryRequirement => requirement !== null);
}

interface SummaryStep {
  readonly id: string;
  readonly description: string;
  readonly status: SummaryStepStatus;
  readonly observedFiles: number;
  readonly expectedFileCount: number;
}

function stepStatusFor(expectedFiles: readonly string[], changes: WorkspaceChanges): {
  readonly status: SummaryStepStatus;
  readonly observedFiles: number;
} {
  if (expectedFiles.length === 0) {
    return { status: "unrecorded", observedFiles: 0 };
  }

  const present = new Set(observedPathsOf(changes));
  const observed = expectedFiles.filter((path) => present.has(path)).length;

  return {
    status: observed === expectedFiles.length ? "observed" : "partial",
    observedFiles: observed,
  };
}

function stepsFrom(plan: unknown, changes: WorkspaceChanges): readonly SummaryStep[] {
  return entries(isRecord(plan) ? plan["steps"] : null)
    .map((step, index) => {
      const id = textField(step["id"]) ?? `step ${String(index + 1)}`;
      const expectedFiles = Array.isArray(step["expectedFiles"])
        ? step["expectedFiles"].filter((file): file is string => typeof file === "string")
        : [];
      const measured = stepStatusFor(expectedFiles, changes);

      return {
        id,
        description: clip(textField(step["description"])),
        status: measured.status,
        observedFiles: measured.observedFiles,
        expectedFileCount: expectedFiles.length,
      };
    });
}

function observedPathsOf(changes: WorkspaceChanges): readonly string[] {
  return [
    ...changes.modified,
    ...changes.added,
    ...changes.deleted,
    ...changes.untracked,
    ...changes.renamed.flatMap((rename) => [rename.from, rename.to]),
  ];
}

/** One line per changed path, each labelled with the category it was measured in. */
function changedFileLines(changes: WorkspaceChanges): readonly string[] {
  const lines: string[] = [];

  for (const path of [...changes.modified].sort()) {
    lines.push(`- ${path} (modified)`);
  }

  for (const path of [...changes.added].sort()) {
    lines.push(`- ${path} (added)`);
  }

  for (const path of [...changes.deleted].sort()) {
    lines.push(`- ${path} (deleted)`);
  }

  for (const rename of [...changes.renamed].sort((left, right) =>
    left.from.localeCompare(right.from),
  )) {
    lines.push(`- ${rename.from} → ${rename.to} (renamed)`);
  }

  for (const path of [...changes.untracked].sort()) {
    lines.push(`- ${path} (untracked)`);
  }

  return lines;
}

function securityCheckCounts(
  evidence: ReturnType<typeof latestRecordedSecurityReview>,
): { readonly passed: number; readonly failed: number; readonly inconclusive: number } {
  if (evidence === null) {
    return { passed: 0, failed: 0, inconclusive: 0 };
  }

  let passed = 0;
  let failed = 0;
  let inconclusive = 0;

  for (const check of evidence.checks) {
    if (check.result === "passed") {
      passed += 1;
    } else if (check.result === "failed") {
      failed += 1;
    } else {
      inconclusive += 1;
    }
  }

  return { passed, failed, inconclusive };
}

function verificationLines(gate: FinalGateResult): readonly string[] {
  const stages = verificationStagesOf(gate);

  if (stages.length === 0) {
    return [`- ${NOT_RECORDED}: the recorded gate carries no per-stage verification results.`];
  }

  return stages.map((stage) => {
    const measured = stage.revision === null ? "" : ` at revision ${String(stage.revision)}`;

    const against = stage.fingerprint === null ? "" : ` against tree ${stage.fingerprint}`;

    return `- ${stage.verification} (${stage.stage}): ${stage.status}${measured}${against}`;
  });
}

/**
 * The per-stage verdicts, or an empty list when the recorded gate carries none.
 *
 * A gate document that passed {@link recordedFinalGateFrom} is typed, but it was still parsed from
 * disk, so the list is checked rather than assumed. This costs a summary one line in the worst case and
 * cannot crash one: a document that reached the renderer has already been refused if its status,
 * revision, and fingerprint were unusable, and an absent list is the only remaining shape a caller
 * might hand over.
 */
function verificationStagesOf(gate: FinalGateResult): readonly FinalGateStageResult[] {
  const stages: unknown = gate.verificationStages;

  return Array.isArray(stages) ? (stages as FinalGateStageResult[]) : [];
}

function fixerLines(fixes: readonly FixAttemptRecord[]): readonly string[] {
  if (fixes.length === 0) {
    return ["- No fix attempt was recorded."];
  }

  const accepted = fixes.filter((entry) => entry.outcome === "accepted").length;
  const rejected = fixes.length - accepted;

  return [
    `- ${String(fixes.length)} recorded attempt(s): ${String(accepted)} accepted, ${String(rejected)} rejected.`,
    ...fixes.map(
      (entry) =>
        `- attempt ${String(entry.attempt)} ${entry.outcome} from "${entry.fixReturnState}" at revision ${String(entry.revisionBefore)}: ${clip(entry.failureSummary)}`,
    ),
  ];
}

/* -------------------------------------------------------------------------------------------- */
/* Rendering                                                                                      */
/* -------------------------------------------------------------------------------------------- */

function section(title: string, lines: readonly string[]): string[] {
  return [``, `## ${title}`, "", ...lines, ""];
}

/** The elision line for a list that was capped, which reports the count rather than hiding it. */
function elision(shown: number, total: number): readonly string[] {
  if (total <= shown) {
    return [];
  }

  return [`- … and ${String(total - shown)} more.`];
}

function capped(lines: readonly string[]): readonly string[] {
  return lines.length <= MAX_SUMMARY_ITEMS
    ? lines
    : [...lines.slice(0, MAX_SUMMARY_ITEMS), ...elision(MAX_SUMMARY_ITEMS, lines.length)];
}

/**
 * The summary document, and the whole of it.
 *
 * Given the same records this returns the same bytes: there is no clock, no ordering that depends on
 * anything but the input, and no prose of the renderer's own. Everything it says is a reading of a
 * recorded artifact, which is what makes it worth approving.
 */
export function buildFinalSummary(input: FinalSummaryInput): string {
  const { gate } = input;

  const requirements = requirementsFrom(input.spec);
  const steps = stepsFrom(input.plan, input.changes);
  const changedFiles = changedFileLines(input.changes);
  const security = latestRecordedSecurityReview(input.security);
  const checks = securityCheckCounts(security);

  const lines: string[] = [
    `# ${input.featureId} — ${input.title}`,
    "",
    `- Session revision: ${String(input.revision)}`,
    `- Working tree: ${input.fingerprint ?? NOT_RECORDED}`,
    `- Final gate: ${gate.status} at revision ${String(gate.revision)}`,
    "",
  ];

  lines.push(...section("Feature", [clip(descriptionOf(input.spec, input.plan))]));

  lines.push(
    ...section(
      "Approved requirements",
      capped(
        requirements.length === 0
          ? [`- ${NOT_RECORDED}: the approved specification declares no structured requirements.`]
          : requirements.map(
              (requirement) =>
                `- ${requirement.id} ${requirement.title} — ${String(requirement.criteriaCount)} acceptance criterion/criteria`,
            ),
      ),
    ),
  );

  lines.push(
    ...section(
      "Plan steps",
      capped(
        steps.length === 0
          ? [`- ${NOT_RECORDED}: the approved plan declares no steps.`]
          : steps.map((step) => {
              const measured =
                step.expectedFileCount === 0
                  ? "no expected files recorded"
                  : `${String(step.observedFiles)} of ${String(step.expectedFileCount)} expected file(s) in the measured change set (${step.status})`;

              return `- ${step.id} ${step.description} — ${measured}`;
            }),
      ),
    ),
  );

  lines.push(
    ...section(
      "Changed files",
      capped(
        input.scope.measured
          ? changedFiles.length === 0
            ? ["- The measured change set is empty."]
            : changedFiles
          : [`- ${NOT_RECORDED}: no change set was measured for this feature.`],
      ),
    ),
  );

  lines.push(...section("Verification", capped(verificationLines(gate))));

  lines.push(
    ...section("Security", [
      `- Gate result: ${gate.security}`,
      `- Recorded checks: ${String(checks.passed)} passed, ${String(checks.failed)} failed, ${String(checks.inconclusive)} inconclusive`,
      ...(security === null
        ? [`- ${NOT_RECORDED}: no security review record was found.`]
        : [
            `- Recorded at revision ${String(security.revision)} against tree ${security.workspaceFingerprint}.`,
          ]),
    ]),
  );

  lines.push(
    ...section("Scope", [
      `- Gate result: ${gate.scope}`,
      `- Approved patterns: ${String(input.scope.approvedPatterns.length)}`,
      `- Paths outside the approved plan: ${
        input.scope.measured ? String(input.scope.unauthorizedPaths.length) : NOT_RECORDED
      }`,
    ]),
  );

  lines.push(...section("Fixer history", capped(fixerLines(input.fixes))));

  lines.push(
    ...section("Final gate", [
      `- Status: ${gate.status}`,
      `- Verified at revision ${String(gate.revision)} against tree ${
        gate.fingerprint.length === 0 ? NOT_RECORDED : gate.fingerprint
      }`,
      `- Verification: ${gate.verification} · Security: ${gate.security} · Scope: ${gate.scope} · Approval: ${gate.approval} · Fixer: ${gate.fixer}`,
      `- Acceptance criteria checked: ${String(gate.criterionCount)}${
        gate.criteriaTruncated ? ` (list truncated)` : ""
      }`,
      `- Blockers: ${
        gate.blockers.length === 0
          ? "none"
          : gate.blockers.map((blocker) => `${blocker.code} (${blocker.route})`).join(", ")
      }`,
    ]),
  );

  return `${lines.join("\n")}\n`;
}

/**
 * One sentence describing the feature, from the specification first and the plan second.
 *
 * Both are read because the specification is what a human approved as the definition of the feature,
 * but a griller that wrote a plan-shaped spec is common enough that falling back to the plan's summary
 * describes the same work from the document that scoped it. Nothing else is consulted: a title is not
 * a description, and repeating the title would read like a description while saying nothing.
 */
function descriptionOf(spec: unknown, plan: unknown): string | null {
  const fromSpec = isRecord(spec)
    ? (textField(spec["summary"]) ?? textField(spec["description"]))
    : null;

  if (fromSpec !== null) {
    return fromSpec;
  }

  return isRecord(plan) ? textField(plan["summary"]) : null;
}