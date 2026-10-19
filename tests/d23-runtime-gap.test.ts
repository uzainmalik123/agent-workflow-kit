import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowState } from "@agent-workflow-kit/core";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import {
  createProjectSecurityReviewProvider,
  createProjectVerificationProvider,
} from "@agent-workflow-kit/project";
import { GitFeaturePublisher, GitWorkspaceProvider } from "@agent-workflow-kit/workspace";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Task X / D-23: the runtime gap a project with no runtime verification carries reaches publishing.
 *
 * A project that declares no runtime verification used to park `runtime_verification` forever at
 * `inconclusive`: valid deferred evidence was never a rejection (D-22), but nothing measured meant
 * nothing decided, so every `agentflow run` re-presented the same stage. D-23 changes exactly one
 * bundle's meaning — outcome `deferred`, verification `runtime`, every check `skipped` with reason
 * `runtime_not_configured` is a *recorded gap*, not an undecided stage: the framework advances it
 * itself with no model call, the final gate treats the stage as `not_performed`, and publishing sits
 * behind an explicit `--accept-unverified runtime` acknowledgment at the push gate.
 *
 * These tests drive the real command tree (`createCli`) with p4-basic's real verification commands,
 * the real git workspace and security review, and a fake model executor only. No model is called;
 * the runtime app in the "configured" test is a node process the framework starts and stops itself.
 *
 * compliance/decisions.md D-23; compliance/KNOWN_ISSUES.md P-32. PRD §17 (M11), §18 (M12), R-146.
 */

const here = dirname(fileURLToPath(import.meta.url));
const p4Basic = join(here, "fixtures", "p4-basic");

const roots: string[] = [];

interface CliRun {
  readonly exitCodes: readonly number[];
  readonly stdout: string;
  readonly stderr: string;
}

function git(cwd: string, ...args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

/** A temp git repository holding a committed copy of p4-basic, `.agentflow/` ignored. */
async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d23-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await cp(p4Basic, repoRoot, { recursive: true });
  await mkdir(join(base, "cache"), { recursive: true });
  await writeFile(join(repoRoot, ".gitignore"), ".agentflow/\n", "utf8");
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "d23@example.invalid");
  git(repoRoot, "config", "user.name", "D-23");
  git(repoRoot, "config", "commit.gpgsign", "false");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "--quiet", "-m", "p4-basic copy");
  return repoRoot;
}

