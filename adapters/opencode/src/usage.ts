import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { DEFAULT_OPENCODE_COMMAND } from "./cli-transport.js";

const execFileAsync = promisify(execFile);

/**
 * Token usage for one OpenCode attempt, as reported by OpenCode itself.
 *
 * Recorded best-effort into each attempt's `invocation.json` alongside the
 * Task M reply-verdict fields (`attempt`, `responseOutcome`). A recording that
 * cannot supply usage keeps the stage's outcome unchanged; it records
 * "unavailable" instead.
 */
export interface AvailableInvocationUsage {
  readonly status: "available";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
  /** Where the numbers came from; always `opencode-session-export` when available. */
  readonly source: "opencode-session-export";
  /** The OpenCode session the numbers were read from. */
  readonly sessionId: string;
}

export interface UnavailableInvocationUsage {
  readonly status: "unavailable";
  readonly source: "unavailable";
  readonly reason: string;
}

export type InvocationUsage = AvailableInvocationUsage | UnavailableInvocationUsage;

/** The shape the task requires when usage is available. */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
}

export function unavailableUsage(reason: string): UnavailableInvocationUsage {
  return { status: "unavailable", source: "unavailable", reason };
}

export function isAvailableUsage(value: unknown): value is AvailableInvocationUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    record["status"] === "available" &&
    typeof record["inputTokens"] === "number" &&
    typeof record["outputTokens"] === "number" &&
    typeof record["reasoningTokens"] === "number" &&
    typeof record["cacheReadTokens"] === "number" &&
    typeof record["cacheWriteTokens"] === "number" &&
    typeof record["cost"] === "number" &&
    record["source"] === "opencode-session-export"
  );
}

/** Reads `usage` from a parsed `invocation.json` value, or `null` when absent/unusable. */
export function usageFromManifestValue(value: unknown): InvocationUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const usage = record["usage"];

  if (usage === "unavailable") {
    return unavailableUsage("recorded as unavailable");
  }

  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return null;
  }

  const candidate = usage as Record<string, unknown>;

  if (candidate["source"] === "unavailable" || candidate["status"] === "unavailable") {
    const reason =
      typeof candidate["reason"] === "string" && candidate["reason"].length > 0
        ? candidate["reason"]
        : "recorded as unavailable";
    return unavailableUsage(reason);
  }

  if (!isAvailableUsage(candidate)) {
    return null;
  }

  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}

function toNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

/**
 * Parses `opencode session export <id>` JSON into usage.
 *
 * Reads `info.tokens { input, output, reasoning, cache: { read, write } }`
 * and `info.cost`, the same numbers the session database holds. Returns an
 * unavailable marker rather than throwing when the shape is unusable.
 */
export function parseUsageFromExport(exportJson: unknown, sessionId: string): InvocationUsage {
  if (!isRecord(exportJson)) {
    return unavailableUsage("export was not a JSON object");
  }

  const info = exportJson["info"];

  if (!isRecord(info)) {
    return unavailableUsage("export had no info object");
  }

  const tokens = info["tokens"];

  if (!isRecord(tokens)) {
    return unavailableUsage("export had no tokens object");
  }

  const cache = tokens["cache"];
  const inputTokens = toNonNegativeInt(tokens["input"]);
  const outputTokens = toNonNegativeInt(tokens["output"]);
  const reasoningTokens = toNonNegativeInt(tokens["reasoning"]);
  const cacheReadTokens = isRecord(cache) ? toNonNegativeInt(cache["read"]) : 0;
  const cacheWriteTokens = isRecord(cache) ? toNonNegativeInt(cache["write"]) : 0;
  const cost = toNonNegativeNumber(info["cost"]);

  if (
    inputTokens === null ||
    outputTokens === null ||
    reasoningTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    cost === null
  ) {
    return unavailableUsage("export tokens or cost were not non-negative numbers");
  }

  return {
    status: "available",
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
    source: "opencode-session-export",
    sessionId,
  };
}

/** How long a usage lookup may take; it must never stall a stage. */
export const USAGE_LOOKUP_TIMEOUT_MS = 15_000;

