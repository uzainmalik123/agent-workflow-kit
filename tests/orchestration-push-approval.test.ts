import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState, WorkflowStateMachine, type WorkflowEvent } from "@agent-workflow-kit/core";
import {
  buildFinalSummary,
  createWorkflowOrchestrator,
  MAX_SUMMARY_ITEMS,
  PUSH_APPROVAL_REVISION_OFFSET,
  type FinalGateResult,
} from "@agent-workflow-kit/orchestration";
import {
  createFeatureSessionStore,
  FEATURE_ARTIFACT_NAMES,
  type FeatureSessionStore,
} from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { featureDirectoryOf, writeSessionDocument } from "../fixtures/session-documents.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import {
  createFakeWorkspaceProvider,
  fingerprintOfChanges,
  type FakeWorkspaceProvider,
} from "../fixtures/workspace-provider.js";
import type { WorkspaceChanges } from "@agent-workflow-kit/orchestration";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The final summary and the publishing approval.
 *
 * Two properties are under test and they are the reason this milestone exists.
 *
 * The summary is a document a person reads before deciding whether to publish, so it has to be a
 * reading of the recorded state and nothing else. Every test below that checks its contents also
 * checks that running it changed no artifact, because a summary that silently revised a spec or
 * appended to a fix history would be describing a workflow it had just edited.
 *
 * The approval is a claim about specific bytes, so it is bound to them: the summary's digest, the gate's
 * digest and revision, and a fingerprint of the tree measured at the moment approval was asked for.
 * Each way that binding can be broken — a changed tree, a moved revision, an edited gate document, a
 * second approval — has its own test, because "stale approval cannot authorize publishing" is one
 * property with several independent ways to fail and a single happy-path test would not notice if only
 * one of them had been closed.
 */

const CLOCK = "2026-04-05T06:07:08.000Z";
const FEATURE = "F-001";
const TITLE = "Google OAuth / API";
const roots: string[] = [];

/**
 * The change set every stage measures until a test moves it.
 *
 * Every path here appears in the plan artifact below, because the scope check runs on the way past and
 * a change set nobody approved would fail the feature for a reason no test is about.
 */
const APPROVED_CHANGES: WorkspaceChanges = {
  modified: ["orchestration/src/orchestrator.ts"],
  added: [],
  deleted: [],
  renamed: [],
  untracked: ["orchestration/src/push-approval.ts"],
};

const SPEC_ARTIFACT = {
  schemaVersion: 1,
  featureId: FEATURE,
  summary: "Sign users in with Google and let the workflow read their account.",
  requirements: [
    {
      id: "REQ-1",
      title: "Google sign-in",
      description: "A user can exchange a Google code for a session.",
      acceptanceCriteria: [
        { id: "AC-1", text: "A valid code produces a session." },
        { id: "AC-2", text: "An invalid code is refused." },
      ],
    },
    {
      id: "REQ-2",
      title: "Account readback",
      description: "The session exposes the account the code belonged to.",
      acceptanceCriteria: [{ id: "AC-3", text: "The email is the one Google returned." }],
    },
  ],
};

const PLAN_ARTIFACT = {
  schemaVersion: 1,
  featureId: FEATURE,
  summary: "Add the token exchange and read the profile back.",
  steps: [
    {
      id: "STEP-1",
      description: "Exchange the authorization code for tokens.",
      expectedFiles: [
        "orchestration/src/orchestrator.ts",
        "orchestration/src/push-approval.ts",
      ],
    },
    {
      // Deliberately only partly present in the change set below: the summary has to report that
      // without calling the step finished, because nothing in the records says it is.
      id: "STEP-2",
      description: "Record the approved publishing checkpoint.",
      expectedFiles: ["orchestration/src/approval-record.ts"],
    },
  ],
};

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly workspace: FakeWorkspaceProvider;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
  /** Flipped by a test to move the tree underneath the recorded evidence. */
  readonly tree: { changes: WorkspaceChanges | null };
}

