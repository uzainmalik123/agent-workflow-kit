import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  DETERMINISTIC_EVIDENCE_KEY,
  type VerificationEvidenceBundle,
  type VerificationProvider,
  type VerificationStage,
  type VerificationRequest,
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

/**
 * A provider that returns whatever it is told to return and records every request.
 *
 * It exists to test the orchestration contract rather than the project adapter: that the evidence is
 * collected after approval and before the stage runs, that it reaches the verifier, and that a bundle
 * the framework cannot verify is refused rather than trusted.
 */
class RecordingProvider implements VerificationProvider {
  readonly requests: VerificationRequest[] = [];
  readonly #bundles: Readonly<Partial<Record<VerificationStage, VerificationEvidenceBundle | Error>>>;

  constructor(bundles: Readonly<Partial<Record<VerificationStage, VerificationEvidenceBundle | Error>>>) {
    this.#bundles = bundles;
  }

  collect(request: VerificationRequest): Promise<VerificationEvidenceBundle> {
    this.requests.push(request);

    const bundle = this.#bundles[request.verification];

    if (bundle === undefined) {
      return Promise.reject(new Error(`no bundle configured for ${request.verification}`));
    }

    if (bundle instanceof Error) {
      return Promise.reject(bundle);
    }

    return Promise.resolve({
      ...bundle,
      verification: request.verification,
      revision: request.revision,
      projectRoot: request.projectRoot,
    });
  }
}

/** A passing, check-free bundle for every stage, so a test only names the stage it is about. */
function passingStages(): Record<VerificationStage, VerificationEvidenceBundle> {
  return {
    static: evidence(),
    test: evidence(),
    runtime: evidence(),
  };
}

function evidence(overrides: Partial<VerificationEvidenceBundle> = {}): VerificationEvidenceBundle {
  return {
    verification: "static",
    outcome: "passed",
    revision: 1,
    implementationFingerprint: "a".repeat(64),
    collectedAt: fixedTimestamp,
    projectRoot: "/tmp/project",
    project: {
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
    },
    checks: [],
    ...overrides,
  };
}

const failedCheck = (kind: "static" | "test" | "runtime"): VerificationEvidenceBundle["checks"][number] => ({
  id: "lint",
  kind,
  capability: "lint",
  capabilityStatus: "applicable",
  label: "Lint",
  executable: "pnpm",
  args: ["run", "lint"],
  cwd: "/tmp/project",
  script: "lint",
  startedAt: fixedTimestamp,
  durationMs: 1200,
  exitCode: 2,
  signal: null,
  status: "failed",
  reason: null,
  stdoutExcerpt: "",
  stderrExcerpt: "error: 2 problems",
  truncated: false,
  revision: 1,
  implementationFingerprint: "a".repeat(64),
});

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

/** Drives the feature to the state before the plan approval gate. */
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

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("orchestrator verification integration", () => {
  it("collects no evidence before the plan is approved, and for no other stage", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider(passingStages());
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
    const provider = new RecordingProvider(passingStages());
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

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
    const provider = new RecordingProvider(passingStages());
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
    const provider = new RecordingProvider({
      ...passingStages(),
      static: evidence({ outcome: "failed", checks: [failedCheck("static")] }),
    });
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "fix_requested",
      stage: "static_verification",
      state: WorkflowState.Fixing,
      event: "request_fix",
      committed: true,
    });
    expect(result.findings).toEqual([
      expect.objectContaining({
        featureId: "F-001",
        severity: "error",
        message: expect.stringContaining("pnpm run lint") as unknown as string,
      }),
    ]);
  });

  it("turns a verifier success into a fix request when a check was blocked", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider({
      ...passingStages(),
      static: evidence({
        outcome: "blocked",
        checks: [{ ...failedCheck("static"), status: "blocked", exitCode: null, reason: "dependency_missing" }],
      }),
    });
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "fix_requested",
      state: WorkflowState.Fixing,
    });
  });

  it("accepts a verifier failure on evidence that passed, because a reader can see more than a code", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider(passingStages());
    const executor = new FakeStageExecutor().configure("static_verification", {
      outcome: "needs_fix",
      findings: [{ featureId: "F-001", severity: "error", message: "The criterion is not met despite a clean run." }],
    });
    const harness = makeHarness(root, provider, executor);

    await driveToPlanGate(harness);
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "fix_requested",
      state: WorkflowState.Fixing,
    });
  });

  it("accepts a deferred runtime stage as completed, because deferral is not failure", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider({
      ...passingStages(),
      runtime: evidence({
        outcome: "deferred",
        checks: [
          {
            ...failedCheck("runtime"),
            kind: "runtime",
            capability: "runtime",
            capabilityStatus: "unsupported",
            executable: null,
            args: [],
            script: null,
            exitCode: null,
            status: "skipped",
            reason: "runtime_deferred",
            stderrExcerpt: "",
          },
        ],
      }),
    });
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
    const provider = new RecordingProvider({ static: new Error("the toolchain is missing") });
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

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
    const provider = new RecordingProvider({
      ...passingStages(),
      static: evidence({ outcome: "passed", checks: [failedCheck("static")] }),
    });
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

    const before = await harness.store.load("F-001");
    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).toBe("rejected");
    expect(result.failureClass).toBe("verification");
    expect(result.error?.message).toContain('claims "passed"');
    expect(await harness.store.load("F-001")).toEqual(before);
  });

  it("persists each attempt under a framework-owned key, and never over the model's own section", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider({
      ...passingStages(),
      static: evidence({ outcome: "failed", checks: [failedCheck("static")] }),
    });
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

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

  it("collects fresh evidence after a fix, so a repair cannot inherit the old result", async () => {
    const root = await makeRoot();
    const provider = new RecordingProvider({
      ...passingStages(),
      static: evidence({ outcome: "failed", checks: [failedCheck("static")] }),
    });
    const harness = makeHarness(root, provider);

    await driveToPlanGate(harness);

    for (let step = 0; step < 3; step += 1) {
      await harness.orchestrator.runNext("F-001");
    }

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({ status: "fix_requested" });
    expect(provider.requests).toHaveLength(1);

    await harness.orchestrator.runNext("F-001");

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({ status: "fix_requested" });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.revision).toBeGreaterThan(provider.requests[0]?.revision ?? 0);
  });

  it("writes no evidence key at all when no provider is configured", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, null);

    await driveToPlanGate(harness);
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

    const artifact = (await harness.store.readArtifact("F-001", "verification")) as Record<string, unknown>;

    expect(Object.keys(artifact)).toEqual(["static_verification"]);
    expect(artifact[DETERMINISTIC_EVIDENCE_KEY]).toBeUndefined();
  });
});
