import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState, type ReviewFinding } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  type WorkflowOrchestrator,
} from "@agent-workflow-kit/orchestration";
import {
  createFeatureSessionStore,
  type FeatureSession,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { FakeStageExecutor, findingFor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * D-13: a plan-review verdict is resolved by the human at the plan approval gate.
 *
 * Three things have to hold together, and each is asserted here against the real command tree:
 *
 * - the orchestrator parks a `plan_review` `needs_fix` at `awaiting_plan_approval` instead of handing
 *   it to a fixer that has no authority over the plan;
 * - the CLI shows that review — verdict and findings — at `run` and at `status`, and refuses to
 *   approve over it without an explicit `--accept-findings`;
 * - `agentflow abandon` ends a feature the human has decided not to carry on with, on exactly the
 *   terms the state machine allows.
 *
 * Nothing here runs a model: the stages are the fake executor's, and the repository is a scratch
 * Git repo the CLI's own stack is pointed at.
 */

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d13-"));
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

/** Runs one command through the real command tree, capturing everything it printed. */
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

  return {
    exitCodes,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

/** The review document a `plan_review` artifact carries when the reviewer wants changes. */
const UNRESOLVED_REVIEW = {
  verdict: "needs_fix",
  summary: "The plan leaves the migration untested.",
  findings: [
    { severity: "error", message: "Step STEP-1 has no test" },
    { severity: "warning", message: "src/app.ts is named by no step" },
  ],
};

/** The review document a `plan_review` artifact carries when the reviewer is satisfied. */
const CLEAN_REVIEW = {
  verdict: "success",
  summary: "Every requirement maps to a step with a verification.",
  findings: [],
};

interface ReviewAnswer {
  readonly content: unknown;
  readonly outcome: "success" | "needs_fix";
  readonly findings?: readonly ReviewFinding[];
}

/**
 * The pre-approval stages, with `plan_review` answering the way the test needs.
 *
 * The review's verdict lives in the artifact, which is the only place the gate and the display can
 * read it from: the response envelope's own `findings` are validated and returned, never persisted.
 */
function executorReviewing(answer: ReviewAnswer): FakeStageExecutor {
  const executor = new FakeStageExecutor();

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
          summary: "A plan whose every step names its files.",
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
    outcome: answer.outcome,
    artifacts: [{ name: "plan_review", content: answer.content }],
    ...(answer.findings === undefined ? {} : { findings: answer.findings }),
  });

  executor.configure("implementation", {
    outcome: "success",
    artifacts: [{ name: "implementation", content: { featureId: "F-001", notes: "done" } }],
  });

  return executor;
}

function stackFactory(
  executor: FakeStageExecutor,
): (repoRoot: string, request: CliStackRequest) => CliStack {
  const workspace = createFakeWorkspaceProvider();
  return (repoRoot) =>
    createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
      workspace,
    });
}

async function startFeature(repoRoot: string, executor: FakeStageExecutor): Promise<CliRun> {
  return runCli(["start", "-i", "F-001", "-t", "Wire the stack"], {
    repoRoot,
    createStack: stackFactory(executor),
  });
}

/** Runs to the plan gate — the point where every D-13 command has to have its answer ready. */
async function runToPlanGate(repoRoot: string, executor: FakeStageExecutor): Promise<CliRun> {
  await startFeature(repoRoot, executor);
  return runCli(["run", "F-001"], { repoRoot, createStack: stackFactory(executor) });
}

async function sessionAt(repoRoot: string): Promise<FeatureSession> {
  return createFeatureSessionStore(repoRoot).load("F-001");
}

/**
 * The orchestrator harness the first test drives, with no workspace provider at all.
 *
 * A pre-approval stage never needs one — it reads the repository root — so this is the smallest
 * stack that can prove where a `plan_review` verdict goes.
 */
interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly orchestrator: WorkflowOrchestrator;
}

async function harness(): Promise<Harness> {
  const store = createFeatureSessionStore(await makeRepo());
  const executor = new FakeStageExecutor();

  return {
    store,
    executor,
    orchestrator: createWorkflowOrchestrator({
      store,
      executor,
      verification: createFakeVerificationProvider(),
    }),
  };
}

