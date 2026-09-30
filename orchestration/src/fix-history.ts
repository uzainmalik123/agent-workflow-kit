import { WorkflowState, type FixReturnState } from "@agent-workflow-kit/core";
import { FIX_ATTEMPT_OUTCOMES, PersistenceError } from "@agent-workflow-kit/persistence";
import type {
  FeatureMutationReader,
  FixAttemptOutcome,
  FixHistoryDocument,
  FixHistoryEntry,
  FixIntegrityRecord,
} from "@agent-workflow-kit/persistence";
import type { OrchestrationError } from "./errors.js";
import { orchestrationError } from "./errors.js";
import type { FixIntegritySnapshot } from "./fix-policy.js";

const FIX_HISTORY_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type FixHistoryOutcome =
  | { readonly ok: true; readonly document: FixHistoryDocument }
  | { readonly ok: false; readonly error: OrchestrationError };

export type FixHistoryRead =
  | { readonly ok: true; readonly entries: readonly FixHistoryEntry[] }
  | { readonly ok: false; readonly error: OrchestrationError };

/** One attempt as the framework measured it, before the history document adds its sequence. */
export interface FixAttemptRecord {
  readonly attempt: number;
  readonly fixReturnState: FixReturnState;
  readonly outcome: FixAttemptOutcome;
  readonly failureSummary: string | null;
  readonly revisionBefore: number;
  readonly implementationFingerprint: string | null;
  readonly changedPaths: readonly string[];
  readonly integrity: FixIntegritySnapshot;
  readonly report: unknown;
}

export function integrityRecordOf(snapshot: FixIntegritySnapshot): FixIntegrityRecord {
  return {
    specSha256: snapshot.specSha256,
    planSha256: snapshot.planSha256,
    planReviewSha256: snapshot.planReviewSha256,
    verificationConfigSha256: snapshot.verificationConfigSha256,
  };
}

/**
 * Parses a stored fix history, or explains why it cannot be used.
 *
 * Reading is as strict as writing, and for the same reason: a fix history is the audit trail of the
 * one stage in the workflow that writes code, so a document the framework cannot interpret is a
 * reason to stop rather than a reason to start again from an empty list. Overwriting it would
 * destroy the record of what the fixer already did.
 */
export function parseFixHistory(raw: unknown): FixHistoryRead {
  if (raw === undefined || raw === null) {
    return { ok: true, entries: [] };
  }

  if (!isRecord(raw)) {
    return {
      ok: false,
      error: orchestrationError(
        "unmergeable_artifact",
        "Artifact \"fixes\" does not hold a fix history document and will not be overwritten.",
      ),
    };
  }

  if (raw["schemaVersion"] !== FIX_HISTORY_SCHEMA_VERSION) {
    return {
      ok: false,
      error: orchestrationError(
        "unmergeable_artifact",
        "Artifact \"fixes\" declares an unsupported schema version.",
      ),
    };
  }

  const fixes = raw["fixes"];

  if (!Array.isArray(fixes)) {
    return {
      ok: false,
      error: orchestrationError(
        "unmergeable_artifact",
        "Artifact \"fixes\" does not contain a fix list.",
      ),
    };
  }

  // Each entry is validated on its own terms before the list is trusted. The fields that later code
  // depends on without rechecking — the attempt number that decides whether the loop still has budget,
  // the outcome that decides whether the next attempt counts, the digests that decide whether the plan
  // still matches what was approved — are exactly the ones a truncated write or a hand edit would leave
  // looking plausible. An entry that fails here is reported by its position, because "the history is
  // corrupt" is not something a human can act on and "entry 3 has no outcome" is.
  const entries: FixHistoryEntry[] = [];

  for (const [index, value] of fixes.entries()) {
    const entry = parseFixEntry(value, index);

    if (entry === null) {
      return {
        ok: false,
        error: orchestrationError(
          "unmergeable_artifact",
          `Artifact "fixes" entry ${String(index + 1)} is not a fix history entry the framework wrote, so the history is not trusted and will not be overwritten.`,
        ),
      };
    }

    entries.push(entry);
  }

  return { ok: true, entries };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isDigestOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SHA256_PATTERN.test(value));
}

