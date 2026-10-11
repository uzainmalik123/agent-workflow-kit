import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import {
  ALL_CATALOG_CODES,
  formatCatalogCode,
  formatVerificationSummary,
  stripControlCharacters,
} from "../apps/cli/src/error-catalog.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { FakeStageExecutor, findingFor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider, passingEvidenceFor } from "../fixtures/verification-provider.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d20-"));
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

async function runCli(
  args: readonly string[],
  options: { readonly repoRoot: string; readonly createStack: (repoRoot: string, request: CliStackRequest) => CliStack },
): Promise<{ exitCodes: readonly number[]; stdout: string; stderr: string }> {
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

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("D-20 catalog: exhaustive coverage", () => {
  it("maps every code to a four-part message with the raw code, wrapped and stripped", () => {
    expect(ALL_CATALOG_CODES.length).toBe(9 + 6 + 11);
    for (const code of ALL_CATALOG_CODES) {
      const lines = formatCatalogCode(code, { featureId: "F-001", detail: "recorded detail with\tescape\u001b[0m" });
      expect(lines.length).toBeGreaterThan(0);
      const text = lines.join("\n");
      const flat = text.replace(/\s+/g, " ");
      // Raw code in parentheses so it can be searched.
      expect(flat).toContain(`(${code})`);
      // Four parts plus next command.
      expect(flat).toContain("Why:");
      expect(flat).toContain("Fix:");
      expect(flat).toContain("Evidence:");
      expect(flat).toContain("Next:");
      expect(flat).toContain("agentflow status F-001");
      // Wrapped, never truncated; stripped of control characters.
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(100);
      }
      expect(text).not.toContain("…");
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\t");
      expect(text).not.toContain("Unknown error");
    }
  });

  it("falls back to cause not determined with evidence and status command for unknown codes", () => {
    const lines = formatCatalogCode("not_a_real_code", { featureId: "F-009" });
    const text = lines.join("\n");
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("(not_a_real_code)");
    expect(flat).toContain("cause not determined");
    expect(flat).toContain("agentflow status F-009");
    expect(text).not.toContain("Unknown error");
  });

  it("gives the exact package_manager_unknown message for a declared build script with no lockfile", () => {
    const lines = formatCatalogCode("package_manager_unknown", {
      featureId: "F-001",
      checkId: "build",
      detail: 'The manifest declares a "build" script.',
    });
    const text = lines.join("\n");
    const flat = text.replace(/\s+/g, " ");
    // What + raw code.
    expect(flat).toContain("(package_manager_unknown)");
    expect(flat).toContain('"build"');
    // Why names the real cause per D-20.
    expect(flat).toContain("no lockfile");
    expect(flat).toContain("packageManager");
    expect(flat).toContain("package.json");
    // How to fix with the exact command.
    expect(flat).toContain("npm install --package-lock-only");
    // Evidence path and next command.
    expect(flat).toContain("Evidence:");
    expect(flat).toContain("agentflow status F-001");
    expect(text).not.toContain("Unknown error");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it("renders the skipped line in the verification summary as skipped (script_absent)", () => {
    const lines = formatVerificationSummary([
      { id: "build", status: "skipped", reason: "script_absent", detail: 'The manifest declares no "build" script.' },
    ]);
    const text = lines.join("\n");
    expect(text).toContain("build: skipped (script_absent)");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
    expect(stripControlCharacters("a\u0007b")).toBe("ab");
  });
});

describe("D-20 CLI: createCli through the fake stack for blocked, inconclusive, failed", () => {
  it("blocked verification prints the catalog code, never Unknown error", async () => {
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
      outcome: "success",
      artifacts: [{ name: "plan_review", content: { verdict: "pass", summary: "Clean.", findings: [] } }],
    });
    executor.configure("implementation", {
      outcome: "success",
      artifacts: [{ name: "implementation", content: { featureId: "F-001", notes: "done" } }],
    });
    executor.configure("code_review", { outcome: "success" });
    executor.configure("scope_review", { outcome: "success" });
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
            script: "build",
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
    const stack = createStack(repoRoot);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const session = await stack.store.load("F-001");
      if (session.machine.state === WorkflowState.StaticVerification) break;
      if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
        await stack.orchestrator.approvePlan("F-001");
        continue;
      }
      await stack.orchestrator.runNext("F-001");
    }
    const ran = await runCli(["run", "F-001"], { repoRoot, createStack });
    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("(package_manager_unknown)");
    expect(ran.stderr).not.toContain("Unknown error");
    for (const line of ran.stderr.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it("inconclusive prints the stage explanation with the raw code, never Unknown error", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    executor.configure("grill", {
      outcome: "inconclusive",
      artifacts: [],
      findings: [findingFor("F-001", "The plan cannot be judged without a target service.")],
      evidence: [{ kind: "static", description: "No lint command is declared, so nothing was measured." }],
      summary: "The grill stage could not conclude.",
    });
    const createStack = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Inconclusive"], { repoRoot, createStack });
    const ran = await runCli(["run", "F-001"], { repoRoot, createStack });
    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("Workflow inconclusive at grill");
    expect(ran.stderr).not.toContain("Unknown error");
    for (const line of ran.stderr.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it("failed prints the stage_failed catalog message, never Unknown error", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    executor.configure("grill", {
      outcome: "failed",
      artifacts: [],
      findings: [findingFor("F-001", "The grill stage failed outright.")],
      summary: "Grill failed.",
    });
    const createStack = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Failed"], { repoRoot, createStack });
    const ran = await runCli(["run", "F-001"], { repoRoot, createStack });
    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("(stage_failed)");
    expect(ran.stderr).not.toContain("Unknown error");
    for (const line of ran.stderr.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});
