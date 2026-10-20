import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowState } from "@agent-workflow-kit/core";
import type { PushApprovalRecord } from "@agent-workflow-kit/persistence";
import { recordStageInvocation } from "@agent-workflow-kit/opencode";
import { createOpenCodeCliTransport, createOpenCodeStageExecutor } from "@agent-workflow-kit/opencode";
import {
  STAGE_DEFINITIONS,
  applySecurityPolicy,
  approvedPathsOf,
  buildFeatureBranch,
  buildFeatureCommitMessage,
  buildFinalSummary,
  createWorkflowOrchestrator,
  evaluateFixIntegrity,
  SECURITY_PROTECTED_PATTERNS,
  withoutFrameworkRecordings,
  type OrchestrationResult,
  type SecurityReviewEvidence,
  type WorkspaceChanges,
  type WorkStage,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore, type FeatureSessionStore } from "@agent-workflow-kit/persistence";
import { createProjectSecurityReviewProvider, createProjectVerificationProvider } from "@agent-workflow-kit/project";
import { GitFeaturePublisher, GitWorkspaceProvider } from "@agent-workflow-kit/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPayload } from "../fixtures/opencode-transport.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";

/**
 * Task Z: the framework's own recordings, and every consumer of the change set.
 *
 * The seam these tests close (P-36): the recorder, the real workspace adapter, and the consumers that
 * read the measured change set were never exercised together. Every test here writes recordings the
 * way production does — through `recordStageInvocation`, the function the OpenCode transport calls —
 * into a real temporary Git repository and a real worktree opened by the real `GitWorkspaceProvider`,
 * so the recordings really are untracked files in the measured tree, exactly as they are in a
 * post-approval worktree where no `.agentflow/.gitignore` exists.
 *
 * The end-to-end harness goes further: it runs the real OpenCode transport against a fake `opencode`
 * executable (a script that prints one valid fenced reply) and the real project security and
 * verification providers, so `security_review`, `final_gate`, and `final_summary` are reached the way
 * a run reaches them. No real model is called anywhere.
 */

const CLOCK = "2026-04-05T06:07:08.000Z";
const FEATURE = "F-001";
const EDITED = "src/app.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** p4-basic's real verification commands: a configured static check and a configured test check. */
const P4_BASIC = join(here, "fixtures", "p4-basic");

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

interface Fixture {
  readonly base: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly storeRoot: string;
  readonly remote: string;
  readonly baselineCommit: string;
}

/**
 * A repository where `agentflow init` has run: one commit, a bare remote, and the `.agentflow/.gitignore`
 * the init command writes. That last file is untracked and ignored by its own `*`, which is why the
 * project checkout shows nothing under `.agentflow/` while a fresh worktree — created from the commit,
 * which contains no `.agentflow/` at all — shows every recording the transport writes into it.
 */
async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-task-z-"));
  roots.push(base);

  const root = join(base, "repo");
  const cacheRoot = join(base, "cache");
  const storeRoot = join(base, "features");
  const remote = join(base, "remote.git");

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(storeRoot, { recursive: true });

  // p4-basic's project files, including the `agent-workflow.config.json` that declares the static and
  // test commands. Without them the verification stages record `deferred` evidence and the final gate
  // blocks on a missing check, which says nothing about the recordings this suite is about.
  await cp(P4_BASIC, root, { recursive: true });

  git(root, "init", "--quiet", "--initial-branch=main", ".");
  git(root, "config", "user.email", "task-z@example.invalid");
  git(root, "config", "user.name", "Task Z Test");
  git(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, EDITED), "export const value = 1;\n", "utf8");
  await mkdir(join(root, ".agentflow"), { recursive: true });
  await writeFile(join(root, ".agentflow", ".gitignore"), "*\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "initial");

  git(root, "init", "--quiet", "--bare", remote);
  git(root, "remote", "add", "origin", remote);

  return { base, root, cacheRoot, storeRoot, remote, baselineCommit: git(root, "rev-parse", "HEAD").trim() };
}

