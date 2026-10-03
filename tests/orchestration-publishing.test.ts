import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  buildFeatureBranch,
  commitCarriesOwnership,
  createWorkflowOrchestrator,
  digestArtifactText,
  isSafeBranchName,
  publishRecordFrom,
  PUBLISHING_BRANCH_PREFIX,
  unsafeBranchNameReason,
  verifyRemoteName,
  type OrchestrationResult,
  type PublishRecord,
  type WorkspaceChanges,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore, type FeatureSessionStore } from "@agent-workflow-kit/persistence";
import { createFakeFeaturePublisher, type FakeFeaturePublisher } from "../fixtures/feature-publisher.js";
import { featureDirectoryOf } from "../fixtures/session-documents.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import {
  createFakeWorkspaceProvider,
  fingerprintOfChanges,
  type FakeWorkspaceProvider,
} from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Publishing: the two steps between an approved summary and a branch on a remote.
 *
 * The properties under test are all refusals, and that is the shape of the milestone. A feature that was
 * certified is still not publishable until a human approved *these* bytes: every test below either edits
 * one of the things the approval names — the summary, the gate document, the tree, the revision, the
 * recorded commit — or takes away one of the things publishing needs. A happy path alone would pass with
 * an implementation that checked nothing, because nothing about a happy path asks a question.
 *
 * The publisher is a fake here on purpose. It records what it was handed, so these tests assert the
 * policy — which branch, which message, which paths, which commit, which remote — and the adapter's own
 * behaviour against real repositories is tested in `tests/publishing-git.test.ts`.
 */

const CLOCK = "2026-04-05T06:07:08.000Z";
const FEATURE = "F-001";
const TITLE = "Publish the approved change";
const roots: string[] = [];

/**
 * The change set every stage measures until a test moves it.
 *
 * Both paths appear in the plan artifact, because the scope check runs on the way to the approval and a
 * change set nobody approved would fail the feature for a reason none of these tests is about.
 */
const APPROVED_CHANGES: WorkspaceChanges = {
  modified: ["src/app.ts"],
  added: ["src/publisher.ts"],
  deleted: [],
  renamed: [],
  untracked: [],
};

const PLAN_ARTIFACT = {
  schemaVersion: 1,
  featureId: FEATURE,
  summary: "Add the publishing adapter.",
  steps: [
    {
      id: "STEP-1",
      description: "Write the publishing adapter and change the application.",
      expectedFiles: ["src/app.ts", "src/publisher.ts"],
    },
  ],
};

interface Harness {
  readonly store: FeatureSessionStore;
  readonly workspace: FakeWorkspaceProvider;
  readonly publisher: FakeFeaturePublisher;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
  /** Flipped by a test to move the tree underneath the recorded evidence. */
  readonly tree: { changes: WorkspaceChanges | null };
}

interface HarnessOptions {
  readonly publisher?: FakeFeaturePublisher;
  readonly publishRemote?: string;
  readonly withoutPublisher?: boolean;
}

function createHarness(root: string, options: HarnessOptions = {}): Harness {
  const store = createFeatureSessionStore(root, { clock: () => CLOCK });
  const executor = new FakeStageExecutor().configure("planning", {
    artifacts: [{ name: "plan", content: PLAN_ARTIFACT }],
  });

  const tree: Harness["tree"] = { changes: null };
  const workspace = createFakeWorkspaceProvider({ changes: () => tree.changes ?? APPROVED_CHANGES });
  const publisher = options.publisher ?? createFakeFeaturePublisher();

  const orchestrator = createWorkflowOrchestrator({
    store,
    executor,
    verification: createFakeVerificationProvider(),
    security: createFakeSecurityProvider(),
    workspace,
    projectRoot: root,
    ...(options.withoutPublisher === true ? {} : { publisher }),
    ...(options.publishRemote === undefined ? {} : { publishRemote: options.publishRemote }),
  });

  return { store, workspace, publisher, orchestrator, tree };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-publishing-"));
  roots.push(root);
  return root;
}

/** Runs the workflow forward, approving the plan whenever it stops to wait for one. */
async function driveTo(harness: Harness, target: WorkflowState): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const session = await harness.store.load(FEATURE);

    if (session.machine.state === target) {
      return;
    }

    if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
      await harness.orchestrator.approvePlan(FEATURE);
      continue;
    }

    await harness.orchestrator.runNext(FEATURE);
  }

  throw new Error(`The workflow never reached "${target}".`);
}

