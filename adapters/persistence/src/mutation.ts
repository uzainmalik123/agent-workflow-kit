import type { WorkflowEvent } from "@agent-workflow-kit/core";
import type {
  FeatureApprovals,
  FeatureArtifactName,
  FeatureSession,
} from "./contracts.js";

/**
 * One artifact write inside a mutation. The content is the value to serialize; orchestration
 * computes merged envelopes, appended fix history, and approval hashes inside `prepare`.
 */
export interface FeatureArtifactWrite {
  readonly name: FeatureArtifactName;
  readonly content: unknown;
}

/**
 * Read-only view of a feature. `mutate` hands one to `prepare` while the per-feature lock is
 * held, so everything the callback reads is the state the mutation is about to replace.
 */
export interface FeatureReadContext {
  /** The session as it exists right now, before any mutation. */
  readonly session: FeatureSession;
  /** Parsed artifact content, or `undefined` when the artifact does not exist. */
  readArtifact(name: FeatureArtifactName): Promise<unknown>;
  /** The exact persisted artifact bytes, or `undefined` when the artifact does not exist. */
  readArtifactText(name: FeatureArtifactName): Promise<string | undefined>;
}

export interface FeatureMutationReader extends FeatureReadContext {
  /** The timestamp this mutation will stamp into the session. */
  readonly timestamp: string;
  /** The revision this mutation will produce. */
  readonly nextRevision: number;
}

export interface FeatureMutationPlan {
  readonly title?: string;
  readonly artifacts?: readonly FeatureArtifactWrite[];
  readonly approvals?: FeatureApprovals;
  /** When present, the store applies it and refuses to write state that is not its result. */
  readonly event?: WorkflowEvent;
}

export type FeatureMutationPreparer = (
  reader: FeatureMutationReader,
) => FeatureMutationPlan | Promise<FeatureMutationPlan>;

export interface FeatureMutationRequest {
  /**
   * Optimistic concurrency precondition. When provided, the mutation is rejected with
   * `REVISION_CONFLICT` before touching any artifact or workflow state if the persisted
   * revision differs. Omit only for operations that are not coordination-sensitive.
   */
  readonly expectedRevision?: number;
  readonly prepare: FeatureMutationPreparer;
}
