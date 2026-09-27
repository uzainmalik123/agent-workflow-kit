import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationCommandEvidence } from "@agent-workflow-kit/orchestration";
import {
  describeOutcome,
  PROJECT_CONFIG_FILENAME,
  ProjectVerificationProvider,
  runChildProcess,
  statusForOutcome,
  type ChildProcessRequest,
} from "@agent-workflow-kit/project";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

interface Project {
  readonly root: string;
  readonly path: (relative: string) => string;
}

async function makeProject(files: Readonly<Record<string, string>> = {}): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-run-"));
  roots.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);

    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }

  return { root, path: (relative) => join(root, relative) };
}

async function makeNodeProject(scriptBody: string, scripts: Readonly<Record<string, string>>): Promise<Project> {
  const project = await makeProject({
    "package.json": JSON.stringify({
      name: "fixture",
      private: true,
      scripts,
    }),
    "pnpm-lock.yaml": "lockfileVersion: 9.0\n",
  });

  await mkdir(project.path("node_modules/.bin"), { recursive: true });
  await writeFile(project.path("node_modules/.bin/runner"), scriptBody, "utf8");
  await chmod(project.path("node_modules/.bin/runner"), 0o755);

  return project;
}

const exitWith = (code: number, message = "output") => `#!/bin/sh\necho "${message}"\nexit ${String(code)}\n`;

const run = (overrides: Partial<ChildProcessRequest> & Pick<ChildProcessRequest, "executable" | "cwd">) =>
  runChildProcess({ args: [], timeoutMs: 10_000, ...overrides });

