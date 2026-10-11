import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { FakeStageExecutor, findingFor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider, passingEvidenceFor } from "../fixtures/verification-provider.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Task R through the real command tree with the fake stack (no model calls).
 *
 * - P-24: an inconclusive result prints the stage's explanation, never
 *   "Unknown error"; findings wrap to the terminal width with a hanging indent.
 * - P-23 gate honesty: an unresolved review with no parseable findings prints
 *   the stored artifact path and "Read it before approving".
 * - Abandon on terminal states: already-failed is idempotent (exit 0),
 *   already-complete refuses (exit 1), unknown ids keep the existing error.
 */

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-task-r-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "cli@example.invalid");
  git(repoRoot, "config", "user.name", "CLI Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(join(repoRoot, "package.json"), '{"name":"test","version":"1.0.0"}', "utf8");
  await writeFile(join(repoRoot, ".gitignore"), ".agentflow/\n", "utf8");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "--quiet", "-m", "initial");
  return repoRoot;
}

interface CliRun {
  readonly exitCodes: readonly number[];
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  args: readonly string[],
  options: { readonly repoRoot: string; readonly createStack: (repoRoot: string, request: CliStackRequest) => CliStack },
): Promise<CliRun> {
  const exitCodes: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    const cli = createCli({
      createStack: options.createStack,
      cwd: () => options.repoRoot,
      exit: (code: number) => {
        exitCodes.push(code);
      },
    });
    await cli.parseAsync(["node", "agentflow", ...args]);
  } finally {
    vi.restoreAllMocks();
  }

  return { exitCodes, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function stackFactory(executor: FakeStageExecutor): (repoRoot: string, request: CliStackRequest) => CliStack {
  const workspace = createFakeWorkspaceProvider();
  return (repoRoot) =>
    createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
      workspace,
    });
}

function preApprovalExecutor(): FakeStageExecutor {
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
  executor.configure("plan_review", {
    outcome: "success",
    artifacts: [{ name: "plan_review", content: { verdict: "pass", summary: "Clean.", findings: [] } }],
  });
  executor.configure("implementation", {
    outcome: "success",
    artifacts: [{ name: "implementation", content: { featureId: "F-001", notes: "done" } }],
  });
  executor.configure("code_review", { outcome: "success" });
  executor.configure("scope_review", { outcome: "success" });
  return executor;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("inconclusive results explain themselves (P-24)", () => {
  it("prints findings and evidence, never 'Unknown error', and wraps long findings", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const longMessage = `The plan cannot be judged without a target service. ${"detail ".repeat(40)}`;
    executor.configure("grill", {
      outcome: "inconclusive",
      artifacts: [],
      findings: [findingFor("F-001", longMessage)],
      evidence: [{ kind: "static", description: "No lint command is declared, so nothing was measured." }],
      summary: "The grill stage could not conclude.",
    });
    await runCli(["start", "-i", "F-001", "-t", "Inconclusive"], {
      repoRoot,
      createStack: stackFactory(executor),
    });
    const ran = await runCli(["run", "F-001"], { repoRoot, createStack: stackFactory(executor) });

    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("Workflow inconclusive at grill");
    expect(ran.stderr).toContain("No lint command is declared");
    expect(ran.stderr).toContain("The plan cannot be judged");
    expect(ran.stderr).not.toContain("Unknown error");
    // Wrapped, never truncated: every line fits 100 columns, no ellipsis, full text present.
    for (const line of ran.stderr.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
    expect(ran.stderr).not.toContain("…");
    expect(ran.stderr).toContain("detail detail");
    // Hanging indent: a long finding produces continuation lines starting with four spaces.
    expect(ran.stderr.split("\n").some((line) => line.startsWith("    "))).toBe(true);
  });

  it("names blocked checks with their reason codes", async () => {
    const repoRoot = await makeRepo();
    const executor = preApprovalExecutor();
    executor.configure("static_verification", {
      outcome: "inconclusive",
      findings: [findingFor("F-001", "Static verification could not conclude.")],
      evidence: [],
    });
    const blockedVerification = createFakeVerificationProvider((request) =>
      passingEvidenceFor(request, {
        outcome: "blocked",
        checks: [
          {
            id: "build",
            kind: request.verification,
            capability: "build",
            capabilityStatus: "blocked",
            label: "Build",
            executable: "npm",
            args: ["run", "build"],
            cwd: request.projectRoot,
            script: null,
            startedAt: "2026-04-05T06:07:08.000Z",
            durationMs: 0,
            exitCode: null,
            signal: null,
            status: "blocked",
            reason: "package_manager_unknown",
            detail: "No package manager could be determined.",
            stdoutExcerpt: "",
            stderrExcerpt: "",
            truncated: false,
            revision: request.revision,
            implementationFingerprint: "f".repeat(64),
          },
        ],
      }),
    );
    const workspace = createFakeWorkspaceProvider();
    const createStack = (root: string) =>
      createOrchestratorStack(root, {
        executor,
        verification: blockedVerification,
        security: createFakeSecurityProvider(),
        workspace,
      });

    await runCli(["start", "-i", "F-001", "-t", "Blocked"], { repoRoot, createStack });
    // Drive to static_verification: approve the plan when the gate is reached.
    const stack = createStack(repoRoot);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const session = await stack.store.load("F-001");
      if (session.machine.state === WorkflowState.StaticVerification) {
        break;
      }
      if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
        await stack.orchestrator.approvePlan("F-001");
        continue;
      }
      await stack.orchestrator.runNext("F-001");
    }
    expect((await stack.store.load("F-001")).machine.state).toBe(WorkflowState.StaticVerification);

    const ran = await runCli(["run", "F-001"], { repoRoot, createStack });
    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("Workflow inconclusive at static_verification");
    expect(ran.stderr).toContain("package_manager_unknown");
    expect(ran.stderr).not.toContain("Unknown error");
  });
});

