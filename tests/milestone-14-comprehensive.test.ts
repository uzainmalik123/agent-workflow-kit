import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import { createWorkflowOrchestrator } from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeFeaturePublisher } from "../fixtures/feature-publisher.js";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

function fixedClock(): string {
  return fixedTimestamp;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-m14c-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Milestone 14 - verification failure with fix", () => {
  it("handles verification failure via fixing loop", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });
    const executor = new FakeStageExecutor();
    const publisher = createFakeFeaturePublisher();
    const orchestrator = createWorkflowOrchestrator({
      store,
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
      workspace: createFakeWorkspaceProvider(),
      publisher,
      projectRoot: root,
    });
    const featureId = "F-002";

    await orchestrator.createFeature({ featureId, title: "Test", request: "# R" });
    
    // Drive to runtime verification
    for (let i = 0; i < 60; i++) {
      const s = await store.load(featureId);
      if (s.machine.state === WorkflowState.RuntimeVerification) break;
      if (s.machine.state === WorkflowState.AwaitingPlanApproval) {
        await orchestrator.approvePlan(featureId);
        continue;
      }
      await orchestrator.runNext(featureId);
    }
    
    // Inject failure
    executor.configure("runtime_verification", {
      outcome: "needs_fix",
      findings: [{ featureId, severity: "error" as const, message: "Test failure" }],
    });
    const fixReq = await orchestrator.runNext(featureId);
    expect(fixReq.status).toBe("fix_requested");
    expect(fixReq.state).toBe(WorkflowState.Fixing);
    
    executor.reset("runtime_verification");
    const fixed = await orchestrator.runNext(featureId);
    expect(fixed.status).toBe("stage_completed");
    expect(fixed.state).toBe(WorkflowState.RuntimeVerification);
  });
});
