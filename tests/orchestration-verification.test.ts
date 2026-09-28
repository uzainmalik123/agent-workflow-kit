import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  DETERMINISTIC_EVIDENCE_KEY,
  type VerificationCommandEvidence,
  type VerificationEvidenceBundle,
  type VerificationProvider,
  type VerificationRequest,
  type VerificationStage,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore, type FeatureSessionStore } from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

interface Harness {
  readonly store: FeatureSessionStore;
  readonly executor: FakeStageExecutor;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
}

/** What a provider may answer with for one request. */
type BundleAnswer = VerificationEvidenceBundle | Error;

/**
 * A provider that answers with exactly what it is told to and records every request.
 *
 * It returns the bundle verbatim. An earlier version of this fixture patched `verification`,
 * `revision`, and `projectRoot` from the request on the way out, which meant no test could ever
 * present the framework with a bundle belonging to something else. A provider is substitutable and
 * the orchestrator is the thing that has to notice, so the fixture stopped helping.
 */
class RecordingProvider implements VerificationProvider {
  readonly requests: VerificationRequest[] = [];
  readonly #answer: (request: VerificationRequest) => BundleAnswer;

  constructor(answer: (request: VerificationRequest) => BundleAnswer) {
    this.#answer = answer;
  }

  collect(request: VerificationRequest): Promise<VerificationEvidenceBundle> {
    this.requests.push(request);

    const answer = this.#answer(request);

    if (answer instanceof Error) {
      return Promise.reject(answer);
    }

    return Promise.resolve(answer);
  }
}

const FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);

function profileSummary(): VerificationEvidenceBundle["project"] {
  return {
    ecosystem: "node",
    language: "typescript",
    packageManager: "pnpm",
    declaredPackageManager: "pnpm",
    dependenciesInstalled: true,
    frameworks: ["vitest"],
    capabilities: [
      { capability: "lint", status: "applicable", reason: "detected", script: "lint", detail: "A lint script." },
      {
        capability: "typecheck",
        status: "unavailable",
        reason: "script_absent",
        script: null,
        detail: "No typecheck script.",
      },
      { capability: "test", status: "unavailable", reason: "script_absent", script: null, detail: "No test script." },
      { capability: "build", status: "unavailable", reason: "script_absent", script: null, detail: "No build." },
      {
        capability: "runtime",
        status: "unsupported",
        reason: "runtime_deferred",
        script: null,
        detail: "Runtime is deferred.",
      },
    ],
  };
}

/** A passing, check-free bundle bound to the request that asked for it. */
function evidenceFor(
  request: VerificationRequest,
  overrides: Partial<VerificationEvidenceBundle> = {},
): VerificationEvidenceBundle {
  return {
    verification: request.verification,
    outcome: "passed",
    revision: request.revision,
    implementationFingerprint: FINGERPRINT,
    workspace: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
    controlPlane: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
    collectedAt: fixedTimestamp,
    projectRoot: request.projectRoot,
    project: profileSummary(),
    checks: [],
    ...overrides,
  };
}

/** A provider that passes every stage, so a test only has to name the stage it is about. */
function passingProvider(): RecordingProvider {
  return new RecordingProvider((request) => evidenceFor(request));
}

/** A provider that fails one stage and passes the rest. */
function failingStaticProvider(overrides: Partial<VerificationEvidenceBundle> = {}): RecordingProvider {
  return new RecordingProvider((request) =>
    request.verification === "static"
      ? evidenceFor(request, { outcome: "failed", checks: [failedCheck(request)] , ...overrides })
      : evidenceFor(request),
  );
}

function failedCheck(request: VerificationRequest): VerificationCommandEvidence {
  return {
    id: "lint",
    kind: request.verification,
    capability: "lint",
    capabilityStatus: "applicable",
    label: "Lint",
    executable: "pnpm",
    args: ["run", "lint"],
    cwd: request.projectRoot,
    script: "lint",
    startedAt: fixedTimestamp,
    durationMs: 1200,
    exitCode: 2,
    signal: null,
    status: "failed",
    reason: null,
    detail: "pnpm run lint exited 2 after 1200ms.",
    stdoutExcerpt: "",
    stderrExcerpt: "error: 2 problems",
    truncated: false,
    revision: request.revision,
    implementationFingerprint: FINGERPRINT,
  };
}

