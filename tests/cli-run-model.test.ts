import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenCodeInvocation,
  createOpenCodeStageExecutor,
} from "@agent-workflow-kit/opencode";
import {
  createCli,
  type CliStack,
  type CliStackFactory,
  type CliStackRequest,
} from "../apps/cli/src/commands.js";
import { createOrchestratorStack } from "../apps/cli/src/stack.js";
import {
  createFakeOpenCodeTransport,
  type FakeOpenCodeTransport,
} from "../fixtures/opencode-transport.js";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";
import { createFakeVerificationProvider } from "../fixtures/verification-provider.js";

/**
 * `agentflow run`'s model selection, driven end to end through the CLI with an injected fake
 * transport.
 *
 * The stack factory wires the real OpenCode stage executor over `FakeOpenCodeTransport`, so the
 * model travels the exact product path — flag/env → `createStack` → executor → transport request —
 * and `buildOpenCodeInvocation` (the same function the real transport calls before spawning) is
 * what turns that request into argv. Nothing here spawns a process or calls a model.
 */

const FLAG_MODEL = "anthropic/claude-sonnet-4-5";
const ENV_MODEL = "openai/gpt-5.2";
const NO_COMMITS_MESSAGE = "this repository has no commits; make an initial commit first";

const roots: string[] = [];
const originalModelEnv = process.env["AGENTFLOW_MODEL"];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** A scratch repository; with `commit` false it is a Git repository with no commits at all. */
async function makeRepo(commit: boolean): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-cli-run-model-"));
  roots.push(base);
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet", "--initial-branch=main", ".");
  git(repoRoot, "config", "user.email", "cli@example.invalid");
  git(repoRoot, "config", "user.name", "CLI Test");
  git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(join(repoRoot, "package.json"), '{"name":"test","version":"1.0.0"}', "utf8");
  if (commit) {
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "--quiet", "-m", "initial");
  }
  return repoRoot;
}

