import { cp, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  createWorkflowOrchestrator,
  SKIPPED_WITHOUT_START_REASONS,
  validateVerificationEvidenceBundle,
  type OrchestrationResult,
  type VerificationEvidenceBundle,
  type VerificationOutcome,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import {
  ProjectSecurityReviewProvider,
  ProjectVerificationProvider,
} from "@agent-workflow-kit/project";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import {
  ALL_CATALOG_CODES,
  formatCatalogCode,
} from "../apps/cli/src/error-catalog.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Task V: the runtime-evidence rejection and the deterministic pipeline end to end.
 *
 * Root cause (Task U, compliance/KNOWN_ISSUES.md P-28): with no runtime configuration the project
 * adapter builds the correct deferred bundle (R-146) whose single skipped check has
 * `startedAt: ""` (adapters/project/src/runtime.ts:280-317, from `NOT_STARTED` at
 * runtime.ts:86-98), and `validateCheck` (orchestration/src/verification.ts:461) required a
 * parseable timestamp, so the validator rejected the framework's own evidence as
 * `verification_evidence_invalid`.
 *
 * The fix (D-22): a skipped check never started, so no start time is fabricated. `validateCheck`
 * accepts an empty or null `startedAt` only for a `skipped` check with a declared skip reason, and
 * still requires a valid timestamp for every check that ran. This is a verification-evidence
 * behavior change under R-263, justified by R-146; no other evidence rule is changed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const p4Basic = join(here, "fixtures", "p4-basic");
const FINGERPRINT = "a".repeat(64);
const STAMP = "2026-04-05T06:07:08.000Z";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

/** A temp git repo holding a copy of the p4-basic fixture. */
async function makeGitCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-task-v-"));
  roots.push(root);
  const copy = join(root, "p4-basic");
  await cp(p4Basic, copy, { recursive: true });
  git(copy, "init", "--quiet", "--initial-branch=main", ".");
  git(copy, "config", "user.email", "task-v@example.invalid");
  git(copy, "config", "user.name", "Task V");
  git(copy, "config", "commit.gpgsign", "false");
  git(copy, "add", ".");
  git(copy, "commit", "--quiet", "-m", "p4-basic copy");
  return copy;
}

/** A plain temp copy of the p4-basic fixture (no git needed: the workspace is faked). */
async function makeCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-task-v-"));
  roots.push(root);
  const copy = join(root, "workspace");
  await cp(p4Basic, copy, { recursive: true });
  return copy;
}

describe("Task V.1: runtime stage on p4-basic validates end to end (no fakes at the seam)", () => {
  it("collects a deferred runtime bundle through the real provider that the real validator accepts", async () => {
    const copy = await makeGitCopy();
    const provider = new ProjectVerificationProvider({ projectRoot: copy });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "runtime_verification",
      verification: "runtime",
      revision: 1,
      projectRoot: copy,
      workspaceId: null,
    });

    // The framework's own answer for "no runtime config": deferred with one skipped check (R-146).
    expect(bundle.outcome).toBe("deferred");
    expect(bundle.checks).toHaveLength(1);
    expect(bundle.checks[0]).toMatchObject({
      status: "skipped",
      reason: "runtime_not_configured",
      startedAt: "",
    });

    // The seam that used to reject it: the real validator accepts the real evidence.
    const validated = validateVerificationEvidenceBundle(bundle);
    expect(validated).toMatchObject({ ok: true });
    if (validated.ok) {
      expect(validated.bundle.outcome).toBe("deferred");
    }
  });
});

