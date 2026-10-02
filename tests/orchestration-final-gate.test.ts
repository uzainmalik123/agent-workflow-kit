import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  criterionClaimsFrom,
  criteriaFromSpec,
  evaluateFinalGate,
  MAX_FINAL_GATE_CRITERIA,
  type FinalGateCriterionInput,
  type FinalGateFixInput,
  type FinalGateInput,
  type FinalGateResult,
  type OrchestrationResult,
  type SecurityReviewEvidence,
  type VerificationEvidenceBundle,
  type VerificationStage,
  type WorkStage,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore, type FeatureSessionStore } from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import {
  createFakeVerificationProvider,
  passingEvidenceFor,
} from "../fixtures/verification-provider.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeWorkspaceProvider, type FakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The final gate, on both sides.
 *
 * Most of this file tests the pure evaluator, because that is where the gate's decisions live and
 * because a pure function is the only version of a check whose behaviour can be enumerated: every
 * assertion below is one requirement about what must not satisfy the gate, written as the case that
 * must not pass. The last two tests are the orchestration half — that the gate runs before the
 * summarizer's agent, that a refusal commits nothing, and that a passing gate carries its answer
 * forward.
 */

const COLLECTED_AT = "2026-04-05T06:07:08.000Z";
const TREE = "a".repeat(64);
const OTHER_TREE = "b".repeat(64);
const roots: string[] = [];

const STAGE_FOR: Readonly<Record<VerificationStage, WorkStage>> = {
  static: "static_verification",
  test: "test_verification",
  runtime: "runtime_verification",
};

function bundle(
  verification: VerificationStage,
  overrides: Partial<VerificationEvidenceBundle> = {},
): VerificationEvidenceBundle {
  return passingEvidenceFor(
    {
      featureId: "F-001",
      stage: STAGE_FOR[verification],
      verification,
      revision: 10,
      projectRoot: "/repo",
      workspaceId: "workspace-1",
    },
    overrides,
  );
}

function securityEvidence(overrides: Partial<SecurityReviewEvidence> = {}): SecurityReviewEvidence {
  return {
    schemaVersion: 1,
    featureId: "F-001",
    stage: "security_review",
    status: "pass",
    revision: 11,
    workspaceFingerprint: TREE,
    projectRoot: "/repo",
    workspaceId: "workspace-1",
    approvedPatterns: [],
    changedPaths: [],
    checks: [],
    collectedAt: COLLECTED_AT,
    ...overrides,
  };
}

function passingInput(): FinalGateInput {
  return {
    featureId: "F-001",
    state: WorkflowState.FinalGate,
    revision: 12,
    fingerprint: TREE,
    criteria: [],
    verification: (["static", "test", "runtime"] as const).map((verification) => ({
      stage: STAGE_FOR[verification],
      verification,
      bundle: bundle(verification),
      fix: null,
      configurationChanged: false,
      claims: [],
    })),
    security: { evidence: securityEvidence(), fix: null },
    scope: {
      basis: "measured",
      insideApprovedScope: true,
      integrityOk: true,
      fingerprint: TREE,
      unauthorizedPaths: [],
      reason: "The change set is inside the approved scope.",
    },
    approval: { status: "intact", reason: "Digests re-verified." },
    fix: { attempts: 0, latest: null },
  };
}

/** Replaces one verification stage's whole input, so each test states only what it is about. */
function withStage(
  input: FinalGateInput,
  verification: VerificationStage,
  stage: Partial<FinalGateInput["verification"][number]>,
): FinalGateInput {
  return {
    ...input,
    verification: input.verification.map((entry) =>
      entry.verification === verification ? { ...entry, ...stage } : entry,
    ),
  };
}

function codes(result: FinalGateResult): readonly string[] {
  return result.blockers.map((blocker) => blocker.code);
}

function routes(result: FinalGateResult): readonly string[] {
  return result.blockers.map((blocker) => blocker.route);
}