function skippedRuntimeCheck(request: VerificationRequest): VerificationCommandEvidence {
  return {
    ...failedCheck(request),
    kind: "runtime",
    capability: "runtime",
    capabilityStatus: "unsupported",
    executable: null,
    args: [],
    script: null,
    exitCode: null,
    status: "skipped",
    reason: "runtime_deferred",
    detail: "Runtime verification has no deterministic command yet.",
    stderrExcerpt: "",
  };
}

function makeHarness(
  root: string,
  provider: VerificationProvider | null,
  executor = new FakeStageExecutor(),
): Harness {
  const store = createFeatureSessionStore(root, { clock: () => fixedTimestamp });
  const orchestrator = createWorkflowOrchestrator({
    store,
    executor,
    ...(provider === null ? {} : { verification: provider }),
    projectRoot: root,
  });

  return { store, executor, orchestrator };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-evidence-"));
  roots.push(root);
  return root;
}

/** Drives the feature to the state before the plan approval gate, then approves it. */
async function driveToPlanGate(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Deterministic verification",
    request: "# Request\n\nVerify deterministically.\n",
  });

  for (let step = 0; step < 6; step += 1) {
    await harness.orchestrator.runNext("F-001");
  }

  await harness.orchestrator.approvePlan("F-001");
}