/** Runs the whole workflow to `committing`, which is what an explicit push approval buys. */
async function driveToCommitting(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: FEATURE,
    title: TITLE,
    request: "# Request\n\nPublish the approved change.\n",
  });

  await driveTo(harness, WorkflowState.FinalSummary);
  await harness.orchestrator.runNext(FEATURE);
  await driveTo(harness, WorkflowState.AwaitingPushApproval);
  await harness.orchestrator.approvePush(FEATURE);
}

async function recordedPublish(harness: Harness): Promise<PublishRecord> {
  const value = await harness.store.readArtifact(FEATURE, "publish");
  const parsed = publishRecordFrom(value);

  if (!parsed.ok) {
    throw new Error(`The recorded publish document cannot be read: ${parsed.reason}`);
  }

  return parsed.record;
}

/** Rewrites the session document, which is what a hand-edited or interrupted run leaves behind. */
async function rewriteSession(
  harness: Harness,
  change: (session: Awaited<ReturnType<FeatureSessionStore["load"]>>) => void,
): Promise<void> {
  const directory = await featureDirectoryOf(harness.store, FEATURE);
  const session = await harness.store.load(FEATURE);

  change(session);

  await writeFile(
    join(directory, "session.json"),
    `${JSON.stringify(session, null, 2)}\n`,
    "utf8",
  );
}