/**
 * The fake `opencode`: a Node program that answers every stage with the payload that stage's contract
 * asks for, derived from the stage's own output slots, and edits the approved file for
 * `implementation` (which is what the real model's tool use would do).
 *
 * It is spawned as `node -e <program>`, so the transport's own arguments land at `process.argv[1]`
 * and the prompt — the last positional — is what the stage identity is read from. Any other
 * invocation (`session list` from the usage observer) exits 0 with no output, which that observer
 * treats as "no sessions".
 */
function fakeOpenCodeProgram(): string {
  const table: Record<string, unknown> = {};

  for (const [stage, definition] of Object.entries(STAGE_DEFINITIONS)) {
    table[stage] = defaultPayload({
      featureId: FEATURE,
      stage: stage as WorkStage,
      role: definition.role,
      fixReturnState: null,
    });
  }

  return [
    `const table = ${JSON.stringify(table)};`,
    "const argv = process.argv.slice(1);",
    'if (argv[0] !== "run") { process.exit(0); }',
    "const prompt = argv[argv.length - 1];",
    "const stageMatch = /stage: `([^`]+)`/.exec(prompt);",
    "const fixMatch = /workflow state `([^`]+)`/.exec(prompt);",
    "const stage = stageMatch === null ? null : stageMatch[1];",
    'if (stage === null || !Object.hasOwn(table, stage)) { process.stderr.write("fake opencode: unknown stage\\n"); process.exit(3); }',
    "const payload = table[stage];",
    'if (stage === "planning") {',
    "  for (const artifact of payload.artifacts) {",
    '    if (artifact.name === "plan") {',
    "      artifact.content = { featureId: \"F-001\", summary: \"Change the exported value.\", steps: [{ id: \"step-1\", description: \"Change the exported value in src/app.ts.\", requirementIds: [\"REQ-1\"], expectedFiles: [\"src/**\"], verification: \"test\" }] };",
    "    }",
    "  }",
    "}",
    "if (fixMatch !== null) {",
    "  for (const artifact of payload.artifacts) {",
    '    if (artifact.name === "fixes") { artifact.content.fixedFor = fixMatch[1]; artifact.content.summary = "Repaired " + fixMatch[1]; }',
    "  }",
    "}",
    'if (stage === "implementation") { process.getBuiltinModule("fs").writeFileSync("src/app.ts", "export const value = 2;\\n"); }',
    'process.stdout.write("```json\\n" + JSON.stringify(payload, null, 2) + "\\n```\\n");',
  ].join("\n");
}

interface E2EHarness {
  readonly fixture: Fixture;
  readonly store: FeatureSessionStore;
  readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
  readonly results: OrchestrationResult[];
}

/**
 * The production stack, with one substitution: the OpenCode executable is the fake program above.
 * Store, orchestrator, workspace provider, publisher, security provider, and verification provider
 * are the real ones, wired the way `createRealStack` wires them.
 */
async function makeE2EHarness(): Promise<E2EHarness> {
  const fixture = await makeFixture();
  const store = createFeatureSessionStore(fixture.storeRoot, { clock: () => CLOCK });
  const transport = createOpenCodeCliTransport({
    command: process.execPath,
    extraArgs: ["-e", fakeOpenCodeProgram()],
  });
  const executor = createOpenCodeStageExecutor({ transport, projectRoot: fixture.root });
  const workspace = new GitWorkspaceProvider({ cacheRoot: fixture.cacheRoot, isoNow: () => CLOCK });
  const verification = createProjectVerificationProvider({
    projectRoot: fixture.root,
    resolveRunRoot: (request) => request.projectRoot,
  });
  const security = createProjectSecurityReviewProvider({
    projectRoot: fixture.root,
    resolveRoot: (request) => request.projectRoot,
  });

  const orchestrator = createWorkflowOrchestrator({
    store,
    executor,
    verification,
    security,
    workspace,
    publisher: new GitFeaturePublisher(),
    projectRoot: fixture.root,
    publishRemote: "origin",
  });

  return { fixture, store, orchestrator, results: [] };
}