/** Runs the three post-approval stages, so the next `runNext` is the static verification. */
async function runToStaticVerification(harness: Harness): Promise<void> {
  await driveToPlanGate(harness);
  await harness.orchestrator.runNext("F-001");
  await harness.orchestrator.runNext("F-001");
  await harness.orchestrator.runNext("F-001");
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("orchestrator verification integration", () => {
  it("collects no evidence before the plan is approved, and for no other stage", async () => {
    const root = await makeRoot();
    const provider = passingProvider();
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);

    expect(provider.requests).toEqual([]);

    for (const stage of ["implementation", "code_review", "scope_review"] as const) {
      const result = await harness.orchestrator.runNext("F-001");

      expect(result.stage).toBe(stage);
    }

    expect(provider.requests).toEqual([]);
  });

  it("collects the evidence for a verification stage before the stage executor runs", async () => {
    const root = await makeRoot();
    const provider = passingProvider();
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({ status: "stage_completed", stage: "static_verification" });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
    });
    expect(harness.executor.requestFor("static_verification")?.verification?.outcome).toBe("passed");
  });

  it("maps each verification stage to its own evidence stage", async () => {
    const root = await makeRoot();
    const provider = passingProvider();
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);

    for (let step = 0; step < 8; step += 1) {
      const result = await harness.orchestrator.runNext("F-001");

      if (result.status === "stage_completed" && result.stage === "runtime_verification") {
        break;
      }

      if (result.status === "awaiting_human") {
        await harness.orchestrator.approvePlan("F-001");
      }
    }

    expect(provider.requests.map((request) => [request.stage, request.verification])).toEqual([
      ["static_verification", "static"],
      ["test_verification", "test"],
      ["runtime_verification", "runtime"],
    ]);
  });

  it("turns a verifier success into a fix request when the recorded evidence failed", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, failingStaticProvider());

    await runToStaticVerification(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "fix_requested",
      stage: "static_verification",
      state: WorkflowState.Fixing,
      event: "request_fix",
      committed: true,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ featureId: "F-001", severity: "error" });
    expect(result.findings[0]?.message).toContain("pnpm run lint");
    // The finding names the command as it ran, not just the capability that failed.
    expect(result.findings[0]?.message).toContain("exited 2");
  });

  it("turns a verifier success into a fix request when a check was blocked", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      request.verification === "static"
        ? evidenceFor(request, {
            outcome: "blocked",
            checks: [
              {
                ...failedCheck(request),
                status: "blocked",
                exitCode: null,
                reason: "dependency_missing",
                detail: "The project's dependencies are not installed.",
              },
            ],
          })
        : evidenceFor(request),
    );
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "fix_requested",
      state: WorkflowState.Fixing,
    });
  });

  it("refuses a passing bundle when the workspace changed underneath the checks", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      evidenceFor(request, {
        outcome: "failed",
        workspace: { before: FINGERPRINT, after: OTHER_FINGERPRINT, changed: true },
      }),
    );
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({ status: "fix_requested", state: WorkflowState.Fixing });
    expect(result.findings[0]?.message).toContain("working tree changed");
    expect(result.findings[0]?.message).toContain(OTHER_FINGERPRINT);
  });

  it("refuses a passing bundle when the control plane changed underneath the checks", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      evidenceFor(request, {
        outcome: "failed",
        controlPlane: { before: FINGERPRINT, after: OTHER_FINGERPRINT, changed: true },
      }),
    );
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const result = await harness.orchestrator.runNext("F-001");

    // The stage fails and the fixer is handed a finding naming the control plane, rather than the
    // stage advancing as if the run had been clean. The findings are ordered after the workspace ones
    // and before the check ones, and there is no workspace change here, so this is the first.
    expect(result).toMatchObject({ status: "fix_requested", state: WorkflowState.Fixing });
    expect(result.findings[0]?.message).toContain("control plane changed");
    expect(result.findings[0]?.message).toContain(OTHER_FINGERPRINT);
  });

  it("refuses a bundle that claims a passed run while the control plane changed", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      evidenceFor(request, {
        outcome: "passed",
        controlPlane: { before: FINGERPRINT, after: OTHER_FINGERPRINT, changed: true },
      }),
    );
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    // A provider that reports a clean pass over a control plane it knows it changed is one that cannot
    // be believed about either, so the bundle is refused before it is interpreted.
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("verification_evidence_invalid");
    expect(result.error?.message).toContain("control plane");
  });

  it("accepts a verifier failure on evidence that passed, because a reader can see more than a code", async () => {
    const root = await makeRoot();
    const executor = new FakeStageExecutor().configure("static_verification", {
      outcome: "needs_fix",
      findings: [{ featureId: "F-001", severity: "error", message: "The criterion is not met despite a clean run." }],
    });
    const harness = makeHarness(root, passingProvider(), executor);

    await runToStaticVerification(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "fix_requested",
      state: WorkflowState.Fixing,
    });
  });

  it("accepts a deferred runtime stage as completed, because deferral is not failure", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      request.verification === "runtime"
        ? evidenceFor(request, { outcome: "deferred", checks: [skippedRuntimeCheck(request)] })
        : evidenceFor(request),
    );
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);

    for (let step = 0; step < 8; step += 1) {
      const result = await harness.orchestrator.runNext("F-001");

      if (result.status === "stage_completed" && result.stage === "runtime_verification") {
        expect(result.state).toBe(WorkflowState.SecurityReview);
        return;
      }
    }

    throw new Error("The runtime verification stage never completed.");
  });

  it("refuses the stage and writes nothing when the provider itself fails", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      request.verification === "static" ? new Error("the toolchain is missing") : evidenceFor(request),
    );
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const before = await harness.store.load("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.failureClass).toBe("verification");
    expect(result.error?.message).toContain("the toolchain is missing");
    expect(harness.executor.requestFor("static_verification")).toBeUndefined();
    expect(await harness.store.load("F-001")).toEqual(before);
  });

  it("refuses a bundle that contradicts itself instead of acting on it", async () => {
    const root = await makeRoot();
    const provider = failingStaticProvider({ outcome: "passed" });
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const before = await harness.store.load("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.failureClass).toBe("verification");
    expect(result.error?.message).toContain('claims "passed"');
    expect(await harness.store.load("F-001")).toEqual(before);
  });

  it("persists each attempt under a framework-owned key, and never over the model's own section", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, failingStaticProvider());

    await runToStaticVerification(harness);

    const first = await harness.orchestrator.runNext("F-001");

    expect(first.status).toBe("fix_requested");

    // The fixer repairs the code, the stage runs again, and the new attempt is appended.
    await harness.orchestrator.runNext("F-001");

    const second = await harness.orchestrator.runNext("F-001");

    expect(second.status).toBe("fix_requested");

    const artifact = (await harness.store.readArtifact("F-001", "verification")) as Record<string, unknown>;

    expect(Object.keys(artifact)).toContain("static_verification");
    expect(Object.keys(artifact)).toContain(DETERMINISTIC_EVIDENCE_KEY);

    const persisted = artifact[DETERMINISTIC_EVIDENCE_KEY] as {
      readonly static_verification: readonly { readonly checks: readonly unknown[] }[];
    };

    expect(persisted.static_verification).toHaveLength(2);
    expect(persisted.static_verification[0]?.checks[0]).toMatchObject({ exitCode: 2, status: "failed" });
  });
});

