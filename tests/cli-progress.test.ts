import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  StageExecutionRequest,
  StageExecutionResult,
  StageExecutor,
} from "@agent-workflow-kit/orchestration";
import { createCli, type CliStack, type CliStackRequest } from "../apps/cli/src/commands.js";
import { createStageProgressReporter, type ProgressTimers } from "../apps/cli/src/progress.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { SIDECAR_SUFFIX } from "@agent-workflow-kit/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";

/**
 * What the CLI prints while a stage runs, and what `status` reports about the last one.
 *
 * Nothing here reaches a model: the progress events come from an injected executor, and the
 * heartbeat comes from injected timers, so a test never waits thirty seconds to see a line.
 */

const roots: string[] = [];
const savedXdgCacheHome = process.env["XDG_CACHE_HOME"];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-cli-progress-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "progress@example.invalid");
  git(repoRoot, "config", "user.name", "Progress Test");
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

interface RunOptions {
  readonly repoRoot: string;
  readonly createStack?: (repoRoot: string, request: CliStackRequest) => CliStack;
}

async function runCli(args: readonly string[], options: RunOptions): Promise<CliRun> {
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

/**
 * A stack whose executor emits progress the way the OpenCode executor does, so the CLI's own
 * printing can be exercised without spawning anything.
 */
function progressStackFactory(): {
  readonly factory: (repoRoot: string, request: CliStackRequest) => CliStack;
  readonly stageTimeouts: number[];
  readonly formatRetries: number[];
} {
  const stageTimeouts: number[] = [];
  const formatRetries: number[] = [];
  const activity = ["\u2192 Read grill.json"];

  const factory = (repoRoot: string, request: CliStackRequest): CliStack => {
    if (request.stageTimeoutMs !== undefined) {
      stageTimeouts.push(request.stageTimeoutMs);
    }

    if (request.formatRetries !== undefined) {
      formatRetries.push(request.formatRetries);
    }

    const base = new FakeStageExecutor();
    base.configure("grill", {
      artifacts: [
        { name: "grill", content: { featureId: "F-001", decisions: [] } },
        {
          name: "spec",
          content: { schemaVersion: 1, featureId: "F-001", summary: "s", requirements: [] },
        },
      ],
    });
    base.configure("planning", {
      artifacts: [{ name: "plan", content: { schemaVersion: 1, featureId: "F-001", summary: "p", steps: [] } }],
    });

    const executor: StageExecutor = {
      async execute(stageRequest: StageExecutionRequest): Promise<StageExecutionResult> {
        request.onProgress?.({ type: "stage_started", stage: stageRequest.stage });
        const result = await base.execute(stageRequest);

        for (const line of activity) {
          request.onProgress?.({ type: "activity", stage: stageRequest.stage, line });
        }

        request.onProgress?.({ type: "stage_finished", stage: stageRequest.stage, elapsedMs: 12_000 });
        return result;
      },
    };

    return createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
  };

  return { factory, stageTimeouts, formatRetries };
}

async function startFeature(repoRoot: string, factory: ReturnType<typeof progressStackFactory>["factory"]): Promise<void> {
  const started = await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], {
    repoRoot,
    createStack: factory,
  });

  expect(started.exitCodes).toEqual([]);
}