/** Drives `runNext`, approving the plan gate when the workflow reaches it, until `stop` is true. */
async function drive(
  harness: E2EHarness,
  stop: (result: OrchestrationResult) => boolean,
  limit = 60,
): Promise<OrchestrationResult> {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const session = await harness.store.load(FEATURE);

    if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
      const approved = await harness.orchestrator.approvePlan(FEATURE);
      harness.results.push(approved);

      if (approved.status !== "gate_approved") {
        throw new Error(`approvePlan stopped the run: ${approved.status} ${approved.error?.code ?? ""}`);
      }

      continue;
    }

    const result = await harness.orchestrator.runNext(FEATURE);
    harness.results.push(result);

    if (stop(result)) {
      return result;
    }

    if (result.status === "rejected" || result.status === "executor_error" || result.status === "scope_violation" || result.status === "conflict") {
      throw new Error(
        `The run stopped at ${result.stage ?? "?"} with ${result.status} (${result.error?.code ?? "no code"}): ${result.error?.message ?? ""}`,
      );
    }

    if (result.status === "stage_failed") {
      throw new Error(
        `The run stopped at ${result.stage ?? "?"} with stage_failed (${result.error?.code ?? "no code"}): ${
          result.error?.message ?? ""
        }`,
      );
    }

    if (result.status === "fix_requested" || result.state === WorkflowState.Failed) {
      const failed = (result.security?.checks ?? [])
        .filter((check) => check.result === "failed")
        .map((check) => {
          const paths = check.paths.slice(0, 3);
          const more =
            check.paths.length > paths.length ? `, … ${String(check.paths.length - paths.length)} more` : "";
          return `${check.check} [${paths.join(", ")}${more}]`;
        });

      throw new Error(
        `The run stopped at ${result.stage ?? "?"} with ${result.status} (${result.error?.code ?? "no code"})${
          failed.length > 0 ? `; failed security checks: ${failed.join("; ")}` : `: ${result.error?.message ?? ""}`
        }`,
      );
    }
  }

  throw new Error(
    `The workflow never reached the requested stage. Last state: ${
      (await harness.store.load(FEATURE)).machine.state
    }; stages seen: ${harness.results.map((entry) => `${entry.stage ?? "?"}:${entry.status}`).join(" -> ")}`,
  );
}

async function startFeature(harness: E2EHarness): Promise<void> {
  const created = await harness.orchestrator.createFeature({
    featureId: FEATURE,
    title: "Recordings in the change set",
    request: "# Request\n\nChange the exported value.\n",
  });

  if (created.status !== "created") {
    throw new Error(`createFeature failed: ${created.status}`);
  }
}

/** Every recording directory written into the worktree, as `<stage>/<stamp>` relative paths. */
async function recordingsIn(directory: string): Promise<readonly string[]> {
  const root = join(directory, ".agentflow", "recordings", FEATURE);
  const stages = await readdir(root).catch(() => [] as string[]);
  const found: string[] = [];

  for (const stage of stages) {
    for (const stamp of await readdir(join(root, stage))) {
      found.push(`${stage}/${stamp}`);
    }
  }

  return found.sort();
}

function checkNamed(evidence: SecurityReviewEvidence | null, check: string) {
  return evidence?.checks.find((entry) => entry.check === check);
}

/**
 * Writes one invocation recording the way the OpenCode transport writes it — through the real
 * recorder, into the given directory — so the paths below are produced by production code rather
 * than by the test.
 */