describe("failing closed without a provider", () => {
  it("refuses a verification stage rather than passing it on the verifier's word", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, null);

    await runToStaticVerification(harness);

    const before = await harness.store.load("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "static_verification",
      failureClass: "verification",
      committed: false,
    });
    expect(result.error?.code).toBe("verification_not_configured");
    expect(result.error?.message).toContain("rather than passed on the verifier's word");
    expect(await harness.store.load("F-001")).toEqual(before);
  });

  it("never calls the verifier executor, so there is no opinion to believe", async () => {
    const root = await makeRoot();
    const executor = new FakeStageExecutor().configure("static_verification", {
      outcome: "success",
      artifacts: [
        {
          name: "verification",
          content: { featureId: "F-001", stage: "static_verification", kind: "static", results: [] },
        },
      ],
    });
    const harness = makeHarness(root, null, executor);

    await runToStaticVerification(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(executor.requestFor("static_verification")).toBeUndefined();
    await expect(harness.store.readArtifact("F-001", "verification")).rejects.toThrow(
      /does not exist/iu,
    );
  });

  it("changes nothing at all, so the stage can be retried once a provider exists", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, null);

    await runToStaticVerification(harness);

    const before = await harness.store.load("F-001");
    const first = await harness.orchestrator.runNext("F-001");
    const second = await harness.orchestrator.runNext("F-001");

    expect(first.error?.code).toBe("verification_not_configured");
    expect(second.error?.code).toBe("verification_not_configured");
    expect(await harness.store.load("F-001")).toEqual(before);
  });

  it("still runs every stage before the first verification stage, so the option can stay optional", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, null);

    await harness.orchestrator.createFeature({
      featureId: "F-001",
      title: "No provider yet",
      request: "# Request\n\nPlan only.\n",
    });

    const stages: string[] = [];

    for (let step = 0; step < 6; step += 1) {
      const result = await harness.orchestrator.runNext("F-001");

      if (result.stage !== null) {
        stages.push(result.stage);
      }
    }

    expect(stages).toEqual(["grill", "planning", "plan_review"]);
  });
});

