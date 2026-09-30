import type {
  FixReturnState,
  WorkflowEvent,
  WorkflowMachineSnapshot,
  WorkflowState,
  WorkspaceBaseline,
} from "@agent-workflow-kit/core";

export const FEATURE_SESSION_SCHEMA_VERSION = 3 as const;
export type FeatureSessionSchemaVersion = typeof FEATURE_SESSION_SCHEMA_VERSION;

export const FEATURE_ARTIFACT_NAMES = [
  "request",
  "grill",
  "spec",
  "plan",
  "plan_review",
  "implementation",
  "code_review",
  "scope_review",
  "verification",
  "security_review",
  "final_summary",
  "fixes",
] as const;

export type FeatureArtifactName = (typeof FEATURE_ARTIFACT_NAMES)[number];

export type FeatureArtifactStatus = "missing" | "present";

export const FEATURE_ARTIFACT_FILENAMES = {
  request: "request.md",
  grill: "grill.json",
  spec: "spec.json",
  plan: "plan.json",
  plan_review: "plan-review.json",
  implementation: "implementation.json",
  code_review: "code-review.json",
  scope_review: "scope-review.json",
  verification: "verification.json",
  security_review: "security-review.json",
  final_summary: "final-summary.md",
  fixes: "fixes.json",
} as const satisfies Record<FeatureArtifactName, string>;

export type FeatureArtifactFilename =
  (typeof FEATURE_ARTIFACT_FILENAMES)[FeatureArtifactName];

export interface FeatureArtifactReference {
  readonly filename: FeatureArtifactFilename;
  readonly status: FeatureArtifactStatus;
  readonly updatedAt?: string;
}

export type FeatureArtifactReferences = {
  readonly [K in FeatureArtifactName]: FeatureArtifactReference;
};

/**
 * Durable record of the human plan approval. The hashes are SHA-256 digests of the exact
 * persisted artifact bytes, so a reviewer can verify them with any standard tool. The record
 * carries no approval semantics: it is written, verified, and interpreted by the orchestrator.
 *
 * The baseline is captured at the moment of approval and is the only definition of "the code as the
 * human approved it" that later stages get. It is optional in the type because the two are written by
 * different actors — the approval hashes by the mutation that accepted the plan, the baseline by the
 * workspace provider that read the repository — and a record with no baseline is a refusal at the next
 * post-approval stage rather than a silent fallback to the working directory.
 */
export interface PlanApprovalRecord {
  readonly approvedAt: string;
  readonly approvedRevision: number;
  readonly specSha256: string;
  readonly planSha256: string;
  readonly planReviewSha256: string;
  readonly baseline: WorkspaceBaseline | null;
}

export interface FeatureApprovals {
  readonly plan: PlanApprovalRecord | null;
}

export interface FeatureSession {
  readonly schemaVersion: FeatureSessionSchemaVersion;
  readonly featureId: string;
  readonly slug: string;
  readonly title: string;
  /**
   * Monotonic revision. Every successful authoritative mutation increments it by exactly one,
   * which is what makes stale writers detectable.
   */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly machine: WorkflowMachineSnapshot;
  readonly artifacts: FeatureArtifactReferences;
  readonly approvals: FeatureApprovals;
}

export interface CreateFeatureSessionInput {
  readonly featureId: string;
  readonly title: string;
  readonly slug?: string;
}

/**
 * Metadata-only patch. Workflow state cannot be set here: moving the machine requires a real
 * event through `mutate`.
 */
export type Clock = () => string;

/**
 * The outcome of one fix attempt, as the framework recorded it.
 *
 * `accepted` means the attempt passed every framework check and the workflow returned to the stage
 * that asked for it. `rejected` means the attempt was refused — a protected file was touched, a check
 * was removed, an approved artifact or the recorded verification configuration changed, or the fix
 * wrote outside the approved scope — and the feature was failed for a human. Rejected attempts are
 * recorded rather than discarded, because "the fixer tried five times and the fifth one edited the
 * test" is the finding a human needs and a history that only kept the successes cannot produce.
 */
export const FIX_ATTEMPT_OUTCOMES = ["accepted", "rejected"] as const;

export type FixAttemptOutcome = (typeof FIX_ATTEMPT_OUTCOMES)[number];