describe("the final gate on complete, fresh evidence", () => {
  it("passes and reports every surface it measured", () => {
    const result = evaluateFinalGate(passingInput());

    expect(result).toMatchObject({
      schemaVersion: 1,
      featureId: "F-001",
      status: "passed",
      state: WorkflowState.FinalGate,
      revision: 12,
      fingerprint: TREE,
      verification: "passed",
      security: "pass",
      scope: "clean",
      approval: "intact",
      fixer: "none",
      blockers: [],
      route: "final_gate",
    });
    expect(result.verificationStages.map((stage) => stage.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("decides the same way twice, and the same way whatever order the evidence arrived in", () => {
    const input = passingInput();

    expect(evaluateFinalGate(input)).toEqual(evaluateFinalGate(input));
    expect(evaluateFinalGate({ ...input, verification: [...input.verification].reverse() })).toEqual(
      evaluateFinalGate(input),
    );
  });

  it("names where each decision came from, without restating any of them", () => {
    const result = evaluateFinalGate(passingInput());

    expect(result.evidence.map((reference) => reference.kind)).toEqual([
      "approval",
      "specification",
      "verification",
      "verification",
      "verification",
      "security",
      "scope",
      "fixes",
    ]);
    expect(result.evidence.every((reference) => reference.reference.length > 0)).toBe(true);
  });

  it("reports the criteria the approved specification declares", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      criteria: [
        { requirementId: "REQ-1", acceptanceCriterionId: "AC-1" },
        { requirementId: "REQ-1", acceptanceCriterionId: "AC-2" },
        { requirementId: "REQ-2", acceptanceCriterionId: "AC-1" },
      ],
    });

    expect(result.requirementIds).toEqual(["REQ-1", "REQ-2"]);
    expect(result.acceptanceCriterionIds).toEqual(["AC-1", "AC-2"]);
    expect(result.criteria.every((criterion) => criterion.status === "passed")).toBe(true);
  });
});

describe("verification evidence that may not satisfy the gate", () => {
  it("refuses a stage whose bundle is a failure", () => {
    const result = evaluateFinalGate(
      withStage(passingInput(), "test", { bundle: bundle("test", { outcome: "failed" }) }),
    );

    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(["verification_failed"]);
    expect(routes(result)).toEqual(["test_verification"]);
    expect(result.route).toBe("test_verification");
  });

  it("refuses a stage that measured nothing, as inconclusive rather than as a failure", () => {
    const result = evaluateFinalGate(
      withStage(passingInput(), "static", { bundle: bundle("static", { outcome: "deferred" }) }),
    );

    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["verification_inconclusive"]);
    expect(result.verification).toBe("inconclusive");
  });

  it("refuses a stage with no bundle at all, and a stage the caller did not describe", () => {
    const missing = evaluateFinalGate(withStage(passingInput(), "runtime", { bundle: null }));

    expect(missing.status).toBe("failed");
    expect(codes(missing)).toEqual(["verification_evidence_missing"]);
    expect(routes(missing)).toEqual(["runtime_verification"]);

    const absent = evaluateFinalGate({
      ...passingInput(),
      verification: passingInput().verification.slice(0, 2),
    });

    expect(absent.status).toBe("failed");
    expect(codes(absent)).toEqual(["verification_evidence_missing"]);
    expect(absent.verificationStages).toHaveLength(3);
    expect(absent.verificationStages[2]).toMatchObject({
      stage: "runtime_verification",
      status: "missing",
      revision: null,
      fingerprint: null,
    });
  });

  it("refuses evidence collected before the fix it was meant to re-test", () => {
    const result = evaluateFinalGate(
      withStage(passingInput(), "runtime", {
        bundle: bundle("runtime", { revision: 10 }),
        fix: {
          originStage: WorkflowState.RuntimeVerification,
          attempt: 1,
          maxAttempts: 3,
          recordedAt: "2026-04-05T07:00:00.000Z",
          revisionBefore: 11,
        },
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["verification_evidence_stale"]);
    expect(routes(result)).toEqual(["runtime_verification"]);
  });

  it("refuses evidence for a different tree than the newest measurement", () => {
    const result = evaluateFinalGate(
      withStage(passingInput(), "static", {
        bundle: bundle("static", { revision: 9, implementationFingerprint: OTHER_TREE }),
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["verification_evidence_stale"]);
    expect(result.verification).toBe("stale");
  });

  it("refuses evidence whose checks are not the ones the fix was measured against", () => {
    const result = evaluateFinalGate(
      withStage(passingInput(), "static", {
        configurationChanged: true,
        fix: {
          originStage: WorkflowState.StaticVerification,
          attempt: 1,
          maxAttempts: 3,
          recordedAt: "2026-04-05T05:00:00.000Z",
          revisionBefore: 9,
        },
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["verification_configuration_changed"]);
  });

  it("reports the worst stage when several are undecided", () => {
    const input = withStage(passingInput(), "static", { bundle: null });
    const result = evaluateFinalGate(
      withStage(input, "runtime", { bundle: bundle("runtime", { outcome: "deferred" }) }),
    );

    expect(result.verification).toBe("missing");
    expect(result.verificationStages.map((stage) => stage.status)).toEqual([
      "missing",
      "passed",
      "inconclusive",
    ]);
    // The route is the earliest stage whose work would produce the missing evidence, because that is
    // the one that produces a repair rather than a dead end.
    expect(result.route).toBe("static_verification");
  });

  it("withholds a criterion a stage reported as failed, without contradicting the stage verdict", () => {
    const result = evaluateFinalGate(
      withStage(passingInput(), "test", {
        claims: [
          { requirementId: "REQ-1", acceptanceCriterionId: "AC-1", status: "failed" },
          { requirementId: "REQ-1", acceptanceCriterionId: "AC-2", status: "inconclusive" },
        ],
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["criterion_reported_failed"]);
  });

  it("leaves an inconclusive or passing claim with nothing to do", () => {
    const result = evaluateFinalGate(
      withStage(passingInput(), "test", {
        claims: [
          { requirementId: "REQ-1", acceptanceCriterionId: "AC-1", status: "inconclusive" },
          { requirementId: "REQ-1", acceptanceCriterionId: "AC-2", status: "passed" },
        ],
      }),
    );

    expect(result.status).toBe("passed");
    expect(result.blockers).toEqual([]);
  });
});

describe("the other surfaces the gate measures", () => {
  it("refuses a feature with no security record", () => {
    const result = evaluateFinalGate({ ...passingInput(), security: { evidence: null, fix: null } });

    expect(result.status).toBe("failed");
    expect(result.security).toBe("missing");
    expect(codes(result)).toEqual(["security_evidence_missing"]);
  });

  it("refuses a security record that could not be decided", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      security: { evidence: securityEvidence({ status: "inconclusive" }), fix: null },
    });

    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["security_inconclusive"]);
  });

  it("refuses a security finding", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      security: { evidence: securityEvidence({ status: "fail" }), fix: null },
    });

    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(["security_not_passed"]);
  });

  it("refuses a security record from before the fix that followed it", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      security: {
        evidence: securityEvidence({ collectedAt: COLLECTED_AT }),
        fix: {
          originStage: WorkflowState.SecurityReview,
          attempt: 1,
          maxAttempts: 3,
          recordedAt: "2026-04-06T00:00:00.000Z",
          revisionBefore: 12,
        },
      },
    });

    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["security_evidence_stale"]);
    expect(result.security).toBe("stale");
  });

  it("treats a tree that moved after the security review as a hard failure", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      security: { evidence: securityEvidence({ workspaceFingerprint: OTHER_TREE }), fix: null },
    });

    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(["security_evidence_stale", "working_tree_changed"]);
    expect(result.route).toBe("security_review");
  });

  it("does not call the tree unmoved when nothing could measure it", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      fingerprint: "",
      security: { evidence: securityEvidence(), fix: null },
    });

    expect(codes(result)).not.toContain("working_tree_changed");
  });

  it("refuses a change set outside the approved scope, naming the paths", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      scope: {
        basis: "measured",
        insideApprovedScope: false,
        integrityOk: true,
        fingerprint: TREE,
        unauthorizedPaths: ["src/other.ts"],
        reason: "Two paths are not in the plan.",
      },
    });

    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(["scope_outside_approved_scope"]);
    expect(result.blockers[0]?.message).toContain("src/other.ts");
  });

  it("refuses a change set nobody could measure, but not a project that measures none", () => {
    const unmeasurable = evaluateFinalGate({
      ...passingInput(),
      scope: {
        basis: "unmeasurable",
        insideApprovedScope: false,
        integrityOk: false,
        fingerprint: null,
        unauthorizedPaths: [],
        reason: "The workspace could not be inspected.",
      },
    });

    expect(unmeasurable.status).toBe("failed");
    expect(codes(unmeasurable)).toEqual(["scope_not_measured"]);
    expect(unmeasurable.route).toBe("escalate");

    const noneToMeasure = evaluateFinalGate({
      ...passingInput(),
      scope: {
        basis: "not_measured",
        insideApprovedScope: true,
        integrityOk: true,
        fingerprint: TREE,
        unauthorizedPaths: [],
        reason: "No isolated workspace is configured.",
      },
    });

    expect(noneToMeasure.status).toBe("passed");
    expect(noneToMeasure.scope).toBe("not_applicable");
  });

  it("refuses a scope measurement from a tree that no longer exists", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      scope: {
        basis: "measured",
        insideApprovedScope: true,
        integrityOk: true,
        fingerprint: OTHER_TREE,
        unauthorizedPaths: [],
        reason: "Measured earlier.",
      },
    });

    expect(result.status).toBe("inconclusive");
    expect(codes(result)).toEqual(["scope_stale"]);
  });

  it("refuses a feature whose approved artifacts moved, or whose approval is gone", () => {
    const invalidated = evaluateFinalGate({
      ...passingInput(),
      approval: { status: "invalidated", reason: "plan.json no longer hashes to the approved digest." },
    });

    expect(invalidated.status).toBe("failed");
    expect(codes(invalidated)).toEqual(["approval_invalidated"]);
    expect(invalidated.route).toBe("plan_review");

    const missing = evaluateFinalGate({
      ...passingInput(),
      approval: { status: "missing", reason: "The session has no approval record." },
    });

    expect(missing.status).toBe("failed");
    expect(codes(missing)).toEqual(["approval_missing"]);
  });

  it("refuses a feature whose repair loop spent its last attempt", () => {
    const result = evaluateFinalGate({
      ...passingInput(),
      fix: {
        attempts: 3,
        latest: {
          originStage: WorkflowState.RuntimeVerification,
          attempt: 3,
          maxAttempts: 3,
          recordedAt: COLLECTED_AT,
          revisionBefore: 11,
        },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.fixer).toBe("exhausted");
    expect(codes(result)).toEqual(["fix_attempts_exhausted"]);
    expect(result.route).toBe("escalate");
  });

  it("says whether the repair was re-tested, which is the question a stuck feature is asked", () => {
    const fix: FinalGateFixInput = {
      originStage: WorkflowState.RuntimeVerification,
      attempt: 1,
      maxAttempts: 3,
      recordedAt: "2026-04-05T05:00:00.000Z",
      revisionBefore: 9,
    };
    const repaired = {
      ...passingInput(),
      verification: passingInput().verification.map((stage) =>
        stage.verification === "runtime" ? { ...stage, fix } : stage,
      ),
      fix: { attempts: 1, latest: fix },
    };

    expect(evaluateFinalGate(repaired).fixer).toBe("reverified");

    // Same evidence, no re-test since the repair: the tree changed, so the runtime record no longer
    // describes it, and the gate says so rather than reporting the repair as verified.
    const stale = {
      ...repaired,
      verification: repaired.verification.map((stage) =>
        stage.verification === "runtime"
          ? { ...stage, bundle: bundle("runtime", { revision: 9, collectedAt: "2026-04-05T04:00:00.000Z" }) }
          : stage,
      ),
    };

    expect(evaluateFinalGate(stale).fixer).toBe("unreverified");
  });

  it("refuses to answer for a feature that is not at the gate", () => {
    const result = evaluateFinalGate({ ...passingInput(), state: WorkflowState.SecurityReview });

    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(["workflow_state_inconsistent"]);
    expect(result.route).toBe("escalate");
  });
});

