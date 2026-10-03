import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowOrchestrator,
  type OrchestrationResult,
  type StageExecutionRequest,
  type WorkStage,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore, type FeatureSessionStore } from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import {
  createFakeWorkspaceProvider,
  type FakeWorkspaceOptions,
  type FakeWorkspaceProvider,
} from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly workspace: FakeWorkspaceProvider;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
}

/** A plan that approves exactly `src/**`, so a scope test has something real to be inside of. */
function planApproving(...expectedFiles: readonly string[]): unknown {
  return {
    featureId: "F-001",
    title: "Workspace lifecycle",
    steps: [
      {
        id: "step-1",
        description: "Change the application source.",
        expectedFiles: [...expectedFiles],
      },
    ],
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-workspace-"));
  roots.push(root);
  return root;
}

function makeHarness(
  root: string,
  options: { readonly workspace?: FakeWorkspaceOptions | null; readonly executor?: FakeStageExecutor } = {},
): Harness {
  const store = createFeatureSessionStore(root, { clock: () => fixedTimestamp });
  const executor =
    options.executor ??
    new FakeStageExecutor().configure("planning", {
      artifacts: [{ name: "plan", content: planApproving("src/**") }],
    });
  const workspace =
    options.workspace === null ? null : createFakeWorkspaceProvider(options.workspace ?? {});

  const orchestrator = createWorkflowOrchestrator({
    store,
    executor,
    verification: createFakeVerificationProvider(),
    projectRoot: root,
    ...(workspace === null ? {} : { workspace }),
  });

  return { store, executor, workspace: workspace ?? createFakeWorkspaceProvider(), orchestrator };
}

/** Creates the feature. The first `runNext` after this is the planning stage. */
async function createFeature(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Workspace lifecycle",
    request: "# Request\n\nChange the application source.\n",
  });
}

/**
 * Runs `runNext` until the given stage has produced a result, and hands back every result. The
 * results are the record a test reads: the plan gate's own `awaiting_human` result is produced by
 * `runNext` without a stage running, so the scope record for a pre-approval stage is on the result
 * for `plan_review` itself, not on the gate.
 */
async function driveTo(harness: Harness, stage: WorkStage): Promise<OrchestrationResult[]> {
  const results: OrchestrationResult[] = [];

  for (let step = 0; step < 40; step += 1) {
    const result = await harness.orchestrator.runNext("F-001");
    results.push(result);

    if (result.stage === stage) {
      return results;
    }
  }

  throw new Error(`The workflow never ran stage "${stage}".`);
}

async function driveToPlanGate(harness: Harness): Promise<OrchestrationResult[]> {
  await createFeature(harness);
  const results = await driveTo(harness, "plan_review");
  // One more call so the gate itself is reported: `plan_review` completes into the approval state.
  results.push(await harness.orchestrator.runNext("F-001"));
  return results;
}

/** The result of the stage that is being tested, rather than the gate that follows it. */
function resultFor(results: readonly OrchestrationResult[], stage: WorkStage): OrchestrationResult {
  const result = results.find((entry) => entry.stage === stage);

  if (result === undefined) {
    throw new Error(`No result was recorded for stage "${stage}".`);
  }

  return result;
}

/** Runs post-approval stages until `stage` has executed, approving nothing further. */
async function runPostApprovalThrough(harness: Harness, stage: WorkStage): Promise<OrchestrationResult[]> {
  return driveTo(harness, stage);
}

