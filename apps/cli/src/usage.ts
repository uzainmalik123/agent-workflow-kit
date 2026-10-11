import {
  isAvailableUsage,
  usageFromManifestValue,
  type InvocationUsage,
} from "@agent-workflow-kit/opencode";
import { findAllRecordings } from "./recordings.js";

/**
 * One attempt's usage, as its own manifest recorded it.
 *
 * Every invocation directory is one attempt: retries of a rejected reply each
 * ran the transport once and each wrote one manifest, and fixer loops run as
 * their own stages with their own manifests. Counting directories therefore
 * counts every attempt, including retries and fixer loops.
 */
export interface UsageAttempt {
  readonly stage: string;
  /** 1-based within its stage when the Task M annotation is present, else position. */
  readonly attempt: number | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly usage: InvocationUsage | null;
  readonly folder: string;
}

export interface UsageSummary {
  readonly attempts: readonly UsageAttempt[];
  readonly attemptCount: number;
  readonly availableCount: number;
  readonly unavailableCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
}

function usageOrNull(manifest: Record<string, unknown>): InvocationUsage | null {
  return usageFromManifestValue(manifest);
}

/**
 * Every recorded attempt for one feature, oldest first, across both recording
 * locations (the project's own recordings and the workspace cache).
 *
 * Best-effort: a feature with no recordings yields an empty summary rather
 * than an error, so `usage` and `status` keep working before any stage ran.
 */
export async function collectUsage(repoRoot: string, featureId: string): Promise<UsageSummary> {
  const recordings = await findAllRecordings(repoRoot, featureId);
  const attempts: UsageAttempt[] = recordings.map((recording) => ({
    stage: recording.stage,
    attempt: recording.attempt,
    startedAt: recording.startedAt,
    durationMs: recording.durationMs,
    usage: usageOrNull(recording.manifest),
    folder: recording.folder,
  }));

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cost = 0;
  let availableCount = 0;

  for (const attempt of attempts) {
    if (attempt.usage !== null && isAvailableUsage(attempt.usage)) {
      availableCount += 1;
      inputTokens += attempt.usage.inputTokens;
      outputTokens += attempt.usage.outputTokens;
      reasoningTokens += attempt.usage.reasoningTokens;
      cacheReadTokens += attempt.usage.cacheReadTokens;
      cacheWriteTokens += attempt.usage.cacheWriteTokens;
      cost += attempt.usage.cost;
    }
  }

  return {
    attempts,
    attemptCount: attempts.length,
    availableCount,
    unavailableCount: attempts.length - availableCount,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
  };
}

function formatTokens(value: number): string {
  return String(value);
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function usageCell(attempt: UsageAttempt): string {
  const usage = attempt.usage;

  if (usage === null || !isAvailableUsage(usage)) {
    return "unavailable";
  }

  return (
    `in ${formatTokens(usage.inputTokens)} / out ${formatTokens(usage.outputTokens)} / ` +
    `reason ${formatTokens(usage.reasoningTokens)} / cache R ${formatTokens(usage.cacheReadTokens)} / ` +
    `W ${formatTokens(usage.cacheWriteTokens)} / ${formatCost(usage.cost)}`
  );
}

/**
 * A human-readable table, one row per stage attempt plus totals.
 *
 * Labeled as best-effort OpenCode reporting, because the numbers are whatever
 * OpenCode's session export said after each run, and a run whose usage could
 * not be read contributes an "unavailable" row that still counts as an attempt.
 */
export function formatUsageTable(featureId: string, summary: UsageSummary): string {
  const lines: string[] = [];
  lines.push(`Usage for ${featureId} (as reported by OpenCode, best effort):`);

  if (summary.attemptCount === 0) {
    lines.push("No recorded attempts.");
    return lines.join("\n");
  }

  lines.push("stage | attempt | usage");
  lines.push("--- | --- | ---");

  // Number attempts per stage in display order when the manifest lacks the
  // Task M attempt number, so retries still read as 1, 2, 3 within a stage.
  const perStageSeen = new Map<string, number>();

  for (const attempt of summary.attempts) {
    const seen = (perStageSeen.get(attempt.stage) ?? 0) + 1;
    perStageSeen.set(attempt.stage, seen);
    const attemptLabel = attempt.attempt ?? seen;
    lines.push(`${attempt.stage} | ${String(attemptLabel)} | ${usageCell(attempt)}`);
  }

  lines.push(
    `Totals: ${String(summary.attemptCount)} attempt(s) ` +
      `(${String(summary.availableCount)} with usage, ${String(summary.unavailableCount)} unavailable), ` +
      `input ${formatTokens(summary.inputTokens)}, output ${formatTokens(summary.outputTokens)}, ` +
      `reasoning ${formatTokens(summary.reasoningTokens)}, cache read ${formatTokens(summary.cacheReadTokens)}, ` +
      `cache write ${formatTokens(summary.cacheWriteTokens)}, cost ${formatCost(summary.cost)}`,
  );

  return lines.join("\n");
}

/** The one totals line `agentflow status` shows. */
export function formatUsageTotalsLine(summary: UsageSummary): string {
  if (summary.attemptCount === 0) {
    return "Usage (as reported by OpenCode, best effort): no recorded attempts";
  }

  return (
    `Usage (as reported by OpenCode, best effort): ${String(summary.attemptCount)} attempt(s), ` +
    `input ${formatTokens(summary.inputTokens)}, output ${formatTokens(summary.outputTokens)}, ` +
    `reasoning ${formatTokens(summary.reasoningTokens)}, cache read ${formatTokens(summary.cacheReadTokens)}, ` +
    `cache write ${formatTokens(summary.cacheWriteTokens)}, cost ${formatCost(summary.cost)}`
  );
}

/** Machine-readable form for `--json`. */
export function usageToJson(featureId: string, summary: UsageSummary): Record<string, unknown> {
  return {
    featureId,
    label: "as reported by OpenCode, best effort",
    attemptCount: summary.attemptCount,
    availableCount: summary.availableCount,
    unavailableCount: summary.unavailableCount,
    totals: {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      reasoningTokens: summary.reasoningTokens,
      cacheReadTokens: summary.cacheReadTokens,
      cacheWriteTokens: summary.cacheWriteTokens,
      cost: summary.cost,
    },
    attempts: summary.attempts.map((attempt) => {
      const usage = attempt.usage;

      if (usage === null || !isAvailableUsage(usage)) {
        return {
          stage: attempt.stage,
          attempt: attempt.attempt,
          startedAt: attempt.startedAt,
          durationMs: attempt.durationMs,
          usage: "unavailable",
        };
      }

      return {
        stage: attempt.stage,
        attempt: attempt.attempt,
        startedAt: attempt.startedAt,
        durationMs: attempt.durationMs,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cost: usage.cost,
          source: usage.source,
        },
      };
    }),
  };
}
