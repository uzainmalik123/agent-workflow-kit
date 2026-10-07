import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  workspaceIdFor,
  type PublishRecord,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore, type FeatureSessionStore } from "@agent-workflow-kit/persistence";
import { GitFeaturePublisher, GitWorkspaceProvider } from "@agent-workflow-kit/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";

/**
 * The whole publishing path, against a repository.
 *
 * The other two publishing suites each hold one half: one drives the orchestrator against a fake
 * workspace and a fake publisher, the other drives the real adapter against a real repository. This one
 * holds them together, because the seam between them is exactly where the interesting failures live — a
 * commit built from a real worktree, pushed to a real remote, and recorded in a real session file.
 *
 * Everything the test claims about the result is read back out of git afterwards. The orchestrator
 * reports success by writing a record, and a record is a claim about the repository rather than evidence
 * of it, so each assertion here asks the remote and the repository what is actually there.
 */

const CLOCK = "2026-04-05T06:07:08.000Z";
const FEATURE = "F-001";
const TITLE = "Publish the branch";

/** The paths the feature is allowed to touch, in the plan artifact and in the worktree. */
const EDITED = "src/app.ts";
const ADDED = "src/published.ts";

const SPEC_ARTIFACT = {
  schemaVersion: 1,
  featureId: FEATURE,
  summary: "Publish an approved change to a branch.",
  requirements: [
    {
      id: "REQ-1",
      title: "One branch",
      description: "The approved change arrives on one branch.",
      acceptanceCriteria: [{ id: "AC-1", text: "The branch holds exactly the approved change." }],
    },
  ],
};

const PLAN_ARTIFACT = {
  schemaVersion: 1,
  featureId: FEATURE,
  summary: "Edit one file and add one.",
  steps: [
    {
      id: "STEP-1",
      description: "Change the feature and add the file that implements it.",
      expectedFiles: [EDITED, ADDED],
    },
  ],
};

const roots: string[] = [];

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly workspace: GitWorkspaceProvider;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
  readonly repositoryRoot: string;
  readonly remote: string;
  readonly baselineCommit: string;
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** A repository with one commit, a bare remote it can push to, and a store of its own. */
async function makeHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-publish-integration-"));
  roots.push(base);

  const repositoryRoot = join(base, "repo");
  const cacheRoot = join(base, "cache");
  const storeRoot = join(base, "features");
  const remote = join(base, "remote.git");

  await mkdir(join(repositoryRoot, "src"), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(storeRoot, { recursive: true });

  git(repositoryRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repositoryRoot, "config", "user.email", "publishing@example.invalid");
  git(repositoryRoot, "config", "user.name", "Publishing Test");
  git(repositoryRoot, "config", "commit.gpgsign", "false");
  await writeFile(join(repositoryRoot, EDITED), "export const value = 1;\n", "utf8");
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "initial");

  git(repositoryRoot, "init", "--quiet", "--bare", remote);
  git(repositoryRoot, "remote", "add", "origin", remote);

  const store = createFeatureSessionStore(storeRoot, { clock: () => CLOCK });
  const executor = new FakeStageExecutor();

  // The agent's work happens here, in the real isolated worktree the framework opened for this stage.
  // Writing it from a stage hook is what makes these tests end-to-end rather than staged: the file the
  // commit will contain is created by the same mechanism a real stage would use.
  executor.configure("implementation", {
    after: async (request) => {
      await writeFile(join(request.workspace.workingDirectory, EDITED), "export const value = 2;\n", "utf8");
      await writeFile(join(request.workspace.workingDirectory, ADDED), "export const published = true;\n", "utf8");
    },
  });

  executor.configure("grill", {
    artifacts: [
      { name: "grill", content: { featureId: FEATURE, decisions: [] } },
      { name: "spec", content: SPEC_ARTIFACT },
    ],
  });
  executor.configure("planning", { artifacts: [{ name: "plan", content: PLAN_ARTIFACT }] });

  const workspace = new GitWorkspaceProvider({ cacheRoot, isoNow: () => CLOCK });

  return {
    store,
    executor,
    workspace,
    repositoryRoot,
    remote,
    baselineCommit: git(repositoryRoot, "rev-parse", "HEAD").trim(),
    orchestrator: createWorkflowOrchestrator({
      store,
      executor,
      // The repository this feature belongs to, which is what a real run is pointed at and what the
      // baseline is captured from. Left unset it would be this test process's own checkout.
      projectRoot: repositoryRoot,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
      workspace,
      // The mechanism half of publishing, the real one. The orchestrator above decides what to commit and
      // where to push it; this is the part that knows what a repository is.
      publisher: new GitFeaturePublisher(),
      publishRemote: "origin",
    }),
  };
}