function workspaceOf(request: StageExecutionRequest | undefined) {
  if (request === undefined) {
    throw new Error("The stage executor was never called.");
  }

  return request.workspace;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("a pre-approval stage runs against the human's own checkout, read-only", () => {
  it("is given the repository root, a read-only workspace, and no baseline to compare against", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root);

    await driveToPlanGate(harness);

    const request = harness.executor.requestFor("planning");

    expect(workspaceOf(request)).toMatchObject({
      repositoryRoot: root,
      workingDirectory: root,
      access: "read_only",
      baseline: null,
    });
  });

  it("never opens an isolated workspace, never asks for one, and never closes one it did not open", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root);

    await driveToPlanGate(harness);

    expect(harness.workspace.opens).toEqual([]);
    // Closing a directory the provider never opened would be a request to tidy up a human's checkout.
    expect(harness.workspace.closed).toEqual([]);
  });

  it("records a scope record that says the tree was measured, not assumed", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root);

    const results = await driveToPlanGate(harness);
    const gate = resultFor(results, "plan_review");

    // The record has to distinguish "looked and found nothing" from "did not look", or a reader would
    // take the second for the first.
    expect(gate.scope).toMatchObject({
      measured: true,
      baselineCommit: null,
      approvedPatterns: [],
      observedPaths: [],
      unauthorizedPaths: [],
    });
  });

  it("reports a write instead of touching the human's files", async () => {
    const root = await makeRoot();
    let dirty = false;
    const executor = new FakeStageExecutor()
      .configure("planning", {
        artifacts: [{ name: "plan", content: planApproving("src/**") }],
      })
      .configure("plan_review", {
        // The write happens while the stage runs, which is the only moment the tree can change.
        after: () => {
          dirty = true;
        },
      });
    const harness = makeHarness(root, {
      executor,
      workspace: { changes: () => (dirty ? { modified: ["src/app.ts"] } : {}) },
    });

    await createFeature(harness);
    await driveTo(harness, "planning");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.stage).toBe("plan_review");
    expect(result.status).toBe("scope_violation");
    expect(result.error?.code).toBe("scope_violation");
    expect(result.error?.message).toContain("src/app.ts");
    expect(result.error?.message).toContain("left untouched");
  });

  it("leaves the human's own uncommitted work out of it", async () => {
    const root = await makeRoot();
    // The same path is dirty in both readings: the human was already editing it, and the framework
    // must not report the human's work as a write it caught.
    const harness = makeHarness(root, { workspace: { changes: { modified: ["src/app.ts"] } } });

    const results = await driveToPlanGate(harness);
    const gate = resultFor(results, "plan_review");

    // The stage passed and the workflow is waiting on a human, which is what "no violation" means.
    expect(gate.status).toBe("stage_completed");
  });

  it("refuses to restore a path in a checkout it does not own", async () => {
    const root = await makeRoot();
    let written = false;
    const executor = new FakeStageExecutor()
      .configure("planning", {
        artifacts: [{ name: "plan", content: planApproving("src/**") }],
      })
      .configure("plan_review", {
        after: () => {
          written = true;
        },
      });
    const harness = makeHarness(root, {
      executor,
      workspace: { changes: () => (written ? { untracked: ["notes.md"] } : {}) },
    });

    await createFeature(harness);
    await driveTo(harness, "planning");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("scope_violation");
    // Nothing was deleted. `notes.md` might be the human's own new file, and the framework is not
    // going to remove something in a checkout it does not own.
    expect(harness.workspace.enforcements).toEqual([]);
    expect(result.scope).toMatchObject({
      measured: true,
      baselineCommit: null,
      unauthorizedPaths: ["notes.md"],
      restoredPaths: [],
    });
  });
});

describe("a post-approval stage needs an isolated workspace", () => {
  it("refuses rather than running in the repository root when no provider is configured", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, { workspace: null });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("workspace_not_configured");
    expect(result.executedStages).toEqual([]);
  });

  it("opens the workspace from the approval baseline and hands the stage its own directory", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, { workspace: { workingDirectory: join(root, "worktrees", "F-001") } });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");
    const results = await runPostApprovalThrough(harness, "implementation");

    const result = results.find((entry) => entry.stage === "implementation");
    const request = harness.executor.requestFor("implementation");

    expect(result?.status).toBe("stage_completed");
    expect(workspaceOf(request)).toMatchObject({
      workingDirectory: join(root, "worktrees", "F-001"),
      access: "read_write",
    });
    expect(workspaceOf(request).baseline?.baselineCommit).toBe(harness.workspace.opens[0]?.baseline.baselineCommit);
  });

  it("refuses a baseline the provider did not open from", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root);

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");

    // A provider that answers a post-approval open without a baseline has not said which commit it
    // detached from, so the framework cannot confirm the one guarantee it exists to make.
    const opened = harness.workspace.open.bind(harness.workspace);
    harness.workspace.open = async (request) => {
      const outcome = await opened(request);

      return outcome.ok
        ? { ...outcome, workspace: { ...outcome.workspace, baseline: null } }
        : outcome;
    };

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("workspace_unavailable");
    expect(result.error?.message).toContain("without reporting the baseline");
    // The provider had already taken a lease by the time it answered, and a lease nobody is using
    // would keep the next run out of the workspace.
    expect(harness.workspace.closed).toHaveLength(1);
  });

  it("refuses a workspace the provider put in the repository root", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, { workspace: { workingDirectory: root } });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("workspace_unavailable");
    expect(result.error?.message).toContain("exactly the isolation this requires");
  });

  it("surfaces a lease refusal as its own code, so a concurrent run is not reported as a broken one", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, { workspace: { openRefusal: "lease_unavailable" } });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("workspace_lease_unavailable");
  });
});