function createHarness(root: string): Harness {
  const store = createFeatureSessionStore(root, { clock: () => CLOCK });
  const executor = new FakeStageExecutor();

  // The griller and the planner are the two stages whose artifacts the summary reads a description
  // from, so both are given structured documents rather than the double's generic ones.
  executor.configure("grill", {
    artifacts: [
      { name: "grill", content: { featureId: FEATURE, decisions: [] } },
      { name: "spec", content: SPEC_ARTIFACT },
    ],
  });
  executor.configure("planning", {
    artifacts: [{ name: "plan", content: PLAN_ARTIFACT }],
  });

  const tree: Harness["tree"] = { changes: null };
  const workspace = createFakeWorkspaceProvider({
    changes: () => tree.changes ?? APPROVED_CHANGES,
  });

  return {
    store,
    executor,
    workspace,
    tree,
    orchestrator: createWorkflowOrchestrator({
      store,
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
      workspace,
    }),
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-push-approval-"));
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

/** Runs the whole workflow to the point where a publishing approval is pending. */
async function driveToApproval(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: FEATURE,
    title: TITLE,
    request: "# Request\n\nSign users in with Google.\n",
  });

  await driveTo(harness, WorkflowState.FinalSummary);
  await harness.orchestrator.runNext(FEATURE);
  await driveTo(harness, WorkflowState.AwaitingPushApproval);
}

async function summaryText(harness: Harness): Promise<string> {
  return harness.store.readArtifactText(FEATURE, "final_summary");
}

async function recordedGate(harness: Harness): Promise<FinalGateResult> {
  return (await harness.store.readArtifact(FEATURE, "final_gate")) as FinalGateResult;
}

/** Every artifact's exact bytes, for the test that asserts the summary changed nothing. */
async function artifactTexts(harness: Harness): Promise<ReadonlyMap<string, string>> {
  const texts = new Map<string, string>();

  for (const name of FEATURE_ARTIFACT_NAMES) {
    try {
      texts.set(name, await harness.store.readArtifactText(FEATURE, name));
    } catch {
      continue;
    }
  }

  return texts;
}

/** Replaces the recorded gate document, as a hand-edited or truncated session file would. */
async function overwriteGate(harness: Harness, gate: unknown): Promise<void> {
  const directory = await featureDirectoryOf(harness.store, FEATURE);
  const session = await harness.store.load(FEATURE);

  await writeFile(
    join(directory, session.artifacts.final_gate.filename),
    `${JSON.stringify(gate, null, 2)}\n`,
    "utf8",
  );
}