const checkFor = (
  bundle: { checks: readonly VerificationCommandEvidence[] },
  id: string,
): VerificationCommandEvidence | undefined => bundle.checks.find((check) => check.id === id);

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("process runner", () => {
  it("reports a zero exit as a pass with both streams captured", async () => {
    const project = await makeProject();

    const outcome = await run({
      executable: "/bin/sh",
      args: ["-c", "echo out; echo err 1>&2; exit 0"],
      cwd: project.root,
    });

    expect(outcome.termination).toBe("exited");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.text.trim()).toBe("out");
    expect(outcome.stderr.text.trim()).toBe("err");
    expect(statusForOutcome(outcome)).toBe("passed");
  });

  it("reports a non-zero exit as a failure, whatever the output says", async () => {
    const project = await makeProject();

    const outcome = await run({
      executable: "/bin/sh",
      args: ["-c", "echo '0 failing'; exit 3"],
      cwd: project.root,
    });

    expect(outcome.exitCode).toBe(3);
    expect(statusForOutcome(outcome)).toBe("failed");
    expect(outcome.stdout.text).toContain("0 failing");
  });

  it("reports a missing executable as blocked rather than failing", async () => {
    const project = await makeProject();

    const outcome = await run({ executable: project.path("node_modules/.bin/absent"), cwd: project.root });

    expect(outcome.termination).toBe("spawn_failed");
    expect(outcome.reason).toBe("executable_not_found");
    expect(statusForOutcome(outcome)).toBe("blocked");
  });

  it("reports an unreadable executable distinctly from a missing one", async () => {
    const project = await makeProject({ "not-executable": "#!/bin/sh\nexit 0\n" });

    const outcome = await run({ executable: project.path("not-executable"), cwd: project.root });

    expect(outcome.termination).toBe("spawn_failed");
    expect(outcome.reason).toBe("executable_not_executable");
  });

  it("terminates a command that exceeds its deadline and reports it as a timeout", async () => {
    const project = await makeProject();

    const outcome = await run({
      executable: "/bin/sh",
      args: ["-c", "sleep 5"],
      cwd: project.root,
      timeoutMs: 150,
      killGraceMs: 100,
    });

    expect(outcome.termination).toBe("timed_out");
    expect(outcome.reason).toBe("deadline_exceeded");
    expect(outcome.exitCode).not.toBe(0);
    expect(statusForOutcome(outcome)).toBe("timed_out");
  });

  it("reports an abort as a cancellation and never as a pass", async () => {
    const project = await makeProject();
    const controller = new AbortController();

    const pending = run({
      executable: "/bin/sh",
      args: ["-c", "sleep 5"],
      cwd: project.root,
      signal: controller.signal,
      killGraceMs: 100,
    });

    controller.abort();

    const outcome = await pending;

    expect(outcome.termination).toBe("cancelled");
    expect(statusForOutcome(outcome)).toBe("cancelled");
  });

  it("returns a cancellation immediately when the signal is already aborted", async () => {
    const project = await makeProject();

    const outcome = await run({
      executable: "/bin/sh",
      args: ["-c", "exit 0"],
      cwd: project.root,
      signal: AbortSignal.abort(),
    });

    expect(outcome.termination).toBe("cancelled");
    expect(outcome.durationMs).toBe(0);
  });

  it("stops a runaway command and says so, keeping the head and the tail", async () => {
    const project = await makeProject();

    const outcome = await run({
      executable: "/bin/sh",
      args: ["-c", "head -c 100 /dev/zero | tr '\\0' 'a'; head -c 400 /dev/zero | tr '\\0' 'z'; sleep 5"],
      cwd: project.root,
      maxStreamBytes: 200,
      captureHeadChars: 40,
      captureTailChars: 40,
      killGraceMs: 100,
    });

    expect(outcome.termination).toBe("output_truncated");
    expect(outcome.stdout.truncated).toBe(true);
    expect(outcome.stdout.text).toContain("omitted");
    expect(outcome.stdout.text.startsWith("a")).toBe(true);
    expect(outcome.stdout.text.endsWith("z")).toBe(true);
    expect(statusForOutcome(outcome)).toBe("failed");
  });

  it("reports a signal death as a failure with the signal name", async () => {
    const project = await makeProject();

    const outcome = await run({
      executable: "/bin/sh",
      args: ["-c", "kill -9 $$; sleep 1"],
      cwd: project.root,
    });

    expect(["signalled", "exited"]).toContain(outcome.termination);

    if (outcome.termination === "signalled") {
      expect(outcome.signal).toBe("SIGKILL");
      expect(statusForOutcome(outcome)).toBe("failed");
    }
  });

  it("passes an argument containing shell metacharacters as one literal argument", async () => {
    const project = await makeProject();

    const outcome = await run({
      executable: "/bin/sh",
      args: ["-c", 'printf "%s" "$1"', "sh", "; rm -rf / && echo $(whoami)"],
      cwd: project.root,
    });

    expect(outcome.stdout.text).toBe("; rm -rf / && echo $(whoami)");
  });

  it("does not run through a shell, so shell syntax in a name is never interpreted", async () => {
    const project = await makeProject();

    const outcome = await run({
      executable: `/bin/echo ; touch ${project.path("pwned")}`,
      args: ["hello"],
      cwd: project.root,
    });

    expect(outcome.termination).toBe("spawn_failed");
    await expect(run({ executable: "/bin/ls", args: [project.path("pwned")], cwd: project.root })).resolves.toMatchObject(
      { exitCode: 2 },
    );
  });

  it("never puts the argument list into its summary", async () => {
    const project = await makeProject();
    const outcome = await run({
      executable: "/bin/sh",
      args: ["-c", "echo a-secret-token >&2; exit 9"],
      cwd: project.root,
    });

    expect(describeOutcome(outcome)).toBe("exited with code 9");
    expect(JSON.stringify({ termination: outcome.termination, reason: outcome.reason })).not.toContain("a-secret-token");
  });
});

