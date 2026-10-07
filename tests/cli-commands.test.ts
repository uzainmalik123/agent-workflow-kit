import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { preflightOpenCode } from "../apps/cli/src/preflight.js";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";

/**
 * The CLI commands themselves, driven through a real scratch repository with an injected stack.
 *
 * `createCli` takes the stack factory, so these tests exercise argument parsing, the run loop, the
 * gate commands, the exit codes, and the messages without an executor that could reach a model: the
 * default stack is the real one, and the only way to get a fake is to say so, which is exactly what
 * each test here does. Nothing in this file runs `opencode`.
 */

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-cli-commands-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "cli@example.invalid");
  git(repoRoot, "config", "user.name", "CLI Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(join(repoRoot, "package.json"), '{"name":"test","version":"1.0.0"}', "utf8");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "--quiet", "-m", "initial");
  return repoRoot;
}

interface CliRun {
  readonly exitCodes: readonly number[];
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly repoRoot: string;
  readonly createStack?: (repoRoot: string, request: CliStackRequest) => CliStack;
}

/** Runs one command against `repoRoot`, capturing output and reported exit codes. */
async function runCli(args: readonly string[], options: RunOptions): Promise<CliRun> {
  const exitCodes: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.join(" "));
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

  return { exitCodes, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** The fake stack: real persistence and real orchestrator, fake executor and fake providers. */
function fakeStackFactory(
  executor: FakeStageExecutor,
): (repoRoot: string, request: CliStackRequest) => CliStack {
  // The three pre-approval stages write the documents the next one reads, so the loop behaves as it
  // does with a model: grill and spec out of `grill`, plan out of `planning`, and `plan_review`
  // approving what the defaults hand back.
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
  executor.configure("planning", {
    artifacts: [
      {
        name: "plan",
        content: { schemaVersion: 1, featureId: "F-001", summary: "A plan.", steps: [] },
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

async function startFeature(repoRoot: string, executor: FakeStageExecutor): Promise<CliRun> {
  return runCli(["start", "-i", "F-001", "-t", "Wire the stack"], {
    repoRoot,
    createStack: fakeStackFactory(executor),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("agentflow start", () => {
  it("creates the feature through the injected stack and persists it under .agentflow", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();

    const started = await startFeature(repoRoot, executor);

    expect(started.exitCodes).toEqual([]);
    expect(started.stdout).toContain("Created feature F-001 (draft)");

    const store = createFeatureSessionStore(repoRoot);
    const session = await store.load("F-001");
    expect(session.machine.state).toBe(WorkflowState.Draft);

    // The feature directory is `<featureId>-<slug of the title>`, so read the one entry rather
    // than hard-coding a slug the store chose.
    const [directory] = await readdir(join(repoRoot, ".agentflow", "features"));
    expect(directory).toMatch(/^F-001-/u);
    if (directory === undefined) {
      throw new Error("start did not persist a feature directory");
    }
    const sessionFile = await readFile(
      join(repoRoot, ".agentflow", "features", directory, "session.json"),
      "utf8",
    );
    expect(sessionFile).toContain("F-001");
  });
});

describe("agentflow run", () => {
  it("runs the pre-approval stages to the plan gate and stops there", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    await startFeature(repoRoot, executor);

    const ran = await runCli(["run", "F-001"], {
      repoRoot,
      createStack: fakeStackFactory(executor),
    });

    expect(ran.exitCodes).toEqual([]);
    expect(ran.stdout).toContain("Workflow paused at awaiting_plan_approval - awaiting approve_plan");
    expect(ran.stdout).toContain("Run 'agentflow approve plan'");
    expect(executor.executedStages).toEqual(["grill", "planning", "plan_review"]);

    const session = await createFeatureSessionStore(repoRoot).load("F-001");
    expect(session.machine.state).toBe(WorkflowState.AwaitingPlanApproval);
    expect(session.approvals.plan).toBeNull();
  });

  it("does not run a stage when the stack's preflight refuses the missing OpenCode", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    await startFeature(repoRoot, executor);

    // The real preflight's own answer for an executable no PATH contains, so the message the CLI
    // prints is the one a user would see, not a hand-written stand-in.
    const refusal = await preflightOpenCode({ command: "opencode-not-installed" }).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(refusal).not.toBeNull();
    expect(refusal?.message).toContain('OpenCode was not found at "opencode-not-installed"');

    const ran = await runCli(["run", "F-001"], {
      repoRoot,
      createStack: (stackRepoRoot) => ({
        ...createOrchestratorStack(stackRepoRoot, {
          executor,
          verification: createFakeVerificationProvider(),
          security: createFakeSecurityProvider(),
        }),
        preflight: () => Promise.reject(refusal ?? new Error("unreachable")),
      }),
    });

    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("Error: OpenCode was not found");
    expect(ran.stderr).toContain("needs that command on PATH");
    // The refusal happens before the first `runNext`, so the workflow never touched a stage.
    expect(executor.callCount).toBe(0);

    const session = await createFeatureSessionStore(repoRoot).load("F-001");
    expect(session.machine.state).toBe(WorkflowState.Draft);
  });
});

describe("agentflow approve plan", () => {
  it("approves the gate the run stopped at and advances the persisted state", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    await startFeature(repoRoot, executor);
    await runCli(["run", "F-001"], { repoRoot, createStack: fakeStackFactory(executor) });

    const approved = await runCli(["approve", "plan", "F-001"], {
      repoRoot,
      createStack: fakeStackFactory(executor),
    });

    expect(approved.exitCodes).toEqual([]);
    expect(approved.stdout).toContain("Plan approved. Workflow advanced to implementing");

    const session = await createFeatureSessionStore(repoRoot).load("F-001");
    expect(session.machine.state).toBe(WorkflowState.Implementing);
    expect(session.approvals.plan).not.toBeNull();
  });
});

describe("help and version", () => {
  // Commander writes help and version and then calls its own exit, which in-process would end the
  // vitest worker itself — so these two go through the built binary like `tests/init.test.ts`.
  const cliPath = join(__dirname, "../apps/cli/dist/cli.js");

  async function runBinary(args: readonly string[]): Promise<{ code: number; stdout: string }> {
    try {
      const result = await promisify(execFile)("node", [cliPath, ...args]);
      return { code: 0, stdout: result.stdout };
    } catch (error: unknown) {
      const err = error as { code?: number; stdout?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? "" };
    }
  }

  it("prints usage for --help", async () => {
    const help = await runBinary(["--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: agentflow");
    expect(help.stdout).toContain("start");
    expect(help.stdout).toContain("run");
    expect(help.stdout).toContain("approve");
  });

  it("prints the package's own version for --version", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
    ) as { version: string };

    const version = await runBinary(["--version"]);

    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(packageJson.version);
  });
});
