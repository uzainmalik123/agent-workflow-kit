import type { WorkspaceAccessLevel, WorkspaceBaseline } from "@agent-workflow-kit/core";
import type {
  StageExecutionRequest,
  StageWorkspaceContext,
} from "@agent-workflow-kit/orchestration";

/**
 * A workspace context for a test that is not about the workspace.
 *
 * `workingDirectory` defaults to `/tmp/agent-workflow-kit-test-project`, which is a path no test runs a
 * real command in; a test that needs a real directory sets it. The shape is the production shape,
 * because a fixture that omits the field the orchestrator now always sets would let a test pass
 * against a request shape the framework can never actually build.
 */
export function testWorkspaceContext(
  overrides: Partial<StageWorkspaceContext> = {},
): StageWorkspaceContext {
  return {
    workspaceId: "test-workspace",
    repositoryRoot: "/tmp/agent-workflow-kit-test-project",
    workingDirectory: "/tmp/agent-workflow-kit-test-project",
    access: "read_only",
    baseline: null,
    ...overrides,
  };
}

export function testWorkspaceBaseline(overrides: Partial<WorkspaceBaseline> = {}): WorkspaceBaseline {
  return {
    repositoryRoot: "/tmp/agent-workflow-kit-test-project",
    baselineCommit: "0".repeat(40),
    approvedRevision: 1,
    workspaceId: "test-workspace",
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function testAccess(level: WorkspaceAccessLevel): WorkspaceAccessLevel {
  return level;
}

/** A request with the workspace context filled in, for the tests that build one by hand. */
export function withTestWorkspace(request: StageExecutionRequest): StageExecutionRequest {
  return { ...request, workspace: testWorkspaceContext() };
}