/** Deletes the recorded gate document, which is a session whose verdict is simply absent. */
async function removeGate(harness: Harness): Promise<void> {
  const directory = await featureDirectoryOf(harness.store, FEATURE);
  const session = await harness.store.load(FEATURE);

  await rm(join(directory, session.artifacts.final_gate.filename), { force: true });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------------------------- */
/* The summary                                                                                    */
/* --------------------------------------------------------------------------------------------- */

describe("writing the final summary", () => {
  it("refuses to write one for a gate that is not recorded", async () => {
    const harness = createHarness(await makeRoot());

    await harness.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(harness, WorkflowState.FinalSummary);

    // A session that reached `final_summary` because the document was removed afterwards is the case
    // the persisted gate exists to make visible. Without the record there is no verdict to report, so
    // nothing is written and the state does not move.
    await removeGate(harness);
    const missing = await harness.orchestrator.runNext(FEATURE);

    expect(missing).toMatchObject({
      status: "rejected",
      stage: "final_summary",
      fromState: WorkflowState.FinalSummary,
      state: WorkflowState.FinalSummary,
      committed: false,
      artifacts: [],
    });
    expect(missing.error?.code).toBe("final_gate_not_recorded");
    await expect(summaryText(harness)).rejects.toThrow();
  });

  it("refuses to write one for a gate that did not pass", async () => {
    const harness = createHarness(await makeRoot());

    await harness.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(harness, WorkflowState.FinalSummary);

    await overwriteGate(harness, { ...(await recordedGate(harness)), status: "failed" });

    const result = await harness.orchestrator.runNext(FEATURE);

    expect(result.error?.code).toBe("final_gate_blocked");
    expect(result.state).toBe(WorkflowState.FinalSummary);
    await expect(summaryText(harness)).rejects.toThrow();
  });

  it("refuses to write one for a gate whose tree has moved since it was decided", async () => {
    const harness = createHarness(await makeRoot());

    await harness.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(harness, WorkflowState.FinalSummary);

    // Inside the approved scope on purpose: the scope check runs first, and a path nobody approved
    // would fail the stage for a different reason before the freshness check was ever reached.
    harness.tree.changes = {
      ...APPROVED_CHANGES,
      untracked: [...APPROVED_CHANGES.untracked, "orchestration/src/approval-record.ts"],
    };

    const result = await harness.orchestrator.runNext(FEATURE);

    expect(result).toMatchObject({
      status: "rejected",
      stage: "final_summary",
      state: WorkflowState.FinalSummary,
      committed: false,
    });
    expect(result.error?.code).toBe("final_gate_evidence_stale");
    await expect(summaryText(harness)).rejects.toThrow();
  });

  it("states every part of the recorded workflow, and nothing else", async () => {
    const harness = createHarness(await makeRoot());

    await harness.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(harness, WorkflowState.FinalSummary);
    await harness.orchestrator.runNext(FEATURE);

    const summary = await summaryText(harness);
    const gate = await recordedGate(harness);
    const session = await harness.store.load(FEATURE);

    // Identity and description, from the records rather than from prose.
    expect(summary).toContain(`# ${FEATURE} — ${TITLE}`);
    expect(summary).toContain("Sign users in with Google and let the workflow read their account.");

    // Approved requirements, read from the spec the human approved.
    expect(summary).toContain("REQ-1 Google sign-in");
    expect(summary).toContain("2 acceptance criterion/criteria");
    expect(summary).toContain("REQ-2 Account readback");

    // Plan steps with what the measurement could support about each: the second step names a file
    // the change set does not contain, so it is reported as partial rather than as complete.
    expect(summary).toContain("STEP-1 Exchange the authorization code for tokens.");
    expect(summary).toContain("2 of 2 expected file(s) in the measured change set (observed)");
    expect(summary).toContain("0 of 1 expected file(s) in the measured change set (partial)");

    // Changed files, each labelled with the category it was measured in.
    expect(summary).toContain("orchestration/src/orchestrator.ts (modified)");
    expect(summary).toContain("orchestration/src/push-approval.ts (untracked)");

    // The framework's own verdicts, one line each.
    expect(summary).toContain("Session revision:");
    expect(summary).toContain("Working tree:");
    expect(summary).toContain("static (static_verification): passed");
    expect(summary).toContain("Gate result: pass");
    expect(summary).toContain("Gate result: clean");
    expect(summary).toContain("- No fix attempt was recorded.");

    // The gate the whole document rests on, including the revision and fingerprint it decided against.
    expect(summary).toContain(`Final gate: passed at revision ${String(gate.revision)}`);
    expect(summary).toContain("Blockers: none");
    expect(summary).toContain(gate.fingerprint);

    // The revision is the one the summary itself was recorded at, which is the revision the approval
    // will later have to find.
    expect(summary).toContain(`Session revision: ${String(session.revision)}`);
    expect(summary).toContain(
      `Session revision: ${String(gate.revision + PUSH_APPROVAL_REVISION_OFFSET)}`,
    );
  });

  it("produces the same document from the same records", async () => {
    const first = createHarness(await makeRoot());

    await first.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(first, WorkflowState.FinalSummary);
    await first.orchestrator.runNext(FEATURE);

    const second = createHarness(await makeRoot());

    await second.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(second, WorkflowState.FinalSummary);
    await second.orchestrator.runNext(FEATURE);

    // Two independent runs, two separate stores, two separate executors. The documents are compared
    // byte for byte because determinism is the property: a summary that varied between runs could not
    // be approved by digest, which is the only way the approval can be bound to it.
    expect(await summaryText(second)).toBe(await summaryText(first));
  });

  it("changes no recorded artifact and no approval", async () => {
    const harness = createHarness(await makeRoot());

    await harness.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(harness, WorkflowState.FinalSummary);

    const before = await artifactTexts(harness);
    const beforeSession = await harness.store.load(FEATURE);

    await harness.orchestrator.runNext(FEATURE);

    const after = await artifactTexts(harness);
    const afterSession = await harness.store.load(FEATURE);

    // The one artifact the stage adds, and nothing else. Every other document is byte-identical, which
    // covers each thing the summary is required not to modify: the requirements and criteria in the
    // spec, the plan, the verification and security records, the scope measurement, and the fix
    // history all live in that set.
    expect([...after.keys()].filter((name) => !before.has(name))).toEqual(["final_summary"]);

    for (const [name, text] of before) {
      expect(after.get(name)).toBe(text);
    }

    // Approvals are untouched, and the state moved by exactly one revision.
    expect(afterSession.approvals).toEqual(beforeSession.approvals);
    expect(afterSession.revision).toBe(beforeSession.revision + 1);
    expect(afterSession.machine.state).toBe(WorkflowState.AwaitingPushApproval);
  });

  it("bounds what it reports without hiding how much there was", () => {
    const requirements = Array.from({ length: MAX_SUMMARY_ITEMS + 5 }, (_, index) => ({
      id: `REQ-${String(index + 1)}`,
      title: `Requirement ${String(index + 1)}`,
      acceptanceCriteria: [{ id: `AC-${String(index + 1)}`, text: "It works." }],
    }));

    const document = buildFinalSummary({
      featureId: FEATURE,
      title: TITLE,
      revision: 7,
      fingerprint: "t".repeat(64),
      spec: { summary: "A bounded feature.", requirements },
      plan: { summary: "A bounded plan.", steps: [] },
      gate: {
        schemaVersion: 1,
        featureId: FEATURE,
        status: "passed",
        state: WorkflowState.FinalGate,
        revision: 5,
        fingerprint: "t".repeat(64),
        requirementIds: requirements.map((requirement) => requirement.id),
        acceptanceCriterionIds: [],
        criteria: [],
        criterionCount: requirements.length,
        criteriaTruncated: false,
        verification: "passed",
        verificationStages: [],
        security: "pass",
        scope: "clean",
        approval: "intact",
        fixer: "none",
        blockers: [],
        route: "final_gate",
        evidence: [],
      },
      security: null,
      fixes: [],
      changes: { modified: [], added: [], deleted: [], renamed: [], untracked: [] },
      scope: { measured: true, approvedPatterns: ["src/**"], unauthorizedPaths: [] },
    });

    expect(document).toContain(`REQ-${String(MAX_SUMMARY_ITEMS)} Requirement ${String(MAX_SUMMARY_ITEMS)}`);
    expect(document).toContain("- … and 5 more.");
    expect(document).not.toContain(`REQ-${String(MAX_SUMMARY_ITEMS + 1)}`);
  });

  it("says so rather than inventing a record it could not find", () => {
    const document = buildFinalSummary({
      featureId: FEATURE,
      title: TITLE,
      revision: 7,
      fingerprint: null,
      spec: null,
      plan: null,
      gate: {
        schemaVersion: 1,
        featureId: FEATURE,
        status: "passed",
        state: WorkflowState.FinalGate,
        revision: 5,
        fingerprint: "",
        requirementIds: [],
        acceptanceCriterionIds: [],
        criteria: [],
        criterionCount: 0,
        criteriaTruncated: false,
        verification: "passed",
        verificationStages: [],
        security: "missing",
        scope: "unmeasured",
        approval: "intact",
        fixer: "none",
        blockers: [],
        route: "final_gate",
        evidence: [],
      },
      security: null,
      fixes: [],
      changes: { modified: [], added: [], deleted: [], renamed: [], untracked: [] },
      scope: { measured: false, approvedPatterns: [], unauthorizedPaths: [] },
    });

    // Nothing here was recorded, and every one of those facts is stated rather than filled in. A
    // summary that read "0 acceptance criteria" for a specification it never saw would be reporting a
    // measurement, and a human approving publishing would be approving a claim nobody made.
    expect(document).toContain("- Working tree: not recorded");
    expect(document).toContain("not recorded: the approved specification declares no structured requirements.");
    expect(document).toContain("not recorded: no change set was measured for this feature.");
    expect(document).toContain("not recorded: no security review record was found.");
    expect(document).toContain("- Paths outside the approved plan: not recorded");
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The approval                                                                                   */
/* --------------------------------------------------------------------------------------------- */

describe("the pending publishing approval", () => {
  it("is a real pending approval rather than a formality", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const session = await harness.store.load(FEATURE);

    expect(session.machine.state).toBe(WorkflowState.AwaitingPushApproval);

    // Reaching the state, having a summary, having passed a gate, and having approved a plan are four
    // different things, and none of them is this one.
    expect(session.approvals.plan).not.toBeNull();
    expect(session.approvals.push).toBeNull();

    // And the state machine says so: from here, only `approve_push` is legal, and only it reaches
    // `committing`.
    const events: readonly WorkflowEvent[] = [
      "advance",
      "request_fix",
      "complete_fix",
      "fail",
      "approve_plan",
      "approve_push",
    ];
    // A fresh machine per event: applying one transition moves the machine, so a shared instance would
    // answer the second question about the state the first one left behind.
    const outcomes = events.map((event) => ({
      event,
      transition: new WorkflowStateMachine(session.machine).transition(event),
    }));

    // Failing a feature stays legal from here, because a person may always decide this work should
    // never ship. Committing is not: only the approval reaches it.
    expect(outcomes.filter((outcome) => outcome.transition.ok).map((outcome) => outcome.event)).toEqual([
      "fail",
      "approve_push",
    ]);

    for (const outcome of outcomes) {
      if (outcome.transition.ok && outcome.event !== "fail") {
        expect(outcome.transition.state).toBe(WorkflowState.Committing);
      }
    }
  });

  it("records nothing while the workflow waits, and moves nothing", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const before = await harness.store.load(FEATURE);
    const waiting = await harness.orchestrator.runNext(FEATURE);
    const after = await harness.store.load(FEATURE);

    expect(waiting).toMatchObject({
      status: "awaiting_human",
      action: "approve_push",
      state: WorkflowState.AwaitingPushApproval,
      committed: false,
    });
    expect(after.revision).toBe(before.revision);
    expect(after.approvals.push).toBeNull();
  });

  it("records the approval against the summary and the gate it was given", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const before = await harness.store.load(FEATURE);
    const gate = await recordedGate(harness);
    const summary = await summaryText(harness);
    const approved = await harness.orchestrator.approvePush(FEATURE, { actor: "release-bot" });
    const after = await harness.store.load(FEATURE);

    expect(approved).toMatchObject({
      status: "gate_approved",
      state: WorkflowState.Committing,
      event: "approve_push",
      committed: true,
    });
    expect(after.approvals.push).toMatchObject({
      decision: "approved",
      featureId: FEATURE,
      actor: "release-bot",
      approvedAt: CLOCK,
      approvedRevision: after.revision,
      summaryRevision: before.revision,
      workingTreeFingerprint: gate.fingerprint,
      finalGateStatus: "passed",
      finalGateRevision: gate.revision,
      finalGateFingerprint: gate.fingerprint,
    });

    // The digests are over the exact persisted bytes, so they are reproducible with `sha256sum` and a
    // later edit to either document cannot preserve them.
    const { createHash } = await import("node:crypto");
    const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

    expect(after.approvals.push?.summarySha256).toBe(sha256(summary));
    expect(after.approvals.push?.finalGateSha256).toBe(
      sha256(await harness.store.readArtifactText(FEATURE, "final_gate")),
    );

    // The approval was recorded without moving anything else: one revision, and the documents the
    // approval names are still the ones it read.
    expect(after.revision).toBe(before.revision + 1);
    expect(await summaryText(harness)).toBe(summary);
  });

  it("records no actor when it was not told one", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    await harness.orchestrator.approvePush(FEATURE);

    expect((await harness.store.load(FEATURE)).approvals.push?.actor).toBeNull();
  });

  it("refuses once the working tree has moved, and records nothing", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const before = await harness.store.load(FEATURE);
    harness.tree.changes = {
      ...APPROVED_CHANGES,
      modified: [...APPROVED_CHANGES.modified, "orchestration/src/summary-renderer.ts"],
    };

    const refused = await harness.orchestrator.approvePush(FEATURE);
    const after = await harness.store.load(FEATURE);

    expect(refused).toMatchObject({
      status: "rejected",
      fromState: WorkflowState.AwaitingPushApproval,
      state: WorkflowState.AwaitingPushApproval,
      committed: false,
    });
    expect(refused.error?.code).toBe("push_approval_stale");
    expect(refused.error?.message).toContain("Re-run the final gate and the summary");
    expect(after.approvals.push).toBeNull();
    expect(after.revision).toBe(before.revision);
  });

  it("refuses when the session has moved on since the summary was recorded", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const before = await harness.store.load(FEATURE);

    // A revision that moved without the state moving: the summary's own revision is no longer the
    // revision the summary was written at, so the pair no longer describes one decision.
    await harness.store.mutate(FEATURE, {
      prepare: () => ({ artifacts: [{ name: "request", content: "# Request\n\nEdited.\n" }] }),
    });

    const refused = await harness.orchestrator.approvePush(FEATURE);
    const after = await harness.store.load(FEATURE);

    expect(refused.error?.code).toBe("push_approval_stale");
    expect(after.approvals.push).toBeNull();
    expect(after.revision).toBe(before.revision + 1);
  });

  it("refuses when the recorded gate no longer matches the tree", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    // The gate document claims a tree that is not the one there is. The measurement is taken at
    // approval time, so this is caught however the document came to say it.
    const gate = await recordedGate(harness);
    await overwriteGate(harness, { ...gate, fingerprint: "f".repeat(64) });

    const refused = await harness.orchestrator.approvePush(FEATURE);

    expect(refused.error?.code).toBe("push_approval_stale");
    expect((await harness.store.load(FEATURE)).approvals.push).toBeNull();
  });

  it("refuses when the recorded gate is stale rather than refreshing the approval", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    // A gate from an earlier run of the feature: same tree, older revision. Nothing here is
    // automatically brought forward — the only way to a valid approval is a new gate, a new summary,
    // and a new approval.
    const gate = await recordedGate(harness);
    await overwriteGate(harness, { ...gate, revision: gate.revision - 1 });

    const refused = await harness.orchestrator.approvePush(FEATURE);

    expect(refused.error?.code).toBe("push_approval_stale");
    expect(refused.error?.message).toContain("Something was recorded in between");
    expect((await harness.store.load(FEATURE)).approvals.push).toBeNull();
  });

  it("refuses when the recorded gate is unreadable", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    await overwriteGate(harness, { schemaVersion: 99 });

    const refused = await harness.orchestrator.approvePush(FEATURE);

    expect(refused.error?.code).toBe("final_gate_not_recorded");
    expect((await harness.store.load(FEATURE)).approvals.push).toBeNull();
  });

  it("refuses a second approval rather than recording one against other evidence", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const approved = await harness.orchestrator.approvePush(FEATURE, { actor: "release-bot" });
    const record = (await harness.store.load(FEATURE)).approvals.push;

    expect(approved.status).toBe("gate_approved");

    // Straight after, the session is in `committing` and the transition is already illegal. A refusal
    // for that reason is correct, and the test that follows is the harder case: the record is present
    // and the state still claims to be waiting, which the store can produce and the orchestrator must
    // not paper over.
    expect(await harness.orchestrator.approvePush(FEATURE)).toMatchObject({
      status: "rejected",
      error: { code: "illegal_transition" },
    });
    expect((await harness.store.load(FEATURE)).approvals.push).toEqual(record);

    const session = await harness.store.load(FEATURE);

    await writeSessionDocument(harness.store, FEATURE, {
      ...session,
      machine: { ...session.machine, state: WorkflowState.AwaitingPushApproval },
    });

    const again = await harness.orchestrator.approvePush(FEATURE);

    expect(again).toMatchObject({
      status: "rejected",
      error: { code: "push_approval_already_granted" },
    });
    expect((await harness.store.load(FEATURE)).approvals.push).toEqual(record);
  });

  it("cannot be given from any other workflow state", async () => {
    const harness = createHarness(await makeRoot());

    await harness.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(harness, WorkflowState.AwaitingPlanApproval);

    const early = await harness.orchestrator.approvePush(FEATURE);

    expect(early).toMatchObject({
      status: "rejected",
      fromState: WorkflowState.AwaitingPlanApproval,
      state: WorkflowState.AwaitingPlanApproval,
      committed: false,
      error: { code: "illegal_transition", failureClass: "workflow" },
    });
    expect((await harness.store.load(FEATURE)).approvals.push).toBeNull();

    // A passing gate and a recorded summary are not an approval either, and a session that has both
    // is still waiting for one.
    await driveTo(harness, WorkflowState.AwaitingPushApproval);

    expect((await harness.store.load(FEATURE)).approvals.push).toBeNull();
  });

  it("cannot be reached by any route other than the explicit approval", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    // The state machine is the whole of that guarantee, so this walks every event from every state
    // that precedes publishing and asks which ones can produce `committing` at all.
    const preceding: readonly string[] = [
      WorkflowState.FinalSummary,
      WorkflowState.AwaitingPushApproval,
    ];

    for (const state of preceding) {
      const machine = new WorkflowStateMachine({ state: state as WorkflowState });
      const events: readonly WorkflowEvent[] = [
        "advance",
        "request_fix",
        "complete_fix",
        "fail",
        "approve_plan",
        "approve_push",
      ];

      for (const event of events) {
        const transition = machine.transition(event);

        if (transition.ok && transition.state === WorkflowState.Committing) {
          expect(state).toBe(WorkflowState.AwaitingPushApproval);
          expect(event).toBe("approve_push");
        }
      }
    }

    // And through the public API. The one other legal move from here is failing the feature, which a
    // person may always do — and which still reaches nothing that publishes, and records no approval.
    const session = await harness.store.load(FEATURE);
    const failed = await harness.orchestrator.failFeature(FEATURE);

    expect(failed).toMatchObject({ status: "feature_failed", state: WorkflowState.Failed, committed: true });
    expect(failed.state).not.toBe(WorkflowState.Committing);

    const after = await harness.store.load(FEATURE);

    expect(after.machine.state).toBe(WorkflowState.Failed);
    expect(after.approvals.push).toBeNull();
    expect(session.approvals.push).toBeNull();
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The tree the approval is bound to                                                               */
/* --------------------------------------------------------------------------------------------- */

describe("the fingerprint an approval is bound to", () => {
  it("is the one the gate measured, and it changes when the change set does", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const gate = await recordedGate(harness);

    expect(gate.fingerprint).toBe(
      fingerprintOfChanges({
        modified: [...APPROVED_CHANGES.modified],
        added: [],
        deleted: [],
        renamed: [],
        untracked: [...APPROVED_CHANGES.untracked],
      }),
    );
    expect(gate.fingerprint).not.toBe(
      fingerprintOfChanges({
        modified: [...APPROVED_CHANGES.modified],
        added: [],
        deleted: [],
        renamed: [],
        untracked: [],
      }),
    );
  });

  it("is re-measured at approval time rather than copied from the gate", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const before = harness.workspace.inspections.length;

    await harness.orchestrator.approvePush(FEATURE);

    // The approval opened the workspace and read the tree for itself. A check that reused the gate's
    // measurement would not have opened anything, and could not have failed.
    expect(harness.workspace.inspections.length).toBeGreaterThan(before);
  });
});