describe("the approval is the moment the starting point is frozen", () => {
  it("records the capture the provider measured, and ties it to the approval revision", async () => {
    const root = await makeRoot();
    const head = "b".repeat(40);
    const harness = makeHarness(root, { workspace: { baseline: { headCommit: head } } });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");

    const session = await harness.store.load("F-001");
    const baseline = session.approvals.plan?.baseline;

    expect(baseline).toMatchObject({ repositoryRoot: root, baselineCommit: head });
    expect(baseline?.approvedRevision).toBe(session.revision);
    expect(baseline?.workspaceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  });

  it("refuses to approve a plan on top of uncommitted tracked work", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, {
      workspace: { baseline: { unstagedPaths: ["src/app.ts"] } },
    });

    await driveToPlanGate(harness);
    const result = await harness.orchestrator.approvePlan("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("workspace_dirty_baseline");

    const session = await harness.store.load("F-001");
    expect(session.approvals.plan).toBeNull();
  });

  it("refuses to approve a plan on top of a staged change", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, { workspace: { baseline: { stagedPaths: ["src/app.ts"] } } });

    await driveToPlanGate(harness);
    const result = await harness.orchestrator.approvePlan("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("workspace_dirty_baseline");
  });
});

describe("a post-approval stage is judged against the approved plan", () => {
  it("accepts a change inside the approved scope and records what was approved", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, { workspace: { changes: { modified: ["src/app.ts"] } } });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");
    const results = await runPostApprovalThrough(harness, "implementation");

    const result = results.find((entry) => entry.stage === "implementation");

    expect(result?.status).toBe("stage_completed");
    expect(result?.scope).toMatchObject({
      measured: true,
      approvedPatterns: ["src/**"],
      observedPaths: ["src/app.ts"],
      unauthorizedPaths: [],
      restoredPaths: [],
    });
  });

  it("puts a path outside the approved scope back and discards the stage result", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, { workspace: { changes: { modified: ["src/app.ts", "docs/notes.md"] } } });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");
    const approved = await harness.store.load("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.stage).toBe("implementation");
    expect(result.status).toBe("scope_violation");
    expect(result.error?.code).toBe("scope_violation");
    expect(harness.workspace.enforcements).toHaveLength(1);
    expect(harness.workspace.enforcements[0]?.paths.map((entry) => entry.path)).toEqual(["docs/notes.md"]);
    expect(result.scope?.restoredPaths).toEqual(["docs/notes.md"]);

    // The session did not advance, and no implementation artifact was recorded from a stage the
    // framework had to clean up after.
    const session = await harness.store.load("F-001");
    expect(session.machine.state).toBe(approved.machine.state);
    expect(session.revision).toBe(approved.revision);
    expect(session.artifacts.implementation).toMatchObject({ status: "missing" });
    expect(session.artifacts.plan).toBeDefined();
  });

  it("refuses a commit made inside the workspace without touching a single file", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, {
      workspace: { changes: { modified: ["src/app.ts"] }, gitState: { headCommit: "c".repeat(40) } },
    });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.stage).toBe("implementation");
    // A moved HEAD is not a scope violation, and a status that said so would send whoever reads this
    // result looking for a path problem that does not exist.
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("repository_state_changed");
    expect(result.error?.message).toContain("no later comparison describes the approved starting point");
    expect(harness.workspace.enforcements).toEqual([]);
  });

  it("refuses a staged path, because staging is the step before a commit", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, {
      workspace: { changes: { modified: ["src/app.ts"] }, gitState: { stagedPaths: ["src/app.ts"] } },
    });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("repository_state_changed");
    expect(result.error?.message).toContain("src/app.ts");
  });

  it("refuses to restore what the provider could not prove safe, and says which paths", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, {
      workspace: {
        changes: { modified: ["docs/notes.md"] },
        enforcement: { unsafePaths: ["docs/notes.md"] },
      },
    });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("scope_violation");
    expect(result.error?.code).toBe("scope_restoration_unsafe");
    expect(result.error?.message).toContain("docs/notes.md");
    expect(result.scope?.unsafePaths).toEqual(["docs/notes.md"]);
  });
});

describe("the lease is held for the whole stage and always given back", () => {
  it("closes the workspace after a completed stage", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root);

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");
    await harness.orchestrator.runNext("F-001");

    expect(harness.workspace.opens).toHaveLength(1);
    expect(harness.workspace.closed).toHaveLength(1);
    expect(harness.workspace.closed[0]?.workspaceId).toBe(harness.workspace.opens[0]?.baseline.workspaceId);
  });

  it("closes the workspace even when the stage executor throws, because that is when a half-written file is most likely", async () => {
    const root = await makeRoot();
    const executor = new FakeStageExecutor().configure("planning", {
      artifacts: [{ name: "plan", content: planApproving("src/**") }],
    });
    const harness = makeHarness(root, { executor });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");

    executor.configure("implementation", { error: new Error("the transport died") });

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("executor_error");
    expect(harness.workspace.closed).toHaveLength(1);
  });

  it("closes the workspace after a scope violation, so the violation does not strand the lease", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, { workspace: { changes: { modified: ["docs/notes.md"] } } });

    await driveToPlanGate(harness);
    await harness.orchestrator.approvePlan("F-001");
    await harness.orchestrator.runNext("F-001");

    expect(harness.workspace.closed).toHaveLength(1);
  });
});