/** A temp git repository that is p4-basic plus a configured, failing runtime verification. */
async function makeRepoWithFailingRuntime(): Promise<string> {
  const repoRoot = await makeRepo();
  const config = JSON.parse(await readFile(join(repoRoot, "agent-workflow.config.json"), "utf8")) as {
    verification: Record<string, unknown>;
  };
  config.verification["runtime"] = {
    command: { executable: "node", args: ["-e", "process.exit(1)"] },
    readiness: { url: "http://127.0.0.1:4699/health", timeoutMs: 10000 },
    checks: [{ id: "web", path: "/", expectedStatus: 200, expectedBodyFragment: "Dashboard" }],
    timeoutMs: 30000,
  };
  await writeFile(
    join(repoRoot, "agent-workflow.config.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "--quiet", "-m", "declare failing runtime verification");
  return repoRoot;
}

async function runCli(
  args: readonly string[],
  repoRoot: string,
  createStack: (repoRoot: string, request: CliStackRequest) => CliStack,
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
  vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.join(" "));
  });

  try {
    const cli = createCli({
      createStack,
      cwd: () => repoRoot,
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

/** The stack wiring from `createRealStack`, with the model executor replaced by the fake. */
function stackFactory(executor: FakeStageExecutor, cacheRoot: string) {
  return (repoRoot: string): CliStack =>
    createOrchestratorStack(repoRoot, {
      executor,
      verification: createProjectVerificationProvider({
        projectRoot: repoRoot,
        resolveRunRoot: (request) => request.projectRoot,
      }),
      security: createProjectSecurityReviewProvider({
        projectRoot: repoRoot,
        resolveRoot: (request) => request.projectRoot,
      }),
      workspace: new GitWorkspaceProvider({ cacheRoot }),
      publisher: new GitFeaturePublisher(),
    });
}

function pipelineExecutor(): FakeStageExecutor {
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
  return executor;
}

/** Drives a feature through the real command tree to the push gate, and returns the executor. */
async function driveToPushGate(executor: FakeStageExecutor, cacheRoot: string): Promise<string> {
  const repoRoot = await makeRepo();
  const createStack = stackFactory(executor, cacheRoot);
  const store = createFeatureSessionStore(repoRoot);

  const started = await runCli(["start", "-i", "F-001", "-t", "Runtime gap"], repoRoot, createStack);
  expect(started.exitCodes, JSON.stringify(started.stderr)).toEqual([]);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = (await store.load("F-001")).machine.state;

    if (state === WorkflowState.AwaitingPushApproval) {
      return repoRoot;
    }

    if (state === WorkflowState.AwaitingPlanApproval) {
      const approved = await runCli(["approve", "plan", "F-001"], repoRoot, createStack);
      expect(approved.exitCodes, JSON.stringify(approved.stderr)).toEqual([]);
      continue;
    }

    const ran = await runCli(["run", "F-001", "--quiet"], repoRoot, createStack);
    expect(ran.exitCodes, JSON.stringify([ran.stdout, ran.stderr])).toEqual([]);
  }

  throw new Error("The workflow never reached awaiting_push_approval.");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("agentflow run on a project with no runtime configuration (D-23)", () => {
  it("reaches awaiting_push_approval with no model call for the runtime stage, and the hint names the acknowledgment", async () => {
    const executor = pipelineExecutor();
    const cacheRoot = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d23-cache-"));
    roots.push(cacheRoot);
    const repoRoot = await driveToPushGate(executor, cacheRoot);
    const store = createFeatureSessionStore(repoRoot);
    const createStack = stackFactory(executor, cacheRoot);

    expect((await store.load("F-001")).machine.state).toBe(WorkflowState.AwaitingPushApproval);

    // D-23's core promise: no executor call happened for the runtime stage. The framework advanced
    // it on its own recorded answer; the model was never consulted and nothing was overruled.
    expect(executor.calls.map((request) => request.stage)).not.toContain("runtime_verification");

    // The gap is on the recorded gate, and the final summary says so in the words the decision fixed.
    const gate = (await store.readArtifact("F-001", "final_gate")) as Record<string, unknown>;
    const gaps = gate["unverifiedRuntime"] as readonly {
      workStage: string;
      reason: string;
      revision: number;
      fingerprint: string;
    }[];
    expect(gate["status"]).toBe("passed");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      workStage: "runtime_verification",
      reason: "runtime_not_configured",
    });
    expect(gaps[0]?.revision).toBeGreaterThan(0);
    expect(gaps[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.readArtifactText("F-001", "final_summary")).toContain(
      "runtime verification: not performed (not configured)",
    );

    // Every human gate maps to `status` first, and this one must name the acknowledgment a human
    // reads before approving: the hint says `--accept-unverified runtime` only while the gap is on
    // the gate.
    const status = await runCli(["status", "F-001"], repoRoot, createStack);
    expect(status.exitCodes, JSON.stringify(status.stderr)).toEqual([]);
    expect(status.stdout).toContain("State: awaiting_push_approval");
    expect(status.stdout).toContain("--accept-unverified runtime");

    const next = await runCli(["next", "F-001"], repoRoot, createStack);
    expect(next.exitCodes, JSON.stringify(next.stderr)).toEqual([]);
    expect(next.stdout).toContain("--accept-unverified runtime");
  });

  it("refuses approve push without the acknowledgment, approves with it, and publishes behind the record", async () => {
    const executor = pipelineExecutor();
    const cacheRoot = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d23-cache-"));
    roots.push(cacheRoot);
    const repoRoot = await driveToPushGate(executor, cacheRoot);
    const createStack = stackFactory(executor, cacheRoot);
    const store = createFeatureSessionStore(repoRoot);

    const refused = await runCli(["approve", "push", "F-001"], repoRoot, createStack);
    expect(refused.exitCodes).toEqual([1]);
    expect(refused.stderr).toContain("runtime verification gap that was not acknowledged");
    expect(refused.stderr).toContain("--accept-unverified runtime");
    // The refusal names the gap with its stage and the evidence location, per the D-20 rule.
    expect(refused.stderr).toContain("runtime_verification");
    // The refusal recorded nothing: the session is still waiting, and no approval exists.
    const stillWaiting = (await store.load("F-001")).machine.state;
    expect(stillWaiting).toBe(WorkflowState.AwaitingPushApproval);
    expect((await store.load("F-001")).approvals.push).toBeNull();

    const approved = await runCli(
      ["approve", "push", "F-001", "--accept-unverified", "runtime"],
      repoRoot,
      createStack,
    );
    expect(approved.exitCodes, JSON.stringify([approved.stdout, approved.stderr])).toEqual([]);
    expect(approved.stdout).toContain("Push approved");
    expect((await store.load("F-001")).machine.state).toBe(WorkflowState.Committing);

    // The acknowledgment is bound to the gate, not remembered as a mood: the record names the gate
    // document the human was shown, by digest, revision, and tree.
    const record = (await store.load("F-001")).approvals.push;
    expect(record).not.toBeNull();
    if (record !== null) {
      expect(record.finalGateSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.finalGateRevision).toBeGreaterThan(0);
      expect(record.workingTreeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("a project with configured runtime verification is untouched by the gap", () => {
  it("runs the configured checks and holds a configured-but-failing runtime at fix_requested, never the gap", async () => {
    const executor = pipelineExecutor();
    const cacheRoot = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d23-cache-"));
    roots.push(cacheRoot);
    const repoRoot = await makeRepoWithFailingRuntime();
    const createStack = stackFactory(executor, cacheRoot);
    const store = createFeatureSessionStore(repoRoot);

    const started = await runCli(["start", "-i", "F-001", "-t", "Failing runtime"], repoRoot, createStack);
    expect(started.exitCodes, JSON.stringify(started.stderr)).toEqual([]);

    const toPlanGate = await runCli(["run", "F-001", "--quiet"], repoRoot, createStack);
    expect(toPlanGate.exitCodes, JSON.stringify([toPlanGate.stdout, toPlanGate.stderr])).toEqual([]);
    expect((await store.load("F-001")).machine.state).toBe(WorkflowState.AwaitingPlanApproval);

    const approved = await runCli(["approve", "plan", "F-001"], repoRoot, createStack);
    expect(approved.exitCodes, JSON.stringify(approved.stderr)).toEqual([]);

    const ran = await runCli(["run", "F-001", "--quiet"], repoRoot, createStack);

    // A configured runtime that fails is a measurement, and measurements outrank absence: the stage
    // sends the feature back to the fixer naming the check, and nothing reaches the push gate with
    // or without the acknowledgment.
    expect(ran.exitCodes).toEqual([1]);
    const combined = `${ran.stdout}\n${ran.stderr}`;
    expect(combined).toContain("feature_failed");
    expect(combined).toContain("runtime_verification");
    // The check the configuration declared was measured and named, in the evidence the fix loop
    // worked from — a real measurement, not the absence the gap decision is about.
    const verification = JSON.stringify(await store.readArtifact("F-001", "verification"));
    expect(verification).toContain('"failed"');
    expect(verification).toContain('"web"');
    // The feature ended wherever the fix loop left it, never at the push gate: a configured runtime
    // that fails is a defect to repair, not a gap to acknowledge.
    expect((await store.load("F-001")).machine.state).toBe(WorkflowState.Failed);
    expect(executor.calls.some((request) => request.stage === "fixing")).toBe(true);
  });
});

describe("the acknowledgment is bound to the tree, not to a mood (D-23 binding)", () => {
  it("a tree that changed after the approval refuses to publish, exhausting the acknowledgment with it", async () => {
    const executor = pipelineExecutor();
    const cacheRoot = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d23-cache-"));
    roots.push(cacheRoot);
    const repoRoot = await driveToPushGate(executor, cacheRoot);
    const createStack = stackFactory(executor, cacheRoot);
    const store = createFeatureSessionStore(repoRoot);

    const approved = await runCli(
      ["approve", "push", "F-001", "--accept-unverified", "runtime"],
      repoRoot,
      createStack,
    );
    expect(approved.exitCodes, JSON.stringify([approved.stdout, approved.stderr])).toEqual([]);

    // Something writes to the worktree after the human approved it. The acknowledgment that let the
    // approval exist covered a specific tree; this one is not covered by anything.
    const lastCall = executor.calls.at(-1);
    expect(lastCall).toBeDefined();
    if (lastCall === undefined) {
      return;
    }
    await writeFile(join(lastCall.workspace.workingDirectory, "sneak.txt"), "sneaky\n", "utf8");

    const published = await runCli(["run", "F-001", "--quiet"], repoRoot, createStack);
    expect(published.exitCodes).toEqual([1]);
    const combined = `${published.stdout}\n${published.stderr}`;
    expect(combined).toContain("publish_approval_stale");
    expect(combined.replace(/\s+/g, " ")).toContain("the tree that would be committed is not the one they saw");
    // Nothing was published, and the refusal is still about the tree the approval named — the
    // gap in the record never became permission to publish some other tree.
    const record = (await store.load("F-001")).approvals.push;
    expect(record).not.toBeNull();
    if (record !== null) {
      expect(record.workingTreeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((await store.load("F-001")).machine.state).toBe(WorkflowState.Committing);
  });
});