/** Timers a test drives by hand: the interval only fires when the test says so. */
function manualTimers(): { readonly timers: ProgressTimers; readonly tick: () => void } {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();

  return {
    timers: {
      setInterval: (callback: () => void): number => {
        const handle = nextHandle;
        nextHandle += 1;
        callbacks.set(handle, callback);
        return handle;
      },
      clearInterval: (handle: unknown): void => {
        if (typeof handle === "number") {
          callbacks.delete(handle);
        }
      },
    },
    tick: (): void => {
      for (const callback of [...callbacks.values()]) {
        callback();
      }
    },
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

describe("the stage progress reporter", () => {
  it("prints started, a heartbeat every 30s from injected timers, and finished", () => {
    const printed: string[] = [];
    const { timers, tick } = manualTimers();
    let now = 1_000_000;

    const report = createStageProgressReporter({
      write: (line) => {
        printed.push(line);
      },
      now: () => now,
      timers,
    });

    report({ type: "stage_started", stage: "grill" });
    now += 30_000;
    tick();
    now += 30_000;
    tick();
    now += 30_000;
    tick();
    report({ type: "stage_finished", stage: "grill", elapsedMs: 90_000 });

    expect(printed).toEqual([
      "stage grill started",
      "grill: still running, 30s elapsed",
      "grill: still running, 60s elapsed",
      "grill: still running, 90s elapsed",
      "stage grill finished in 90s",
    ]);
  });

  it("stops the heartbeat when the stage finishes", () => {
    const printed: string[] = [];
    const { timers, tick } = manualTimers();
    let now = 0;

    const report = createStageProgressReporter({
      write: (line) => {
        printed.push(line);
      },
      now: () => now,
      timers,
    });

    report({ type: "stage_started", stage: "grill" });
    report({ type: "stage_finished", stage: "grill", elapsedMs: 1_000 });
    now = 60_000;
    tick();

    expect(printed).toEqual(["stage grill started", "stage grill finished in 1s"]);
  });

  it("prints tool-use lines as they come and drops everything else, prompt included", () => {
    const printed: string[] = [];
    const report = createStageProgressReporter({
      write: (line) => {
        printed.push(line);
      },
      timers: manualTimers().timers,
    });

    report({ type: "stage_started", stage: "grill" });
    report({ type: "activity", stage: "grill", line: "\u001b[0m\u2192 \u001b[0mRead a.ts\u001b[0m" });
    report({ type: "activity", stage: "grill", line: "> agentflow-write \u00b7 big-pickle" });
    report({
      type: "activity",
      stage: "grill",
      line: "# Agent Workflow Kit: Implementer on stage `grill`\nSECRET-PROMPT-CONTENT",
    });
    report({ type: "activity", stage: "grill", line: `\u2192 Read ${"x".repeat(500)}` });

    expect(printed[0]).toBe("stage grill started");
    expect(printed[1]).toBe("\u2192 Read a.ts");
    expect(printed[2]?.length).toBeLessThanOrEqual(120);
    expect(printed.join("\n")).not.toContain("SECRET-PROMPT-CONTENT");
    expect(printed.join("\n")).not.toContain("big-pickle");
    expect(printed).toHaveLength(3);
  });

  it("prints nothing for progress under quiet, but still names a failed stage's recording", () => {
    const printed: string[] = [];
    const { timers, tick } = manualTimers();

    const report = createStageProgressReporter({
      write: (line) => {
        printed.push(line);
      },
      now: () => 0,
      timers,
      quiet: true,
    });

    report({ type: "stage_started", stage: "grill" });
    report({ type: "activity", stage: "grill", line: "\u2192 Read a.ts" });
    tick();
    report({ type: "stage_finished", stage: "grill", elapsedMs: 45_000 });
    report({
      type: "stage_failed",
      stage: "grill",
      elapsedMs: 45_000,
      recordingFolder: "/home/someone/.cache/agent-workflow-kit/workspaces/abc/.agentflow/recordings/F-001/grill",
    });

    expect(printed).toEqual([
      "stage grill failed after 45s; recording folder: /home/someone/.cache/agent-workflow-kit/workspaces/abc/.agentflow/recordings/F-001/grill",
    ]);
  });

  it("prints a reply-retry line naming the code and which retry it is", () => {
    const printed: string[] = [];
    const report = createStageProgressReporter({
      write: (line) => {
        printed.push(line);
      },
      timers: manualTimers().timers,
    });

    report({
      type: "format_retry",
      stage: "grill",
      code: "malformed_response",
      retry: 1,
      maxRetries: 2,
    });
    report({
      type: "format_retry",
      stage: "grill",
      code: "empty_response",
      retry: 2,
      maxRetries: 2,
    });

    expect(printed).toEqual([
      "grill: reply rejected (malformed_response), retry 1 of 2",
      "grill: reply rejected (empty_response), retry 2 of 2",
    ]);
  });

  it("keeps reply-retry lines quiet, like every other progress line", () => {
    const printed: string[] = [];
    const report = createStageProgressReporter({
      write: (line) => {
        printed.push(line);
      },
      timers: manualTimers().timers,
      quiet: true,
    });

    report({
      type: "format_retry",
      stage: "grill",
      code: "malformed_response",
      retry: 1,
      maxRetries: 2,
    });

    expect(printed).toEqual([]);
  });
});

describe("agentflow run progress", () => {
  it("prints one started and one finished line per stage on stderr, leaving stdout alone", async () => {
    const repoRoot = await makeRepo();
    const { factory } = progressStackFactory();
    await startFeature(repoRoot, factory);

    const ran = await runCli(["run", "F-001"], { repoRoot, createStack: factory });

    expect(ran.exitCodes).toEqual([]);
    expect(ran.stderr.split("\n")).toEqual([
      "stage grill started",
      "\u2192 Read grill.json",
      "stage grill finished in 12s",
      "stage planning started",
      "\u2192 Read grill.json",
      "stage planning finished in 12s",
      "stage plan_review started",
      "\u2192 Read grill.json",
      "stage plan_review finished in 12s",
    ]);
    expect(ran.stdout).toContain("Workflow paused at awaiting_plan_approval");
  });

  it("prints nothing extra under --quiet", async () => {
    const repoRoot = await makeRepo();
    const { factory } = progressStackFactory();
    await startFeature(repoRoot, factory);

    const ran = await runCli(["run", "F-001", "--quiet"], { repoRoot, createStack: factory });

    expect(ran.exitCodes).toEqual([]);
    expect(ran.stderr).toBe("");
    expect(ran.stdout).toContain("Workflow paused at awaiting_plan_approval");
  });

  it("passes --stage-timeout to the stack in milliseconds, and defaults to 900s", async () => {
    const repoRoot = await makeRepo();
    const explicit = progressStackFactory();
    await startFeature(repoRoot, explicit.factory);
    await runCli(["run", "F-001", "--stage-timeout", "45"], {
      repoRoot,
      createStack: explicit.factory,
    });
    expect(explicit.stageTimeouts).toEqual([45_000]);

    const defaults = progressStackFactory();
    await runCli(["run", "F-001"], { repoRoot, createStack: defaults.factory });
    expect(defaults.stageTimeouts).toEqual([900_000]);
  });

  it("refuses a stage timeout that is not a positive number of seconds", async () => {
    const repoRoot = await makeRepo();
    const { factory } = progressStackFactory();
    await startFeature(repoRoot, factory);

    const ran = await runCli(["run", "F-001", "--stage-timeout", "0"], {
      repoRoot,
      createStack: factory,
    });

    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("--stage-timeout");
  });

  it("passes --format-retries to the stack, defaults to 2, and accepts 0 as a real answer", async () => {
    const repoRoot = await makeRepo();

    const explicit = progressStackFactory();
    await startFeature(repoRoot, explicit.factory);
    await runCli(["run", "F-001", "--format-retries", "1"], {
      repoRoot,
      createStack: explicit.factory,
    });
    expect(explicit.formatRetries).toEqual([1]);

    const disabled = progressStackFactory();
    await runCli(["run", "F-001", "--format-retries", "0"], {
      repoRoot,
      createStack: disabled.factory,
    });
    expect(disabled.formatRetries).toEqual([0]);

    const defaults = progressStackFactory();
    await runCli(["run", "F-001"], { repoRoot, createStack: defaults.factory });
    expect(defaults.formatRetries).toEqual([2]);
  });

  it("refuses a --format-retries value that is not a whole number of retries", async () => {
    const repoRoot = await makeRepo();
    const { factory } = progressStackFactory();
    await startFeature(repoRoot, factory);

    const ran = await runCli(["run", "F-001", "--format-retries", "many"], {
      repoRoot,
      createStack: factory,
    });

    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("--format-retries");
  });
});

interface RecordingSpec {
  readonly featureId: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly durationMs: number;
}

/** The directory name the recorder itself uses: a compact UTC stamp plus a short suffix. */
function compactStamp(startedAt: string): string {
  const parsed = Date.parse(startedAt);
  const iso = Number.isNaN(parsed) ? startedAt : new Date(parsed).toISOString();

  return iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

async function writeRecording(base: string, spec: RecordingSpec): Promise<string> {
  const folder = join(
    base,
    ".agentflow",
    "recordings",
    spec.featureId,
    spec.stage,
    `${compactStamp(spec.startedAt)}-aaaa`,
  );
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "invocation.json"),
    `${JSON.stringify(
      {
        featureId: spec.featureId,
        stage: spec.stage,
        command: "opencode",
        args: [],
        cwd: base,
        startedAt: spec.startedAt,
        durationMs: spec.durationMs,
        termination: "exited",
        exitCode: 0,
        error: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return folder;
}

describe("agentflow status", () => {
  it("prints the last stage, its elapsed time, and its recording folder", async () => {
    const repoRoot = await makeRepo();
    const { factory } = progressStackFactory();
    await startFeature(repoRoot, factory);

    await writeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 30_000,
    });
    const latest = await writeRecording(repoRoot, {
      featureId: "F-001",
      stage: "planning",
      startedAt: "2026-01-02T00:00:00.000Z",
      durationMs: 836_000,
    });

    const status = await runCli(["status", "F-001"], { repoRoot, createStack: factory });

    expect(status.exitCodes).toEqual([]);
    expect(status.stdout).toContain("Feature: F-001");
    expect(status.stdout).toContain("Last stage: planning");
    expect(status.stdout).toContain("Last stage elapsed: 836s");
    expect(status.stdout).toContain(`Recording folder: ${latest}`);
  });

  it("finds a write stage's recording in the workspace cache", async () => {
    const repoRoot = await makeRepo();
    const { factory } = progressStackFactory();
    await startFeature(repoRoot, factory);

    await writeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 30_000,
    });

    const cacheHome = join(dirname(repoRoot), "cache-home");
    process.env["XDG_CACHE_HOME"] = cacheHome;

    const workspace = join(cacheHome, "agent-workflow-kit", "workspaces", "abc123");
    const latest = await writeRecording(workspace, {
      featureId: "F-001",
      stage: "implementation",
      startedAt: "2026-01-03T00:00:00.000Z",
      durationMs: 600_000,
    });
    await writeFile(
      join(dirname(workspace), `abc123${SIDECAR_SUFFIX}`),
      `${JSON.stringify(
        {
          version: 1,
          workspaceId: "abc123",
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

    const status = await runCli(["status", "F-001"], { repoRoot, createStack: factory });

    expect(status.exitCodes).toEqual([]);
    expect(status.stdout).toContain("Last stage: implementation");
    expect(status.stdout).toContain("Last stage elapsed: 600s");
    expect(status.stdout).toContain(`Recording folder: ${latest}`);
    expect(status.stdout).toContain(join("workspaces", "abc123"));
  });
});

describe("the run loop keeps its state machine output", () => {
  it("reports the same states as before, with progress on stderr only", async () => {
    const repoRoot = await makeRepo();
    const { factory } = progressStackFactory();
    await startFeature(repoRoot, factory);

    const ran = await runCli(["run", "F-001"], { repoRoot, createStack: factory });

    expect(ran.exitCodes).toEqual([]);
    expect(ran.stdout.split("\n")[0]).toBe(
      "Workflow paused at awaiting_plan_approval - awaiting approve_plan",
    );
    expect(ran.stdout).toContain("Run 'agentflow approve plan' or 'agentflow approve push' to continue.");
  });
});
