import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { formatCatalogCode } from "../apps/cli/src/error-catalog.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { FakeStageExecutor, findingFor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider, failedSecurityReviewFor } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Task Z, item 6: what a run prints when a stage failed on a deterministic measurement.
 *
 * The message these tests pin used to say "Read the findings with the status command, repair the
 * defect, then re-run" — a defect the human had never been shown, and a re-run that would read the
 * same tree and produce the same failure. What it has to say instead is the check that failed, the
 * paths that check measured (summarized, because the findings below the message already carry the
 * full list), that re-running without changing those paths changes nothing, and where the record of
 * the measurement lives.
 *
 * The first three tests pin the text the catalog prints for a caller that hands it the evidence. The
 * last one is a run: the real CLI, the real orchestrator, a security review that really failed with
 * five measured paths, so the derivation from a run result to that text is exercised rather than
 * assumed.
 */

const FEATURE = "F-001";

/**
 * A width the wrapper never reaches, so an assertion is about the words the catalog chose rather
 * than about where the 100-column wrap happened to break them. Wrapping itself is asserted once,
 * at the real width, below.
 */
const WIDE = 400;

/** What the failed check measured: five paths, so the summary has something to leave out. */
const MEASURED = [
  "src/app.ts",
  "scripts/build.sh",
  "docs/setup.md",
  "extra/one.txt",
  "extra/two.txt",
];

const roots: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-task-z-item6-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "cli@example.invalid");
  git(repoRoot, "config", "user.name", "CLI Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(join(repoRoot, "package.json"), '{"name":"test","version":"1.0.0"}', "utf8");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "--quiet", "-m", "initial");
  return repoRoot;
}