describe("binding evidence to the request that asked for it", () => {
  /**
   * Each case below is a bundle that passes every structural rule and is nonetheless about something
   * other than the stage about to run. None may reach the verifier, and none may write anything.
   */
  const hostile: readonly {
    readonly name: string;
    readonly answer: (request: VerificationRequest) => VerificationEvidenceBundle;
    readonly expected: string;
    readonly code?: string;
  }[] = [
    {
      name: "evidence from a revision that has already been superseded",
      answer: (request) => evidenceFor(request, { revision: request.revision - 1 }),
      expected: "an earlier revision",
    },
    {
      name: "evidence from a revision that has not happened yet",
      answer: (request) => evidenceFor(request, { revision: request.revision + 1 }),
      expected: "a later revision",
    },
    {
      name: "evidence for another repository",
      answer: (request) => evidenceFor(request, { projectRoot: join(request.projectRoot, "..", "elsewhere") }),
      expected: "may only verify",
    },
    {
      name: "evidence for another verification stage",
      answer: (request) => evidenceFor(request, { verification: request.verification === "static" ? "test" : "static" }),
      expected: "evidence for the",
    },
    {
      name: "a check that disagrees with its own bundle about the revision",
      answer: (request) =>
        evidenceFor(request, {
          outcome: "failed",
          checks: [{ ...failedCheck(request), revision: request.revision + 3 }],
        }),
      expected: "claims revision",
    },
    {
      name: "a check that disagrees with its own bundle about the fingerprint",
      answer: (request) =>
        evidenceFor(request, {
          outcome: "failed",
          checks: [{ ...failedCheck(request), implementationFingerprint: OTHER_FINGERPRINT }],
        }),
      expected: "claims fingerprint",
    },
    {
      name: "a check that reports itself as another kind",
      answer: (request) =>
        evidenceFor(request, {
          outcome: "failed",
          checks: [{ ...failedCheck(request), kind: request.verification === "static" ? "test" : "static" }],
        }),
      // The structural validator catches this one before the identity check, because a check whose
      // `kind` disagrees with the bundle it is inside is already a malformed record.
      code: "verification_evidence_invalid",
      expected: "does not belong to the",
    },
  ];

  for (const scenario of hostile) {
    it(`refuses ${scenario.name}`, async () => {
      const root = await makeRoot();
      const provider = new RecordingProvider(scenario.answer);
      const harness = makeHarness(root, provider);

      await runToStaticVerification(harness);

      const before = await harness.store.load("F-001");
      const result = await harness.orchestrator.runNext("F-001");

      expect(result.status).toBe("rejected");
      expect(result.error?.code).toBe(scenario.code ?? "verification_evidence_mismatch");
      expect(result.error?.message).toContain(scenario.expected);
      expect(harness.executor.requestFor("static_verification")).toBeUndefined();
      expect(await harness.store.load("F-001")).toEqual(before);
    });
  }

  it("accepts a bundle whose project root is the same directory spelled differently", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      evidenceFor(request, { projectRoot: `${request.projectRoot}/./` }),
    );
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({ status: "stage_completed" });
  });

  it("refuses a bundle with no control-plane measurement at all", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) => {
      const withoutControlPlane: Record<string, unknown> = { ...evidenceFor(request) };

      delete withoutControlPlane["controlPlane"];

      return withoutControlPlane as unknown as VerificationEvidenceBundle;
    });
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const result = await harness.orchestrator.runNext("F-001");

    // A provider that measures nothing cannot report that nothing moved, so this is missing evidence
    // rather than a pass.
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("verification_evidence_invalid");
    expect(result.error?.message).toContain("control-plane measurement");
  });

  it("refuses a bundle whose control-plane claim contradicts its own hashes", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      evidenceFor(request, {
        controlPlane: { before: FINGERPRINT, after: OTHER_FINGERPRINT, changed: false },
      }),
    );
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("verification_evidence_invalid");
    expect(result.error?.message).toContain("claims changed=false");
  });

  it("refuses a bundle whose workspace claim contradicts its own hashes", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider((request) =>
      evidenceFor(request, {
        workspace: { before: FINGERPRINT, after: OTHER_FINGERPRINT, changed: false },
      }),
    );
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("verification_evidence_invalid");
    expect(result.error?.message).toContain("claims changed=false");
  });
});

