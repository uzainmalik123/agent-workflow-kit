import type { FeatureMutationReader, PushApprovalRecord } from "@agent-workflow-kit/persistence";
import { digestArtifactText } from "./approval.js";
import type { OrchestrationError } from "./errors.js";
import { orchestrationError } from "./errors.js";
import type { FinalGateResult } from "./final-gate.js";

/**
 * The publishing approval.
 *
 * `approve_plan` records what a human agreed to build. This records the separate agreement a human has
 * to give before anything is published: that the work they are shown is the work that exists, and that
 * the tree it was measured against has not moved since. Everything here follows from taking that
 * second sentence seriously, because an approval is only worth anything if it is about a specific set
 * of bytes.
 *
 * So the record names four things rather than one. It names the **summary** by digest, so the document
 * a human read cannot be edited afterwards without the edit being detectable. It names the **gate** by
 * digest, revision, and fingerprint, so the verdict being relied on is the one that was actually
 * recorded. It names the **tree** by fingerprint, measured at the moment of approval rather than
 * copied from an earlier measurement. And it carries the **revision** the approval was given at, so a
 * session that moved afterwards says so.
 *
 * The record is written in the same mutation as the `approve_push` event, exactly as the plan approval
 * is written in the same mutation as `approve_plan`. There is therefore no window in which the session
 * is in `committing` without a record of why, or in which a record exists for a transition that was
 * refused.
 */
export type PushApprovalOutcome =
  | { readonly ok: true; readonly record: PushApprovalRecord }
  | { readonly ok: false; readonly error: OrchestrationError };

/** How many session revisions separate the gate decision from the summary it justifies. */
export const PUSH_APPROVAL_REVISION_OFFSET = 2;

export interface PushApprovalEvidence {
  /**
   * The gate result read back from `final-gate.json`.
   *
   * Passed in rather than read here because parsing a gate document is
   * {@link recordedFinalGateFrom}'s job, and this module should not hold a second, more forgiving
   * opinion about what a gate result is. A caller that could not produce one has already refused.
   */
  readonly gate: FinalGateResult;
  /** The gate's own digest, over the exact bytes of `final-gate.json`. */
  readonly gateSha256: string;
  /**
   * The working-tree fingerprint measured at the moment approval was requested.
   *
   * Measured here and not earlier, and never taken from the gate: the whole question this approval
   * answers is whether the tree still looks the way it did when the gate passed, and an answer copied
   * from the gate could not say no.
   */
  readonly fingerprint: string;
  /** Who approved, when the caller was told. Null when it was not told. */
  readonly actor: string | null;
}

/**
 * Builds the approval record, or refuses.
 *
 * Every refusal here is a refusal to record an approval that would mean something other than what the
 * human agreed to, and each one names what it found instead:
 *
 * - A gate revision that is not the one the summary was written from. The summary is the last artifact
 *   before the checkpoint, and nothing is recorded between them, so a gate any older than that is a
 *   verdict about evidence the summary never saw.
 * - A tree fingerprint that differs from the gate's. This is the case that matters most and it is not
 *   a rare one: anything that wrote to the worktree after the gate — a fixer, an editor, a test that
 *   wrote a snapshot — moves the fingerprint, and a human approving a summary of one tree cannot be
 *   taken as approving another.
 * - A missing summary. There is nothing to have read, and approving nothing is not an approval.
 *
 * Nothing here decides whether the work is good. That was the gate's answer, it is already recorded,
 * and re-litigating it here would give an approval the power to veto a verdict nobody asked it to
 * review.
 */
export async function buildPushApproval(
  reader: FeatureMutationReader,
  evidence: PushApprovalEvidence,
): Promise<PushApprovalOutcome> {
  const session = reader.session;

  if (session.approvals.push !== null) {
    return {
      ok: false,
      error: orchestrationError(
        "push_approval_already_granted",
        `Feature "${session.featureId}" already records a publishing approval at revision ${String(session.approvals.push.approvedRevision)}. A second approval is refused rather than silently re-recorded against evidence the first one did not cover.`,
      ),
    };
  }

  const { gate } = evidence;

  if (gate.featureId !== session.featureId) {
    return {
      ok: false,
      error: orchestrationError(
        "push_approval_stale",
        `The recorded final gate belongs to "${gate.featureId}" but this session is "${session.featureId}", so it was never this feature's evidence.`,
      ),
    };
  }

  if (gate.status !== "passed") {
    return {
      ok: false,
      error: orchestrationError(
        "final_gate_blocked",
        `The recorded final gate is "${gate.status}", not "passed", so there is no certification for a publishing approval to rely on.`,
      ),
    };
  }

  if (gate.fingerprint.length === 0) {
    return {
      ok: false,
      error: orchestrationError(
        "push_approval_stale",
        `The recorded final gate at revision ${String(gate.revision)} carries no working-tree fingerprint, so it cannot be tied to any tree and nothing can be approved against it.`,
      ),
    };
  }

  // The gate was decided at `gate.revision`, and the mutation that recorded it became the next
  // revision; the summary was written from that gate and its own mutation is the next after that. Any
  // other distance means something was recorded in between — a re-run of a stage, a fix, a second gate —
  // and the summary on disk is no longer the document that was derived from this verdict.
  const summaryRevision = session.revision;
  const expectedSummaryRevision = gate.revision + PUSH_APPROVAL_REVISION_OFFSET;

  if (summaryRevision !== expectedSummaryRevision) {
    return {
      ok: false,
      error: orchestrationError(
        "push_approval_stale",
        `The recorded final gate was decided at revision ${String(gate.revision)} and the summary that follows it is recorded at revision ${String(summaryRevision)}, but only a summary at revision ${String(expectedSummaryRevision)} can have been written from that gate. Something was recorded in between, so the approval cannot be bound to this evidence.`,
      ),
    };
  }

  if (evidence.fingerprint !== gate.fingerprint) {
    return {
      ok: false,
      error: orchestrationError(
        "push_approval_stale",
        `The working tree now fingerprints as ${evidence.fingerprint}, but the recorded final gate was decided against ${gate.fingerprint}. The tree changed after the gate, so the summary describes work that is no longer what is on disk. Re-run the final gate and the summary, then approve again.`,
      ),
    };
  }

  let summaryText: string | undefined;

  try {
    summaryText = await reader.readArtifactText("final_summary");
  } catch (error) {
    return {
      ok: false,
      error: orchestrationError(
        "persistence_failed",
        `The final summary could not be read for approval: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }

  if (summaryText === undefined) {
    return {
      ok: false,
      error: orchestrationError(
        "push_approval_stale",
        `No final summary is recorded for feature "${session.featureId}", so there is nothing for this approval to approve.`,
      ),
    };
  }

  return {
    ok: true,
    record: {
      decision: "approved",
      // Written from the session rather than from a caller, so the record cannot name a feature other
      // than the one whose session file contains it.
      featureId: session.featureId,
      approvedAt: reader.timestamp,
      approvedRevision: reader.nextRevision,
      actor: evidence.actor,
      summarySha256: digestArtifactText(summaryText),
      summaryRevision,
      workingTreeFingerprint: evidence.fingerprint,
      finalGateStatus: "passed",
      finalGateRevision: gate.revision,
      finalGateFingerprint: gate.fingerprint,
      finalGateSha256: evidence.gateSha256,
    },
  };
}