async function recordInto(directory: string, stage: WorkStage): Promise<string> {
  const written = await recordStageInvocation(directory, { featureId: FEATURE, stage }, {
    command: "opencode",
    args: ["run", "--standalone", "--agent", "agentflow-write", "--format", "default", "probe"],
    cwd: directory,
    startedAt: CLOCK,
    observation: {
      termination: "exited",
      exitCode: 0,
      stdout: "```json\n{}\n```\n",
      stderr: "",
      startedAt: CLOCK,
      durationMs: 7,
    },
    error: null,
  });

  expect(written, "the real recorder could not write the recording").not.toBeNull();
  expect((written?.manifestPath ?? "").startsWith(`${directory}/.agentflow/recordings/${FEATURE}/${stage}/`)).toBe(
    true,
  );
  return written?.manifestPath ?? "";
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("the real recorder and the security review", () => {
  it("does not fail protected_configuration_changed for the framework's own recordings", async () => {
    const harness = await makeE2EHarness();
    await startFeature(harness);

    const result = await drive(harness, (entry) => entry.stage === "security_review");

    // The recordings are really on disk in the worktree: this test is only worth anything if the
    // transport wrote them there through the same function production calls.
    const worktree = result.scope?.workingDirectory ?? "";
    expect(worktree.startsWith(harness.fixture.cacheRoot)).toBe(true);
    const recorded = await recordingsIn(worktree);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.some((entry) => entry.startsWith("implementation/"))).toBe(true);

    // The stage must not be sent to the fixer for the framework's own diagnostics.
    const protectedCheck = checkNamed(result.security, "protected_configuration_changed");
    expect(protectedCheck?.paths, "the recordings must not be the protected check's paths").toEqual([]);
    expect(protectedCheck?.result).toBe("passed");
    expect(result.status).toBe("stage_completed");
  });

  it("keeps every other .agentflow/ path failing the security scan", async () => {
    const harness = await makeE2EHarness();
    await startFeature(harness);

    const result = await drive(harness, (entry) => entry.stage === "security_review");
    const worktree = result.scope?.workingDirectory ?? "";

    // A near-miss under the recorder's own directory, and a plain file under .agentflow/: both are
    // agent writes, and both must stay protected no matter what is excused for the recorder.
    const forged = join(worktree, ".agentflow", "recordings", FEATURE, "security_review", "20260405T060708Z-abcd");
    await mkdir(forged, { recursive: true });
    await writeFile(join(forged, "notes.md"), "not a recording\n", "utf8");
    await writeFile(join(worktree, ".agentflow", "notes.md"), "where does this belong?\n", "utf8");

    const changes: WorkspaceChanges = {
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [
        ".agentflow/recordings/F-001/security_review/20260405T060708Z-abcd/notes.md",
        ".agentflow/notes.md",
      ],
    };

    const checks = applySecurityPolicy({
      changes,
      approvedPatterns: ["src/**"],
      protectedPatterns: SECURITY_PROTECTED_PATTERNS,
    });
    const protectedCheck = checks.find((check) => check.check === "protected_configuration_changed");

    expect(protectedCheck?.result).toBe("failed");
    expect(protectedCheck?.paths).toEqual([
      ".agentflow/notes.md",
      ".agentflow/recordings/F-001/security_review/20260405T060708Z-abcd/notes.md",
    ]);
  });
});

describe("the real recorder and the final gate and summary", () => {
  it("runs the gate and the summary past the recordings without listing them as changed files", async () => {
    const harness = await makeE2EHarness();
    await startFeature(harness);

    await drive(harness, (entry) => entry.stage === "final_summary" && entry.state === WorkflowState.AwaitingPushApproval);

    const gate = harness.results.find((entry) => entry.stage === "final_gate");
    const summary = harness.results.find((entry) => entry.stage === "final_summary");

    expect(gate?.status).toBe("stage_completed");
    expect(summary?.status).toBe("stage_completed");

    const worktree = summary?.scope?.workingDirectory ?? "";
    expect((await recordingsIn(worktree)).length).toBeGreaterThan(0);

    const document = await harness.store.readArtifactText(FEATURE, "final_summary");
    expect(document).not.toContain(".agentflow/recordings");
    expect(document).not.toContain("(untracked)");
  });
});