describe("evidence freshness after a fix", () => {
  it("re-runs the commands after a repair, at a new revision and against a new fingerprint", async () => {
    const root = await makeRoot();
    const runs: VerificationRequest[] = [];
    const provider = new RecordingProvider((request) => {
      runs.push(request);

      // The first attempt failed against the tree as it was. The fixer changes a source file, so the
      // second attempt measures a different implementation and the provider says so with a new digest.
      const repaired = runs.length > 1;
      const fingerprint = repaired ? OTHER_FINGERPRINT : FINGERPRINT;

      return repaired
        ? evidenceFor(request, { implementationFingerprint: fingerprint, workspace: { before: fingerprint, after: fingerprint, changed: false } })
        : evidenceFor(request, { outcome: "failed", checks: [failedCheck(request)] });
    });
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    const first = await harness.orchestrator.runNext("F-001");

    expect(first.status).toBe("fix_requested");
    expect(first.verification?.implementationFingerprint).toBe(FINGERPRINT);

    // The fixer repairs the source. Nothing the old evidence recorded applies to the new tree.
    await harness.orchestrator.runNext("F-001");

    expect(harness.executor.requestFor("fixing")?.fixReturnState).toBe(WorkflowState.StaticVerification);

    const second = await harness.orchestrator.runNext("F-001");

    expect(second.status).toBe("stage_completed");
    expect(second.verification?.implementationFingerprint).toBe(OTHER_FINGERPRINT);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.revision).toBeGreaterThan(runs[0]?.revision ?? 0);
  });

  it("cannot satisfy the stage with the attempt it already recorded", async () => {
    const root = await makeRoot();
    let answerCount = 0;
    const provider = new RecordingProvider((request) => {
      answerCount += 1;

      // A provider that tried to replay a stored bundle would have to reuse the old revision, which
      // is exactly the case the identity check refuses.
      return answerCount === 1
        ? evidenceFor(request, { outcome: "failed", checks: [failedCheck(request)] })
        : evidenceFor(request, { revision: 1, checks: [failedCheck(request)], outcome: "failed" });
    });
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({ status: "fix_requested" });

    await harness.orchestrator.runNext("F-001");

    const replayed = await harness.orchestrator.runNext("F-001");

    expect(replayed.status).toBe("rejected");
    expect(replayed.error?.code).toBe("verification_evidence_mismatch");
  });

  it("runs exactly one stage per call, refusals included", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, null);

    await runToStaticVerification(harness);

    const before = await harness.store.load("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.executedStages).toEqual([]);
    expect(result.committed).toBe(false);
    expect(await harness.store.load("F-001")).toEqual(before);

    // The session is still sitting in the state that expects a static verification, not one stage on.
    expect((await harness.store.load("F-001")).machine.state).toBe(WorkflowState.StaticVerification);
  });
});

describe("stage coverage", () => {
  it("names every stage it collected, so a wiring mistake is visible in the result", async () => {
    const root = await makeRoot();
    const provider = passingProvider();
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);

    for (let step = 0; step < 8; step += 1) {
      const result = await harness.orchestrator.runNext("F-001");

      if (result.stage !== null && result.verification !== null) {
        expect(result.verification.verification).toBe(
          result.stage === "static_verification"
            ? "static"
            : result.stage === "test_verification"
              ? "test"
              : "runtime",
        );
      }
    }

    expect(provider.requests.map((request) => request.verification)).toEqual(["static", "test", "runtime"]);
  });
});

describe("the provider interface is what the framework requires", () => {
  it("states the stage, the revision, and the root in the request it hands over", async () => {
    const root = await makeRoot();
    const provider = passingProvider();
    const harness = makeHarness(root, provider);

    await runToStaticVerification(harness);
    await harness.orchestrator.runNext("F-001");

    expect(provider.requests[0]).toMatchObject({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      projectRoot: root,
    });
    expect(typeof provider.requests[0]?.revision).toBe("number");
  });

  it("hands the collected bundle to the verifier, workspace measurement included", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, passingProvider());

    await runToStaticVerification(harness);
    await harness.orchestrator.runNext("F-001");

    const delivered = harness.executor.requestFor("static_verification")?.verification;

    expect(delivered?.workspace).toEqual({ before: FINGERPRINT, after: FINGERPRINT, changed: false });
  });
});

const STAGE_NAMES: readonly VerificationStage[] = ["static", "test", "runtime"];

describe("every stage is verified the same way", () => {
  it("collects one bundle per stage, in workflow order", async () => {
    const root = await makeRoot();
    const provider = passingProvider();
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);

    for (let step = 0; step < 8; step += 1) {
      const result = await harness.orchestrator.runNext("F-001");

      if (result.status === "stage_completed" && result.stage === "runtime_verification") {
        break;
      }
    }

    expect(provider.requests.map((request) => request.verification)).toEqual(STAGE_NAMES);
  });
});