describe("verification provider", () => {
  it("collects a passing static stage from the project's own scripts", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner", typecheck: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root, clock: () => 1_800_000_000_000 });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 3,
      projectRoot: project.root,
    });

    expect(bundle.outcome).toBe("passed");
    expect(bundle.verification).toBe("static");
    expect(bundle.revision).toBe(3);
    expect(bundle.project.packageManager).toBe("pnpm");
    expect(bundle.project.ecosystem).toBe("node");
    expect(bundle.checks.map((check) => check.id).sort()).toEqual(["build", "lint", "typecheck"]);
    expect(checkFor(bundle, "lint")).toMatchObject({
      status: "passed",
      exitCode: 0,
      executable: "pnpm",
      args: ["run", "lint"],
      script: "lint",
      capabilityStatus: "applicable",
    });
    expect(checkFor(bundle, "build")?.status).toBe("skipped");
    expect(bundle.implementationFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("runs the project script itself, so the recorded exit code is the project's", async () => {
    const project = await makeNodeProject(exitWith(1, "error: problem in app.ts"), { lint: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
    });

    expect(bundle.outcome).toBe("failed");
    expect(checkFor(bundle, "lint")).toMatchObject({ status: "failed", exitCode: 1 });
    expect(checkFor(bundle, "lint")?.stdoutExcerpt).toContain("problem in app.ts");
  });

  it("defers a stage that has nothing to run, and never calls that a pass", async () => {
    const project = await makeNodeProject(exitWith(0), {});
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "test_verification",
      verification: "test",
      revision: 1,
      projectRoot: project.root,
    });

    expect(bundle.outcome).toBe("deferred");
    expect(bundle.checks).toHaveLength(1);
    expect(bundle.checks[0]).toMatchObject({ capability: "test", status: "skipped" });
  });

  it("defers the runtime stage explicitly, for every project", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "runtime_verification",
      verification: "runtime",
      revision: 1,
      projectRoot: project.root,
    });

    expect(bundle.outcome).toBe("deferred");
    expect(checkFor(bundle, "runtime")).toMatchObject({ status: "skipped", reason: "runtime_deferred" });
  });

  it("blocks instead of installing when dependencies are missing", async () => {
    const project = await makeProject({
      "package.json": JSON.stringify({ name: "fixture", scripts: { lint: "eslint ." } }),
      "pnpm-lock.yaml": "",
    });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
    });

    expect(bundle.outcome).toBe("blocked");
    expect(bundle.project.dependenciesInstalled).toBe(false);
    expect(checkFor(bundle, "lint")).toMatchObject({ status: "blocked", reason: "dependency_missing" });
  });

  it("blocks when no package manager can be determined", async () => {
    const project = await makeProject({
      "package.json": JSON.stringify({ name: "fixture", scripts: { lint: "eslint ." } }),
    });
    await mkdir(project.path("node_modules"), { recursive: true });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
    });

    expect(bundle.outcome).toBe("blocked");
    expect(checkFor(bundle, "lint")).toMatchObject({ reason: "package_manager_unknown" });
  });

  it("reports an uninspectable project as blocked with the refusal, and executes nothing", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });
    let invocations = 0;
    const provider = new ProjectVerificationProvider({
      projectRoot: project.root,
      run: (request) => {
        invocations += 1;
        return runChildProcess(request);
      },
    });

    await writeFile(project.path("package.json"), "{ broken", "utf8");

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
    });

    expect(bundle.outcome).toBe("blocked");
    expect(bundle.implementationFingerprint).toBe("0".repeat(64));
    expect(bundle.checks[0]).toMatchObject({ id: "discovery", status: "blocked", reason: "manifest_malformed" });
    expect(bundle.project.capabilities.every((capability) => capability.detail.includes("manifest_malformed"))).toBe(
      true,
    );
    expect(invocations).toBe(0);
  });

  it("runs a declared command for a project whose ecosystem has no adapter", async () => {
    const project = await makeProject({
      "pyproject.toml": "[project]\nname = \"fixture\"\n",
      [PROJECT_CONFIG_FILENAME]: JSON.stringify({
        schemaVersion: 1,
        verification: {
          static: [{ id: "ruff", capability: "lint", executable: "ruff", args: ["check", "--output-format", "concise"] }],
          test: [{ id: "pytest", capability: "test", executable: "pytest", args: ["-q"] }],
        },
      }),
    });
    await mkdir(project.path("bin"), { recursive: true });
    await writeFile(project.path("bin/ruff"), exitWith(0), "utf8");
    await chmod(project.path("bin/ruff"), 0o755);
    await writeFile(project.path("bin/pytest"), exitWith(1, "1 failed"), "utf8");
    await chmod(project.path("bin/pytest"), 0o755);

    const executed: string[] = [];
    const provider = new ProjectVerificationProvider({
      projectRoot: project.root,
      run: (request) => {
        executed.push([request.executable, ...request.args].join(" "));
        return runChildProcess({ ...request, env: { ...process.env, PATH: `${project.path("bin")}:${process.env["PATH"] ?? ""}` } });
      },
    });

    const staticBundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
    });

    expect(staticBundle.outcome).toBe("passed");
    expect(executed).toEqual(["ruff check --output-format concise"]);
    expect(provider.config?.static[0]?.id).toBe("ruff");
    expect(checkFor(staticBundle, "ruff")).toMatchObject({ status: "passed", script: null, capability: "lint" });

    const testBundle = await provider.collect({
      featureId: "F-001",
      stage: "test_verification",
      verification: "test",
      revision: 2,
      projectRoot: project.root,
    });

    expect(testBundle.outcome).toBe("failed");
    expect(checkFor(testBundle, "pytest")).toMatchObject({ status: "failed", exitCode: 1 });
  });

  it("runs a detected script and a configured one, but never the same capability twice", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner", test: "runner" });
    await writeFile(
      project.path(PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        verification: { static: [{ id: "custom-lint", capability: "lint", executable: "true", args: [] }] },
      }),
      "utf8",
    );

    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
    });

    const lintChecks = bundle.checks.filter((check) => check.capability === "lint");

    expect(lintChecks).toHaveLength(1);
    expect(checkFor(bundle, "custom-lint")).toMatchObject({ status: "passed", script: null });
    expect(checkFor(bundle, "lint")).toBeUndefined();
  });

  it("refuses a request whose project root does not match the provider's", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    await expect(
      provider.collect({
        featureId: "F-001",
        stage: "static_verification",
        verification: "static",
        revision: 1,
        projectRoot: "/somewhere/else",
      }),
    ).rejects.toMatchObject({ code: "command_invalid" });
  });

  it("records a fresh fingerprint, so evidence cannot outlive the code it measured", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });
    const request = {
      featureId: "F-001",
      stage: "static_verification" as const,
      verification: "static" as const,
      revision: 1,
      projectRoot: project.root,
    };

    const before = await provider.collect(request);

    await mkdir(project.path("src"), { recursive: true });
    await writeFile(project.path("src/app.ts"), "export const x = 1;\n", "utf8");

    const after = await provider.collect(request);

    expect(before.implementationFingerprint).not.toBe(after.implementationFingerprint);
  });

  it("reports a timeout as a timeout, and a spawn failure as blocked", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner", test: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root, timeoutMs: 120 });

    const timedOut = await run({
      executable: "/bin/sh",
      args: ["-c", "sleep 5"],
      cwd: project.root,
      timeoutMs: 120,
      killGraceMs: 100,
    });

    expect(statusForOutcome(timedOut)).toBe("timed_out");
    expect(provider.projectRoot).toBe(project.root);
  });

  it("uses the injected clock for its timestamps", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root, clock: () => 1_800_000_000_000 });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
    });

    expect(bundle.collectedAt).toBe(new Date(1_800_000_000_000).toISOString());
    expect(checkFor(bundle, "lint")?.startedAt).toBe(bundle.collectedAt);
  });

  it("produces a bundle the orchestrator's validator accepts, whatever the outcome", async () => {
    const project = await makeNodeProject(exitWith(1, "boom"), { lint: "runner", test: "runner", build: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    for (const [verification, stage] of [
      ["static", "static_verification"],
      ["test", "test_verification"],
      ["runtime", "runtime_verification"],
    ] as const) {
      const bundle = await provider.collect({
        featureId: "F-001",
        stage,
        verification,
        revision: 1,
        projectRoot: project.root,
      });

      expect(bundle.outcome).toMatch(/passed|failed|blocked|deferred/u);
      expect(bundle.checks.every((check) => check.kind === verification)).toBe(true);
      expect(bundle.checks.every((check) => check.revision === 1)).toBe(true);
      expect(bundle.checks.every((check) => check.implementationFingerprint === bundle.implementationFingerprint)).toBe(
        true,
      );
    }
  });
});

describe("verification evidence records", () => {
  it("keeps the command and the result together, and never a shell line", async () => {
    const project = await makeNodeProject(exitWith(0, "all good"), { lint: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
    });

    const check = checkFor(bundle, "lint") as VerificationCommandEvidence;

    expect(check.executable).toBe("pnpm");
    expect(check.args).toEqual(["run", "lint"]);
    expect(check.cwd).toBe(project.root);
    expect(check.durationMs).toBeGreaterThanOrEqual(0);
    expect(check.truncated).toBe(false);
  });
});
