import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";

/**
 * The two CLI warnings of Task L, driven through the fake stack.
 *
 * Both warnings are advisory on purpose: each test asserts that the message printed *and* that the
 * command still did exactly what it did before the warning existed — `run` still reaches the plan
 * gate, `approve plan` still approves. Nothing here runs `opencode`.
 *
 * The scratch repository commits a `.gitignore` for `.agentflow/`, the same protection `agentflow
 * init` writes, so a test about untracked files is about the files it creates and not about the
 * framework's own state directory.
 */

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-cli-warnings-"));
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
  readonly warnings: string;
}

interface RunOptions {
  readonly repoRoot: string;
  readonly createStack?: (repoRoot: string, request: CliStackRequest) => CliStack;
}

/** Runs one command, capturing everything it printed, including `console.warn`. */
async function runCli(args: readonly string[], options: RunOptions): Promise<CliRun> {
  const exitCodes: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const warnings: string[] = [];

  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
    warnings.push(parts.join(" "));
  });

  try {
    const cli = createCli({
      ...(options.createStack === undefined ? {} : { createStack: options.createStack }),
      cwd: () => options.repoRoot,
      exit: (code: number) => {
        exitCodes.push(code);
      },
    });

    await cli.parseAsync(["node", "agentflow", ...args]);
  } finally {
    vi.restoreAllMocks();
  }

  return {
    exitCodes,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    warnings: warnings.join("\n"),
  };
}

/**
 * The fake stack, with the plan configured per test.
 *
 * The default plan is the shape the planner really produced before Task L — steps that declare
 * their files under some other key, so `approvedScopeFromPlan` derives nothing from them.
 */
function fakeStackFactory(
  executor: FakeStageExecutor,
): (repoRoot: string, request: CliStackRequest) => CliStack {
  executor.configure("grill", {
    artifacts: [
      { name: "grill", content: { featureId: "F-001", decisions: [] } },
      {
        name: "spec",
        content: {
          schemaVersion: 1,
          featureId: "F-001",
          summary: "A summary the plan reviewer reads.",
          requirements: [],
        },
      },
    ],
  });

  return (repoRoot) =>
    createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
}

/** A planning result whose steps leave the derived scope empty (P-13's plan). */
function executorWithoutExpectedFiles(): FakeStageExecutor {
  const executor = new FakeStageExecutor();
  executor.configure("planning", {
    artifacts: [
      {
        name: "plan",
        content: {
          schemaVersion: 1,
          featureId: "F-001",
          summary: "A plan that names its files under other keys.",
          declaredFileSet: { created: ["src/app.ts"], modified: [], deleted: [] },
          steps: [
            {
              id: "STEP-1",
              description: "Write the helper.",
              requirementIds: ["REQ-1"],
              files: ["src/app.ts"],
              verification: "Run the tests.",
            },
          ],
        },
      },
    ],
  });

  return executor;
}

/** A planning result whose every step names `expectedFiles`, the key the derivation reads. */
function executorWithExpectedFiles(): FakeStageExecutor {
  const executor = new FakeStageExecutor();
  executor.configure("planning", {
    artifacts: [
      {
        name: "plan",
        content: {
          schemaVersion: 1,
          featureId: "F-001",
          summary: "A plan the scope derivation can read.",
          steps: [
            {
              id: "STEP-1",
              description: "Write the helper.",
              requirementIds: ["REQ-1"],
              expectedFiles: ["src/app.ts"],
              verification: "Run the tests.",
            },
          ],
        },
      },
    ],
  });

  return executor;
}

async function startFeature(repoRoot: string, executor: FakeStageExecutor): Promise<CliRun> {
  return runCli(["start", "-i", "F-001", "-t", "Wire the stack"], {
    repoRoot,
    createStack: fakeStackFactory(executor),
  });
}

/** Runs to the plan gate, the point at which both warnings have to have been seen. */
async function runToPlanGate(
  repoRoot: string,
  executor: FakeStageExecutor,
): Promise<CliRun> {
  await startFeature(repoRoot, executor);
  return runCli(["run", "F-001"], { repoRoot, createStack: fakeStackFactory(executor) });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("untracked files warning", () => {
  it("prints at run start, naming the files and the worktree they will not reach", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    await writeFile(join(repoRoot, "notes.md"), "scratch notes\n", "utf8");

    const ran = await runToPlanGate(repoRoot, executor);

    expect(ran.exitCodes).toEqual([]);
    expect(ran.warnings).toContain("untracked file(s) will not be seen by write stages");
    expect(ran.warnings).toContain("notes.md");
    expect(ran.warnings).toContain("Write stages run in a worktree of the approved commit");
    // The warning is advice, not a gate: the run still reached the plan gate.
    expect(ran.stdout).toContain("Workflow paused at awaiting_plan_approval");
  });

  it("says nothing when the working tree has no untracked file", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();

    const ran = await runToPlanGate(repoRoot, executor);

    expect(ran.warnings).not.toContain("untracked");
    expect(ran.stdout).toContain("Workflow paused at awaiting_plan_approval");
  });

  it("prints before `approve plan` too, and does not stop the approval", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    await runToPlanGate(repoRoot, executor);
    await writeFile(join(repoRoot, "notes.md"), "scratch notes\n", "utf8");

    const approved = await runCli(["approve", "plan", "F-001"], {
      repoRoot,
      createStack: fakeStackFactory(executor),
    });

    expect(approved.warnings).toContain("untracked file(s) will not be seen by write stages");
    expect(approved.warnings).toContain("notes.md");
    expect(approved.exitCodes).toEqual([]);
    expect(approved.stdout).toContain("Plan approved. Workflow advanced to implementing");

    const session = await createFeatureSessionStore(repoRoot).load("F-001");
    expect(session.approvals.plan).not.toBeNull();
  });
});

describe("empty approved-scope warning at plan approval", () => {
  it("warns that implementation will fail the scope check, and approves anyway", async () => {
    const repoRoot = await makeRepo();
    const executor = executorWithoutExpectedFiles();
    const ran = await runToPlanGate(repoRoot, executor);

    expect(ran.exitCodes).toEqual([]);

    const approved = await runCli(["approve", "plan", "F-001"], {
      repoRoot,
      createStack: fakeStackFactory(executor),
    });

    expect(approved.warnings).toContain("implementation will fail the scope check");
    expect(approved.warnings).toContain("zero file patterns");
    expect(approved.warnings).toContain("`expectedFiles`");
    expect(approved.exitCodes).toEqual([]);
    expect(approved.stdout).toContain("Plan approved. Workflow advanced to implementing");

    const session = await createFeatureSessionStore(repoRoot).load("F-001");
    expect(session.machine.state).toBe(WorkflowState.Implementing);
    expect(session.approvals.plan).not.toBeNull();
  });

  it("stays silent when the stored plan yields a non-empty scope", async () => {
    const repoRoot = await makeRepo();
    const executor = executorWithExpectedFiles();
    await runToPlanGate(repoRoot, executor);

    const approved = await runCli(["approve", "plan", "F-001"], {
      repoRoot,
      createStack: fakeStackFactory(executor),
    });

    expect(approved.warnings).not.toContain("zero file patterns");
    expect(approved.warnings).not.toContain("implementation will fail the scope check");
    expect(approved.exitCodes).toEqual([]);
    expect(approved.stdout).toContain("Plan approved. Workflow advanced to implementing");
  });
});
