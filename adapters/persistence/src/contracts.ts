import type {
  FixReturnState,
  WorkflowEvent,
  WorkflowMachineSnapshot,
  WorkflowState,
} from "@agent-workflow-kit/core";

export const FEATURE_SESSION_SCHEMA_VERSION = 2 as const;
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
 */
export interface PlanApprovalRecord {
  readonly approvedAt: string;
  readonly approvedRevision: number;
  readonly specSha256: string;
  readonly planSha256: string;
  readonly planReviewSha256: string;
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
export interface FeatureSessionUpdate {
  readonly title?: string;
  readonly artifacts?: FeatureArtifactReferences;
  readonly approvals?: FeatureApprovals;
}

export type FeatureSessionUpdater =
  | FeatureSessionUpdate
  | ((session: FeatureSession) => FeatureSessionUpdate);

export type Clock = () => string;

/** Entry recorded in the durable fix-history artifact. */
export interface FixHistoryEntry {
  readonly sequence: number;
  readonly fixReturnState: FixReturnState;
  readonly recordedAt: string;
  readonly sessionRevision: number;
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
