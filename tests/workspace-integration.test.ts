import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordStageInvocation } from "@agent-workflow-kit/opencode";
import {
  createWorkflowOrchestrator,
  type OrchestrationResult,
  type StageExecutionRequest,
  type WorkStage,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { GitWorkspaceProvider } from "@agent-workflow-kit/workspace";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The orchestrator and the Git adapter, together, against a real repository.
 *
 * The two halves of this milestone are tested apart on purpose — orchestration against a fake port,
 * the adapter against real Git — and this file exists because a pair of separate tests can each be
 * right about their own contract and still disagree about it. Here a feature approves a real commit, a
 * real stage runs in a real worktree, and the framework's own enforcement decides what happens to what
 * the stage wrote.
 */

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly cacheRoot: string;
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-integration-"));
  roots.push(base);

  const root = join(base, "repo");
  const cacheRoot = join(base, "cache");

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });

  git(root, "init", "--quiet", "--initial-branch=main", ".");
  git(root, "config", "user.email", "integration@example.invalid");
  git(root, "config", "user.name", "Integration Test");
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "initial");

  return { root, cacheRoot };
}

/** A plan that approves exactly `src/**`, so a scope assertion has something real to be inside of. */
function planApprovingSource(): unknown {
  return {
    featureId: "F-001",
    title: "Change the value",
    steps: [{ id: "step-1", description: "Change the exported value.", expectedFiles: ["src/**"] }],
  };
}

interface Harness {
  readonly store: ReturnType<typeof createFeatureSessionStore>;
  readonly executor: FakeStageExecutor;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
  /** Where each post-approval stage actually ran, recorded by the executor. */
  readonly directories: Map<string, string>;
  /** Where the feature was when `approvePlan` was called, for the session assertions. */
  readonly beforeApprovalRevision: number;
}

function makeHarness(
  fixture: Fixture,
  onExecute: (directory: string) => Promise<void> = () => Promise.resolve(),
  transport: (request: StageExecutionRequest) => Promise<void> = () => Promise.resolve(),
): Harness {
  const store = createFeatureSessionStore(fixture.root, { clock: () => fixedTimestamp });
  const directories = new Map<string, string>();
  const executor = new FakeStageExecutor({
    // Every stage records where it ran, and every post-approval stage is where a test wants a change
    // written. A pre-approval stage has no baseline, so the callback never touches the human's own
    // checkout — the same distinction the framework itself makes. The transport hook runs for every
    // stage, after whatever the stage wrote, because the real adapter records the invocation while
    // the stage is still running — in the same working directory the scope check reads back.
    after: async (request) => {
      directories.set(request.stage, request.workspace.workingDirectory);

      if (request.workspace.baseline !== null) {
        await onExecute(request.workspace.workingDirectory);
      }

      await transport(request);
    },
  }).configure("planning", { artifacts: [{ name: "plan", content: planApprovingSource() }] });

  const orchestrator = createWorkflowOrchestrator({
    store,
    executor,
    verification: createFakeVerificationProvider(),
    workspace: new GitWorkspaceProvider({ cacheRoot: fixture.cacheRoot, isoNow: () => fixedTimestamp }),
    projectRoot: fixture.root,
  });

  return { store, executor, orchestrator, directories, beforeApprovalRevision: 0 };
}

async function createFeature(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Change the value",
    request: "# Request\n\nChange the exported value.\n",
  });
}

/** Drives `runNext` to the plan gate, which is the result that carries the gate itself. */
async function driveToPlanGate(harness: Harness): Promise<OrchestrationResult> {
  for (let step = 0; step < 40; step += 1) {
    const result = await harness.orchestrator.runNext("F-001");

    if (result.status === "awaiting_human" && result.action === "approve_plan") {
      return result;
    }
  }

  throw new Error("The workflow never reached the plan approval gate.");
}

async function approvePlan(harness: Harness): Promise<OrchestrationResult> {
  await createFeature(harness);
  await driveToPlanGate(harness);

  return harness.orchestrator.approvePlan("F-001");
}