function parseFixEntry(value: unknown, index: number): FixHistoryEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!Number.isInteger(value["sequence"]) || value["sequence"] !== index + 1) {
    // The framework numbers entries from one, in order, as it appends them. A gap means something
    // between two attempts wrote to this artifact, which is not something a repair loop is allowed to
    // do, and continuing would report an attempt count that does not match the record.
    return null;
  }

  if (!Number.isInteger(value["attempt"]) || (value["attempt"] as number) < 1) {
    return null;
  }

  if (!isFixReturnState(value["fixReturnState"])) {
    return null;
  }

  // Derived from the contract's own list rather than repeated here, so adding an outcome cannot leave
  // the writer able to produce entries its own reader then refuses.
  if (!(FIX_ATTEMPT_OUTCOMES as readonly unknown[]).includes(value["outcome"])) {
    return null;
  }

  if (!isNullableString(value["failureSummary"]) || typeof value["recordedAt"] !== "string") {
    return null;
  }

  if (!Number.isInteger(value["revisionBefore"]) || !Number.isInteger(value["revisionAfter"])) {
    return null;
  }

  if (!Number.isInteger(value["sessionRevision"])) {
    return null;
  }

  if (!isNullableString(value["implementationFingerprint"])) {
    return null;
  }

  const changedPaths = value["changedPaths"];

  if (
    !Array.isArray(changedPaths) ||
    !changedPaths.every((path) => typeof path === "string" && path.length > 0)
  ) {
    return null;
  }

  const integrity = value["integrity"];

  if (
    !isRecord(integrity) ||
    !isDigestOrNull(integrity["specSha256"]) ||
    !isDigestOrNull(integrity["planSha256"]) ||
    !isDigestOrNull(integrity["planReviewSha256"]) ||
    !isDigestOrNull(integrity["verificationConfigSha256"])
  ) {
    return null;
  }

  return value as unknown as FixHistoryEntry;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

async function readExistingFixes(reader: {
  readArtifact(name: "fixes"): Promise<unknown>;
}): Promise<FixHistoryRead> {
  let existing: unknown;

  try {
    existing = await reader.readArtifact("fixes");
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "ARTIFACT_NOT_FOUND") {
      return { ok: true, entries: [] };
    }

    return {
      ok: false,
      error: orchestrationError(
        "unmergeable_artifact",
        `Artifact "fixes" could not be read while appending fix history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  return parseFixHistory(existing);
}

/**
 * Appends one entry per fix attempt. Entries are never rewritten.
 *
 * The record is framework-written, and the framework's measurements are the part that matters: the
 * attempt number and the originating state say which loop this was, `revisionBefore` and
 * `revisionAfter` bracket exactly the mutation that recorded it, `changedPaths` and the integrity
 * digests are what the framework measured rather than what the fixer reported, and `outcome` records
 * whether the framework believed the attempt at all. The fixer's own report is preserved as a claim
 * inside the entry, next to the framework's verdict on it.
 */
export async function appendFixHistoryEntry(
  reader: FeatureMutationReader,
  attempt: FixAttemptRecord,
): Promise<FixHistoryOutcome> {
  const existing = await readExistingFixes(reader);

  if (!existing.ok) {
    return existing;
  }

  const previous = existing.entries;

  const entry: FixHistoryEntry = {
    sequence: previous.length + 1,
    attempt: attempt.attempt,
    fixReturnState: attempt.fixReturnState,
    failureSummary: attempt.failureSummary,
    recordedAt: reader.timestamp,
    revisionBefore: attempt.revisionBefore,
    revisionAfter: reader.nextRevision,
    sessionRevision: reader.nextRevision,
    implementationFingerprint: attempt.implementationFingerprint,
    changedPaths: [...attempt.changedPaths].sort(),
    integrity: integrityRecordOf(attempt.integrity),
    outcome: attempt.outcome,
    report: attempt.report,
  };

  return { ok: true, document: { schemaVersion: FIX_HISTORY_SCHEMA_VERSION, fixes: [...previous, entry] } };
}

export function isFixReturnState(value: unknown): value is FixReturnState {
  switch (value) {
    case WorkflowState.PlanReview:
    case WorkflowState.CodeReview:
    case WorkflowState.ScopeReview:
    case WorkflowState.StaticVerification:
    case WorkflowState.TestVerification:
    case WorkflowState.RuntimeVerification:
    case WorkflowState.SecurityReview:
      return true;
    default:
      return false;
  }
}