/**
 * The digests of the things a fix had to leave alone, captured before it ran and compared after.
 *
 * These are the immutable representation of what the fix was being held to: the requirements and
 * acceptance criteria in the spec, the plan that scoped the work, its review, and the verification
 * commands the failing stage was measured with. Persisting both sides is what makes a rejected fix
 * auditable — a reader can see which of them moved rather than being told that something did — and it
 * is why the record is useful after the workspace is gone.
 */
export interface FixIntegrityRecord {
  readonly specSha256: string | null;
  readonly planSha256: string | null;
  readonly planReviewSha256: string | null;
  readonly verificationConfigSha256: string | null;
}

/**
 * One entry in the durable fix-history artifact.
 *
 * Every field is framework-written and none of them is the fixer's word about whether it worked. The
 * report is there because a human reading the history wants to know what was attempted; `outcome` is
 * there because that report is not evidence; and the revisions, the integrity digests, and the changed
 * paths are there because they are. An audit of a fix loop should be answerable from this document
 * alone: which stage asked, how many times, what the tree looked like before and after, what the
 * success criteria hashed to on both sides, which paths moved, and whether the framework believed it.
 */
export interface FixHistoryEntry {
  readonly sequence: number;
  /** Which attempt this was, counted per origin stage. 1 is the first fix for that stage. */
  readonly attempt: number;
  /** The stage whose failure triggered the attempt, and the state the workflow returns to. */
  readonly fixReturnState: FixReturnState;
  /** One sentence on why the attempt was refused, or null when it was accepted. */
  readonly failureSummary: string | null;
  readonly recordedAt: string;
  /** The session revision the fix was made against. */
  readonly revisionBefore: number;
  /** The revision that carried this entry; equal to `sessionRevision`. */
  readonly revisionAfter: number;
  /** The revision that carried this entry. Kept as its own field so older readers still line up. */
  readonly sessionRevision: number;
  /** The implementation fingerprint the failure was measured with, when there was one. */
  readonly implementationFingerprint: string | null;
  /** Every path the fix changed, as measured, sorted. */
  readonly changedPaths: readonly string[];
  readonly integrity: FixIntegrityRecord;
  readonly outcome: FixAttemptOutcome;
  readonly report: unknown;
}

export interface FixHistoryDocument {
  readonly schemaVersion: 1;
  readonly fixes: readonly FixHistoryEntry[];
}

export interface FeatureEventInput {
  readonly previousState: WorkflowState;
  readonly event: WorkflowEvent;
  readonly resultingState: WorkflowState;
  readonly success: boolean;
  /** The session revision this event produced, or the unchanged revision when it was refused. */
  readonly revision: number;
  readonly errorCode?: string;
}

export interface FeatureEvent extends FeatureEventInput {
  readonly timestamp: string;
  readonly featureId: string;
}

export function createEmptyArtifactReferences(): FeatureArtifactReferences {
  return {
    request: { filename: FEATURE_ARTIFACT_FILENAMES.request, status: "missing" },
    grill: { filename: FEATURE_ARTIFACT_FILENAMES.grill, status: "missing" },
    spec: { filename: FEATURE_ARTIFACT_FILENAMES.spec, status: "missing" },
    plan: { filename: FEATURE_ARTIFACT_FILENAMES.plan, status: "missing" },
    plan_review: {
      filename: FEATURE_ARTIFACT_FILENAMES.plan_review,
      status: "missing",
    },
    implementation: {
      filename: FEATURE_ARTIFACT_FILENAMES.implementation,
      status: "missing",
    },
    code_review: {
      filename: FEATURE_ARTIFACT_FILENAMES.code_review,
      status: "missing",
    },
    scope_review: {
      filename: FEATURE_ARTIFACT_FILENAMES.scope_review,
      status: "missing",
    },
    verification: {
      filename: FEATURE_ARTIFACT_FILENAMES.verification,
      status: "missing",
    },
    security_review: {
      filename: FEATURE_ARTIFACT_FILENAMES.security_review,
      status: "missing",
    },
    final_summary: {
      filename: FEATURE_ARTIFACT_FILENAMES.final_summary,
      status: "missing",
    },
    fixes: {
      filename: FEATURE_ARTIFACT_FILENAMES.fixes,
      status: "missing",
    },
  };
}

export function createEmptyApprovals(): FeatureApprovals {
  return { plan: null };
}
