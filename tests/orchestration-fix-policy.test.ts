import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  MAX_FIX_ATTEMPTS,
  STAGE_DEFINITIONS,
  createWorkflowOrchestrator,
  evaluateFixIntegrity,
  failureReasonFrom,
  failureTargetFrom,
  isApprovalVerifiedStage,
  isVerificationCheckPath,
  latestFixEntry,
  latestRecordedEvidence,
  nextFixAttempt,
  resolveMaxFixAttempts,
  staleVerificationEvidence,
  suspectedFilesFrom,
  verificationConfigurationDigest,
  verificationForOrigin,
  workStageForOrigin,
  type FixIntegritySnapshot,
  type OrchestrationResult,
  type StageExecutionRequest,
  type VerificationEvidenceBundle,
  type WorkspaceChanges,
  type WorkflowOrchestrator,
} from "@agent-workflow-kit/orchestration";
import {
  createFeatureSessionStore,
  type FeatureSessionStore,
  type FixHistoryDocument,
  type FixHistoryEntry,
} from "@agent-workflow-kit/persistence";
import { FakeStageExecutor, findingFor } from "../fixtures/stage-executor.js";
import {
  createFakeVerificationProvider,
  passingEvidenceFor,
  type FakeVerificationProvider,
} from "../fixtures/verification-provider.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { inspectionOf } from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly orchestrator: WorkflowOrchestrator;
  readonly verification: FakeVerificationProvider;
  readonly workspace: ReturnType<typeof createFakeWorkspaceProvider>;
}

function fixedClock(): string {
  return fixedTimestamp;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-fix-policy-"));
  roots.push(root);
  return root;
}

/**
 * The change set the workspace reports, which a test rewrites from the executor's `after` hook.
 *
 * It is a mutable box rather than a fixed value because the fake provider is asked twice per fixing
 * run — once for the fix guard and once for the scope check — and a test that wants the framework to
 * see a change only during the fix has to be able to introduce it at exactly that point. Declaring the
 * change up front would make every earlier stage in the drive fail its own scope check instead.
 */
function changeSet() {
  const box = { current: {} as Partial<WorkspaceChanges> };

  return {
    read: (): Partial<WorkspaceChanges> => box.current,
    set: (changes: Partial<WorkspaceChanges>): void => {
      box.current = changes;
    },
  };
}

function createHarness(
  root: string,
  options: {
    readonly changes?: () => Partial<WorkspaceChanges>;
    readonly maxFixAttempts?: number;
    readonly verification?: () => FakeVerificationProvider;
    readonly workingDirectory?: (repositoryRoot: string) => string;
  } = {},
): Harness {
  const store = createFeatureSessionStore(root, { clock: fixedClock });
  const executor = new FakeStageExecutor();
  const { changes, workingDirectory, verification: verificationFor, maxFixAttempts } = options;
  const workspace = createFakeWorkspaceProvider({
    ...(changes === undefined ? {} : { changes }),
    ...(workingDirectory === undefined
      ? {}
      : { workingDirectory: (repositoryRoot: string) => workingDirectory(repositoryRoot) }),
  });
  const verification =
    verificationFor === undefined ? createFakeVerificationProvider() : verificationFor();

  const orchestrator = createWorkflowOrchestrator({
    store,
    executor,
    verification,
    workspace,
    ...(maxFixAttempts === undefined ? {} : { maxFixAttempts }),
  });

  return { store, executor, orchestrator, verification, workspace };
}

async function createFeature(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Fix policy",
    request: "# Request\n\nRepair the reported defects.\n",
  });
}

/** A plan that authorizes exactly `src/**`, so a scope check has something real to decide. */
async function approveScope(harness: Harness, patterns: readonly string[] = ["src/**"]): Promise<void> {
  harness.executor.configure("planning", {
    artifacts: [
      {
        name: "plan",
        content: {
          featureId: "F-001",
          steps: [{ expectedFiles: [...patterns] }],
        },
      },
    ],
  });

  await driveToState(harness, WorkflowState.AwaitingPlanApproval);
  await harness.orchestrator.approvePlan("F-001");
  harness.executor.reset("planning");
}