describe("the real recorder and fix integrity", () => {
  it("accepts a fixing stage whose only new paths are its own recordings, and still rejects any other .agentflow/ write", async () => {
    const fixture = await makeFixture();
    const workspace = new GitWorkspaceProvider({ cacheRoot: fixture.cacheRoot, isoNow: () => CLOCK });

    // The tree as it is before the fix attempt: the approved commit, measured by the real adapter.
    const baseline = {
      repositoryRoot: fixture.root,
      baselineCommit: fixture.baselineCommit,
      workspaceId: `ws-${FEATURE}`,
      approvedRevision: 1,
      capturedAt: CLOCK,
    };
    const openedBefore = await workspace.open({ featureId: FEATURE, baseline, access: "read_write" });
    expect(openedBefore.ok, openedBefore.ok ? "" : openedBefore.message).toBe(true);

    if (!openedBefore.ok) {
      return;
    }

    const before = await workspace.inspect({ workspace: openedBefore.workspace });
    expect(before.ok).toBe(true);

    // What a recorded fixing stage leaves behind: the fixer's edit, and the transport's own recording.
    const directory = openedBefore.workspace.workingDirectory;
    await writeFile(join(directory, EDITED), "export const value = 3;\n", "utf8");
    await recordInto(directory, "fixing");

    const after = await workspace.inspect({ workspace: openedBefore.workspace });
    expect(after.ok).toBe(true);

    if (!after.ok) {
      return;
    }

    const attemptChanges = after.inspection.changes;
    const recordingPaths = [...attemptChanges.untracked].filter((path) => path.startsWith(".agentflow/recordings/"));
    expect(recordingPaths.length).toBeGreaterThan(0);

    // 1. A recorded fixing stage passes: its own recordings are not the fixer's writes.
    expect(
      evaluateFixIntegrity({
        featureId: FEATURE,
        originStage: WorkflowState.SecurityReview,
        attempt: 1,
        approvedPatterns: ["src/**"],
        changes: attemptChanges,
        before: {
          specSha256: "1".repeat(64),
          planSha256: "2".repeat(64),
          planReviewSha256: "3".repeat(64),
          verificationConfigSha256: "4".repeat(64),
        },
        after: {
          specSha256: "1".repeat(64),
          planSha256: "2".repeat(64),
          planReviewSha256: "3".repeat(64),
          verificationConfigSha256: "4".repeat(64),
        },
      }),
    ).toEqual({ ok: true });

    // 2. Any other write under .agentflow/ is still a rejection, near-miss shape included.
    await writeFile(join(directory, ".agentflow", "notes.md"), "where does this belong?\n", "utf8");
    const nearMiss = join(
      directory,
      ".agentflow",
      "recordings",
      FEATURE,
      "fixing",
      "20260405T060708Z-abcd",
    );
    await mkdir(nearMiss, { recursive: true });
    await writeFile(join(nearMiss, "notes.md"), "not a recording\n", "utf8");

    const afterUnapproved = await workspace.inspect({ workspace: openedBefore.workspace });
    expect(afterUnapproved.ok).toBe(true);

    if (!afterUnapproved.ok) {
      return;
    }

    const verdict = evaluateFixIntegrity({
      featureId: FEATURE,
      originStage: WorkflowState.SecurityReview,
      attempt: 1,
      approvedPatterns: ["src/**"],
      changes: afterUnapproved.inspection.changes,
      before: {
        specSha256: "1".repeat(64),
        planSha256: "2".repeat(64),
        planReviewSha256: "3".repeat(64),
        verificationConfigSha256: "4".repeat(64),
      },
      after: {
        specSha256: "1".repeat(64),
        planSha256: "2".repeat(64),
        planReviewSha256: "3".repeat(64),
        verificationConfigSha256: "4".repeat(64),
      },
    });

    expect(verdict.ok).toBe(false);

    if (!verdict.ok) {
      expect(verdict.rejections[0].code).toBe("fix_protected_file_touched");
      expect(verdict.rejections[0].paths).toEqual([
        ".agentflow/notes.md",
        ".agentflow/recordings/F-001/fixing/20260405T060708Z-abcd/notes.md",
      ]);
    }

    await workspace.close(openedBefore.workspace);
  });
});