/** Rewrites the recorded publish document with something a push would act on. */
async function overwritePublish(harness: Harness, value: unknown): Promise<void> {
  const directory = await featureDirectoryOf(harness.store, FEATURE);
  const session = await harness.store.load(FEATURE);

  await writeFile(
    join(directory, session.artifacts.publish.filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function publishResult(harness: Harness): Promise<OrchestrationResult> {
  return harness.orchestrator.publishFeature(FEATURE);
}

/**
 * Rewrites the approval so it describes a different tree — consistently.
 *
 * The approval names four things about the tree it was given for: a fingerprint, the gate's fingerprint,
 * the digest of the gate document, and the gate's revision. This changes the first three together, which
 * is what a session recorded against this tree would look like, and leaves everything else alone. It
 * exists so a test can ask the question *after* the fingerprint check rather than instead of it.
 */
async function rebindApprovalTo(harness: Harness, changes: WorkspaceChanges): Promise<void> {
  const directory = await featureDirectoryOf(harness.store, FEATURE);
  const session = await harness.store.load(FEATURE);
  const gate = (await harness.store.readArtifact(FEATURE, "final_gate")) as Record<string, unknown>;
  const fingerprint = fingerprintOfChanges(changes);
  const gateText = `${JSON.stringify({ ...gate, fingerprint }, null, 2)}\n`;

  await writeFile(join(directory, session.artifacts.final_gate.filename), gateText, "utf8");

  await rewriteSession(harness, (current) => {
    const approval = current.approvals.push;

    if (approval === null) {
      throw new Error("The feature was driven to the commit step without an approval.");
    }

    Object.assign(approval, {
      finalGateFingerprint: fingerprint,
      workingTreeFingerprint: fingerprint,
      finalGateSha256: digestArtifactText(gateText),
    });
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------------------------- */
/* Branch names and messages, as policy                                                            */
/* --------------------------------------------------------------------------------------------- */

describe("what publishing is willing to name", () => {
  it("builds one branch per approval, derived from what the approval names", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);

    const session = await harness.store.load(FEATURE);
    const approval = session.approvals.push;
    const request = harness.publisher.commits[0];
    const recorded = approval;

    if (recorded === null || request === undefined) {
      throw new Error("The commit step ran without an approval or without reaching the publisher.");
    }

    const expected = buildFeatureBranch({ featureId: FEATURE, approval: recorded });

    if (!expected.ok) {
      throw new Error(`The branch should be safe: ${expected.error.message}`);
    }

    expect(request.branch).toBe(expected.branch);
    expect(request.branch.startsWith(`${PUBLISHING_BRANCH_PREFIX}/${FEATURE}-`)).toBe(true);

    // The same approval twice names the same branch, which is what makes a retry find the branch it
    // created instead of colliding with one.
    const again = buildFeatureBranch({ featureId: FEATURE, approval: recorded });

    expect(again.ok && again.branch).toBe(expected.branch);
  });

  it("refuses every branch that is not one of its own, whatever it is called", () => {
    expect(isSafeBranchName("main")).toBe(false);
    expect(isSafeBranchName("master")).toBe(false);
    expect(isSafeBranchName("develop")).toBe(false);
    expect(isSafeBranchName("release/1.0")).toBe(false);
    expect(isSafeBranchName(`${PUBLISHING_BRANCH_PREFIX}/../main`)).toBe(false);
    expect(isSafeBranchName(`${PUBLISHING_BRANCH_PREFIX}/F-1..F-2`)).toBe(false);
    expect(isSafeBranchName(`${PUBLISHING_BRANCH_PREFIX}/F-1 x`)).toBe(false);
    expect(isSafeBranchName(`${PUBLISHING_BRANCH_PREFIX}/F-1~1`)).toBe(false);
    expect(isSafeBranchName(`${PUBLISHING_BRANCH_PREFIX}/-F-1`)).toBe(false);
    expect(isSafeBranchName(`${PUBLISHING_BRANCH_PREFIX}/F-1.lock`)).toBe(false);
    expect(isSafeBranchName(`${PUBLISHING_BRANCH_PREFIX}/F-1`)).toBe(true);
  });

  it("refuses a remote name that git would read as something other than a remote", () => {
    expect(verifyRemoteName("origin").ok).toBe(true);
    expect(verifyRemoteName("upstream-1").ok).toBe(true);
    // The leading `-` is the interesting one: `--mirror` on a command line is a flag, not a remote.
    expect(verifyRemoteName("--mirror").ok).toBe(false);
    expect(verifyRemoteName("../elsewhere").ok).toBe(false);
    expect(verifyRemoteName("a..b").ok).toBe(false);
    expect(verifyRemoteName("").ok).toBe(false);
  });

  it("recognises its own commit and nothing else", () => {
    const ownership = { featureId: FEATURE, summarySha256: "a".repeat(64) };
    const message = [
      `feat(${FEATURE}): something`,
      "",
      `Feature-Id: ${FEATURE}`,
      `Push-Approval-Summary-Sha256: ${ownership.summarySha256}`,
    ].join("\n");

    expect(commitCarriesOwnership(message, ownership)).toBe(true);
    expect(commitCarriesOwnership(message, { ...ownership, featureId: "F-002" })).toBe(false);
    expect(commitCarriesOwnership(message, { ...ownership, summarySha256: "b".repeat(64) })).toBe(false);
    // A trailer an unrelated commit happened to mention in its body is not ownership either.
    expect(
      commitCarriesOwnership(`feat: something\n\nFeature-Id: ${FEATURE}\nnot a trailer`, ownership),
    ).toBe(false);
  });

  it("names a refusal for a branch name rather than a boolean", () => {
    // Two layers, in this order, and the first is the one that does the work: a name outside the
    // framework's own namespace is refused for not being in it, and a *reserved* name inside that
    // namespace is refused on its own account.
    expect(unsafeBranchNameReason("main")).toContain(`not under "${PUBLISHING_BRANCH_PREFIX}/"`);
    expect(unsafeBranchNameReason(`${PUBLISHING_BRANCH_PREFIX}/main`)).toContain("line of development");
    expect(unsafeBranchNameReason("feature/x")).toContain(`not under "${PUBLISHING_BRANCH_PREFIX}/"`);
    expect(unsafeBranchNameReason(`${PUBLISHING_BRANCH_PREFIX}/F-1`)).toBeNull();
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Reaching the commit step                                                                       */
/* --------------------------------------------------------------------------------------------- */

describe("publishing a feature that was not approved", () => {
  it("refuses to publish from any state that is not a publishing state", async () => {
    const harness = createHarness(await makeRoot());

    await harness.orchestrator.createFeature({
      featureId: FEATURE,
      title: TITLE,
      request: "# Request\n\nPublish the approved change.\n",
    });

    const before = await publishResult(harness);

    expect(before).toMatchObject({ status: "rejected", state: WorkflowState.Draft, committed: false });
    expect(before.error?.code).toBe("publish_state_invalid");

    await driveTo(harness, WorkflowState.AwaitingPushApproval);

    // The gate itself: from here publishing is one step away and still refused, because reaching the
    // commit step requires the approval that only `approvePush` records.
    const atGate = await publishResult(harness);

    expect(atGate).toMatchObject({ status: "rejected", state: WorkflowState.AwaitingPushApproval });
    expect(atGate.error?.code).toBe("publish_state_invalid");
    expect(harness.publisher.commits).toHaveLength(0);
  });

  it("refuses a feature whose approval was removed after it was given", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await rewriteSession(harness, (session) => {
      Object.assign(session.approvals, { push: null });
    });

    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Committing, committed: false });
    expect(result.error?.code).toBe("publish_not_approved");
    expect(harness.publisher.commits).toHaveLength(0);
  });

  it("refuses to publish at all when no publisher is configured", async () => {
    const harness = createHarness(await makeRoot(), { withoutPublisher: true });

    await driveToCommitting(harness);
    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Committing, committed: false });
    expect(result.error?.code).toBe("publisher_not_configured");
    expect((await harness.store.load(FEATURE)).machine).toEqual({ state: WorkflowState.Committing });
  });

  it("refuses a remote name that is not a remote name, before any git runs", async () => {
    const harness = createHarness(await makeRoot(), { publishRemote: "--mirror" });

    await driveToCommitting(harness);
    const result = await publishResult(harness);

    expect(result.error?.code).toBe("publish_remote_unavailable");
    expect(harness.publisher.commits).toHaveLength(0);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The commit step                                                                                */
/* --------------------------------------------------------------------------------------------- */

describe("writing the commit", () => {
  it("hands the publisher only what the approval describes", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);

    const session = await harness.store.load(FEATURE);
    const approval = session.approvals.push;
    const result = await publishResult(harness);

    expect(result.status).toBe("committed");
    expect(result.state).toBe(WorkflowState.Pushing);

    const request = harness.publisher.commits[0];

    if (approval === null || request === undefined) {
      throw new Error("The commit step ran without an approval or without reaching the publisher.");
    }

    expect(request.featureId).toBe(FEATURE);
    expect(request.expectedHead).toBe(session.approvals.plan?.baseline?.baselineCommit);
    expect(request.paths).toEqual(["src/app.ts", "src/publisher.ts"]);
    expect(request.ownership).toEqual({ featureId: FEATURE, summarySha256: approval.summarySha256 });
    expect(request.commitMessage.split("\n")[0]).toBe(`feat(${FEATURE}): ${TITLE}`);
    expect(request.commitMessage).toContain(`Push-Approval-Revision: ${String(approval.approvedRevision)}`);
  });

  it("opens the workspace read-write, and gives it back", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);

    const closedBefore = harness.workspace.closed.length;

    await publishResult(harness);

    // Every stage gives its workspace back, and so does publishing: a lease this process holds while it
    // refuses or finishes would keep the next run out of a workspace nobody is using.
    expect(harness.workspace.closed).toHaveLength(closedBefore + 1);
    expect(harness.workspace.opens.at(-1)?.access).toBe("read_write");
  });

  it("records the commit, and says only that, before anything is pushed", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    const result = await publishResult(harness);
    const record = await recordedPublish(harness);
    const session = await harness.store.load(FEATURE);
    const approval = session.approvals.push;

    if (approval === null) {
      throw new Error("The push approval went missing between the commit and this assertion.");
    }

    expect(result.publish).toEqual(record);
    expect(record).toMatchObject({
      schemaVersion: 1,
      featureId: FEATURE,
      commit: harness.publisher.commits.length === 1 ? result.publish?.commit : undefined,
      result: "committed",
      remote: null,
      pushedAt: null,
      paths: ["src/app.ts", "src/publisher.ts"],
      revisionBefore: approval.approvedRevision,
    });
    expect(record.branch).toBe(harness.publisher.commits[0]?.branch);
    expect(record.approval).toMatchObject({
      approvedRevision: approval.approvedRevision,
      summarySha256: approval.summarySha256,
      finalGateSha256: approval.finalGateSha256,
    });
    // A push that has not happened is not recorded as one, in the document or in the result.
    expect(harness.publisher.pushes).toHaveLength(0);
  });

  it("refuses a tree that no longer matches the one the approval was given for", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);

    // Inside the approved scope on purpose: the fingerprint is what this test is about, and a scope
    // failure would answer a different question first.
    harness.tree.changes = {
      ...APPROVED_CHANGES,
      added: [...APPROVED_CHANGES.added, "src/extra.ts"],
    };

    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Committing, committed: false });
    expect(result.error?.code).toBe("publish_approval_stale");
    expect(harness.publisher.commits).toHaveLength(0);
  });

  it("refuses a path the plan does not describe, even for an approval that matches the tree", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);

    // The approval is rewritten to describe this tree exactly, so the fingerprint check passes and the
    // question left is the scope one. Without that, the fingerprint would answer first and this test
    // would prove nothing about scope — which is the right order for the framework and the wrong order
    // for a test that wants to reach the second line of defence.
    const changes: WorkspaceChanges = { ...APPROVED_CHANGES, untracked: ["docs/plan.md"] };

    harness.tree.changes = changes;
    await rebindApprovalTo(harness, changes);

    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Committing, committed: false });
    expect(result.error?.code).toBe("publish_scope_violation");
    expect(harness.publisher.commits).toHaveLength(0);
  });

  it("refuses a worktree with nothing in it rather than writing an empty commit", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    harness.tree.changes = { modified: [], added: [], deleted: [], renamed: [], untracked: [] };

    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Committing });
    expect(harness.publisher.commits).toHaveLength(0);
  });

  it("turns a publisher refusal into a workflow refusal and stays put", async () => {
    const publisher = createFakeFeaturePublisher({ commitRefusal: "branch_conflict" });
    const harness = createHarness(await makeRoot(), { publisher });

    await driveToCommitting(harness);
    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Committing, committed: false });
    expect(result.error?.code).toBe("publish_branch_conflict");
    expect((await harness.store.load(FEATURE)).machine).toEqual({ state: WorkflowState.Committing });
    await expect(harness.store.readArtifact(FEATURE, "publish")).rejects.toThrow();
  });

  it("reports a publisher that throws as a publishing failure, without moving the feature", async () => {
    const publisher = createFakeFeaturePublisher({ commitThrows: new Error("git exploded") });
    const harness = createHarness(await makeRoot(), { publisher });

    await driveToCommitting(harness);
    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Committing, committed: false });
    expect(harness.publisher.commits).toHaveLength(1);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The push step                                                                                  */