async function driveTo(h: Harness, target: WorkflowState): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const session = await h.store.load("F-001");

    if (session.machine.state === target) {
      return;
    }

    if (session.machine.state === WorkflowState.Failed) {
      throw new Error("Feature failed while driving to the target state.");
    }

    await h.orchestrator.runNext("F-001");
  }

  throw new Error(`Workflow never reached state "${target}".`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("plan_review needs_fix reaches the human (D-13)", () => {
  it("parks at the approval gate with the artifact recorded, never entering the fixer", async () => {
    const h = await harness();

    await h.orchestrator.createFeature({
      featureId: "F-001",
      title: "Plan gate",
      request: "# Request\n\nReview the plan.\n",
    });

    h.executor.configure("plan_review", {
      outcome: "needs_fix",
      findings: [findingFor("F-001", "the plan needs work")],
      artifacts: [{ name: "plan_review", content: UNRESOLVED_REVIEW }],
    });

    await driveTo(h, WorkflowState.PlanReview);

    const review = await h.orchestrator.runNext("F-001");

    expect(review).toMatchObject({
      status: "stage_completed",
      state: WorkflowState.AwaitingPlanApproval,
    });

    const session = await h.store.load("F-001");
    expect(session.machine.state).toBe(WorkflowState.AwaitingPlanApproval);
    expect(session.artifacts.plan_review.status).toBe("present");
    expect(h.executor.calls.some((request) => request.stage === "fixing")).toBe(false);
  });

  it("still sends a code-stage verdict to the fixer, where the fixer has authority", async () => {
    const repoRoot = await makeRepo();
    const executor = executorReviewing({ content: CLEAN_REVIEW, outcome: "success" });
    executor.configure("code_review", {
      outcome: "needs_fix",
      findings: [findingFor("F-001", "The implementation skips step 2")],
    });

    await startFeature(repoRoot, executor);

    const stack = stackFactory(executor)(repoRoot, {});
    const orchestrator = stack.orchestrator;

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const session = await stack.store.load("F-001");

      if (session.machine.state === WorkflowState.CodeReview) {
        break;
      }

      if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
        await orchestrator.approvePlan("F-001");
        continue;
      }

      if (session.machine.state === WorkflowState.Failed) {
        throw new Error("Feature failed while driving to code review.");
      }

      await orchestrator.runNext("F-001");
    }

    const session = await stack.store.load("F-001");
    expect(session.machine.state).toBe(WorkflowState.CodeReview);

    const review = await orchestrator.runNext("F-001");

    expect(review).toMatchObject({
      status: "fix_requested",
      stage: "code_review",
      state: WorkflowState.Fixing,
    });
  });
});

describe("the plan review is shown where the human has to act on it", () => {
  it("prints the verdict, the findings, and the way out at the gate", async () => {
    const repoRoot = await makeRepo();
    const executor = executorReviewing({
      content: UNRESOLVED_REVIEW,
      outcome: "needs_fix",
      findings: [findingFor("F-001", "Step STEP-1 has no test")],
    });

    const ran = await runToPlanGate(repoRoot, executor);

    expect(ran.exitCodes).toEqual([]);
    expect(ran.stdout).toContain("Workflow paused at awaiting_plan_approval");
    expect(ran.stdout).toContain("Plan review: needs_fix");
    expect(ran.stdout).toContain("The plan leaves the migration untested.");
    expect(ran.stdout).toContain("[error] Step STEP-1 has no test");
    expect(ran.stdout).toContain("[warning] src/app.ts is named by no step");
    expect(ran.stdout).toContain("agentflow approve plan F-001 --accept-findings");
    expect(ran.stdout).toContain("agentflow abandon F-001 --reason");
  });

  it("prints the same findings from status", async () => {
    const repoRoot = await makeRepo();
    const executor = executorReviewing({
      content: UNRESOLVED_REVIEW,
      outcome: "needs_fix",
      findings: [findingFor("F-001", "Step STEP-1 has no test")],
    });
    await runToPlanGate(repoRoot, executor);

    const status = await runCli(["status", "F-001"], {
      repoRoot,
      createStack: stackFactory(executor),
    });

    expect(status.exitCodes).toEqual([]);
    expect(status.stdout).toContain("State: awaiting_plan_approval");
    expect(status.stdout).toContain("Plan review: needs_fix");
    expect(status.stdout).toContain("[error] Step STEP-1 has no test");
    expect(status.stdout).toContain("[warning] src/app.ts is named by no step");
  });

  it("says nothing when the review recorded nothing to act on", async () => {
    const repoRoot = await makeRepo();
    const executor = executorReviewing({ content: { featureId: "F-001" }, outcome: "success" });
    await runToPlanGate(repoRoot, executor);

    const status = await runCli(["status", "F-001"], {
      repoRoot,
      createStack: stackFactory(executor),
    });

    expect(status.exitCodes).toEqual([]);
    expect(status.stdout).not.toContain("Plan review:");
    expect(status.stdout).not.toContain("findings");
  });
});