/** Where a stage actually ran, as the executor saw it rather than as the test hoped. */
function workspaceOf(harness: Harness, stage: WorkStage): string {
  const request = harness.executor.requestFor(stage);

  if (request === undefined) {
    throw new Error(`The stage executor was never called for "${stage}".`);
  }

  return request.workspace.workingDirectory;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("a post-approval stage in a real worktree", () => {
  it("runs outside the human's checkout, and leaves the human's checkout exactly as it was", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, async (directory) => {
      await writeFile(join(directory, "src", "app.ts"), "export const value = 2;\n", "utf8");
    });

    const approval = await approvePlan(harness);
    const result = await harness.orchestrator.runNext("F-001");
    const directory = harness.directories.get("implementation") ?? "";

    expect(result.stage).toBe("implementation");
    expect(result.status).toBe("stage_completed");

    // The stage ran in the cache, on the approved commit, and nowhere near the human's files.
    const approvedBaseline = (await harness.store.load("F-001")).approvals.plan?.baseline;

    expect(approval.status).toBe("gate_approved");
    expect(approvedBaseline?.baselineCommit).toBe(git(fixture.root, "rev-parse", "HEAD").trim());
    expect(directory.startsWith(fixture.cacheRoot)).toBe(true);
    expect(git(directory, "rev-parse", "HEAD").trim()).toBe(approvedBaseline?.baselineCommit);

    expect(await readFile(join(fixture.root, "src", "app.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await readFile(join(directory, "src", "app.ts"), "utf8")).toBe("export const value = 2;\n");
    // The only new thing in the human's checkout is the framework's own session directory, which is
    // untracked and so never part of a commit a human could have approved.
    expect(git(fixture.root, "status", "--porcelain").trim()).toBe("?? .agentflow/");
  });

  it("records the approved patterns and the paths it actually saw, measured rather than assumed", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, async (directory) => {
      await writeFile(join(directory, "src", "app.ts"), "export const value = 2;\n", "utf8");
      await writeFile(join(directory, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
    });

    await approvePlan(harness);
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("stage_completed");
    expect(result.scope).toMatchObject({
      measured: true,
      baselineCommit: git(fixture.root, "rev-parse", "HEAD").trim(),
      approvedPatterns: ["src/**"],
      observedPaths: ["src/app.ts", "src/extra.ts"],
      unauthorizedPaths: [],
      restoredPaths: [],
      removedPaths: [],
      stagedPaths: [],
    });
    expect(result.scope?.fingerprint).not.toBe("");
  });

  it("puts an unapproved file back, keeps the approved one, and discards the stage's result", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, async (directory) => {
      await writeFile(join(directory, "src", "app.ts"), "export const value = 2;\n", "utf8");
      await writeFile(join(directory, "secrets.txt"), "token = hunter2\n", "utf8");
    });

    await approvePlan(harness);
    const approved = await harness.store.load("F-001");
    const result = await harness.orchestrator.runNext("F-001");
    const directory = workspaceOf(harness, "implementation");

    expect(result.status).toBe("scope_violation");
    expect(result.error?.code).toBe("scope_violation");
    expect(result.error?.message).toContain("secrets.txt");
    expect(result.scope?.unauthorizedPaths).toEqual(["secrets.txt"]);
    // The file was never in the approved commit, so the reversal is a deletion, not a restore, and the
    // record says which of the two happened.
    expect(result.scope?.restoredPaths).toEqual([]);
    expect(result.scope?.removedPaths).toEqual(["secrets.txt"]);
    expect(result.scope?.unsafePaths).toEqual([]);

    // The approved change survives the cleanup, and the unapproved file is gone from disk as well as
    // from the record: the reversal is surgical, and it is real rather than a bookkeeping entry.
    expect(await readFile(join(directory, "src", "app.ts"), "utf8")).toBe("export const value = 2;\n");
    await expect(readFile(join(directory, "secrets.txt"), "utf8")).rejects.toThrow();

    // Nothing from the cleaned-up stage reached the session, which is what makes the cleanup mean
    // anything.
    const session = await harness.store.load("F-001");
    expect(session.machine.state).toBe(approved.machine.state);
    expect(session.revision).toBe(approved.revision);
    expect(session.artifacts.implementation).toMatchObject({ status: "missing" });
  });

  it("refuses a commit made in the worktree, and leaves that commit there to be looked at", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, async (directory) => {
      await writeFile(join(directory, "src", "app.ts"), "export const value = 2;\n", "utf8");
      git(
        directory,
        "-c",
        "user.email=stage@example.invalid",
        "-c",
        "user.name=Stage",
        "commit",
        "--quiet",
        "-am",
        "not approved by anyone",
      );
    });

    await approvePlan(harness);
    const result = await harness.orchestrator.runNext("F-001");
    const directory = workspaceOf(harness, "implementation");
    const commit = git(directory, "rev-parse", "HEAD").trim();

    // A moved HEAD is not a scope violation, and a record that said otherwise would send a reviewer
    // looking for a path problem that does not exist.
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("repository_state_changed");
    expect(result.scope?.unauthorizedPaths).toEqual([]);

    // The commit survives: the framework refuses to rewrite history a stage wrote, and a human can
    // see what happened in the workspace.
    expect(git(directory, "rev-parse", "HEAD").trim()).toBe(commit);
    expect(git(directory, "log", "--oneline", "-1").trim()).toContain("not approved by anyone");
    expect(git(fixture.root, "log", "--oneline").trim().split("\n")).toHaveLength(1);
  });

  it("refuses a staged file, because staging is the step before a commit", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, async (directory) => {
      await writeFile(join(directory, "src", "app.ts"), "export const value = 2;\n", "utf8");
      git(directory, "add", "src/app.ts");
    });

    await approvePlan(harness);
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("repository_state_changed");
    expect(result.scope?.stagedPaths).toEqual(["src/app.ts"]);
  });

  it("refuses to approve a plan over uncommitted work, and does nothing to the work", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture);

    // The human has an edit in flight when they get round to approving.
    await writeFile(join(fixture.root, "src", "app.ts"), "export const value = 7;\n", "utf8");
    await writeFile(join(fixture.root, "notes.txt"), "not yet\n", "utf8");
    git(fixture.root, "add", "notes.txt");

    const result = await approvePlan(harness);

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("workspace_dirty_baseline");
    expect(result.error?.message).toContain("notes.txt");
    expect(result.error?.message).toContain("src/app.ts");
    // No worktree was created, because the baseline was refused before anything was opened.
    expect(git(fixture.root, "worktree", "list").trim().split("\n")).toHaveLength(1);

    // And nothing was stashed, reset, or committed to get past it.
    expect(git(fixture.root, "status", "--porcelain").trim()).toBe("A  notes.txt\n M src/app.ts\n?? .agentflow/");
    expect(git(fixture.root, "stash", "list").trim()).toBe("");
    expect(git(fixture.root, "worktree", "list").trim().split("\n")).toHaveLength(1);

    const session = await harness.store.load("F-001");
    expect(session.approvals.plan).toBeNull();
  });

  it("reuses the same worktree for the next stage of the same feature", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, async (directory) => {
      await writeFile(join(directory, "src", "app.ts"), "export const value = 2;\n", "utf8");
    });

    await approvePlan(harness);
    await harness.orchestrator.runNext("F-001");
    const first = workspaceOf(harness, "implementation");
    const reviewed = await harness.orchestrator.runNext("F-001");
    const reviewedStage = reviewed.stage;

    // The lease is released after every stage, so the next stage can re-enter the worktree and see what
    // the previous one did. Two stages of one feature cannot run at once, and they do not need to.
    expect(reviewedStage).toBe("code_review");
    expect(workspaceOf(harness, reviewedStage ?? "implementation")).toBe(first);
    expect(await readFile(join(first, "src", "app.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(git(fixture.root, "worktree", "list").trim().split("\n")).toHaveLength(2);
  });

  it("keeps the worktree, and its changes, after the feature fails", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, async (directory) => {
      await writeFile(join(directory, "src", "app.ts"), "export const value = 2;\n", "utf8");
    });

    await approvePlan(harness);
    harness.executor.configure("implementation", { error: new Error("the transport died") });
    const failed = await harness.orchestrator.runNext("F-001");
    const directory = workspaceOf(harness, "implementation");

    // A failed stage is the moment a half-written worktree is most likely, so it is left on disk with
    // its changes, and its lease released, for a human to read.
    expect(failed.status).toBe("executor_error");
    expect(await readFile(join(directory, "src", "app.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(git(directory, "status", "--porcelain").trim()).toBe("M src/app.ts");
    expect(git(fixture.root, "status", "--porcelain").trim()).toBe("?? .agentflow/");
  });

  it("refuses a second run of the same feature while the first still holds the workspace", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture);

    const approval = await approvePlan(harness);
    const baseline = (await harness.store.load("F-001")).approvals.plan?.baseline ?? null;

    expect(approval.status).toBe("gate_approved");
    expect(baseline?.baselineCommit).toBe(git(fixture.root, "rev-parse", "HEAD").trim());

    if (baseline === null) {
      throw new Error("The approved plan recorded no baseline, so there is nothing to contend for.");
    }

    // Take the lease, and do not give it back.
    const held = new GitWorkspaceProvider({ cacheRoot: fixture.cacheRoot, isoNow: () => fixedTimestamp });
    const opened = await held.open({ featureId: "F-001", baseline, access: "read_write" });

    expect(opened.ok ? opened.workspace.workingDirectory.startsWith(fixture.cacheRoot) : false).toBe(true);

    // A second provider, as a concurrent run of the same feature in another process would be.
    const contended = await new GitWorkspaceProvider({
      cacheRoot: fixture.cacheRoot,
      isoNow: () => fixedTimestamp,
    }).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(contended).toMatchObject({ ok: false, code: "lease_unavailable" });

    // The refusal came from the lease rather than from anything a stage did: no post-approval stage has
    // run at all, and the worktree is untouched.
    expect(harness.executor.requestFor("implementation")).toBeUndefined();
    expect(git(opened.ok ? opened.workspace.workingDirectory : fixture.cacheRoot, "status", "--porcelain").trim()).toBe("");
  });
});

