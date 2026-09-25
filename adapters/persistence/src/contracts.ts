import type {
  WorkflowEvent,
  WorkflowMachineSnapshot,
  WorkflowState,
} from "@agent-workflow-kit/core";

export const FEATURE_SESSION_SCHEMA_VERSION = 1 as const;
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

export interface FeatureSession {
  readonly schemaVersion: FeatureSessionSchemaVersion;
  readonly featureId: string;
  readonly slug: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly machine: WorkflowMachineSnapshot;
  readonly artifacts: FeatureArtifactReferences;
}

export interface CreateFeatureSessionInput {
  readonly featureId: string;
  readonly title: string;
  readonly slug?: string;
}

export interface FeatureSessionUpdate {
  readonly title?: string;
  readonly machine?: WorkflowMachineSnapshot;
  readonly artifacts?: FeatureArtifactReferences;
}

export type FeatureSessionUpdater =
  | FeatureSessionUpdate
  | ((session: FeatureSession) => FeatureSessionUpdate);

export type Clock = () => string;

export interface FeatureEventInput {
  readonly previousState: WorkflowState;
  readonly event: WorkflowEvent;
  readonly resultingState: WorkflowState;
  readonly success: boolean;
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
  };
}