async function driveTo(harness: Harness, target: WorkflowState): Promise<void> {
  let last = "";

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const session = await harness.store.load(FEATURE);

    if (session.machine.state === target) {
      return;
    }

    if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
      await harness.orchestrator.approvePlan(FEATURE);
      continue;
    }

    const result = await harness.orchestrator.runNext(FEATURE);

    // Kept so that a workflow which stops early says which refusal stopped it, rather than only that it
    // stopped. A stage that refuses leaves the state where it was, and the next call would refuse again,
    // so the last result is the answer to "why did it stop".
    const failure = result.error;

    last = `${result.stage ?? "?"}: ${result.status}${failure === null ? "" : ` (${failure.code}: ${failure.message})`}`;
  }

  throw new Error(`The workflow never reached "${target}". The last step was ${last || "none"}.`);
}

/** The whole feature, from a request to a session waiting for a publishing decision. */
async function driveToPushApproval(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: FEATURE,
    title: TITLE,
    request: "# Request\n\nPublish an approved change.\n",
  });

  await driveTo(harness, WorkflowState.FinalSummary);
  await harness.orchestrator.runNext(FEATURE);
  await driveTo(harness, WorkflowState.AwaitingPushApproval);
}

async function publishRecord(harness: Harness): Promise<PublishRecord> {
  return (await harness.store.readArtifact(FEATURE, "publish")) as PublishRecord;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("publishing an approved change to a real repository", () => {
  it("puts exactly the approved change on the remote, on its own branch", async () => {
    const harness = await makeHarness();

    await driveToPushApproval(harness);
    await harness.orchestrator.approvePush(FEATURE);
    await driveTo(harness, WorkflowState.Committing);

    // The first publishing step writes the commit. Nothing is on the remote yet, and the state says so
    // rather than claiming a push that has not happened.
    const committed = await harness.orchestrator.publishFeature(FEATURE);

    expect(committed.status).toBe("committed");
    expect(committed.state).toBe(WorkflowState.Pushing);

    const record = await publishRecord(harness);

    expect(record.result).toBe("committed");
    expect(record.remote).toBeNull();
    expect(git(harness.remote, "for-each-ref", "--format=%(refname)").trim()).toBe("");

    // The second step pushes what was recorded, and only that.
    const pushed = await harness.orchestrator.publishFeature(FEATURE);

    expect(pushed.status).toBe("published");
    expect(pushed.state).toBe(WorkflowState.Complete);

    const published = await publishRecord(harness);

    expect(published.result).toBe("pushed");
    expect(published.remote).toBe("origin");
    expect(published.branch).toBe(record.branch);
    expect(published.commit).toBe(record.commit);

    // Ask the remote what it holds. One ref, and it is the one this feature named.
    expect(git(harness.remote, "for-each-ref", "--format=%(refname)").trim()).toBe(
      `refs/heads/${record.branch}`,
    );
    expect(git(harness.remote, "rev-parse", `refs/heads/${record.branch}`).trim()).toBe(record.commit);

    // Ask the remote what is in it: the approved edit, the approved addition, and nothing else.
    expect(git(harness.remote, "show", "--name-status", "--format=", record.branch).trim().split("\n").sort()).toEqual(
      [`M\t${EDITED}`, `A\t${ADDED}`].sort(),
    );
    expect(git(harness.remote, "rev-parse", `${record.branch}^`).trim()).toBe(harness.baselineCommit);

    // And what it says about who approved it, read from the commit on the remote.
    const message = git(harness.remote, "log", "-1", "--format=%B", record.branch);

    expect(message).toContain(`Feature-Id: ${FEATURE}`);
    expect(message).toContain(`Push-Approval-Summary-Sha256: ${record.approval.summarySha256}`);
  });

  it("leaves the branch the workflow was working on untouched", async () => {
    const harness = await makeHarness();

    await driveToPushApproval(harness);
    await harness.orchestrator.approvePush(FEATURE);
    await driveTo(harness, WorkflowState.Committing);

    const committed = await harness.orchestrator.publishFeature(FEATURE);

    expect(committed.status).toBe("committed");

    const record = await publishRecord(harness);
    const local = git(harness.repositoryRoot, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n");

    // `main` is where the approved work was based, and it is still there, still at the approved commit.
    // Publishing created a branch; it did not move the one the repository was on.
    expect(local.filter((ref) => ref !== "").sort()).toEqual([`refs/heads/${record.branch}`, "refs/heads/main"]);
    expect(git(harness.repositoryRoot, "rev-parse", "refs/heads/main").trim()).toBe(harness.baselineCommit);
  });

  it("keeps the workspace reusable after publishing, which is what a retry needs", async () => {
    const harness = await makeHarness();

    await driveToPushApproval(harness);
    await harness.orchestrator.approvePush(FEATURE);
    await driveTo(harness, WorkflowState.Committing);

    await harness.orchestrator.publishFeature(FEATURE);
    await harness.orchestrator.publishFeature(FEATURE);

    const record = await publishRecord(harness);
    const reopened = await harness.workspace.open({
      featureId: FEATURE,
      baseline: {
        repositoryRoot: harness.repositoryRoot,
        baselineCommit: harness.baselineCommit,
        workspaceId: workspaceIdFor(FEATURE),
        approvedRevision: 1,
        capturedAt: CLOCK,
      },
      access: "read_write",
    });

    expect(reopened.ok, reopened.ok ? "" : reopened.message).toBe(true);

    if (reopened.ok) {
      // HEAD is still the approved commit and the change is still uncommitted, because the commit was
      // written out of band. That is the whole reason a second publishing attempt can find the same
      // approved tree instead of a worktree somebody committed in.
      expect(git(reopened.workspace.workingDirectory, "rev-parse", "HEAD").trim()).toBe(
        harness.baselineCommit,
      );
      expect(await readFile(join(reopened.workspace.workingDirectory, ADDED), "utf8")).toBe(
        "export const published = true;\n",
      );

      await harness.workspace.close(reopened.workspace);
    }

    // And a repeat of the push is refused on the record's own evidence, not on a guess.
    const again = await harness.orchestrator.publishFeature(FEATURE);

    expect(again).toMatchObject({
      status: "rejected",
      error: { code: "publish_already_published" },
    });
    expect(git(harness.remote, "rev-parse", `refs/heads/${record.branch}`).trim()).toBe(record.commit);
  });

  it("refuses to push when the remote does not exist, records nothing as pushed, and finishes on a retry", async () => {
    const harness = await makeHarness();

    git(harness.repositoryRoot, "remote", "remove", "origin");

    await driveToPushApproval(harness);
    await harness.orchestrator.approvePush(FEATURE);
    await driveTo(harness, WorkflowState.Committing);

    // The commit still happens: it is written in this repository and is worth having whether or not a
    // remote exists. Only the push fails.
    expect(await harness.orchestrator.publishFeature(FEATURE)).toMatchObject({ status: "committed" });

    const failed = await harness.orchestrator.publishFeature(FEATURE);

    expect(failed.status).toBe("rejected");
    expect(failed.error?.code).toBe("publish_remote_unavailable");
    expect(failed.error?.failureClass).toBe("workspace");
    expect(failed.state).toBe(WorkflowState.Pushing);

    const recorded = await publishRecord(harness);

    expect(recorded.result).toBe("committed");
    expect(recorded.remote).toBeNull();
    expect(recorded.pushedAt).toBeNull();

    // The remote comes back, and the retry pushes the commit that was already recorded rather than
    // writing another one: the branch still has exactly two commits, and the remote received the one on
    // top of the approved commit.
    git(harness.repositoryRoot, "remote", "add", "origin", harness.remote);

    const retried = await harness.orchestrator.publishFeature(FEATURE);

    expect(retried.status).toBe("published");
    expect(git(harness.repositoryRoot, "rev-list", "--count", recorded.branch).trim()).toBe("2");
    expect(git(harness.remote, "rev-parse", `refs/heads/${recorded.branch}`).trim()).toBe(recorded.commit);
  });

  it("refuses to publish a change the approval does not describe", async () => {
    const harness = await makeHarness();

    await driveToPushApproval(harness);
    await harness.orchestrator.approvePush(FEATURE);
    await driveTo(harness, WorkflowState.Committing);

    // Somebody edits the approved document after the approval that named its digest was given. The
    // approval is a claim about specific bytes, so a different summary is a different document — and this
    // commit must not happen, not even the parts of it that did not change.
    const summary = await harness.store.readArtifactText(FEATURE, "final_summary");

    await harness.store.writeArtifact(FEATURE, "final_summary", `${summary}\nEdited after the approval.\n`);

    const result = await harness.orchestrator.publishFeature(FEATURE);

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("publish_summary_mismatch");
    expect(
      git(harness.repositoryRoot, "for-each-ref", "--format=%(refname)", "refs/heads/agentflow").trim(),
    ).toBe("");
  });

  it("publishes the same change set the workspace reported, path for path", async () => {
    const harness = await makeHarness();

    await driveToPushApproval(harness);
    await harness.orchestrator.approvePush(FEATURE);
    await driveTo(harness, WorkflowState.Committing);

    expect(harness.executor.executedStages).toContain("implementation");

    const committed = await harness.orchestrator.publishFeature(FEATURE);

    expect(committed.status).toBe("committed");

    const record = await publishRecord(harness);
    const tree = git(harness.repositoryRoot, "ls-tree", "-r", "--name-only", record.commit).split("\n");

    // Every path the remote will have, spelled out. Nothing this framework added, nothing the fixture
    // repository happened to contain, and the cache of worktrees nowhere in it.
    expect(tree.filter((path) => path !== "").sort()).toEqual([ADDED, EDITED].sort());
  });

  it("stages no path under .agentflow/, with files present under the project's .agentflow/", async () => {
    const harness = await makeHarness();

    // The project's .agentflow/, in both shapes it really takes: state committed before the feature
    // existed (so it is inside the publish worktree when staging runs), and the runtime records a run
    // leaves behind, untracked, in the project checkout.
    const tracked = ".agentflow/recordings/F-001/grill/t/stdout.txt";

    await mkdir(join(harness.repositoryRoot, ".agentflow", "recordings", "F-001", "grill", "t"), { recursive: true });
    await writeFile(join(harness.repositoryRoot, tracked), "captured\n", "utf8");
    git(harness.repositoryRoot, "add", tracked);
    git(harness.repositoryRoot, "commit", "--quiet", "-m", "record a stage");

    await mkdir(join(harness.repositoryRoot, ".agentflow", "features", "F-001"), { recursive: true });
    await writeFile(join(harness.repositoryRoot, ".agentflow", "features", "F-001", "session.json"), "{}\n", "utf8");

    await driveToPushApproval(harness);
    await harness.orchestrator.approvePush(FEATURE);
    await driveTo(harness, WorkflowState.Committing);

    expect((await harness.orchestrator.publishFeature(FEATURE)).status).toBe("committed");

    const record = await publishRecord(harness);

    // The staging step is `git add -- <approved paths>` in a temporary index, and the commit is built
    // from that index, so the commit's own diff is exactly what that staging step staged.
    const staged = git(harness.repositoryRoot, "show", "--name-status", "--format=", record.commit)
      .trim()
      .split("\n")
      .sort();

    expect(staged).toEqual([`A\t${ADDED}`, `M\t${EDITED}`].sort());
    expect(staged.some((line) => line.includes(".agentflow"))).toBe(false);

    // Not vacuous: the commit's inherited tree holds .agentflow/ paths, so staging ran over a worktree
    // that contained them and staged none of them.
    const tree = git(harness.repositoryRoot, "ls-tree", "-r", "--name-only", record.commit).split("\n");

    expect(tree).toContain(tracked);

    expect((await harness.orchestrator.publishFeature(FEATURE)).status).toBe("published");

    const onRemote = git(harness.remote, "show", "--name-status", "--format=", record.branch).split("\n");

    expect(onRemote.some((line) => line.includes(".agentflow"))).toBe(false);

    // The project's own state files are untouched.
    expect(
      await readFile(join(harness.repositoryRoot, ".agentflow", "features", "F-001", "session.json"), "utf8"),
    ).toBe("{}\n");
    expect(await readFile(join(harness.repositoryRoot, tracked), "utf8")).toBe("captured\n");
  });
});