async function driveToState(harness: Harness, target: WorkflowState): Promise<OrchestrationResult[]> {
  const observed: OrchestrationResult[] = [];

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const session = await harness.store.load("F-001");

    if (session.machine.state === target) {
      return observed;
    }

    if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
      await harness.orchestrator.approvePlan("F-001");
      continue;
    }

    if (session.machine.state === WorkflowState.AwaitingPushApproval) {
      await harness.orchestrator.approvePush("F-001");
      continue;
    }

    if (session.machine.state === WorkflowState.Failed) {
      throw new Error("Feature failed while driving to the target state.");
    }

    observed.push(await harness.orchestrator.runNext("F-001"));
  }

  throw new Error(`Workflow never reached state "${target}".`);
}

async function requestFixFrom(harness: Harness, stage: "static_verification"): Promise<void> {
  harness.executor.configure(stage, {
    outcome: "needs_fix",
    findings: [findingFor("F-001", "the reported defect is unresolved")],
  });

  await driveToState(harness, STAGE_DEFINITIONS[stage].state);

  const result = await harness.orchestrator.runNext("F-001");

  expect(result).toMatchObject({
    status: "fix_requested",
    stage,
    state: WorkflowState.Fixing,
    fixReturnState: STAGE_DEFINITIONS[stage].state,
  });
}

async function completeFix(harness: Harness): Promise<OrchestrationResult> {
  return harness.orchestrator.runNext("F-001");
}

async function fixHistory(harness: Harness): Promise<readonly FixHistoryEntry[]> {
  const raw = await harness.store.readArtifact("F-001", "fixes").catch(() => undefined);

  return raw === undefined ? [] : (raw as FixHistoryDocument).fixes;
}

function fixingCalls(harness: Harness): number {
  return harness.executor.calls.filter((request) => request.stage === "fixing").length;
}

/** The most recent request for a stage. `requestFor` answers with the first, which is wrong for a loop. */
function lastRequestFor(harness: Harness, stage: "fixing"): StageExecutionRequest | undefined {
  return harness.executor.calls.filter((request) => request.stage === stage).at(-1);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("the fixer input contract", () => {
  it("hands the fixer the failure it was sent to repair, and nothing else", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await approveScope(harness);
    await requestFixFrom(harness, "static_verification");
    await completeFix(harness);

    const contract = harness.executor.requestFor("fixing")?.fix;

    expect(contract).toMatchObject({
      featureId: "F-001",
      failedStage: WorkflowState.StaticVerification,
      failedVerification: "static",
      approvedScope: ["src/**"],
      attempt: 1,
      maxAttempts: MAX_FIX_ATTEMPTS,
    });
    expect(contract?.failureReason).toContain("static");
    expect(contract?.protectedPaths).toEqual(expect.arrayContaining(["agent-workflow.config.json"]));
  });

  it("carries no contract on any stage that is not a fix", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await approveScope(harness);
    await requestFixFrom(harness, "static_verification");
    await completeFix(harness);

    for (const request of harness.executor.calls) {
      expect(request.stage === "fixing" ? request.fix !== null : request.fix === null).toBe(true);
    }
  });

  it("names a review-stage fix as having no deterministic verification", () => {
    expect(verificationForOrigin(WorkflowState.CodeReview)).toBeNull();
    expect(verificationForOrigin(WorkflowState.StaticVerification)).toBe("static");
    expect(verificationForOrigin(WorkflowState.RuntimeVerification)).toBe("runtime");
    expect(workStageForOrigin(WorkflowState.CodeReview)).toBe("code_review");
  });
});

