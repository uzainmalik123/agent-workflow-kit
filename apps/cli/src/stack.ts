import { createWorkflowOrchestrator } from "@agent-workflow-kit/orchestration";
import type { WorkflowOrchestrator, WorkflowOrchestratorOptions } from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import type { FeatureSessionStore } from "@agent-workflow-kit/persistence";

export type OrchestratorStackOptions = Omit<WorkflowOrchestratorOptions, "store" | "projectRoot">;

export interface OrchestratorStack {
  readonly orchestrator: WorkflowOrchestrator;
  readonly store: FeatureSessionStore;
}

export function createOrchestratorStack(
  repoRoot: string,
  options: OrchestratorStackOptions,
): OrchestratorStack {
  const store = createFeatureSessionStore(repoRoot);
  const orchestrator = createWorkflowOrchestrator({ ...options, store, projectRoot: repoRoot });

  return { orchestrator, store };
}