/**
 * The recorder and the scope guard meet in one directory. The transport writes
 * `.agentflow/recordings/<featureId>/<stage>/<stamp>/{invocation.json,stdout.txt,stderr.txt}` into
 * the stage's own working directory while the stage runs, and the post-stage inspection measures the
 * same tree afterwards. The framework writing its own diagnostics is not a stage writing to a
 * checkout nobody approved — but the guard must still refuse every other write, including one the
 * agent put under `.agentflow/` itself, or it would be no guard at all.
 */
describe("a stage whose transport records its invocation", () => {
  /**
   * Runs `runNext` until a stage actually executes. The first call after `createFeature` only applies
   * the workflow's own `advance` event (a `PASSIVE_ADVANCE_STATES` step, orchestrator.ts:639), and a
   * test about the stage needs the call that runs the stage.
   */
  async function runStage(harness: Harness): Promise<OrchestrationResult> {
    for (let step = 0; step < 40; step += 1) {
      const result = await harness.orchestrator.runNext("F-001");

      if (result.stage !== null) {
        return result;
      }

      if (result.status !== "advanced") {
        throw new Error(`The workflow stopped before a stage ran: ${result.status}`);
      }
    }

    throw new Error("No stage ran.");
  }

  /** What the real adapter does when an invocation returns: write the recording, best-effort. */
  async function recordInvocation(request: StageExecutionRequest): Promise<void> {
    const written = await recordStageInvocation(
      request.workspace.workingDirectory,
      { featureId: request.feature.featureId, stage: request.stage },
      {
        command: "opencode",
        args: ["run", "--standalone", "--agent", "agentflow-read", "--format", "json", "--prompt", "probe"],
        cwd: request.workspace.workingDirectory,
        startedAt: fixedTimestamp,
        observation: {
          termination: "exited",
          exitCode: 0,
          stdout: "{\"probe\":\"ok\"}\n",
          stderr: "",
          startedAt: fixedTimestamp,
          durationMs: 7,
        },
        error: null,
      },
    );

    if (written === null) {
      throw new Error("The recording could not be written.");
    }
  }

  /** What one recorded stage leaves on disk: the stamp directories, and the first one's files. */
  async function recordingsOf(
    root: string,
    stage: WorkStage,
  ): Promise<{ readonly stamps: readonly string[]; readonly files: readonly string[] }> {
    const directory = join(root, ".agentflow", "recordings", "F-001", stage);
    const stamps = await readdir(directory);
    const [stamp] = stamps;
    const files = stamp === undefined ? [] : await readdir(join(directory, stamp));

    return { stamps, files: [...files].sort() };
  }

  it("completes a read stage that recorded itself, and keeps the recording on disk", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, undefined, recordInvocation);
    await createFeature(harness);

    const result = await runStage(harness);

    expect(result.stage).toBe("grill");
    expect(result.status).toBe("stage_completed");
    expect(result.scope?.unauthorizedPaths).toEqual([]);
    expect(await recordingsOf(fixture.root, "grill")).toEqual({
      stamps: [expect.any(String)],
      files: ["invocation.json", "stderr.txt", "stdout.txt"],
    });
  });

  it("still refuses a read stage that wrote anything else, even under .agentflow", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, undefined, async (request) => {
      await writeFile(
        join(request.workspace.workingDirectory, ".agentflow", "notes.md"),
        "where does this file belong?\n",
        "utf8",
      );
      // A near-miss: the recording's own directory shape and stamp, but a file the recorder never
      // writes. The exclusion is the exact recorder output, not the directory it lives in.
      const forged = join(
        request.workspace.workingDirectory,
        ".agentflow",
        "recordings",
        "F-001",
        "grill",
        "20260405T060708Z-abcd",
      );
      await mkdir(forged, { recursive: true });
      await writeFile(join(forged, "notes.md"), "not a recording\n", "utf8");
      await recordInvocation(request);
    });
    await createFeature(harness);

    const result = await runStage(harness);

    expect(result.status).toBe("scope_violation");
    expect(result.error?.code).toBe("scope_violation");
    expect(result.error?.message).toContain(".agentflow/notes.md");
    // Only the agent's files are blamed: the recording is still measured — a guard that stopped
    // looking at it would be blind — but it is not treated as a stage write.
    expect(result.scope?.unauthorizedPaths).toEqual([
      ".agentflow/notes.md",
      ".agentflow/recordings/F-001/grill/20260405T060708Z-abcd/notes.md",
    ]);
    expect(result.scope?.observedPaths).toContain(".agentflow/notes.md");
    expect(
      result.scope?.observedPaths.some(
        (path) =>
          path.startsWith(".agentflow/recordings/F-001/grill/20260405T060708Z-") && path.endsWith("/stdout.txt"),
      ),
    ).toBe(true);
    // A pre-approval violation is reported and left on disk for the human to read, never reverted.
    expect(result.scope?.restoredPaths).toEqual([]);
    expect(result.scope?.removedPaths).toEqual([]);
  });

  it("keeps the recording when the stage fails", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, undefined, recordInvocation);
    await createFeature(harness);
    harness.executor.configure("grill", { error: new Error("the transport died") });

    const result = await runStage(harness);

    expect(result.status).toBe("executor_error");
    expect(result.error?.message).toContain("the transport died");
    expect((await recordingsOf(fixture.root, "grill")).files).toEqual([
      "invocation.json",
      "stderr.txt",
      "stdout.txt",
    ]);
  });

  it("keeps the recording when the stage's result is rejected", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, undefined, recordInvocation);
    await createFeature(harness);
    harness.executor.configure("grill", { raw: { nonsense: true } });

    const result = await runStage(harness);

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("executor_malformed_result");
    expect((await recordingsOf(fixture.root, "grill")).files).toEqual([
      "invocation.json",
      "stderr.txt",
      "stdout.txt",
    ]);
  });

  it("passes the guard for the stage after a recorded stage", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, undefined, recordInvocation);
    await createFeature(harness);

    const first = await runStage(harness);
    const second = await runStage(harness);

    expect(first.stage).toBe("grill");
    expect(first.status).toBe("stage_completed");
    expect(second.stage).toBe("planning");
    expect(second.status).toBe("stage_completed");
    expect((await recordingsOf(fixture.root, "grill")).stamps).toHaveLength(1);
    expect((await recordingsOf(fixture.root, "planning")).stamps).toHaveLength(1);
  });

  it("reports the scope violation rather than the executor failure when a stage has both", async () => {
    const fixture = await makeFixture();
    const harness = makeHarness(fixture, undefined, async (request) => {
      await writeFile(join(request.workspace.workingDirectory, "leftover.txt"), "half-written\n", "utf8");
      await recordInvocation(request);
    });
    await createFeature(harness);
    harness.executor.configure("grill", { error: new Error("the transport died") });

    const result = await runStage(harness);

    // Pre-existing precedence, pinned rather than changed: the scope verdict outranks the executor's
    // failure (orchestration/src/orchestrator.ts, the check at the enforcement call and the
    // executor-failure branch after it), so the executor's own error is not what the user sees.
    expect(result.status).toBe("scope_violation");
    expect(result.error?.code).toBe("scope_violation");
    expect(result.error?.message).toContain("leftover.txt");
    expect(result.error?.message).not.toContain("the transport died");
  });
});