describe("approving over unresolved findings", () => {
  it("refuses without --accept-findings, then approves with it", async () => {
    const repoRoot = await makeRepo();
    const executor = executorReviewing({
      content: UNRESOLVED_REVIEW,
      outcome: "needs_fix",
      findings: [findingFor("F-001", "Step STEP-1 has no test")],
    });
    await runToPlanGate(repoRoot, executor);

    const refused = await runCli(["approve", "plan", "F-001"], {
      repoRoot,
      createStack: stackFactory(executor),
    });

    expect(refused.exitCodes).toEqual([1]);
    expect(refused.stderr).toContain("Plan approval refused");
    expect(refused.stderr).toContain("[error] Step STEP-1 has no test");
    expect(refused.stderr).toContain("--accept-findings");
    expect(refused.stderr).toContain("agentflow abandon F-001 --reason");

    // The refusal is the CLI's own: the gate itself was never reached, so the feature is exactly
    // where the run left it and nothing has been approved in secret.
    const untouched = await sessionAt(repoRoot);
    expect(untouched.machine.state).toBe(WorkflowState.AwaitingPlanApproval);
    expect(untouched.approvals.plan).toBeNull();

    const approved = await runCli(["approve", "plan", "F-001", "--accept-findings"], {
      repoRoot,
      createStack: stackFactory(executor),
    });

    expect(approved.exitCodes).toEqual([]);
    expect(approved.stdout).toContain("Plan approved. Workflow advanced to implementing");

    const session = await sessionAt(repoRoot);
    expect(session.machine.state).toBe(WorkflowState.Implementing);
    expect(session.approvals.plan).not.toBeNull();
  });

  it("approves a review with nothing unresolved, without the flag", async () => {
    const repoRoot = await makeRepo();
    const executor = executorReviewing({ content: CLEAN_REVIEW, outcome: "success" });
    await runToPlanGate(repoRoot, executor);

    const approved = await runCli(["approve", "plan", "F-001"], {
      repoRoot,
      createStack: stackFactory(executor),
    });

    expect(approved.exitCodes).toEqual([]);
    expect(approved.stderr).not.toContain("Plan approval refused");
    expect(approved.stdout).toContain("Plan approved. Workflow advanced to implementing");
  });
});

describe("agentflow abandon", () => {
  it("ends a feature at the gate, and refuses one the machine says is terminal", async () => {
    const repoRoot = await makeRepo();
    const executor = executorReviewing({
      content: UNRESOLVED_REVIEW,
      outcome: "needs_fix",
      findings: [findingFor("F-001", "Step STEP-1 has no test")],
    });
    await runToPlanGate(repoRoot, executor);

    const abandoned = await runCli(["abandon", "F-001", "--reason", "Wrong feature entirely"], {
      repoRoot,
      createStack: stackFactory(executor),
    });

    expect(abandoned.exitCodes).toEqual([]);
    expect(abandoned.stdout).toContain("Abandoning F-001: Wrong feature entirely");
    expect(abandoned.stdout).toContain(
      "Feature F-001 abandoned; the workflow reached terminal state failed.",
    );

    const session = await sessionAt(repoRoot);
    expect(session.machine.state).toBe(WorkflowState.Failed);

    // A second abandon has nothing left to end, and the state machine — not the CLI — is what says
    // so. Its message is the one a human reads.
    const again = await runCli(["abandon", "F-001", "--reason", "Again"], {
      repoRoot,
      createStack: stackFactory(executor),
    });

    expect(again.exitCodes).toEqual([1]);
    expect(again.stderr).toContain(
      'State "failed" is terminal and cannot process event "fail".',
    );
    expect(again.stdout).toContain("Abandoning F-001: Again");
  });
});