/** Upper bound on `session list` / `session export` output kept in memory. */
const USAGE_MAX_OUTPUT_BYTES = 4_000_000;

export interface UsageLookupOptions {
  /** The OpenCode executable. Defaults to `opencode` on `PATH`. */
  readonly command?: string;
  readonly timeoutMs?: number;
}

function lookupCommand(options?: UsageLookupOptions): string {
  return options?.command ?? DEFAULT_OPENCODE_COMMAND;
}

function lookupTimeout(options?: UsageLookupOptions): number {
  return options?.timeoutMs ?? USAGE_LOOKUP_TIMEOUT_MS;
}

/**
 * Lists session IDs for the project containing `workingDirectory`, newest first.
 *
 * Best-effort: any failure yields an empty list rather than a throw, so a
 * usage lookup can never fail a stage.
 */
export async function listSessionIds(
  workingDirectory: string,
  options?: UsageLookupOptions,
): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(
      lookupCommand(options),
      ["session", "list", "--format", "json"],
      {
        cwd: workingDirectory,
        timeout: lookupTimeout(options),
        maxBuffer: USAGE_MAX_OUTPUT_BYTES,
        shell: false,
      },
    );

    const parsed = JSON.parse(stdout) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    const ids: string[] = [];

    for (const entry of parsed) {
      if (isRecord(entry) && typeof entry["id"] === "string" && entry["id"].length > 0) {
        ids.push(entry["id"]);
      }
    }

    return ids;
  } catch {
    return [];
  }
}

/**
 * Exports one session and parses its usage.
 *
 * Best-effort: any failure yields an unavailable marker rather than a throw.
 */
export async function exportSessionUsage(
  sessionId: string,
  workingDirectory: string,
  options?: UsageLookupOptions,
): Promise<InvocationUsage> {
  if (sessionId.length === 0) {
    return unavailableUsage("empty session id");
  }

  try {
    const { stdout } = await execFileAsync(lookupCommand(options), ["session", "export", sessionId], {
      cwd: workingDirectory,
      timeout: lookupTimeout(options),
      maxBuffer: USAGE_MAX_OUTPUT_BYTES,
      shell: false,
    });

    return parseUsageFromExport(JSON.parse(stdout) as unknown, sessionId);
  } catch {
    return unavailableUsage("session export failed");
  }
}

/**
 * Finds usage for one just-finished `opencode run`.
 *
 * `beforeIds` are the session IDs seen before the run; the first ID seen
 * after the run that was not there before is the run's session, because each
 * stage is one fresh `--standalone` session and stages run sequentially. When
 * the before-listing failed, the newest session after the run is used as a
 * fallback. When nothing new is found, or the export fails, the result is an
 * unavailable marker — never a throw.
 *
 * This performs no stage invocation of its own: it only observes sessions
 * with `session list` / `session export` after the run finished, so the
 * transport's argv, format, and response parsing are untouched.
 */
export async function findUsageForRun(
  beforeIds: ReadonlySet<string> | readonly string[],
  workingDirectory: string,
  options?: UsageLookupOptions,
): Promise<InvocationUsage> {
  const before = new Set<string>(beforeIds);
  const after = await listSessionIds(workingDirectory, options);

  if (after.length === 0) {
    return unavailableUsage("no sessions listed after the run");
  }

  const fresh = after.find((id) => !before.has(id));
  const candidate = fresh ?? (before.size === 0 ? after[0] : undefined);

  if (candidate === undefined) {
    return unavailableUsage("no new session for the run");
  }

  return exportSessionUsage(candidate, workingDirectory, options);
}

/**
 * Writes usage into an invocation's manifest, keeping every field already there.
 *
 * Best-effort, like every write in the recorder: a manifest that cannot be
 * read or rewritten leaves the recording exactly as it was, and a stage's
 * outcome never changes because usage could not be recorded.
 */
export async function annotateInvocationUsage(
  manifestPath: string,
  usage: InvocationUsage,
): Promise<void> {
  try {
    const text = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(text) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }

    const annotated = {
      ...(parsed as Record<string, unknown>),
      usage,
    };

    await writeFile(manifestPath, `${JSON.stringify(annotated, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort by design.
  }
}
