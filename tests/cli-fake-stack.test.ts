import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowState } from "@agent-workflow-kit/core";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-cli-fake-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(join(repoRoot, "package.json"), '{"name":"test","version":"1.0.0"}', "utf8");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "--quiet", "-m", "initial");
  return repoRoot;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("CLI with injected fake stack", () => {
  it("start creates a feature", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const { orchestrator, store } = createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
    const result = await orchestrator.createFeature({ featureId: "F-001", title: "Test" });
    expect(result.status).toBe("created");
    const session = await store.load("F-001");
    expect(session.featureId).toBe("F-001");
  });

  it("run to plan approval", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    // Configure executor for stages as needed
    executor.configure("grill", {
      artifacts: [
        { name: "grill", content: { featureId: "F-001", decisions: [] } },
        { name: "spec", content: { schemaVersion: 1, featureId: "F-001", summary: "s", requirements: [] } },
      ],
    });
    executor.configure("planning", {
      artifacts: [{ name: "plan", content: { schemaVersion: 1, featureId: "F-001", summary: "p", steps: [] } }],
    });
    const { orchestrator, store } = createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
    await orchestrator.createFeature({ featureId: "F-001", title: "Test" });
    // Run until awaiting plan approval
    for (let i = 0; i < 20; i++) {
      const res = await orchestrator.runNext("F-001");
      if (res.status === "awaiting_human") break;
    }
    const session = await store.load("F-001");
    expect(session.machine.state).toBe(WorkflowState.AwaitingPlanApproval);
  });

  it("approve plan advances workflow", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    executor.configure("grill", {
      artifacts: [
        { name: "grill", content: { featureId: "F-001", decisions: [] } },
        { name: "spec", content: { schemaVersion: 1, featureId: "F-001", summary: "s", requirements: [] } },
      ],
    });
    executor.configure("planning", {
      artifacts: [{ name: "plan", content: { schemaVersion: 1, featureId: "F-001", summary: "p", steps: [] } }],
    });
    const { orchestrator } = createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
    await orchestrator.createFeature({ featureId: "F-001", title: "Test" });
    for (let i = 0; i < 20; i++) {
      const res = await orchestrator.runNext("F-001");
      if (res.status === "awaiting_human") break;
    }
    const approveRes = await orchestrator.approvePlan("F-001");
    expect(approveRes.status).toBe("gate_approved");
  });
});
