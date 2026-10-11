import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState, type FixReturnState } from "@agent-workflow-kit/core";
import { createFeatureSessionStore, type FeatureSession } from "@agent-workflow-kit/persistence";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { nextStep } from "../apps/cli/src/next-step.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";

/**
 * Task O: after every command the CLI says what to do next.
 *
 * The first block pins the pure mapping exhaustively: one test iterates the full
 * `WorkflowState` enum, so a newly added state hits `nextStep`'s throwing default arm and fails
 * until it is mapped. The second block drives the real command tree through the fake stack (no
 * model calls) and asserts the `Next:` line after each command.
 */

function sessionIn(state: WorkflowState): FeatureSession {
  const machine =
    state === WorkflowState.Fixing
      ? { state, fixReturnState: WorkflowState.CodeReview as FixReturnState }
      : { state };
  return {
    schemaVersion: 5,
    featureId: "F-001",
    slug: "s",
    title: "t",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    machine,
    artifacts: {},
    approvals: { plan: null, push: null },
  } as unknown as FeatureSession;
}

const RUN_CONTINUES_STATES: readonly WorkflowState[] = [
  WorkflowState.Draft,
  WorkflowState.Grilling,
  WorkflowState.SpecReady,
  WorkflowState.Planning,
  WorkflowState.PlanReview,
  WorkflowState.Implementing,
  WorkflowState.CodeReview,
  WorkflowState.ScopeReview,
  WorkflowState.StaticVerification,
  WorkflowState.TestVerification,
  WorkflowState.RuntimeVerification,
  WorkflowState.Fixing,
  WorkflowState.SecurityReview,
  WorkflowState.FinalGate,
  WorkflowState.FinalSummary,
  WorkflowState.Committing,
  WorkflowState.Pushing,
];

describe("nextStep maps every workflow state", () => {
  it("covers the full WorkflowState enum: 21 states, each with one command and a one-line reason", () => {
    const states = Object.values(WorkflowState);
    expect(states).toHaveLength(21);

    for (const state of states) {
      const step = nextStep(sessionIn(state));
      expect(step.command.length, `command for ${state}`).toBeGreaterThan(0);
      expect(step.reason.length, `reason for ${state}`).toBeGreaterThan(0);
      expect(step.reason, `one-line reason for ${state}`).not.toContain("\n");
      expect(step.command, `one-line command for ${state}`).not.toContain("\n");
    }

    // The iteration above is the guard: a 22nd state reaches the throwing default arm.
    expect(new Set(states).size).toBe(21);
  });

  it("throws for a state outside the enum, so an unmapped state cannot read as guidance", () => {
    expect(() => nextStep(sessionIn("bogus" as WorkflowState))).toThrow("unmapped workflow state");
  });

  it("maps every machine-driven state to `agentflow run`", () => {
    expect(RUN_CONTINUES_STATES).toHaveLength(17);
    for (const state of RUN_CONTINUES_STATES) {
      expect(nextStep(sessionIn(state)).command, `command for ${state}`).toBe("agentflow run F-001");
    }
  });

  it("maps awaiting_plan_approval to status first, with --accept-findings only when unresolved", () => {
    const unresolved = nextStep(sessionIn(WorkflowState.AwaitingPlanApproval), {
      planReviewUnresolved: true,
    });
    expect(unresolved.command).toBe("agentflow status F-001");
    expect(unresolved.reason).toContain("agentflow approve plan F-001 --accept-findings");
    expect(unresolved.reason).toContain('agentflow abandon F-001 --reason "..."');

    const resolved = nextStep(sessionIn(WorkflowState.AwaitingPlanApproval), {
      planReviewUnresolved: false,
    });
    expect(resolved.command).toBe("agentflow status F-001");
    expect(resolved.reason).toContain("agentflow approve plan F-001");
    expect(resolved.reason).not.toContain("--accept-findings");

    // Unknown review reads as unresolved: fail closed, like the approval gate (N2, P-18).
    expect(nextStep(sessionIn(WorkflowState.AwaitingPlanApproval)).reason).toContain(
      "--accept-findings",
    );
  });

  it("maps awaiting_push_approval to status, then approve push, then run to commit and push", () => {
    const step = nextStep(sessionIn(WorkflowState.AwaitingPushApproval));
    expect(step.command).toBe("agentflow status F-001");
    expect(step.reason).toContain("agentflow approve push F-001");
    expect(step.reason).toContain("agentflow run F-001");
  });

  it("maps complete to done plus how to start another feature", () => {
    const step = nextStep(sessionIn(WorkflowState.Complete));
    expect(step.command).toBe("done");
    expect(step.reason).toContain("complete");
    expect(step.reason).toContain("agentflow start");
  });

  it("maps failed to terminal: cannot be resumed, start a new feature instead", () => {
    const step = nextStep(sessionIn(WorkflowState.Failed));
    expect(step.command).toBe("done");
    expect(step.reason).toContain("cannot be resumed");
    expect(step.reason).toContain("agentflow start");
  });
});

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-cli-next-"));
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
  options: { readonly repoRoot: string; readonly createStack?: (repoRoot: string, request: CliStackRequest) => CliStack },
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