function projectSummary(): VerificationEvidenceBundle["project"] {
  return {
    ecosystem: "node",
    language: "javascript",
    packageManager: "npm",
    declaredPackageManager: null,
    dependenciesInstalled: true,
    frameworks: [],
    capabilities: [
      { capability: "lint", status: "applicable", reason: "detected", script: "lint", detail: "Lint." },
      {
        capability: "typecheck",
        status: "not_applicable",
        reason: "language_without_typecheck",
        script: null,
        detail: "No type system.",
      },
      { capability: "test", status: "applicable", reason: "detected", script: "test", detail: "Tests." },
      {
        capability: "build",
        status: "unavailable",
        reason: "script_absent",
        script: null,
        detail: "No build script.",
      },
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

function baseCheck(): Record<string, unknown> {
  return {
    id: "runtime",
    kind: "runtime",
    capability: "runtime",
    capabilityStatus: "not_applicable",
    label: 'Runtime check "runtime"',
    executable: null,
    args: [],
    cwd: "/repo",
    script: null,
    startedAt: STAMP,
    durationMs: 0,
    exitCode: null,
    signal: null,
    status: "skipped",
    reason: "runtime_not_configured",
    detail: "No runtime verification is configured.",
    stdoutExcerpt: "",
    stderrExcerpt: "",
    truncated: false,
    revision: 1,
    implementationFingerprint: FINGERPRINT,
  };
}

function bundleWith(checks: readonly Record<string, unknown>[], outcome: VerificationOutcome): Record<string, unknown> {
  return {
    verification: "runtime",
    outcome,
    revision: 1,
    implementationFingerprint: FINGERPRINT,
    workspace: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
    controlPlane: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
    collectedAt: STAMP,
    projectRoot: "/repo",
    workspaceId: null,
    project: projectSummary(),
    checks,
  };
}

describe("Task V.2: skipped checks validate without a start time; ran checks still need one", () => {
  it("documents the skip reasons a never-started check may carry", () => {
    expect([...SKIPPED_WITHOUT_START_REASONS].sort()).toEqual(
      [
        "ecosystem_unsupported",
        "language_without_typecheck",
        "not_attempted",
        "runtime_deferred",
        "runtime_not_configured",
        "script_absent",
      ].sort(),
    );
  });

  it("accepts an empty startedAt for a skipped check with a declared skip reason", () => {
    for (const reason of SKIPPED_WITHOUT_START_REASONS) {
      const check = { ...baseCheck(), reason, startedAt: "" };
      const validated = validateVerificationEvidenceBundle(bundleWith([check], "deferred"));
      expect(validated, `reason ${reason}`).toMatchObject({ ok: true });
    }
  });

  it("accepts a null startedAt for a skipped check and normalises it to empty", () => {
    const check = { ...baseCheck(), startedAt: null };
    const validated = validateVerificationEvidenceBundle(bundleWith([check], "deferred"));
    expect(validated).toMatchObject({ ok: true });
    if (validated.ok) {
      expect(validated.bundle.checks[0]?.startedAt).toBe("");
    }
  });

  it.each(["passed", "failed", "blocked", "timed_out", "cancelled"] as const)(
    "rejects an empty startedAt on a %s check that ran",
    (status) => {
      const check = { ...baseCheck(), status, startedAt: "" };
      const outcome = status === "failed" ? "failed" : status === "blocked" ? "blocked" : "failed";
      const validated = validateVerificationEvidenceBundle(
        bundleWith(
          [{ ...check, reason: status === "failed" ? "status_mismatch" : "spawn_failed" }],
          outcome,
        ),
      );
      expect(validated.ok).toBe(false);
      if (!validated.ok) {
        expect(validated.code).toBe("verification_evidence_invalid");
      }
    },
  );

  it("rejects a malformed timestamp even on a skipped check", () => {
    const check = { ...baseCheck(), startedAt: "not-a-timestamp" };
    const validated = validateVerificationEvidenceBundle(bundleWith([check], "deferred"));
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.code).toBe("verification_evidence_invalid");
    }
  });

  it("rejects an empty startedAt on a skipped check with no declared reason", () => {
    for (const reason of [null, ""]) {
      const check = { ...baseCheck(), reason, startedAt: "" };
      const validated = validateVerificationEvidenceBundle(bundleWith([check], "deferred"));
      expect(validated, `reason ${String(reason)}`).toMatchObject({
        ok: false,
        code: "verification_evidence_invalid",
      });
    }
  });

  it("rejects an empty startedAt on a skipped check with a reason that is not a skip reason", () => {
    const check = { ...baseCheck(), reason: "package_manager_unknown", startedAt: "" };
    const validated = validateVerificationEvidenceBundle(bundleWith([check], "deferred"));
    expect(validated).toMatchObject({ ok: false, code: "verification_evidence_invalid" });
  });

  it('still rejects "blocked" without a blocked check', () => {
    const validated = validateVerificationEvidenceBundle(bundleWith([{ ...baseCheck() }], "blocked"));
    expect(validated).toMatchObject({ ok: false, code: "verification_evidence_invalid" });
    if (!validated.ok) {
      expect(validated.message).toContain("blocked");
    }
  });

  it('still rejects "deferred" without every check skipped', () => {
    const passed = {
      ...baseCheck(),
      id: "lint",
      kind: "static",
      capability: "lint",
      capabilityStatus: "applicable",
      executable: "echo",
      args: ["no lint"],
      startedAt: STAMP,
      status: "passed",
      reason: null,
    };
    const bundle = {
      ...bundleWith([passed, { ...baseCheck(), kind: "static", capability: "lint" }], "deferred"),
      verification: "static",
    };
    const validated = validateVerificationEvidenceBundle(bundle);
    expect(validated).toMatchObject({ ok: false, code: "verification_evidence_invalid" });
    if (!validated.ok) {
      expect(validated.message).toContain("deferred");
    }
  });
});

describe("Task V.4: CLI prints the raw message as Detail and never a placeholder", () => {
  it("prints no literal <id> or <stage> for any catalog code, with or without context", () => {
    for (const code of ALL_CATALOG_CODES) {
      for (const context of [
        { featureId: "F-001", stage: "static_verification", detail: "raw message" },
        {},
      ]) {
        const text = formatCatalogCode(code, context).join("\n");
        expect(text, `code ${code}`).not.toContain("<id>");
        expect(text, `code ${code}`).not.toContain("<stage>");
      }
    }
    const unknown = formatCatalogCode("not_a_real_code", {
      featureId: "F-009",
      stage: "runtime_verification",
      detail: "boom",
    }).join("\n");
    expect(unknown).not.toContain("<id>");
    expect(unknown).not.toContain("<stage>");
    expect(unknown).toContain("F-009");
    expect(unknown).toContain("Detail: boom");
    // The unknown-code fallback evidence path carries the feature id, not a placeholder.
    expect(unknown).toContain(".agentflow/features/F-009/");
  });

  it("always prints the raw message as a Detail line, verbatim apart from wrapping and stripping", () => {
    const message = "A verification evidence check is not a valid evidence record.";
    const text = formatCatalogCode("executor_error", {
      featureId: "F-001",
      stage: "runtime_verification",
      detail: message,
    }).join("\n");
    expect(text).toContain(`Detail: ${message}`);
    expect(text).toContain("(executor_error)");
    // Wrapped output: collapse whitespace before matching multi-word phrases.
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("agentflow run F-001");
    expect(flat).toContain(".agentflow/recordings/F-001/runtime_verification/");

    const dirty = "tab\there\bescape\u001b[0m";
    const stripped = formatCatalogCode("stage_failed", { featureId: "F-001", detail: dirty }).join("\n");
    expect(stripped).not.toContain("\t");
    expect(stripped).not.toContain("");
    expect(stripped).toContain("Detail: tabhereescape[0m");
    for (const line of stripped.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it('says "cause not determined" only when the message is empty', () => {
    const withDetail = formatCatalogCode("not_a_real_code", {
      featureId: "F-001",
      detail: "the orchestrator said why",
    }).join("\n");
    expect(withDetail).not.toContain("cause not determined");
    expect(withDetail).toContain("Detail: the orchestrator said why");

    const withoutDetail = formatCatalogCode("not_a_real_code", { featureId: "F-001" }).join("\n");
    expect(withoutDetail).toContain("cause not determined");
    expect(withoutDetail).not.toContain("Detail:");

    const configuredWith = formatCatalogCode("configured", {
      featureId: "F-001",
      checkId: "lint",
      detail: "recorded state",
    }).join(" ");
    expect(configuredWith).not.toContain("cause not determined");
    const configuredWithout = formatCatalogCode("configured", {
      featureId: "F-001",
      checkId: "lint",
    }).join(" ");
    expect(configuredWithout).toContain("cause not determined");
  });
});

describe("Task V.3: deterministic pipeline with real providers and a fake model executor only", () => {
  it("drives past the unconfigured runtime stage to the push gate on the recorded gap (D-23)", async () => {
    const workspaceDir = await makeCopy();
    const storeRoot = await mkdtemp(join(tmpdir(), "agent-workflow-kit-task-v-store-"));
    roots.push(storeRoot);

    const store = createFeatureSessionStore(storeRoot);
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
    const workspace = createFakeWorkspaceProvider({ workingDirectory: workspaceDir });
    // Real project verification provider, real validator (inside the orchestrator), real security
    // review provider and real final-gate logic; the only fake is the model executor. The providers
    // run in the orchestrator-assigned directory, which the resolvers pin to the request.
    const verification = new ProjectVerificationProvider({
      projectRoot: workspaceDir,
      resolveRunRoot: (request) => request.projectRoot,
    });
    const security = new ProjectSecurityReviewProvider({
      projectRoot: workspaceDir,
      resolveRoot: (request) => request.projectRoot,
    });
    const orchestrator = createWorkflowOrchestrator({
      store,
      executor,
      workspace,
      verification,
      security,
      projectRoot: storeRoot,
    });

    await orchestrator.createFeature({
      featureId: "F-001",
      title: "Deterministic pipeline",
      request: "# Request\n\nProve the pipeline.\n",
    });

    const observed: OrchestrationResult[] = [];
    const runUntil = async (
      predicate: (result: OrchestrationResult) => boolean,
      limit = 60,
    ): Promise<OrchestrationResult> => {
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const result = await orchestrator.runNext("F-001");
        observed.push(result);
        if (predicate(result)) {
          return result;
        }
        if (result.status === "awaiting_human" && result.action === "approve_plan") {
          await orchestrator.approvePlan("F-001");
        }
      }
      throw new Error(`Pipeline never satisfied the predicate (last: ${JSON.stringify(observed.at(-1)?.status)}).`);
    };

    // Static: real commands run, real bundle validates, the stage advances.
    const staticResult = await runUntil(
      (result) => result.stage === "static_verification" && result.status === "stage_completed",
    );
    expect(staticResult.verification).not.toBeNull();
    expect(staticResult.verification?.outcome).toBe("passed");
    // Every check that ran carries a real timestamp (V.2's rule, observed end to end).
    for (const check of staticResult.verification?.checks ?? []) {
      expect(check.startedAt.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(check.startedAt))).toBe(false);
    }

    // Test: the same, through the real `node test.mjs` run.
    const testResult = await runUntil(
      (result) => result.stage === "test_verification" && result.status === "stage_completed",
    );
    expect(testResult.verification).not.toBeNull();
    expect(testResult.verification?.outcome).toBe("passed");

    // Runtime (D-23): no runtime configuration on the p4-basic copy, so the real provider reports
    // deferred with one skipped check (V.1). This is the one absence the workflow carries forward
    // (D-23): the framework itself advances the stage without consulting any model, records the
    // deferred bundle, and holds publishing behind an explicit `--accept-unverified runtime`
    // acknowledgment (compliance/decisions.md D-23). Valid-but-unmeasured deferred evidence of any
    // other shape is still held at inconclusive exactly as before (R-146).
    const runtimeResult = await runUntil(
      (result) => result.stage === "runtime_verification" && result.status === "stage_completed",
    );
    expect(runtimeResult.status).toBe("stage_completed");
    expect(runtimeResult.state).toBe(WorkflowState.SecurityReview);
    expect(runtimeResult.error).toBeNull();
    expect(runtimeResult.verification).not.toBeNull();
    expect(runtimeResult.verification?.outcome).toBe("deferred");
    expect(runtimeResult.verification?.checks).toHaveLength(1);
    expect(runtimeResult.verification?.checks[0]).toMatchObject({
      status: "skipped",
      reason: "runtime_not_configured",
    });
    // The advance is the framework's own: the fake model was never consulted for the runtime stage,
    // so there was no reported success to overrule.
    expect(executor.requestFor("runtime_verification")).toBeUndefined();

    // The advance is a real event, not an error state: the next run walks into and through the
    // security review, landing in the final gate instead of re-presenting the runtime stage forever
    // (the parking this decision replaces).
    expect(await orchestrator.runNext("F-001")).toMatchObject({
      stage: "security_review",
      state: WorkflowState.FinalGate,
    });

    // From here the pipeline runs on nothing but the recorded gap: the final gate treats the stage's
    // `not_performed` verdict as the one absence its aggregate may stand on, and the session reaches
    // awaiting_push_approval rather than parking before it.
    const reachState = async (target: WorkflowState): Promise<void> => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const session = await store.load("F-001");

        if (session.machine.state === target) {
          return;
        }

        if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
          await orchestrator.approvePlan("F-001");
          continue;
        }

        await orchestrator.runNext("F-001");
      }

      throw new Error(`Pipeline never reached "${target}".`);
    };

    await reachState(WorkflowState.AwaitingPushApproval);

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

    const summary = await store.readArtifactText("F-001", "final_summary");
    expect(summary).toContain("runtime verification: not performed (not configured)");

    // STOP: nothing was published. The push approval itself is refused until a human acknowledges the
    // gap with `--accept-unverified runtime` — that command surface is Task X's own suite
    // (tests/d23-runtime-gap.test.ts); here the pipeline is driven only as far as the gate the
    // acknowledgment belongs behind, by design rather than by defect.
    expect(observed.every((result) => result.status !== "rejected")).toBe(true);
    expect(
      observed.some((result) => result.error?.code === "verification_evidence_invalid"),
    ).toBe(false);
  });
});