/* --------------------------------------------------------------------------------------------- */

describe("pushing the commit", () => {
  it("pushes the recorded commit to the configured remote, and only then completes", async () => {
    const harness = createHarness(await makeRoot(), { publishRemote: "upstream" });

    await driveToCommitting(harness);
    const committed = await publishResult(harness);
    const pushed = await publishResult(harness);
    const record = await recordedPublish(harness);

    expect(committed.status).toBe("committed");
    expect(pushed.status).toBe("published");
    expect(pushed.state).toBe(WorkflowState.Complete);
    expect((await harness.store.load(FEATURE)).machine).toEqual({ state: WorkflowState.Complete });

    expect(harness.publisher.pushes).toHaveLength(1);
    expect(harness.publisher.pushes[0]).toMatchObject({
      featureId: FEATURE,
      remote: "upstream",
      branch: committed.publish?.branch,
      // The commit the record names, named explicitly rather than as "whatever the branch points at".
      commit: committed.publish?.commit,
    });

    expect(record).toMatchObject({
      result: "pushed",
      remote: "upstream",
      pushedAt: CLOCK,
    });
    expect(record.revisionAfter).toBeGreaterThan(record.revisionBefore);
  });

  it("stays in pushing after a refused push, and finishes on a retry without re-committing", async () => {
    const publisher = createFakeFeaturePublisher({ pushRefusal: "push_rejected", failFirstPushes: 1 });
    const harness = createHarness(await makeRoot(), { publisher });

    await driveToCommitting(harness);
    const committed = await publishResult(harness);
    const refused = await publishResult(harness);

    expect(refused).toMatchObject({ status: "rejected", state: WorkflowState.Pushing, committed: false });
    expect(refused.error?.code).toBe("publish_push_rejected");
    expect((await harness.store.load(FEATURE)).machine).toEqual({ state: WorkflowState.Pushing });

    // The record still says "committed" and still names the commit, which is what makes the retry a
    // retry: nothing is re-committed, and the record never claimed a push that did not happen.
    const midway = await recordedPublish(harness);

    expect(midway).toMatchObject({ result: "committed", remote: null, pushedAt: null });
    expect(midway.commit).toBe(committed.publish?.commit);

    const succeeded = await harness.orchestrator.publishFeature(FEATURE);

    expect(succeeded).toMatchObject({ status: "published", state: WorkflowState.Complete });
    expect(harness.publisher.commits).toHaveLength(1);
    expect(harness.publisher.pushes).toHaveLength(2);
    // The retry pushed the commit the first attempt recorded, not a new one.
    expect(harness.publisher.pushes[1]?.commit).toBe(midway.commit);
  });

  it("refuses to push a record it cannot read", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);

    const directory = await featureDirectoryOf(harness.store, FEATURE);
    const session = await harness.store.load(FEATURE);

    await rm(join(directory, session.artifacts.publish.filename), { force: true });

    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Pushing });
    expect(result.error?.code).toBe("publish_record_missing");
    expect(harness.publisher.pushes).toHaveLength(0);
  });

  it("refuses a record that was edited after it was written", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);

    const record = await recordedPublish(harness);

    await overwritePublish(harness, { ...record, commit: "not-a-commit" });

    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Pushing });
    expect(result.error?.code).toBe("publish_record_invalid");
    expect(harness.publisher.pushes).toHaveLength(0);
  });

  it("refuses a record from a different approval than the one now in force", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);

    const record = await recordedPublish(harness);

    await overwritePublish(harness, {
      ...record,
      approval: { ...record.approval, summarySha256: "b".repeat(64) },
    });

    const result = await publishResult(harness);

    expect(result.error?.code).toBe("publish_approval_stale");
    expect(harness.publisher.pushes).toHaveLength(0);
  });

  it("refuses a record that claims a push the session does not agree with", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);

    const record = await recordedPublish(harness);

    await overwritePublish(harness, { ...record, result: "pushed", remote: "origin", pushedAt: CLOCK });

    const result = await publishResult(harness);

    expect(result.error?.code).toBe("publish_record_invalid");
    expect(harness.publisher.pushes).toHaveLength(0);
  });

  it("refuses to publish a feature that is already complete", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);
    await publishResult(harness);

    const again = await publishResult(harness);

    expect(again).toMatchObject({ status: "rejected", state: WorkflowState.Complete, committed: false });
    expect(again.error?.code).toBe("publish_already_published");
    expect(harness.publisher.pushes).toHaveLength(1);
  });

  it("publishes one step per call, the same way a stage is one step", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);

    const first = await harness.orchestrator.runNext(FEATURE);
    const second = await harness.orchestrator.runNext(FEATURE);

    expect(first).toMatchObject({ status: "committed", state: WorkflowState.Pushing });
    expect(second).toMatchObject({ status: "published", state: WorkflowState.Complete });
    expect(harness.publisher.commits).toHaveLength(1);
    expect(harness.publisher.pushes).toHaveLength(1);
  });

  it("runs nothing on a completed feature, and pushes nothing twice", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await harness.orchestrator.runNext(FEATURE);
    await harness.orchestrator.runNext(FEATURE);

    const third = await harness.orchestrator.runNext(FEATURE);

    // `runNext` on a finished feature reports that it is finished, and the explicit `publishFeature` above
    // is where a second publish is named as one. Neither runs a stage, and neither pushes again.
    expect(third.status).toBe("terminal");
    expect(harness.publisher.pushes).toHaveLength(1);
    expect(await publishResult(harness)).toMatchObject({
      status: "rejected",
      error: { code: "publish_already_published" },
    });
    expect(harness.publisher.pushes).toHaveLength(1);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The record itself                                                                              */
/* --------------------------------------------------------------------------------------------- */

describe("the recorded publishing result", () => {
  it("is written twice, and the second write is the only one that names a remote", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);

    const first = await recordedPublish(harness);

    expect(first.remote).toBeNull();
    expect(await readFile(await publishPath(harness), "utf8")).not.toContain('"origin"');

    await publishResult(harness);

    expect((await recordedPublish(harness)).remote).toBe("origin");
  });

  it("refuses a document that is not a record rather than reading part of one", () => {
    expect(publishRecordFrom(null).ok).toBe(false);
    expect(publishRecordFrom({ schemaVersion: 2 }).ok).toBe(false);
    expect(publishRecordFrom({ schemaVersion: 1, featureId: FEATURE }).ok).toBe(false);
    // A branch this framework would not have pushed is not a branch a record may name.
    expect(
      publishRecordFrom({
        schemaVersion: 1,
        featureId: FEATURE,
        branch: "main",
        commit: "a".repeat(40),
        result: "committed",
        remote: null,
        paths: ["src/app.ts"],
        revisionBefore: 4,
        revisionAfter: 5,
        recordedAt: CLOCK,
        pushedAt: null,
        approval: {
          approvedAt: CLOCK,
          approvedRevision: 4,
          summarySha256: "a".repeat(64),
          finalGateSha256: "b".repeat(64),
          actor: null,
        },
      }).ok,
    ).toBe(false);
    // A 64-character digest is a digest; a 40-character one in a digest field is not.
    expect(
      publishRecordFrom({
        schemaVersion: 1,
        featureId: FEATURE,
        branch: `${PUBLISHING_BRANCH_PREFIX}/${FEATURE}-0123456789ab`,
        commit: "a".repeat(40),
        result: "committed",
        remote: null,
        paths: ["src/app.ts"],
        revisionBefore: 4,
        revisionAfter: 5,
        recordedAt: CLOCK,
        pushedAt: null,
        approval: {
          approvedAt: CLOCK,
          approvedRevision: 4,
          summarySha256: "c".repeat(40),
          finalGateSha256: "b".repeat(64),
          actor: null,
        },
      }).ok,
    ).toBe(false);
  });

  it("carries no command output, so the record is the same on every run", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);

    const record = await recordedPublish(harness);

    expect(Object.keys(record).sort()).toEqual([
      "approval",
      "branch",
      "commit",
      "featureId",
      "paths",
      "pushedAt",
      "recordedAt",
      "remote",
      "result",
      "revisionAfter",
      "revisionBefore",
      "schemaVersion",
    ]);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The session file itself                                                                        */
/* --------------------------------------------------------------------------------------------- */

describe("a session that was edited between the two steps", () => {
  it("refuses to push when the recorded commit no longer exists in the document", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await publishResult(harness);

    const directory = await featureDirectoryOf(harness.store, FEATURE);
    const session = await harness.store.load(FEATURE);

    // A file the store cannot parse at all. That is a persistence failure rather than an invalid record,
    // and it is worth the distinction: the two mean "the write went wrong" and "the write was fine and
    // the document says something else".
    await writeFile(join(directory, session.artifacts.publish.filename), "{ not json\n", "utf8");

    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Pushing });
    expect(result.error?.code).toBe("persistence_failed");
    expect(harness.publisher.pushes).toHaveLength(0);
  });

  it("refuses to commit when the summary changed after the approval", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await harness.store.writeArtifact(FEATURE, "final_summary", "# edited after approval\n");

    const result = await publishResult(harness);

    expect(result).toMatchObject({ status: "rejected", state: WorkflowState.Committing });
    expect(result.error?.code).toBe("publish_summary_mismatch");
    expect(harness.publisher.commits).toHaveLength(0);
  });

  it("refuses to commit when the gate document changed after the approval", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);

    const gate = (await harness.store.readArtifact(FEATURE, "final_gate")) as Record<string, unknown>;

    await harness.store.writeArtifact(FEATURE, "final_gate", { ...gate, note: "edited" });

    const result = await publishResult(harness);

    expect(result.error?.code).toBe("publish_approval_stale");
    expect(harness.publisher.commits).toHaveLength(0);
  });

  it("refuses to commit when the session recorded something after the approval", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    await rewriteSession(harness, (session) => {
      Object.assign(session, { revision: session.revision + 1 });
    });

    const result = await publishResult(harness);

    expect(result.error?.code).toBe("publish_approval_stale");
    expect(harness.publisher.commits).toHaveLength(0);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The gate that leads here                                                                       */
/* --------------------------------------------------------------------------------------------- */

describe("the approval that publishing runs on", () => {
  it("records who approved what, at a revision the session can be checked against", async () => {
    const harness = createHarness(await makeRoot());

    await driveToCommitting(harness);
    const approved = await harness.store.load(FEATURE);
    const approval = approved.approvals.push;

    expect(approval).not.toBeNull();
    expect(approval?.featureId).toBe(FEATURE);
    // The approval is the session's business, not a separate record: a session with no approval has
    // nothing to publish, which is why removing it above is a refusal rather than a smaller publish.
    expect(approved.machine).toEqual({ state: WorkflowState.Committing });
  });
});

async function publishPath(harness: Harness): Promise<string> {
  const directory = await featureDirectoryOf(harness.store, FEATURE);
  const session = await harness.store.load(FEATURE);

  return join(directory, session.artifacts.publish.filename);
}