describe("bounded fix attempts", () => {
  it("allows exactly the limit and refuses the attempt after it without invoking the fixer", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await approveScope(harness);

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt += 1) {
      await requestFixFrom(harness, "static_verification");

      const result = await completeFix(harness);

      expect(result).toMatchObject({
        status: "stage_completed",
        stage: "fixing",
        state: WorkflowState.StaticVerification,
      });
      expect(lastRequestFor(harness, "fixing")?.fix).toMatchObject({ attempt });
    }

    // The stage asks for one more repair, and the framework refuses it before the fixer is reached.
    await requestFixFrom(harness, "static_verification");

    const invokedBefore = fixingCalls(harness);
    const refusal = await completeFix(harness);

    expect(refusal).toMatchObject({
      status: "feature_failed",
      stage: "fixing",
      state: WorkflowState.Failed,
      committed: true,
      event: "fail",
      error: { code: "fix_attempts_exhausted", failureClass: "workflow" },
      fix: {
        originStage: WorkflowState.StaticVerification,
        attempt: MAX_FIX_ATTEMPTS + 1,
        maxAttempts: MAX_FIX_ATTEMPTS,
        outcome: "rejected",
      },
    });
    expect(fixingCalls(harness)).toBe(invokedBefore);
    expect(await fixHistory(harness)).toHaveLength(MAX_FIX_ATTEMPTS + 1);
    expect((await fixHistory(harness)).at(-1)).toMatchObject({
      attempt: MAX_FIX_ATTEMPTS + 1,
      outcome: "rejected",
      fixReturnState: WorkflowState.StaticVerification,
    });
  });

  it("counts attempts per origin stage, so one repair loop does not spend another's budget", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await approveScope(harness);
    await requestFixFrom(harness, "static_verification");
    await completeFix(harness);

    expect(
      nextFixAttempt(await fixHistory(harness), WorkflowState.StaticVerification),
    ).toBe(2);
    expect(
      nextFixAttempt(await fixHistory(harness), WorkflowState.RuntimeVerification),
    ).toBe(1);
  });

  it("clamps a limit that would refuse every repair", () => {
    expect(resolveMaxFixAttempts(undefined)).toBe(MAX_FIX_ATTEMPTS);
    expect(resolveMaxFixAttempts(null)).toBe(MAX_FIX_ATTEMPTS);
    expect(resolveMaxFixAttempts(0)).toBe(MAX_FIX_ATTEMPTS);
    expect(resolveMaxFixAttempts(-3)).toBe(MAX_FIX_ATTEMPTS);
    expect(resolveMaxFixAttempts(Number.NaN)).toBe(MAX_FIX_ATTEMPTS);
    expect(resolveMaxFixAttempts(2.5)).toBe(MAX_FIX_ATTEMPTS);
    expect(resolveMaxFixAttempts(1)).toBe(1);
    expect(resolveMaxFixAttempts(9)).toBe(9);
  });
});

