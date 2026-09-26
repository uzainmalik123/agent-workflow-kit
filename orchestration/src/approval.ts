import { createHash } from "node:crypto";
import type { FeatureMutationReader, FeatureReadContext, PlanApprovalRecord } from "@agent-workflow-kit/persistence";
import type { WorkflowState } from "@agent-workflow-kit/core";
import type { OrchestrationError } from "./errors.js";
import { orchestrationError } from "./errors.js";
import {
  APPROVAL_VERIFIED_STAGES,
  APPROVED_ARTIFACTS,
  type ApprovedArtifactName,
  type WorkStage,
} from "./stages.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * SHA-256 over the exact persisted artifact bytes, as lowercase hex. Hashing the stored file
 * rather than a re-serialization means the digest can be reproduced with `sha256sum` and cannot
 * drift because of key order or formatting.
 */
export function digestArtifactText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isArtifactDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export type ApprovalOutcome =
  | { readonly ok: true; readonly record: PlanApprovalRecord }
  | { readonly ok: false; readonly error: OrchestrationError };

export type ApprovalVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: OrchestrationError };

async function readApprovedArtifact(
  reader: FeatureReadContext,
  name: ApprovedArtifactName,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: OrchestrationError }> {
  let text: string | undefined;

  try {
    text = await reader.readArtifactText(name);
  } catch (error) {
    return {
      ok: false,
      error: orchestrationError(
        "approval_evidence_missing",
        `Approved artifact "${name}" could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  if (text === undefined) {
    return {
      ok: false,
      error: orchestrationError(
        "approval_evidence_missing",
        `Plan approval requires the "${name}" artifact to exist.`,
      ),
    };
  }

  return { ok: true, text };
}

/**
 * Builds the durable approval checkpoint. The digests cover the exact bytes of the artifacts the
 * human is approving, and the record is written in the same mutation as the approval event, so a
 * checkpoint can never describe a plan the session did not actually approve.
 */
export async function buildPlanApproval(
  reader: FeatureMutationReader,
): Promise<ApprovalOutcome> {
  const digests: Partial<Record<ApprovedArtifactName, string>> = {};

  for (const name of APPROVED_ARTIFACTS) {
    const read = await readApprovedArtifact(reader, name);

    if (!read.ok) {
      return read;
    }

    digests[name] = digestArtifactText(read.text);
  }

  return {
    ok: true,
    record: {
      approvedAt: reader.timestamp,
      approvedRevision: reader.nextRevision,
      specSha256: digests["spec"] ?? "",
      planSha256: digests["plan"] ?? "",
      planReviewSha256: digests["plan_review"] ?? "",
    },
  };
}

/**
 * Enforces the freeze. A stage that may only run against an approved plan must find a checkpoint,
 * and the approved artifacts must still hash to it. Changed requirements are never accepted
 * silently and are never re-approved automatically.
 */
export async function verifyPlanApproval(
  reader: FeatureReadContext,
  stage: WorkStage,
  state: WorkflowState,
): Promise<ApprovalVerification> {
  const checkpoint = reader.session.approvals.plan;
  const requiresCheckpoint = APPROVAL_VERIFIED_STAGES.has(stage);

  if (checkpoint === null) {
    if (!requiresCheckpoint) {
      return { ok: true };
    }

    return {
      ok: false,
      error: orchestrationError(
        "approval_missing",
        `State "${state}" requires an approved plan checkpoint, but the session has none. Re-approval is never automatic.`,
      ),
    };
  }

  if (!isArtifactDigest(checkpoint.specSha256)) {
    return {
      ok: false,
      error: orchestrationError(
        "approval_invalidated",
        "The recorded plan approval does not contain usable artifact digests.",
      ),
    };
  }

  const expected: ReadonlyArray<readonly [ApprovedArtifactName, string]> = [
    ["spec", checkpoint.specSha256],
    ["plan", checkpoint.planSha256],
    ["plan_review", checkpoint.planReviewSha256],
  ];

  for (const [name, digest] of expected) {
    if (!isArtifactDigest(digest)) {
      return {
        ok: false,
        error: orchestrationError(
          "approval_invalidated",
          `The recorded plan approval has an invalid digest for "${name}".`,
        ),
      };
    }

    const read = await readApprovedArtifact(reader, name);

    if (!read.ok) {
      return {
        ok: false,
        error: orchestrationError(
          "approval_invalidated",
          `Artifact "${name}" was approved but is no longer available.`,
        ),
      };
    }

    const actual = digestArtifactText(read.text);

    if (actual !== digest) {
      return {
        ok: false,
        error: orchestrationError(
          "approval_invalidated",
          `Artifact "${name}" changed after plan approval (approved ${digest}, found ${actual}).`,
        ),
      };
    }
  }

  return { ok: true };
}