interface CliRun {
  readonly exitCodes: readonly number[];
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command against `repoRoot`, capturing output and reported exit codes. */
async function runCli(
  args: readonly string[],
  repoRoot: string,
  createStack: CliStackFactory,
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
      createStack,
      cwd: () => repoRoot,
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
 * A stack whose stages run the real executor over an injected fake transport — the seam the argv
 * assertions read from. The CLI's resolved model goes into the executor exactly as
 * `createRealStack` wires it.
 */
function stackFactoryOver(transport: FakeOpenCodeTransport): CliStackFactory {
  return (repoRoot: string, request: CliStackRequest): CliStack =>
    createOrchestratorStack(repoRoot, {
      executor: createOpenCodeStageExecutor({
        transport,
        projectRoot: repoRoot,
        model: request.model ?? null,
      }),
      verification: createFakeVerificationProvider(),
      security: createFakeSecurityProvider(),
    });
}

async function startFeature(repoRoot: string, factory: CliStackFactory): Promise<void> {
  const started = await runCli(["start", "-i", "F-001", "-t", "Wire the stack"], repoRoot, factory);
  expect(started.exitCodes).toEqual([]);
}

/** The argv the real transport would spawn, built from the request the executor handed over. */
function argvOf(request: FakeOpenCodeTransport["calls"][number]): readonly string[] {
  return buildOpenCodeInvocation(request).args;
}

beforeEach(() => {
  // A developer's own AGENTFLOW_MODEL must not change what these tests observe.
  delete process.env["AGENTFLOW_MODEL"];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalModelEnv === undefined) {
    delete process.env["AGENTFLOW_MODEL"];
  } else {
    process.env["AGENTFLOW_MODEL"] = originalModelEnv;
  }
  for (const root of roots.splice(0)) {
    void rm(root, { recursive: true, force: true });
  }
});

describe("agentflow run model selection", () => {
  it("puts the exact --model value into every stage's invocation argv", async () => {
    const repoRoot = await makeRepo(true);
    const transport = createFakeOpenCodeTransport();
    const factory = stackFactoryOver(transport);
    await startFeature(repoRoot, factory);

    const ran = await runCli(
      ["run", "F-001", "--model", FLAG_MODEL],
      repoRoot,
      factory,
    );

    expect(ran.exitCodes).toEqual([]);
    expect(ran.stdout).toContain("awaiting_plan_approval");
    // The stage Task C saw run modelless is the first one here.
    expect(transport.calls[0]?.stage).toBe("grill");

    expect(transport.calls.length).toBeGreaterThan(0);
    for (const call of transport.calls) {
      expect(call.model).toBe(FLAG_MODEL);
      const argv = argvOf(call);
      const at = argv.indexOf("--model");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(argv[at + 1]).toBe(FLAG_MODEL);
    }
  });

  it("falls back to AGENTFLOW_MODEL when the flag is absent", async () => {
    const repoRoot = await makeRepo(true);
    const transport = createFakeOpenCodeTransport();
    const factory = stackFactoryOver(transport);
    await startFeature(repoRoot, factory);

    process.env["AGENTFLOW_MODEL"] = ENV_MODEL;
    const ran = await runCli(["run", "F-001"], repoRoot, factory);

    expect(ran.exitCodes).toEqual([]);
    expect(ran.stdout).toContain("awaiting_plan_approval");

    expect(transport.calls.length).toBeGreaterThan(0);
    for (const call of transport.calls) {
      expect(call.model).toBe(ENV_MODEL);
      const argv = argvOf(call);
      const at = argv.indexOf("--model");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(argv[at + 1]).toBe(ENV_MODEL);
    }
  });

  it("prefers the --model flag over AGENTFLOW_MODEL", async () => {
    const repoRoot = await makeRepo(true);
    const transport = createFakeOpenCodeTransport();
    const factory = stackFactoryOver(transport);
    await startFeature(repoRoot, factory);

    process.env["AGENTFLOW_MODEL"] = ENV_MODEL;
    const ran = await runCli(
      ["run", "F-001", "--model", FLAG_MODEL],
      repoRoot,
      factory,
    );

    expect(ran.exitCodes).toEqual([]);
    expect(transport.calls.length).toBeGreaterThan(0);
    for (const call of transport.calls) {
      expect(call.model).toBe(FLAG_MODEL);
      const argv = argvOf(call);
      expect(argv).toContain(FLAG_MODEL);
      expect(argv).not.toContain(ENV_MODEL);
    }
  });

  it("refuses an invalid model value from the flag or the environment before any stage runs", async () => {
    const repoRoot = await makeRepo(true);
    const transport = createFakeOpenCodeTransport();
    const factory = stackFactoryOver(transport);
    await startFeature(repoRoot, factory);

    for (const bad of ["bad model", "-not-a-model", ""]) {
      const ran = await runCli(["run", "F-001", "--model", bad], repoRoot, factory);
      expect(ran.exitCodes).toEqual([1]);
      expect(ran.stderr).toContain("Invalid --model value");
    }

    process.env["AGENTFLOW_MODEL"] = "bad model";
    const fromEnv = await runCli(["run", "F-001"], repoRoot, factory);
    expect(fromEnv.exitCodes).toEqual([1]);
    expect(fromEnv.stderr).toContain("Invalid AGENTFLOW_MODEL value");

    expect(transport.callCount).toBe(0);
  });

  it("refuses to run when the repository has no commits", async () => {
    const repoRoot = await makeRepo(false);
    const transport = createFakeOpenCodeTransport();
    const factory = stackFactoryOver(transport);
    await startFeature(repoRoot, factory);

    const ran = await runCli(["run", "F-001"], repoRoot, factory);

    expect(ran.exitCodes).toEqual([1]);
    expect(ran.stderr).toContain(NO_COMMITS_MESSAGE);
    // No stage ran: the precheck fires before the workflow is touched.
    expect(transport.callCount).toBe(0);
  });
});