async function runCli(
  args: readonly string[],
  options: { readonly repoRoot: string; readonly createStack: (repoRoot: string, request: CliStackRequest) => CliStack },
): Promise<{ exitCodes: readonly number[]; stdout: string; stderr: string }> {
  const exitCodes: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    const cli = createCli({
      createStack: options.createStack,
      cwd: () => options.repoRoot,
      exit: (code: number) => {
        exitCodes.push(code);
      },
    });
    await cli.parseAsync(["node", "agentflow", ...args]);
  } finally {
    vi.restoreAllMocks();
  }

  return { exitCodes, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("item 6: the catalog's stage-failure message", () => {
  it("names the check, summarizes the paths, says a re-run reports the same failure, and points at the evidence", () => {
    const lines = formatCatalogCode("stage_failed", {
      featureId: FEATURE,
      stage: "security_review",
      checkId: "shell_execution",
      failedPaths: MEASURED,
      evidencePath: null,
    }, WIDE).join("\n");

    expect(lines).toContain("(stage_failed)");
    expect(lines).toContain('Check "shell_execution" failed on 5 path(s): src/app.ts, scripts/build.sh, docs/setup.md (+2 more)');
    expect(lines).toContain("reports the same failure");
    expect(lines).toContain("re-running is not the repair");
    expect(lines).toContain("Evidence: .agentflow/features/F-001/");

    // The defect a human was never shown is not what this message asks them to repair.
    expect(lines).not.toContain("repair the defect");

    // No placeholder reaches a printed line, and the wrapped message stays inside the width the CLI
    // prints at.
    expect(lines).not.toContain("<id>");
    expect(lines).not.toContain("<stage>");
    const wrapped = formatCatalogCode("stage_failed", {
      featureId: FEATURE,
      stage: "security_review",
      checkId: "shell_execution",
      failedPaths: MEASURED,
      evidencePath: null,
    }).join("\n");
    for (const line of wrapped.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it("reads the same way for the orchestrator's own stage_reported_failure code", () => {
    const lines = formatCatalogCode("stage_reported_failure", {
      featureId: FEATURE,
      stage: "security_review",
      checkId: "shell_execution",
      failedPaths: MEASURED,
      evidencePath: null,
    }, WIDE).join("\n");

    expect(lines).toContain('Check "shell_execution" failed on 5 path(s): src/app.ts, scripts/build.sh, docs/setup.md (+2 more)');
    expect(lines).toContain("reports the same failure");
    expect(lines).not.toContain("repair the defect");
  });

  it("without a recorded check id it points at the findings and the evidence instead of promising that a repair follows a re-run", () => {
    const lines = formatCatalogCode("stage_failed", {
      featureId: FEATURE,
      stage: "implementation",
      checkId: null,
      failedPaths: null,
      evidencePath: null,
    }, WIDE).join("\n");

    expect(lines).toContain("Read the findings this message carries, then the evidence it names");
    expect(lines).toContain("repeats the run rather than repairing it");
    expect(lines).toContain("Evidence: .agentflow/features/F-001/");
    expect(lines).not.toContain("repair the defect");
    // Determinism is claimed only for a measurement that was actually recorded.
    expect(lines).not.toContain("reports the same failure");
  });

  it("summarizes a single measured path without a count that implies more", () => {
    const lines = formatCatalogCode("stage_failed", {
      featureId: FEATURE,
      stage: "security_review",
      checkId: "protected_configuration_changed",
      failedPaths: [".agentflow/plan.json"],
      evidencePath: "/home/someone/.cache/agent-workflow-kit/workspaces/abc/.agentflow/recordings/F-001/security_review",
    }, WIDE).join("\n");

    expect(lines).toContain('Check "protected_configuration_changed" failed on 1 path(s): .agentflow/plan.json.');
    expect(lines).not.toContain("more)");
    expect(lines).toContain(
      "Evidence: /home/someone/.cache/agent-workflow-kit/workspaces/abc/.agentflow/recordings/F-001/security_review",
    );
    expect(lines).not.toContain("repair the defect");
  });
});

describe("item 6: the CLI's own failure output for a run that failed", () => {
  it("prints the check id, the measured paths, and the evidence location — never an instruction to repair an unseen defect", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    executor.configure("grill", {
      artifacts: [
        { name: "grill", content: { featureId: FEATURE, decisions: [] } },
        { name: "spec", content: { schemaVersion: 1, featureId: FEATURE, summary: "s", requirements: [] } },
      ],
    });
    executor.configure("planning", {
      artifacts: [{ name: "plan", content: { schemaVersion: 1, featureId: FEATURE, summary: "p", steps: [] } }],
    });
    executor.configure("plan_review", {
      outcome: "success",
      artifacts: [{ name: "plan_review", content: { verdict: "pass", summary: "Clean.", findings: [] } }],
    });
    executor.configure("implementation", {
      outcome: "success",
      artifacts: [{ name: "implementation", content: { featureId: FEATURE, notes: "done" } }],
    });
    executor.configure("code_review", { outcome: "success" });
    executor.configure("scope_review", { outcome: "success" });
    executor.configure("static_verification", { outcome: "success" });
    executor.configure("test_verification", { outcome: "success" });
    executor.configure("runtime_verification", { outcome: "success" });
    // The stage reports failure itself, over a security record that also failed a check with five
    // measured paths: the result carries both, and the message must state the measurement.
    executor.configure("security_review", {
      outcome: "failed",
      // A failed stage may not carry artifacts, so the one this run reports failure with is empty.
      artifacts: [],
      findings: [findingFor(FEATURE, "The security review found execution the plan did not describe.")],
      summary: "The security review failed.",
    });

    const workspace = createFakeWorkspaceProvider();
    const createStack = (root: string) =>
      createOrchestratorStack(root, {
        executor,
        verification: createFakeVerificationProvider(),
        security: createFakeSecurityProvider((request) =>
          failedSecurityReviewFor(
            request,
            "shell_execution",
            MEASURED,
            "The stage's reply introduced a shell invocation the approved plan does not describe.",
          ),
        ),
        workspace,
      });

    await runCli(["start", "-i", FEATURE, "-t", "Fail the security review"], { repoRoot, createStack });

    const stack = createStack(repoRoot);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const session = await stack.store.load(FEATURE);

      if (session.machine.state === WorkflowState.SecurityReview) {
        break;
      }

      if (session.machine.state === WorkflowState.AwaitingPlanApproval) {
        await stack.orchestrator.approvePlan(FEATURE);
        continue;
      }

      await stack.orchestrator.runNext(FEATURE);
    }

    const ran = await runCli(["run", FEATURE], { repoRoot, createStack });
    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("(stage_failed)");
    expect(ran.stderr).not.toContain("Unknown error");
    expect(ran.stderr).not.toContain("repair the defect");

    // The wrapped message read back as one line, so the assertions are about the words rather than
    // about where the 100-column wrapper happened to break them. The paths are the validator's own
    // order: the security record's check parser sorts every check's paths as it reads them
    // (orchestration/src/security.ts:542), so a record handed in unsorted leaves in sorted order.
    const flat = ran.stderr.split("\n").join(" ").replace(/\s+/g, " ");
    const sorted = [...MEASURED].sort();
    expect(flat).toContain(
      `Check "shell_execution" failed on 5 path(s): ${sorted.slice(0, 3).join(", ")} (+2 more)`,
    );
    expect(flat).toContain("reports the same failure");
    expect(flat).toContain("Evidence: .agentflow/features/F-001/");

    for (const line of ran.stderr.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});