describe("reading what a stage recorded", () => {
  it("takes acceptance criteria only from a structured specification", () => {
    expect(
      criteriaFromSpec({
        requirements: [
          {
            id: "REQ-1",
            acceptanceCriteria: [{ id: "AC-1", text: "It signs in." }, { id: "AC-2" }],
          },
          { id: "REQ-2" },
          { title: "no id at all", acceptanceCriteria: [{ id: "AC-9" }] },
          "not an object",
        ],
      }),
    ).toEqual([
      { requirementId: "REQ-1", acceptanceCriterionId: "AC-1" },
      { requirementId: "REQ-1", acceptanceCriterionId: "AC-2" },
    ]);
  });

  it("takes nothing from a specification written as prose, rather than refusing the whole feature", () => {
    expect(criteriaFromSpec({ objective: "Sign users in.", requirements: "The user can sign in." })).toEqual([]);
    expect(criteriaFromSpec("# Spec\n\nThe user can sign in.\n")).toEqual([]);
    expect(criteriaFromSpec(null)).toEqual([]);
  });

  it("reads one stage's own results, and skips anything that is not one", () => {
    const artifact = {
      static_verification: {
        results: [
          { requirementId: "REQ-1", acceptanceCriterionId: "AC-1", status: "failed" },
          { requirementId: "REQ-2", status: "inconclusive" },
          { requirementId: "REQ-3", status: "probably" },
          { status: "passed" },
          "not an object",
        ],
      },
      test_verification: { results: [{ requirementId: "REQ-9", status: "passed" }] },
    };

    expect(criterionClaimsFrom(artifact, "static_verification")).toEqual([
      { requirementId: "REQ-1", acceptanceCriterionId: "AC-1", status: "failed" },
      { requirementId: "REQ-2", acceptanceCriterionId: null, status: "inconclusive" },
    ]);
    expect(criterionClaimsFrom(artifact, "test_verification")).toEqual([
      { requirementId: "REQ-9", acceptanceCriterionId: null, status: "passed" },
    ]);
    expect(criterionClaimsFrom(artifact, "runtime_verification")).toEqual([]);
    expect(criterionClaimsFrom(undefined, "static_verification")).toEqual([]);
  });

  it("bounds the criteria it reports without hiding how many there were", () => {
    const criteria: FinalGateCriterionInput[] = Array.from({ length: 60 }, (_unused, index) => ({
      requirementId: `REQ-${String(index)}`,
      acceptanceCriterionId: `AC-${String(index)}`,
    }));

    const result = evaluateFinalGate({ ...passingInput(), criteria });

    expect(result.criteria).toHaveLength(MAX_FINAL_GATE_CRITERIA);
    expect(result.criterionCount).toBe(60);
    expect(result.criteriaTruncated).toBe(true);
    expect(result.acceptanceCriterionIds).toHaveLength(60);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The gate inside the workflow                                                                    */
/* --------------------------------------------------------------------------------------------- */

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly workspace: FakeWorkspaceProvider;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
  /** Flipped by a test to make the tree move underneath the recorded evidence. */
  readonly tree: { moved: boolean };
}

function fixedClock(): string {
  return COLLECTED_AT;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-final-gate-"));
  roots.push(root);
  return root;
}

function createHarness(root: string): Harness {
  const store = createFeatureSessionStore(root, { clock: fixedClock });
  const executor = new FakeStageExecutor();
  const tree = { moved: false };
  const workspace = createFakeWorkspaceProvider({
    changes: () => (tree.moved ? { untracked: ["src/written-after-security.ts"] } : {}),
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

async function driveToState(harness: Harness, target: WorkflowState): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const session = await harness.store.load("F-001");

    if (session.machine.state === target) {
      return;
    }

    if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
      await harness.orchestrator.approvePlan("F-001");
      continue;
    }

    const result = await harness.orchestrator.runNext("F-001");

    if (result.status === "awaiting_human" && result.state === WorkflowState.AwaitingPlanApproval) {
      await harness.orchestrator.approvePlan("F-001");
    }
  }

  throw new Error(`The workflow never reached "${target}".`);
}

async function createFeature(harness: Harness): Promise<OrchestrationResult> {
  return harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Google OAuth / API",
    request: "# Request\n\nSign users in with Google.\n",
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("the final gate inside the workflow", () => {
  it("certifies a feature whose evidence is complete and carries the answer forward", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await driveToState(harness, WorkflowState.FinalGate);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "stage_completed",
      stage: "final_gate",
      role: "final_gate_reviewer",
      state: WorkflowState.FinalSummary,
      committed: true,
    });
    expect(result.finalGate).toMatchObject({
      status: "passed",
      verification: "passed",
      security: "pass",
      scope: "clean",
      approval: "intact",
      blockers: [],
    });
  });

  it("refuses a feature whose tree moved after the last deterministic check, without running anything", async () => {
    const harness = createHarness(await makeRoot());

    await createFeature(harness);
    await driveToState(harness, WorkflowState.FinalGate);

    const enforced = harness.workspace.enforcements.length;

    harness.tree.moved = true;

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "stage_failed",
      stage: "final_gate",
      fromState: WorkflowState.FinalGate,
      state: WorkflowState.FinalGate,
      executedStages: [],
      committed: false,
      artifacts: [],
    });
    expect(result.error?.code).toBe("final_gate_blocked");
    expect(result.finalGate?.blockers.map((blocker) => blocker.code)).toContain("working_tree_changed");
    expect(result.finalGate?.blockers.map((blocker) => blocker.code)).toContain(
      "scope_outside_approved_scope",
    );
    // Both stages' records predate the move, and the route names the earliest one: re-running
    // `scope_review` is what has to happen before any of the rest describes this tree.
    expect(result.finalGate?.route).toBe("scope_review");

    // The gate did not run the summarizer's agent, and it did not restore the path that decided it:
    // a gate that deleted the evidence of a scope violation while explaining it would leave the next
    // run with nothing to find.
    expect(harness.executor.executedStages).not.toContain("final_gate");
    expect(harness.workspace.enforcements).toHaveLength(enforced);
    expect((await harness.store.load("F-001")).machine.state).toBe(WorkflowState.FinalGate);
  });
});