describe("what a rejected fix leaves behind", () => {
  async function rejectAfter(
    changes: Partial<WorkspaceChanges>,
    plan: readonly string[] = ["src/**"],
  ): Promise<{ readonly harness: Harness; readonly result: OrchestrationResult }> {
    const box = changeSet();
    const harness = createHarness(await makeRoot(), { changes: box.read });

    await createFeature(harness);
    await approveScope(harness, plan);
    await requestFixFrom(harness, "static_verification");

    harness.executor.configure("fixing", {
      after: () => {
        box.set(changes);
      },
    });

    return { harness, result: await completeFix(harness) };
  }

  it("refuses a fix that edited the verification configuration, and leaves it written", async () => {
    const { harness, result } = await rejectAfter({ modified: ["agent-workflow.config.json"] });

    expect(result).toMatchObject({
      status: "feature_failed",
      state: WorkflowState.Failed,
      committed: true,
      error: { code: "fix_protected_file_touched", failureClass: "workflow" },
      fix: { outcome: "rejected", rejectionCodes: ["fix_protected_file_touched"] },
    });
    // Nothing is restored. The restored paths are the evidence a human is about to be sent to read.
    expect(harness.workspace.enforcements).toEqual([]);
    const history = await fixHistory(harness);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sequence: 1,
      attempt: 1,
      outcome: "rejected",
      changedPaths: ["agent-workflow.config.json"],
    });
    expect(history[0]?.failureSummary).toContain("framework-controlled");
  });

  it("refuses a fix that removed a test file, and leaves it removed", async () => {
    const { harness, result } = await rejectAfter({ deleted: ["src/parser.test.ts"] });

    expect(result).toMatchObject({
      status: "feature_failed",
      error: { code: "fix_check_removed" },
      fix: { rejectionCodes: ["fix_check_removed"] },
    });
    expect(harness.workspace.enforcements).toEqual([]);
    expect(await fixHistory(harness)).toEqual([
      expect.objectContaining({ outcome: "rejected", changedPaths: ["src/parser.test.ts"] }),
    ]);
  });

  it("refuses a fix that renamed a test file out of the runner's way", async () => {
    const { result } = await rejectAfter({
      renamed: [{ from: "tests/parser.test.ts", to: "src/parser-checkpoint.ts" }],
    });

    expect(result).toMatchObject({
      status: "feature_failed",
      error: { code: "fix_check_removed" },
    });
  });

  it("refuses a fix that wrote outside the approved scope, and does not put it back", async () => {
    const { harness, result } = await rejectAfter({ untracked: ["docs/notes.md"] });

    expect(result).toMatchObject({
      status: "feature_failed",
      error: { code: "fix_outside_approved_scope" },
      fix: { rejectionCodes: ["fix_outside_approved_scope"] },
    });
    // The scope check would reverse this path, and does not run: the guard's verdict stands, and a
    // half-reverted attempt would leave a tree the fixer never wrote — a third state, and no evidence.
    expect(harness.workspace.enforcements).toEqual([]);
  });

  it("names every shape of one refusal, not only the first", async () => {
    const { result } = await rejectAfter({
      modified: ["agent-workflow.config.json", "docs/notes.md"],
    });

    expect(result.fix?.rejectionCodes).toEqual([
      "fix_protected_file_touched",
      "fix_outside_approved_scope",
    ]);
    expect(result.error?.message).toContain("further violation");
  });

  it("accepts a fix that stayed inside the approved scope and records what it changed", async () => {
    const box = changeSet();
    const harness = createHarness(await makeRoot(), { changes: box.read });

    await createFeature(harness);
    await approveScope(harness);
    await requestFixFrom(harness, "static_verification");

    harness.executor.configure("fixing", {
      after: () => {
        box.set({ modified: ["src/parser.ts"], added: ["src/token.ts"] });
      },
    });

    const result = await completeFix(harness);

    expect(result).toMatchObject({
      status: "stage_completed",
      stage: "fixing",
      state: WorkflowState.StaticVerification,
    });
    const history = await fixHistory(harness);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      attempt: 1,
      outcome: "accepted",
      failureSummary: null,
      changedPaths: ["src/parser.ts", "src/token.ts"],
    });

    // The digests are checked one at a time rather than with a matcher inside the object literal,
    // because a matcher there would assert on an `any` and would stop being checked at all.
    for (const digest of Object.values(history[0]?.integrity ?? {})) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe("fresh evidence after a fix", () => {
  it("refuses a bundle gathered before the fix it is asked to judge", async () => {
    const stale = createFakeVerificationProvider((request) =>
      // Everything about this bundle is well formed and bound to the request; only its collection time
      // is wrong, which is the part binding cannot see.
      passingEvidenceFor(request, { collectedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const harness = createHarness(await makeRoot(), { verification: () => stale });

    await createFeature(harness);
    await approveScope(harness);
    await requestFixFrom(harness, "static_verification");
    await completeFix(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "static_verification",
      state: WorkflowState.StaticVerification,
      error: { code: "stale_verification_evidence", failureClass: "verification" },
    });
    // The refusal happens before the executor, so no verdict was recorded against the older bundle.
    expect(harness.executor.requestFor("static_verification")?.fixReturnState).toBeNull();
  });

  it("accepts a bundle collected after the fix was recorded", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await approveScope(harness);
    await requestFixFrom(harness, "static_verification");
    await completeFix(harness);

    harness.executor.reset("static_verification");

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({ status: "stage_completed", stage: "static_verification" });
  });
});

describe("the integrity policy, on its own", () => {
  const before: FixIntegritySnapshot = {
    specSha256: "a".repeat(64),
    planSha256: "b".repeat(64),
    planReviewSha256: null,
    verificationConfigSha256: "c".repeat(64),
  };

  const after: FixIntegritySnapshot = { ...before };

  function verdictFor(changes: Partial<WorkspaceChanges>, snapshots = { before, after }) {
    return evaluateFixIntegrity({
      featureId: "F-001",
      originStage: WorkflowState.StaticVerification,
      attempt: 1,
      approvedPatterns: ["src/**"],
      changes: { ...inspectionOf(changes).changes },
      before: snapshots.before,
      after: snapshots.after,
    });
  }

  it("accepts a change set that violates nothing", () => {
    expect(verdictFor({ modified: ["src/parser.ts"] })).toEqual({ ok: true });
  });

  it("refuses a spec, plan, or plan review that moved", () => {
    for (const field of ["specSha256", "planSha256", "planReviewSha256"] as const) {
      const verdict = verdictFor(
        {},
        { before, after: { ...before, [field]: "d".repeat(64) } },
      );

      expect(verdict.ok).toBe(false);

      if (!verdict.ok) {
        expect(verdict.rejections[0].code).toBe("fix_target_modified");
      }
    }
  });

  it("refuses a created artifact as loudly as a rewritten one, because a null is not a digest", () => {
    expect(verdictFor({}, { before, after: { ...before, planReviewSha256: "e".repeat(64) } }).ok).toBe(
      false,
    );
  });

  it("refuses a changed verification configuration under its own code", () => {
    const verdict = verdictFor(
      {},
      { before, after: { ...before, verificationConfigSha256: "f".repeat(64) } },
    );

    if (!verdict.ok) {
      expect(verdict.rejections[0].code).toBe("fix_verification_config_modified");
    }
  });

  it("does not restore, and says so in the message", () => {
    const verdict = verdictFor({ modified: ["agent-workflow.config.json"] });

    if (!verdict.ok) {
      expect(verdict.rejections[0].message).toContain("does not restore them");
    }
  });

  it("classifies check-shaped paths by convention", () => {
    for (const path of ["src/a.test.ts", "spec/models_spec.rb", "pkg/test_data.go", "lib/__tests__/a.js", "tests/run.ts"]) {
      expect(isVerificationCheckPath(path)).toBe(true);
    }

    for (const path of ["src/latest.ts", "src/spectacle.ts", "src/testing.ts"]) {
      expect(isVerificationCheckPath(path)).toBe(false);
    }
  });
});

describe("reading the failure back off disk", () => {
  const section = {
    static_verification: {
      results: [
        { requirementId: "FR-2", acceptanceCriterionId: "AC-2", status: "failed", description: "Rejects malformed input." },
      ],
      findings: [{ filePath: "src/parser.ts" }],
    },
  };

  it("takes the criterion from a recorded failing result rather than guessing one", () => {
    expect(failureTargetFrom(section, "static_verification")).toEqual({
      requirementId: "FR-2",
      acceptanceCriterionId: "AC-2",
      description: "Rejects malformed input.",
    });
    expect(failureTargetFrom({ static_verification: { results: [] } }, "static_verification")).toBeNull();
    expect(failureTargetFrom({}, "static_verification")).toBeNull();
  });

  it("collects the paths the failing stage named", () => {
    expect(suspectedFilesFrom(section, "static_verification")).toEqual(["src/parser.ts"]);
    expect(suspectedFilesFrom({}, "static_verification")).toEqual([]);
  });

  it("prefers the deterministic check over the model's account of it", () => {
    const bundle = {
      checks: [
        {
          id: "lint",
          capability: "lint",
          status: "failed",
          executable: "pnpm",
          args: ["lint"],
          detail: "Two files disagree with the formatter.",
        },
      ],
    } as unknown as VerificationEvidenceBundle;

    const reason = failureReasonFrom(WorkflowState.StaticVerification, bundle, null);

    expect(reason).toContain('"lint" is failed');
    expect(reason).toContain("pnpm lint");
  });

  it("says so when the stage recorded nothing to name", () => {
    const reason = failureReasonFrom(WorkflowState.CodeReview, null, null);

    expect(reason).toContain("named no numbered acceptance criterion");
  });

  it("reports a corrupt evidence record as no evidence rather than trusting it", () => {
    expect(latestRecordedEvidence({ deterministic_evidence: { static_verification: [{}] } }, "static_verification")).toBeNull();
    expect(latestRecordedEvidence("not an artifact", "static_verification")).toBeNull();
    expect(latestRecordedEvidence({}, "static_verification")).toBeNull();
  });

  it("finds the newest fix for one stage and ignores the others", () => {
    const entries = [
      { fixReturnState: WorkflowState.StaticVerification, recordedAt: "2026-04-05T06:07:08.000Z", revisionBefore: 3, revisionAfter: 4, attempt: 1 },
      { fixReturnState: WorkflowState.RuntimeVerification, recordedAt: "2026-04-05T06:07:09.000Z", revisionBefore: 5, revisionAfter: 6, attempt: 1 },
      { fixReturnState: WorkflowState.StaticVerification, recordedAt: "2026-04-05T06:07:10.000Z", revisionBefore: 7, revisionAfter: 8, attempt: 2 },
    ] as unknown as readonly FixHistoryEntry[];

    expect(latestFixEntry(entries, "static_verification")).toMatchObject({ attempt: 2 });
    expect(latestFixEntry(entries, "runtime_verification")).toMatchObject({ attempt: 1 });
    expect(latestFixEntry(entries, "test_verification")).toBeNull();
  });

  it("treats a rejected attempt as the last change for freshness purposes", () => {
    const bundle = { collectedAt: "2026-04-05T06:07:08.000Z", revision: 9, verification: "static" } as unknown as VerificationEvidenceBundle;

    expect(
      staleVerificationEvidence(bundle, {
        recordedAt: "2026-04-05T06:07:08.000Z",
        revisionBefore: 9,
      }),
    ).not.toBeNull();
    expect(
      staleVerificationEvidence(bundle, {
        recordedAt: "2026-04-05T06:07:07.000Z",
        revisionBefore: 8,
      }),
    ).toBeNull();
  });

  it("hashes the recorded verification configuration for the stage that failed", () => {
    const artifact = {
      deterministic_evidence: {
        static_verification: [
          passingEvidenceFor(
            {
              featureId: "F-001",
              stage: "static_verification",
              verification: "static",
              revision: 1,
              projectRoot: "/tmp",
              workspaceId: null,
            },
            { checks: [] },
          ),
        ],
      },
    };

    const digest = verificationConfigurationDigest(artifact, "static_verification");

    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(verificationConfigurationDigest(artifact, "test_verification")).toBeNull();
    expect(verificationConfigurationDigest(undefined, "static_verification")).toBeNull();
  });
});

describe("where a fix is allowed to write", () => {
  it("gives a fix sent back after approval an isolated workspace", () => {
    expect(isApprovalVerifiedStage("fixing", true)).toBe(true);
  });

  it("keeps a fix sent back from plan review read-only, because no plan was approved yet", () => {
    expect(isApprovalVerifiedStage("fixing", false)).toBe(false);
  });

  it("leaves every other stage's answer a property of the stage alone", () => {
    expect(isApprovalVerifiedStage("static_verification", false)).toBe(true);
    expect(isApprovalVerifiedStage("plan_review", true)).toBe(false);
    expect(isApprovalVerifiedStage("planning", true)).toBe(false);
  });

  it("refuses a post-approval fix from a provider that hands back the human's checkout", async () => {
    const root = await makeRoot();
    const harness = createHarness(root);

    await createFeature(harness);
    await approveScope(harness);
    await requestFixFrom(harness, "static_verification");

    // A provider that returns the repository root has not isolated anything. Accepting that for a fix
    // would put the fixer's edits into uncommitted work the framework cannot tell apart from the
    // human's, which is the one thing the workspace layer exists to prevent. The substitution happens
    // after the drive because a provider like this is refused for every post-approval stage, and the
    // point here is what it means for a fixer specifically.
    const inPlace = createHarness(root, {
      workingDirectory: (repositoryRoot) => repositoryRoot,
    });
    const orchestrator = createWorkflowOrchestrator({
      store: harness.store,
      executor: harness.executor,
      verification: harness.verification,
      workspace: inPlace.workspace,
    });

    const result = await orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "workspace_unavailable" },
    });
    expect(result.error?.message).toContain("exactly the isolation this requires");
    expect(fixingCalls(harness)).toBe(0);
    // No attempt was made, so there is nothing to record. Writing an entry for a fixer that never ran
    // would put a line in the audit trail for a repair that never happened.
    expect(await fixHistory(harness)).toHaveLength(0);
  });

  it("refuses a fix outright when nothing could measure what it changed", async () => {
    const root = await makeRoot();
    const store = createFeatureSessionStore(root, { clock: fixedClock });
    const executor = new FakeStageExecutor();
    // No workspace provider, so nothing can read the tree before and after the repair. A fix measured by
    // nobody would be recorded as one that changed nothing, which is the one claim the audit trail must
    // never make on the fixer's behalf.
    const orchestrator = createWorkflowOrchestrator({
      store,
      executor,
      verification: createFakeVerificationProvider(),
    });

    await orchestrator.createFeature({
      featureId: "F-001",
      title: "Fix policy",
      request: "# Request\n\nRepair the reported defects.\n",
    });

    executor.configure("plan_review", {
      outcome: "needs_fix",
      findings: [findingFor("F-001", "the plan needs work")],
    });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const session = await store.load("F-001");

      if (session.machine.state === WorkflowState.PlanReview) {
        break;
      }

      await orchestrator.runNext("F-001");
    }

    const review = await orchestrator.runNext("F-001");

    expect(review).toMatchObject({ status: "fix_requested", state: WorkflowState.Fixing });

    const result = await orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "fixing",
      error: { code: "workspace_not_configured" },
    });
    expect(executor.calls.some((request) => request.stage === "fixing")).toBe(false);
  });

  it("does not charge a human's uncommitted work to a fix that ran before approval", async () => {
    const root = await makeRoot();
    // A fix sent back from plan review runs against whatever the human has in their checkout, which may
    // already contain their uncommitted work. The tree as it looked before the fix ran is the only
    // baseline that can tell that apart from the fix, so the difference between the two — here, nothing,
    // because a pre-approval fix is read-only — is the only thing the fix can be said to have done.
    const box = changeSet();
    const harness = createHarness(root, { changes: box.read });

    await createFeature(harness);
    harness.executor.configure("plan_review", {
      outcome: "needs_fix",
      findings: [findingFor("F-001", "the plan needs work")],
    });

    await driveToState(harness, WorkflowState.PlanReview);

    const review = await harness.orchestrator.runNext("F-001");

    expect(review).toMatchObject({
      status: "fix_requested",
      stage: "plan_review",
      state: WorkflowState.Fixing,
    });

    box.set({ modified: ["src/human-in-progress.ts"] });

    const result = await harness.orchestrator.runNext("F-001");

    expect(lastRequestFor(harness, "fixing")?.workspace.access).toBe("read_only");
    expect(result).toMatchObject({
      status: "stage_completed",
      stage: "fixing",
      state: WorkflowState.PlanReview,
    });

    const history = await fixHistory(harness);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ outcome: "accepted", changedPaths: [] });
  });
});

describe("attempt limits the caller configures", () => {
  it("honours a configured limit instead of the default", async () => {
    const root = await makeRoot();
    const harness = createHarness(root, { maxFixAttempts: 2 });
    await createFeature(harness);
    await approveScope(harness);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await requestFixFrom(harness, "static_verification");
      await completeFix(harness);

      expect(lastRequestFor(harness, "fixing")?.fix).toMatchObject({
        attempt,
        maxAttempts: 2,
      });
    }

    await requestFixFrom(harness, "static_verification");

    const result = await completeFix(harness);

    expect(result).toMatchObject({ status: "feature_failed" });
    expect(fixingCalls(harness)).toBe(2);
    expect(await fixHistory(harness)).toHaveLength(3);
  });
});