describe("plan gate honesty (P-23)", () => {
  it("prints the stored review path with 'Read it before approving' when no findings parsed", async () => {
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
    executor.configure("plan_review", {
      outcome: "needs_fix",
      artifacts: [{ name: "plan_review", content: { verdict: "needs_fix" } }],
      findings: [findingFor("F-001", "top-level only, never persisted")],
    });
    const createStack = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Gate"], { repoRoot, createStack });
    await runCli(["run", "F-001"], { repoRoot, createStack });

    const refused = await runCli(["approve", "plan", "F-001"], { repoRoot, createStack });
    expect(refused.exitCodes).toEqual([1]);
    expect(refused.stderr).toContain("Plan approval refused");
    expect(refused.stderr).toContain("Stored review:");
    expect(refused.stderr).toContain("plan-review.json");
    expect(refused.stderr).toContain("Read it before approving");
    expect(refused.stderr).not.toContain("findingsBySeverity");

    const status = await runCli(["status", "F-001"], { repoRoot, createStack });
    expect(status.stdout).toContain("Stored review:");
    expect(status.stdout).toContain("Read it before approving");
  });
});

describe("abandon on terminal states", () => {
  it("is idempotent on an already-failed feature (exit 0)", async () => {
    const repoRoot = await makeRepo();
    const executor = preApprovalExecutor();
    const createStack = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Abandon"], { repoRoot, createStack });
    const stack = createStack(repoRoot, {});
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const session = await stack.store.load("F-001");
      if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
        break;
      }
      await stack.orchestrator.runNext("F-001");
    }
    const first = await runCli(["abandon", "F-001", "--reason", "Wrong"], { repoRoot, createStack });
    expect(first.exitCodes).toEqual([]);
    expect(first.stdout).toContain("abandoned");

    const second = await runCli(["abandon", "F-001", "--reason", "Again"], { repoRoot, createStack });
    expect(second.exitCodes).toEqual([]);
    expect(second.stdout).toContain("Feature F-001 is already failed; nothing to abandon.");
  });

  it("refuses an already-complete feature (exit 1)", async () => {
    const repoRoot = await makeRepo();
    // Stub store: the session is complete, so the command must refuse before touching the orchestrator.
    const completeSession = {
      featureId: "F-001",
      machine: { state: WorkflowState.Complete },
    };
    const createStack = (): CliStack => ({
      orchestrator: {} as CliStack["orchestrator"],
      store: {
        load: () => Promise.resolve(completeSession),
      } as unknown as CliStack["store"],
    });
    const ran = await runCli(["abandon", "F-001", "--reason", "Too late"], { repoRoot, createStack });
    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("Feature F-001 is already complete and cannot be abandoned.");
  });

  it("keeps the existing error for unknown ids", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const createStack = stackFactory(executor);
    const ran = await runCli(["abandon", "F-999", "--reason", "Nope"], { repoRoot, createStack });
    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toMatch(/Error|Abandon failed/);
  });

  it("documents both terminal cases in the abandon help", () => {
    const cli = createCli({ createStack: stackFactory(new FakeStageExecutor()), cwd: () => tmpdir() });
    const abandon = cli.commands.find((command) => command.name() === "abandon");
    expect(abandon).toBeDefined();
    expect(abandon?.description()).toContain("already-failed");
    expect(abandon?.description()).toContain("already-complete");
  });
});
