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
import { createStageProgressReporter } from "../apps/cli/src/progress.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import { formatCatalogCode } from "../apps/cli/src/error-catalog.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";

/**
 * Task Y's CLI-facing behaviour, and nothing else: the transient-retry progress line, the error
 * catalog's Detail handling (collapse and ANSI stripping), the Evidence line that names the
 * absolute recording folder, and the model `status` reports for the last stage.
 *
 * No test here reaches a model: the run error comes from a fake executor, the progress events are
 * handed to the reporter by hand, and the status recording is written as a manifest.
 */

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-task-y-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "task-y@example.invalid");
  git(repoRoot, "config", "user.name", "Task Y");
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

/** A stack whose first stage fails so a run can end in an error the CLI prints detail about. */
function failingStackFactory(): (repoRoot: string, request: CliStackRequest) => CliStack {
  return (repoRoot: string, request: CliStackRequest): CliStack => {
    const base = new FakeStageExecutor();
    base.configure("grill", { error: new Error("the agent crashed on a provider fault") });

    const executor: StageExecutor = {
      async execute(stageRequest: StageExecutionRequest): Promise<StageExecutionResult> {
        request.onProgress?.({ type: "stage_started", stage: stageRequest.stage });
        return base.execute(stageRequest);
      },
    };

    return createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
  };
}

async function startFeature(repoRoot: string, factory: (repoRoot: string, request: CliStackRequest) => CliStack): Promise<void> {
  const started = await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], {
    repoRoot,
    createStack: factory,
  });

  expect(started.exitCodes).toEqual([]);
}

interface RecordingSpec {
  readonly featureId: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly durationMs: number;
  /** The argv the invocation was launched with, as the manifest records it. */
  readonly args?: readonly string[];
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
        args: spec.args ?? [],
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

describe("the stage progress reporter: transient retries", () => {
  it("prints one line per transient retry, with the backoff in whole seconds", () => {
    const printed: string[] = [];
    const report = createStageProgressReporter({
      write: (line) => {
        printed.push(line);
      },
    });

    report({ type: "stage_started", stage: "grill" });
    report({
      type: "transient_retry",
      stage: "grill",
      retry: 1,
      maxRetries: 2,
      delayMs: 15_000,
    });
    report({
      type: "transient_retry",
      stage: "grill",
      retry: 2,
      maxRetries: 2,
      delayMs: 45_000,
    });
    report({ type: "stage_finished", stage: "grill", elapsedMs: 65_000 });

    expect(printed).toEqual([
      "stage grill started",
      "stage grill: provider connection error, retry 1 of 2 in 15s",
      "stage grill: provider connection error, retry 2 of 2 in 45s",
      "stage grill finished in 65s",
    ]);
  });

  it("silences the transient-retry line under --quiet, like every other progress line", () => {
    const printed: string[] = [];
    const report = createStageProgressReporter({
      write: (line) => {
        printed.push(line);
      },
      quiet: true,
    });

    report({ type: "stage_started", stage: "grill" });
    report({
      type: "transient_retry",
      stage: "grill",
      retry: 1,
      maxRetries: 2,
      delayMs: 15_000,
    });
    report({ type: "stage_finished", stage: "grill", elapsedMs: 16_000 });

    // Progress is silenced entirely under --quiet — but the failure line still gets through,
    // because it names the recording a human needs, not progress they asked to skip.
    expect(printed).toEqual([]);
    report({
      type: "stage_failed",
      stage: "grill",
      elapsedMs: 16_000,
      recordingFolder: "/recordings/F-001/grill",
    });
    expect(printed).toEqual(["stage grill failed after 16s; recording folder: /recordings/F-001/grill"]);
  });
});

describe("the error catalog: Detail handling (Task Y)", () => {
  it("collapses consecutive identical detail lines to one", () => {
    const detail = [
      "opencode: provider overloaded",
      "opencode: provider overloaded",
      "opencode: provider overloaded",
      "and then something else",
    ].join("\n");

    const lines = formatCatalogCode("executor_error", {
      featureId: "F-001",
      stage: "grill",
      detail,
    });

    const detailLines = lines.filter((line) => line.startsWith("Detail:"));
    expect(detailLines).toEqual(["Detail: opencode: provider overloaded"].concat(["Detail: and then something else"]));
  });

  it("keeps a repeated line that is separated by a different line", () => {
    const lines = formatCatalogCode("executor_error", {
      featureId: "F-001",
      stage: "grill",
      detail: "a\nb\na",
    });

    // Every detail line carries its own prefix; only consecutive duplicates collapse.
    const detailLines = lines.filter((line) => line.startsWith("Detail:"));
    expect(detailLines).toEqual(["Detail: a", "Detail: b", "Detail: a"]);
  });

  it("strips complete ANSI sequences from detail lines, leaving no [0m- or [91m-shaped fragment", () => {
    const detail = "\u001b[91m\u001b[1mECONNRESET\u001b[0m\u001b[22m\u001b[39m\u0007";

    const lines = formatCatalogCode("executor_error", { featureId: "F-001", detail });
    const text = lines.join("\n");

    expect(text).toContain("Detail: ECONNRESET");
    for (const fragment of ["\u001b", "[0m", "[22m", "[39m", "[91m", "[1m", "\u0007"]) {
      expect(text, `fragment "${fragment}"`).not.toContain(fragment);
    }
  });
});

describe("agentflow status: the last stage's model", () => {
  it("prints the model the last stage was launched with", async () => {
    const repoRoot = await makeRepo();
    await startFeature(repoRoot, failingStackFactory());

    await writeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 30_000,
      args: [
        "run",
        "--standalone",
        "--agent",
        "agentflow-implement",
        "--format",
        "text",
        "--model",
        "opencode/grok-4",
        "the prompt is never parsed as a model",
      ],
    });
    await writeRecording(repoRoot, {
      featureId: "F-001",
      stage: "planning",
      startedAt: "2026-01-02T00:00:00.000Z",
      durationMs: 60_000,
      args: [
        "run",
        "--standalone",
        "--agent",
        "agentflow-plan",
        "--format",
        "text",
        "--model",
        "opencode/gpt-5.2",
        "a later prompt",
      ],
    });

    const status = await runCli(["status", "F-001"], { repoRoot, createStack: failingStackFactory() });

    expect(status.exitCodes).toEqual([]);
    expect(status.stdout).toContain("Last stage: planning");
    // The last stage's own model, not an earlier stage's.
    expect(status.stdout).toContain("Last stage model: opencode/gpt-5.2");
    expect(status.stdout).not.toContain("grok-4");
  });

