import { WorkflowState, type FixReturnState } from "@agent-workflow-kit/core";
import { PersistenceError } from "@agent-workflow-kit/persistence";
import type {
  FeatureMutationReader,
  FixHistoryDocument,
  FixHistoryEntry,
} from "@agent-workflow-kit/persistence";
import type { OrchestrationError } from "./errors.js";
import { orchestrationError } from "./errors.js";

const FIX_HISTORY_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type FixHistoryOutcome =
  | { readonly ok: true; readonly document: FixHistoryDocument }
  | { readonly ok: false; readonly error: OrchestrationError };

/**
 * Appends one entry per successful fix attempt. Entries are never rewritten: each fix records the
 * state that asked for it, the fixer's own report, when it was recorded, and the session revision
 * that carried it, so a later stage can explain what was changed and why.
 */
export async function appendFixHistoryEntry(
  reader: FeatureMutationReader,
  fixReturnState: FixReturnState,
  report: unknown,
): Promise<FixHistoryOutcome> {
  let existing: unknown;

  try {
    existing = await reader.readArtifact("fixes");
  } catch (error) {
    if (!(error instanceof PersistenceError) || error.code !== "ARTIFACT_NOT_FOUND") {
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

    existing = undefined;
  }

  let previous: readonly FixHistoryEntry[] = [];

  if (isRecord(existing)) {
    if (existing["schemaVersion"] !== FIX_HISTORY_SCHEMA_VERSION) {
      return {
        ok: false,
        error: orchestrationError(
          "unmergeable_artifact",
          `Artifact "fixes" declares an unsupported schema version.`,
        ),
      };
    }

    const fixes = existing["fixes"];

    if (!Array.isArray(fixes)) {
      return {
        ok: false,
        error: orchestrationError(
          "unmergeable_artifact",
          `Artifact "fixes" does not contain a fix list.`,
        ),
      };
    }

    previous = fixes as readonly FixHistoryEntry[];
  }

  const entry: FixHistoryEntry = {
    sequence: previous.length + 1,
    fixReturnState,
    recordedAt: reader.timestamp,
    sessionRevision: reader.nextRevision,
    report,
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