describe("the real recorder and the final summary's changed files", () => {
  it("lists the code that changed and not the framework's recordings", async () => {
    const fixture = await makeFixture();
    const workspace = new GitWorkspaceProvider({ cacheRoot: fixture.cacheRoot, isoNow: () => CLOCK });
    const baseline = {
      repositoryRoot: fixture.root,
      baselineCommit: fixture.baselineCommit,
      workspaceId: `ws-${FEATURE}`,
      approvedRevision: 1,
      capturedAt: CLOCK,
    };
    const opened = await workspace.open({ featureId: FEATURE, baseline, access: "read_write" });
    expect(opened.ok, opened.ok ? "" : opened.message).toBe(true);

    if (!opened.ok) {
      return;
    }

    const directory = opened.workspace.workingDirectory;
    await writeFile(join(directory, EDITED), "export const value = 2;\n", "utf8");
    await recordInto(directory, "implementation");

    const inspected = await workspace.inspect({ workspace: opened.workspace });
    expect(inspected.ok).toBe(true);

    if (!inspected.ok) {
      return;
    }

    const document = buildFinalSummary({
      featureId: FEATURE,
      title: "Recordings",
      revision: 4,
      fingerprint: inspected.inspection.fingerprint,
      spec: null,
      plan: {
        featureId: FEATURE,
        steps: [{ id: "STEP-1", description: "Change the value.", expectedFiles: [EDITED] }],
      },
      gate: {
        schemaVersion: 1,
        featureId: FEATURE,
        status: "passed",
        state: WorkflowState.AwaitingPushApproval,
        revision: 4,
        fingerprint: inspected.inspection.fingerprint,
        requirementIds: ["REQ-1"],
        acceptanceCriterionIds: [],
        criteria: [],
        criterionCount: 0,
        criteriaTruncated: false,
        verification: "passed",
        verificationStages: [],
        unverifiedRuntime: [],
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
      changes: inspected.inspection.changes,
      scope: {
        measured: true,
        approvedPatterns: ["src/**"],
        unauthorizedPaths: [],
      },
    });

    expect(document).toContain(`${EDITED} (modified)`);
    expect(document).not.toContain(".agentflow/recordings");
  });
});

/**
 * Item 4's gate, and the reason the other tests matter: a recording that reaches the published
 * commit is a leak out of the change set rather than a wrong line in a report.
 *
 * This harness is the publishing integration harness with one addition — the recordings are written
 * by the real recorder, from stage hooks, into the worktree the real adapter opened — so the paths
 * the publisher stages are produced the way a real run produces them. The assertions are read back
 * out of the remote, because a publish record is a claim about the repository rather than evidence
 * of it.
 */
describe("the real recorder and publishing", () => {
  const SPEC_ARTIFACT = {
    schemaVersion: 1,
    featureId: FEATURE,
    summary: "Publish one approved edit.",
    requirements: [
      {
        id: "REQ-1",
        title: "One edit",
        description: "The approved edit arrives on one branch.",
        acceptanceCriteria: [{ id: "AC-1", text: "The branch holds exactly the approved edit." }],
      },
    ],
  };

  const PLAN_ARTIFACT = {
    schemaVersion: 1,
    featureId: FEATURE,
    summary: "Edit one file.",
    steps: [{ id: "STEP-1", description: "Change the exported value.", expectedFiles: [EDITED] }],
  };

  /**
   * The publish step itself, called the way the orchestrator calls it: `approvedPathsOf(changes)` at
   * orchestrator.ts:1133 into `commitFeature({ paths })` at orchestrator.ts:1174.
   *
   * The stages that normally run first cannot get here while the recordings are in the change set —
   * `security_review` fails on them and the fix loop then rejects them, which is P-35 and P-36 — so
   * this test composes the two production functions the publish path is built from, with the
   * recorder's own output as the input, rather than bypassing a guard that exists. The guards it
   * stands in for are the same `approvedPathsOf` call, and the scope guard already excuses these
   * paths (Task F), which is why the question "would they be staged?" has an answer at all.
   */
  it("stages the recordings when the change set carries them, and lands them in the commit", async () => {
    const fixture = await makeFixture();
    const workspace = new GitWorkspaceProvider({ cacheRoot: fixture.cacheRoot, isoNow: () => CLOCK });
    const baseline = {
      repositoryRoot: fixture.root,
      baselineCommit: fixture.baselineCommit,
      workspaceId: `ws-${FEATURE}`,
      approvedRevision: 1,
      capturedAt: CLOCK,
    };
    const opened = await workspace.open({ featureId: FEATURE, baseline, access: "read_write" });
    expect(opened.ok, opened.ok ? "" : opened.message).toBe(true);

    if (!opened.ok) {
      return;
    }

    const directory = opened.workspace.workingDirectory;
    await writeFile(join(directory, EDITED), "export const value = 2;\n", "utf8");
    const manifest = await recordInto(directory, "implementation");

    const inspected = await workspace.inspect({ workspace: opened.workspace });
    expect(inspected.ok).toBe(true);

    if (!inspected.ok) {
      return;
    }

    // The exact value the publish path derives from the measured change set, composed the way
    // orchestrator.ts composes it: `withoutFrameworkRecordings` around `approvedPathsOf`.
    const paths = approvedPathsOf(withoutFrameworkRecordings(inspected.inspection.changes));
    expect(paths).toContain(EDITED);
    expect(
      inspected.inspection.changes.untracked.filter((path) => path.startsWith(".agentflow/")),
      "the measured change set still carries the framework's recordings; only the publish path drops them",
    ).not.toEqual([]);

    const approval: PushApprovalRecord = {
      decision: "approved",
      featureId: FEATURE,
      approvedAt: CLOCK,
      approvedRevision: 1,
      actor: "human@example.invalid",
      summarySha256: "a".repeat(64),
      summaryRevision: 1,
      workingTreeFingerprint: inspected.inspection.fingerprint,
      finalGateStatus: "passed",
      finalGateRevision: 1,
      finalGateFingerprint: inspected.inspection.fingerprint,
      finalGateSha256: "b".repeat(64),
    };
    const branch = buildFeatureBranch({ featureId: FEATURE, approval });
    const message = buildFeatureCommitMessage({ featureId: FEATURE, title: "Publish the approved edit", approval });

    expect(branch.ok && message.ok).toBe(true);

    if (!branch.ok || !message.ok) {
      return;
    }

    const committed = await new GitFeaturePublisher().commitFeature({
      workspace: opened.workspace,
      featureId: FEATURE,
      branch: branch.branch,
      commitMessage: message.message,
      paths,
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: approval.summarySha256 },
    });

    expect(committed.ok, committed.ok ? "" : committed.message).toBe(true);

    if (!committed.ok) {
      return;
    }

    const tree = git(fixture.root, "ls-tree", "-r", "--name-only", committed.commit)
      .split("\n")
      .filter((path) => path !== "");

    expect(tree).toContain(EDITED);
    expect(
      tree.filter((path) => path.startsWith(".agentflow/")),
      `the recordings written by the real recorder (${manifest}) must not be in the published commit`,
    ).toEqual([]);

    await workspace.close(opened.workspace);
  });

  it("publishes the approved change and none of the framework's recordings", async () => {
    const fixture = await makeFixture();
    const store = createFeatureSessionStore(fixture.storeRoot, { clock: () => CLOCK });
    const executor = new FakeStageExecutor();

    executor.configure("grill", {
      artifacts: [
        { name: "grill", content: { featureId: FEATURE, decisions: [] } },
        { name: "spec", content: SPEC_ARTIFACT },
      ],
    });
    executor.configure("planning", { artifacts: [{ name: "plan", content: PLAN_ARTIFACT }] });

    // The agent's edit, and the transport's own recording of the stage that made it — the pair that
    // really exists in a worktree when the publisher stages.
    const manifests: string[] = [];
    let worktree = "";
    executor.configure("implementation", {
      after: async (request) => {
        await writeFile(join(request.workspace.workingDirectory, EDITED), "export const value = 2;\n", "utf8");
        worktree = request.workspace.workingDirectory;
        manifests.push(await recordInto(request.workspace.workingDirectory, "implementation"));
      },
    });
    executor.configure("security_review", {
      after: async (request) => {
        manifests.push(await recordInto(request.workspace.workingDirectory, "security_review"));
      },
    });

    const workspace = new GitWorkspaceProvider({ cacheRoot: fixture.cacheRoot, isoNow: () => CLOCK });
    const orchestrator = createWorkflowOrchestrator({
      store,
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
      workspace,
      publisher: new GitFeaturePublisher(),
      projectRoot: fixture.root,
      publishRemote: "origin",
    });

    const seen: string[] = [];
    const runTo = async (target: WorkflowState): Promise<void> => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const session = await store.load(FEATURE);

        if (session.machine.state === target) {
          return;
        }

        if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
          await orchestrator.approvePlan(FEATURE);
          continue;
        }

        const result = await orchestrator.runNext(FEATURE);
        seen.push(
          `${result.stage ?? "?"}:${result.status}${result.error === null ? "" : ` (${result.error.code})`}`,
        );
      }

      throw new Error(`The workflow never reached "${target}". Steps: ${seen.join(" -> ")}`);
    };

    await orchestrator.createFeature({
      featureId: FEATURE,
      title: "Publish the recordings-free change",
      request: "# Request\n\nPublish an approved change.\n",
    });
    await runTo(WorkflowState.FinalSummary);
    await orchestrator.runNext(FEATURE);
    await runTo(WorkflowState.AwaitingPushApproval);

    // Non-vacuity: the recordings are on disk in the worktree the approval fingerprints, so a commit
    // built from that worktree could contain them.
    expect(manifests.length).toBe(2);
    const relative = manifests.map((path) => path.slice(worktree.length + 1));
    expect(relative.every((path) => path.startsWith(".agentflow/recordings/"))).toBe(true);

    await orchestrator.approvePush(FEATURE);
    await runTo(WorkflowState.Committing);

    const committed = await orchestrator.publishFeature(FEATURE);
    expect(committed.status, seen.join(" -> ")).toBe("committed");
    const pushed = await orchestrator.publishFeature(FEATURE);
    expect(pushed.status).toBe("published");

    const record = (await store.readArtifact(FEATURE, "publish")) as { readonly branch: string };
    const changed = git(fixture.remote, "show", "--name-status", "--format=", record.branch)
      .trim()
      .split("\n")
      .sort();

    // The whole published change set: the approved edit and nothing else.
    expect(changed).toEqual([`M\t${EDITED}`]);
    expect(changed.some((line) => line.includes(".agentflow/"))).toBe(false);

    const tree = git(fixture.remote, "ls-tree", "-r", "--name-only", record.branch).split("\n");
    expect(tree.some((path) => path.startsWith(".agentflow/recordings/"))).toBe(false);
  });
});