/** Fake stack with a clean plan review, so approvals succeed without --accept-findings. */
function stackFactory(
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
  executor.configure("planning", {
    artifacts: [
      {
        name: "plan",
        content: {
          schemaVersion: 1,
          featureId: "F-001",
          summary: "A plan.",
          steps: [
            {
              id: "STEP-1",
              description: "Write the helper.",
              requirementIds: ["REQ-1"],
              expectedFiles: ["src/**"],
              verification: "Run the tests.",
            },
          ],
        },
      },
    ],
  });
  executor.configure("plan_review", {
    artifacts: [
      {
        name: "plan_review",
        content: { verdict: "pass", summary: "The plan covers the requirements.", findings: [] },
      },
    ],
  });

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

describe("Next: lines through the fake stack", () => {
  it("start says to run next", async () => {
    const repoRoot = await makeRepo();
    const started = await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], {
      repoRoot,
      createStack: stackFactory(new FakeStageExecutor()),
    });

    expect(started.exitCodes).toEqual([]);
    expect(started.stdout).toContain("Created feature F-001 (draft)");
    expect(started.stdout).toContain("Next: agentflow run F-001");
  });

  it("run at the plan gate recommends status, and --quiet silences the Next: line", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const factory = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], { repoRoot, createStack: factory });

    const ran = await runCli(["run", "F-001"], { repoRoot, createStack: factory });
    expect(ran.exitCodes).toEqual([]);
    expect(ran.stdout).toContain("Workflow paused at awaiting_plan_approval");
    expect(ran.stdout).toContain("Next: agentflow status F-001");
    expect(ran.stdout).toContain("agentflow approve plan F-001");

    const quiet = await runCli(["run", "F-001", "--quiet"], { repoRoot, createStack: factory });
    expect(quiet.exitCodes).toEqual([]);
    expect(quiet.stdout).toContain("Workflow paused at awaiting_plan_approval");
    expect(quiet.stdout).not.toContain("Next:");
  });

  it("approve plan says the approval only moved forward and run does the work", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const factory = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], { repoRoot, createStack: factory });
    await runCli(["run", "F-001"], { repoRoot, createStack: factory });

    const approved = await runCli(["approve", "plan", "F-001"], { repoRoot, createStack: factory });
    expect(approved.exitCodes).toEqual([]);
    expect(approved.stdout).toContain("Plan approved. Workflow advanced to implementing");
    expect(approved.stdout).toContain("Next: agentflow run F-001");
    expect(approved.stdout).toContain("only moved the workflow forward");
  });

  it("status prints the Next: recommendation for the current state", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const factory = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], { repoRoot, createStack: factory });
    await runCli(["run", "F-001"], { repoRoot, createStack: factory });

    const status = await runCli(["status", "F-001"], { repoRoot, createStack: factory });
    expect(status.exitCodes).toEqual([]);
    expect(status.stdout).toContain("State: awaiting_plan_approval");
    expect(status.stdout).toContain("Next: agentflow status F-001");
  });

  it("next prints the recommended command and reason, and errors clearly on unknown ids", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const factory = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], { repoRoot, createStack: factory });
    await runCli(["run", "F-001"], { repoRoot, createStack: factory });

    const next = await runCli(["next", "F-001"], { repoRoot, createStack: factory });
    expect(next.exitCodes).toEqual([]);
    expect(next.stdout).toContain("Next: agentflow status F-001");
    expect(next.stdout).toContain("agentflow approve plan F-001");

    const unknown = await runCli(["next", "F-999"], { repoRoot, createStack: factory });
    expect(unknown.exitCodes).toEqual([1]);
    expect(unknown.stderr).toContain('unknown feature id "F-999"');
  });

  it("abandon ends the feature and says a failed feature cannot be resumed", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const factory = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], { repoRoot, createStack: factory });
    await runCli(["run", "F-001"], { repoRoot, createStack: factory });

    const abandoned = await runCli(["abandon", "F-001", "--reason", "Wrong feature"], {
      repoRoot,
      createStack: factory,
    });
    expect(abandoned.exitCodes).toEqual([]);
    expect(abandoned.stdout).toContain("terminal state failed");
    expect(abandoned.stdout).toContain("Next: done");
    expect(abandoned.stdout).toContain("cannot be resumed");

    const session = await createFeatureSessionStore(repoRoot).load("F-001");
    expect(session.machine.state).toBe(WorkflowState.Failed);
  });

  it("approve push says run commits and pushes, after the full drive to the push gate", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    const factory = stackFactory(executor);
    await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], { repoRoot, createStack: factory });
    await runCli(["run", "F-001"], { repoRoot, createStack: factory });
    await runCli(["approve", "plan", "F-001"], { repoRoot, createStack: factory });
    const postApproval = await runCli(["run", "F-001"], { repoRoot, createStack: factory });
    expect(postApproval.stdout).toContain("awaiting_push");

    const status = await runCli(["status", "F-001"], { repoRoot, createStack: factory });
    expect(status.stdout).toContain("State: awaiting_push_approval");
    expect(status.stdout).toContain("Next: agentflow status F-001");
    expect(status.stdout).toContain("agentflow approve push F-001");

    const approved = await runCli(["approve", "push", "F-001"], { repoRoot, createStack: factory });
    expect(approved.exitCodes).toEqual([]);
    expect(approved.stdout).toContain("Push approved. Workflow advanced to committing");
    expect(approved.stdout).toContain("Next: agentflow run F-001");
    expect(approved.stdout).toContain("commits and pushes");
  });

  it("init says to edit the config, commit it, then start", async () => {
    const repoRoot = await makeRepo();
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({
        name: "test",
        private: true,
        scripts: { lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc -b", test: "vitest run" },
        devDependencies: { eslint: "^9.0.0", typescript: "^5.0.0", vitest: "^3.0.0" },
      }),
      "utf8",
    );
    await writeFile(join(repoRoot, "tsconfig.json"), "{}", "utf8");
    await writeFile(join(repoRoot, "package-lock.json"), "{}", "utf8");

    const initialized = await runCli(["init"], { repoRoot });
    expect(initialized.exitCodes).toEqual([]);
    expect(initialized.stdout).toContain("Initialized Agent Workflow Kit project");
    expect(initialized.stdout).toContain("Next:");
    expect(initialized.stdout).toContain("agent-workflow.config.json");
    expect(initialized.stdout).toContain("agentflow start");
  });
});