  it("prints no model line when the recording names none", async () => {
    const repoRoot = await makeRepo();
    await startFeature(repoRoot, failingStackFactory());

    await writeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 30_000,
    });

    const status = await runCli(["status", "F-001"], { repoRoot, createStack: failingStackFactory() });

    expect(status.exitCodes).toEqual([]);
    expect(status.stdout).toContain("Last stage: grill");
    expect(status.stdout).not.toContain("Last stage model:");
    expect(status.stdout).toContain(`Recording folder: ${join(repoRoot, ".agentflow", "recordings", "F-001", "grill")}`);
  });
});

/** A stack that records the transient-retry budget the CLI resolved, like progressStackFactory does for format retries. */
function transientBudgetFactory(): {
  readonly factory: (repoRoot: string, request: CliStackRequest) => CliStack;
  readonly transientRetries: number[];
} {
  const transientRetries: number[] = [];

  const factory = (repoRoot: string, request: CliStackRequest): CliStack => {
    if (request.transientRetries !== undefined) {
      transientRetries.push(request.transientRetries);
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

    const executor: StageExecutor = {
      async execute(stageRequest: StageExecutionRequest): Promise<StageExecutionResult> {
        request.onProgress?.({ type: "stage_started", stage: stageRequest.stage });
        return base.execute(stageRequest);
      },
    };

    return createOrchestratorStack(repoRoot, {
      executor,
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
  };

  return { factory, transientRetries };
}

describe("agentflow run --transient-retries", () => {
  it("passes the flag to the stack, defaults to 2, and accepts 0 as a real answer", async () => {
    const repoRoot = await makeRepo();

    const explicit = transientBudgetFactory();
    await startFeature(repoRoot, explicit.factory);
    await runCli(["run", "F-001", "--transient-retries", "1"], {
      repoRoot,
      createStack: explicit.factory,
    });
    expect(explicit.transientRetries).toEqual([1]);

    const disabled = transientBudgetFactory();
    await runCli(["run", "F-001", "--transient-retries", "0"], {
      repoRoot,
      createStack: disabled.factory,
    });
    expect(disabled.transientRetries).toEqual([0]);

    const defaults = transientBudgetFactory();
    await runCli(["run", "F-001"], { repoRoot, createStack: defaults.factory });
    expect(defaults.transientRetries).toEqual([2]);
  });

  it("refuses a --transient-retries value that is not a whole number of retries", async () => {
    const repoRoot = await makeRepo();
    const { factory } = transientBudgetFactory();
    await startFeature(repoRoot, factory);

    const ran = await runCli(["run", "F-001", "--transient-retries", "many"], {
      repoRoot,
      createStack: factory,
    });

    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("--transient-retries");
  });
});

describe("agentflow run: the Evidence line names the absolute recording folder", () => {
  it("prints the folder the stage's own failure line named, not the project fallback", async () => {
    const repoRoot = await makeRepo();
    const cacheFolder = join(
      dirname(repoRoot),
      "cache-home",
      "workspaces",
      "abc123",
      ".agentflow",
      "recordings",
      "F-001",
      "runtime_verification",
    );
    const base = failingStackFactory();

    await startFeature(repoRoot, base);

    // The executor emits the recording folder the real executor names on the failure path
    // (under the workspace cache for a post-approval stage), then fails; the run's error line
    // must use that folder as its Evidence. The wrapper is passed into the stack — swapping the
    // executor on a built stack would not rewire the orchestrator — so the emission reaches the
    // CLI exactly the way the real executor's does.
    const factory = (repo: string, request: CliStackRequest): CliStack => {
      const failing = new FakeStageExecutor();
      failing.configure("grill", { error: new Error("the agent crashed on a provider fault") });

      const executor: StageExecutor = {
        async execute(stageRequest: StageExecutionRequest): Promise<StageExecutionResult> {
          request.onProgress?.({ type: "stage_started", stage: stageRequest.stage });
          try {
            return await failing.execute(stageRequest);
          } finally {
            request.onProgress?.({
              type: "stage_failed",
              stage: stageRequest.stage,
              elapsedMs: 5_000,
              recordingFolder: cacheFolder,
            });
          }
        },
      };

      return createOrchestratorStack(repo, {
        executor,
        verification: createFakeVerificationProvider(),
        security: createFakeSecurityProvider(),
      });
    };

    await writeRecording(repoRoot, {
      featureId: "F-001",
      stage: "grill",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 30_000,
    });
    const ran = await runCli(["run", "F-001"], { repoRoot, createStack: factory });

    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain("Workflow error (executor_error):");
    const squashed = ran.stderr.replace(/\s+/gu, "");
    expect(squashed).toContain(`Evidence:${cacheFolder}`);
    expect(squashed).not.toContain("Evidence:.agentflow/recordings/F-001/grill");
  });
});
