import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  annotateInvocationUsage,
  isAvailableUsage,
  parseUsageFromExport,
  usageFromManifestValue,
  type InvocationUsage,
} from "@agent-workflow-kit/opencode";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { collectUsage, formatUsageTable, formatUsageTotalsLine, usageToJson } from "../apps/cli/src/usage.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { SIDECAR_SUFFIX } from "@agent-workflow-kit/workspace";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";

/**
 * Task P: token usage per feature, recorded best-effort and reported.
 *
 * No real model calls here: every recording is fake data written directly to
 * `invocation.json`, covering retries (several attempts for one stage),
 * missing usage (no `usage` field or an unavailable marker), and both
 * recording locations (the project's own recordings and the workspace cache).
 */

const roots: string[] = [];
const savedXdgCacheHome = process.env["XDG_CACHE_HOME"];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-usage-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "usage@example.invalid");
  git(repoRoot, "config", "user.name", "Usage Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(join(repoRoot, "package.json"), '{"name":"test","version":"1.0.0"}', "utf8");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "--quiet", "-m", "initial");
  return repoRoot;
}

interface CliRun {
  readonly exitCodes: readonly number[];
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  args: readonly string[],
  options: { repoRoot: string; createStack?: (repoRoot: string, request: CliStackRequest) => CliStack },
): Promise<CliRun> {
  const exitCodes: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.join(" "));
  });

  try {
    const cli = createCli({
      ...(options.createStack === undefined ? {} : { createStack: options.createStack }),
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

function fakeStackFactory(executor: FakeStageExecutor) {
  executor.configure("grill", {
    artifacts: [{ name: "grill", content: { featureId: "F-001", decisions: [] } }],
  });

  return (repoRoot: string) =>
    createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
}

async function startFeature(repoRoot: string, executor: FakeStageExecutor): Promise<void> {
  await runCli(["start", "-i", "F-001", "-t", "Usage"], {
    repoRoot,
    createStack: fakeStackFactory(executor),
  });
}

function compactStamp(startedAt: string): string {
  const parsed = Date.parse(startedAt);
  const iso = Number.isNaN(parsed) ? startedAt : new Date(parsed).toISOString();

  return iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

interface FakeRecordingSpec {
  readonly featureId: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly attempt?: number;
  readonly responseOutcome?: string;
  readonly usage?: unknown;
}

async function writeFakeRecording(base: string, spec: FakeRecordingSpec, suffix = "aaaa"): Promise<string> {
  const folder = join(
    base,
    ".agentflow",
    "recordings",
    spec.featureId,
    spec.stage,
    `${compactStamp(spec.startedAt)}-${suffix}`,
  );
  await mkdir(folder, { recursive: true });

  const manifest: Record<string, unknown> = {
    featureId: spec.featureId,
    stage: spec.stage,
    command: "opencode",
    args: ["run", "--standalone"],
    cwd: base,
    startedAt: spec.startedAt,
    durationMs: spec.durationMs,
    termination: "exited",
    exitCode: 0,
    error: null,
  };

  if (spec.attempt !== undefined) {
    manifest["attempt"] = spec.attempt;
  }

  if (spec.responseOutcome !== undefined) {
    manifest["responseOutcome"] = spec.responseOutcome;
  }

  if (spec.usage !== undefined) {
    manifest["usage"] = spec.usage;
  }

  await writeFile(join(folder, "invocation.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(folder, "stdout.txt"), "fake stdout", "utf8");
  await writeFile(join(folder, "stderr.txt"), "", "utf8");

  return folder;
}

function availableUsage(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: "available",
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cacheReadTokens: 1000,
    cacheWriteTokens: 0,
    cost: 0,
    source: "opencode-session-export",
    sessionId: "ses_fake1",
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();

  if (savedXdgCacheHome === undefined) {
    delete process.env["XDG_CACHE_HOME"];
  } else {
    process.env["XDG_CACHE_HOME"] = savedXdgCacheHome;
  }

  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("usage parsing", () => {
  it("parses a real session-export shape with cost 0 and tokens > 0 for a free model", () => {
    const exported = {
      info: {
        id: "ses_probe",
        cost: 0,
        tokens: { input: 8663, output: 2, reasoning: 0, cache: { read: 1408, write: 0 } },
      },
    };

    const usage = parseUsageFromExport(exported, "ses_probe");

    expect(isAvailableUsage(usage)).toBe(true);

    if (isAvailableUsage(usage)) {
      expect(usage.inputTokens).toBe(8663);
      expect(usage.outputTokens).toBe(2);
      expect(usage.reasoningTokens).toBe(0);
      expect(usage.cacheReadTokens).toBe(1408);
      expect(usage.cacheWriteTokens).toBe(0);
      expect(usage.cost).toBe(0);
      expect(usage.source).toBe("opencode-session-export");
      expect(usage.sessionId).toBe("ses_probe");
    }
  });

  it("returns unavailable for a malformed export rather than throwing", () => {
    for (const bad of [null, [], {}, { info: null }, { info: { tokens: null } }, { info: { tokens: {}, cost: -1 } }]) {
      const usage = parseUsageFromExport(bad, "ses_x");
      expect(usage.status).toBe("unavailable");
    }
  });

  it("reads available, unavailable, and missing usage from a manifest value", () => {
    expect(usageFromManifestValue({ usage: availableUsage() })?.status).toBe("available");
    expect(usageFromManifestValue({ usage: { source: "unavailable", status: "unavailable" } })?.status).toBe(
      "unavailable",
    );
    expect(usageFromManifestValue({ usage: "unavailable" })?.status).toBe("unavailable");
    expect(usageFromManifestValue({})).toBeNull();
    expect(usageFromManifestValue(null)).toBeNull();
  });

  it("annotates a manifest with usage while keeping the Task M fields", async () => {
    const base = await mkdtemp(join(tmpdir(), "agent-workflow-usage-annotate-"));
    roots.push(base);
    const folder = join(base, "invocation");
    await mkdir(folder, { recursive: true });
    const manifestPath = join(folder, "invocation.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ stage: "planning", attempt: 2, responseOutcome: "accepted" })}\n`,
      "utf8",
    );

    const usage: InvocationUsage = {
      status: "available",
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      cost: 0,
      source: "opencode-session-export",
      sessionId: "ses_1",
    };
    await annotateInvocationUsage(manifestPath, usage);

    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(parsed["attempt"]).toBe(2);
    expect(parsed["responseOutcome"]).toBe("accepted");
    expect(usageFromManifestValue(parsed)?.status).toBe("available");
  });
});

describe("usage aggregation", () => {
  it("counts every attempt including retries of one stage and sums available usage", async () => {
    const repoRoot = await makeRepo();

    // planning attempted 3 times (Task M retry shape): two rejections then accepted.
    await writeFakeRecording(
      repoRoot,
      {
        featureId: "F-001",
        stage: "planning",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 1000,
        attempt: 1,
        responseOutcome: "malformed_response",
        usage: availableUsage({ inputTokens: 100, outputTokens: 10, sessionId: "ses_a1" }),
      },
      "a001",
    );
    await writeFakeRecording(
      repoRoot,
      {
        featureId: "F-001",
        stage: "planning",
        startedAt: "2026-01-01T00:01:00.000Z",
        durationMs: 1000,
        attempt: 2,
        responseOutcome: "empty_response",
        usage: availableUsage({ inputTokens: 200, outputTokens: 20, sessionId: "ses_a2" }),
      },
      "a002",
    );
    await writeFakeRecording(
      repoRoot,
      {
        featureId: "F-001",
        stage: "planning",
        startedAt: "2026-01-01T00:02:00.000Z",
        durationMs: 1000,
        attempt: 3,
        responseOutcome: "accepted",
        usage: availableUsage({ inputTokens: 300, outputTokens: 30, sessionId: "ses_a3" }),
      },
      "a003",
    );

    const summary = await collectUsage(repoRoot, "F-001");

    expect(summary.attemptCount).toBe(3);
    expect(summary.availableCount).toBe(3);
    expect(summary.unavailableCount).toBe(0);
    expect(summary.inputTokens).toBe(600);
    expect(summary.outputTokens).toBe(60);
    expect(summary.cost).toBe(0);
  });

  it("counts attempts with missing usage as unavailable without changing the totals", async () => {
    const repoRoot = await makeRepo();

    await writeFakeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 500,
      usage: availableUsage({ inputTokens: 50, outputTokens: 5 }),
    });
    // No usage field at all: an old recording from before usage existed.
    await writeFakeRecording(
      repoRoot,
      {
        featureId: "F-001",
        stage: "planning",
        startedAt: "2026-01-01T00:01:00.000Z",
        durationMs: 500,
      },
      "b002",
    );
    // Explicit unavailable marker: a lookup that failed best-effort.
    await writeFakeRecording(
      repoRoot,
      {
        featureId: "F-001",
        stage: "plan_review",
        startedAt: "2026-01-01T00:02:00.000Z",
        durationMs: 500,
        usage: { status: "unavailable", source: "unavailable", reason: "no sessions listed" },
      },
      "b003",
    );

    const summary = await collectUsage(repoRoot, "F-001");

    expect(summary.attemptCount).toBe(3);
    expect(summary.availableCount).toBe(1);
    expect(summary.unavailableCount).toBe(2);
    expect(summary.inputTokens).toBe(50);
    expect(summary.outputTokens).toBe(5);

    const table = formatUsageTable("F-001", summary);
    expect(table).toContain("as reported by OpenCode, best effort");
    expect(table).toContain("unavailable");
    expect(table).toContain("3 attempt(s)");
  });

  it("includes write-stage recordings from the workspace cache", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    await startFeature(repoRoot, executor);

    await writeFakeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1000,
      usage: availableUsage({ inputTokens: 10, outputTokens: 1, sessionId: "ses_read" }),
    });

    const cacheHome = join(dirname(repoRoot), "cache-home");
    process.env["XDG_CACHE_HOME"] = cacheHome;
    const workspace = join(cacheHome, "agent-workflow-kit", "workspaces", "ws123");

    await writeFakeRecording(
      workspace,
      {
        featureId: "F-001",
        stage: "implementation",
        startedAt: "2026-01-02T00:00:00.000Z",
        durationMs: 2000,
        usage: availableUsage({ inputTokens: 70, outputTokens: 7, sessionId: "ses_write" }),
      },
      "c001",
    );
    await writeFile(
      join(dirname(workspace), `ws123${SIDECAR_SUFFIX}`),
      `${JSON.stringify(
        {
          version: 1,
          workspaceId: "ws123",
          featureId: "F-001",
          repositoryRoot: repoRoot,
          baselineCommit: "a".repeat(40),
          approvedRevision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          lease: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const summary = await collectUsage(repoRoot, "F-001");

    expect(summary.attemptCount).toBe(2);
    expect(summary.inputTokens).toBe(80);
    expect(summary.outputTokens).toBe(8);

    const json = usageToJson("F-001", summary) as {
      attempts: Array<{ stage: string }>;
      totals: { inputTokens: number };
    };
    expect(json.attempts.map((entry) => entry.stage).sort()).toEqual(["grill", "implementation"]);
    expect(json.totals.inputTokens).toBe(80);
  });
});

describe("agentflow usage command", () => {
  it("prints a per-stage table plus totals labeled best effort, with a --json option", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    await startFeature(repoRoot, executor);

    await writeFakeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1000,
      attempt: 1,
      responseOutcome: "accepted",
      usage: availableUsage({ inputTokens: 10, outputTokens: 1 }),
    });
    await writeFakeRecording(
      repoRoot,
      {
        featureId: "F-001",
        stage: "grill",
        startedAt: "2026-01-01T00:01:00.000Z",
        durationMs: 1000,
        attempt: 2,
        responseOutcome: "accepted",
        usage: { status: "unavailable", source: "unavailable", reason: "export failed" },
      },
      "d002",
    );

    const table = await runCli(["usage", "F-001"], {
      repoRoot,
      createStack: fakeStackFactory(new FakeStageExecutor()),
    });

    expect(table.exitCodes).toEqual([]);
    expect(table.stdout).toContain("Usage for F-001 (as reported by OpenCode, best effort)");
    expect(table.stdout).toContain("grill");
    expect(table.stdout).toContain("unavailable");
    expect(table.stdout).toContain("2 attempt(s)");

    const jsonRun = await runCli(["usage", "F-001", "--json"], {
      repoRoot,
      createStack: fakeStackFactory(new FakeStageExecutor()),
    });

    expect(jsonRun.exitCodes).toEqual([]);
    const parsed = JSON.parse(jsonRun.stdout) as {
      attemptCount: number;
      totals: { inputTokens: number };
      attempts: unknown[];
      label: string;
    };
    expect(parsed.attemptCount).toBe(2);
    expect(parsed.totals.inputTokens).toBe(10);
    expect(parsed.attempts).toHaveLength(2);
    expect(parsed.label).toContain("best effort");
  });

  it("shows one totals line in status", async () => {
    const repoRoot = await makeRepo();
    const executor = new FakeStageExecutor();
    await startFeature(repoRoot, executor);

    await writeFakeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1000,
      usage: availableUsage({ inputTokens: 33, outputTokens: 3 }),
    });

    const status = await runCli(["status", "F-001"], {
      repoRoot,
      createStack: fakeStackFactory(new FakeStageExecutor()),
    });

    expect(status.exitCodes).toEqual([]);
    expect(status.stdout).toContain("Usage (as reported by OpenCode, best effort): 1 attempt(s)");
    expect(status.stdout).toContain("input 33");
    expect(formatUsageTotalsLine(await collectUsage(repoRoot, "F-001"))).toContain("best effort");
  });
});