describe("the result the summary is written from", () => {
  it("is persisted by the gate rather than reconstructed later", async () => {
    const harness = createHarness(await makeRoot());

    await harness.orchestrator.createFeature({ featureId: FEATURE, title: TITLE });
    await driveTo(harness, WorkflowState.FinalGate);

    const session = await harness.store.load(FEATURE);

    await expect(harness.store.readArtifactText(FEATURE, "final_gate")).rejects.toThrow();

    const gated = await harness.orchestrator.runNext(FEATURE);

    expect(gated).toMatchObject({ status: "stage_completed", stage: "final_gate", artifacts: ["final_gate"] });
    expect(session.machine.state).toBe(WorkflowState.FinalGate);

    const gate = await recordedGate(harness);

    expect(gate).toMatchObject({
      schemaVersion: 1,
      featureId: FEATURE,
      state: WorkflowState.FinalGate,
      status: "passed",
      revision: session.revision,
    });
  });

  it("is the same gate the summary was written from and the approval records", async () => {
    const harness = createHarness(await makeRoot());

    await driveToApproval(harness);

    const gate = await recordedGate(harness);
    const summary = await summaryText(harness);
    const waiting = await harness.store.load(FEATURE);

    // One decision, three references to it: the artifact the gate wrote, the document the human reads,
    // and the revision the session is sitting at. They agree, which is what lets the summary be
    // approved by digest instead of by resemblance.
    expect(summary).toContain(`Final gate: passed at revision ${String(gate.revision)}`);
    expect(waiting.revision).toBe(gate.revision + PUSH_APPROVAL_REVISION_OFFSET);

    await harness.orchestrator.approvePush(FEATURE);

    const approved = await harness.store.load(FEATURE);

    expect(approved.approvals.push?.finalGateRevision).toBe(gate.revision);
    expect(approved.approvals.push?.summaryRevision).toBe(waiting.revision);
    expect(approved.machine.state).toBe(WorkflowState.Committing);
  });
});
