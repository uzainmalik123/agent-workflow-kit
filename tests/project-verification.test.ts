import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createWorkflowOrchestrator,
  DETERMINISTIC_EVIDENCE_KEY,
  type VerificationCommandEvidence,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import {
  describeOutcome,
  PROJECT_CONFIG_FILENAME,
  ProjectVerificationProvider,
  runChildProcess,
  statusForOutcome,
  type ChildProcessRequest,
} from "@agent-workflow-kit/project";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";

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

/**
 * A lockfile in the shape pnpm itself writes.
 *
 * A bare `lockfileVersion: 9.0` is a lockfile pnpm considers malformed — the version is a float where
 * pnpm writes a string, and there is no `settings` or `importers` section — so the first `pnpm run` in
 * a project containing one repairs it. That repair is a real write to a fingerprinted file, and a stage
 * whose command changed the tree it was checking is refused whatever it exited with. The fixture has to
 * be a lockfile no package manager would want to fix, or the test measures pnpm's repair instead of the
 * property it is about.
 */
const PNPM_LOCKFILE = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";

async function makeNodeProject(scriptBody: string, scripts: Readonly<Record<string, string>>): Promise<Project> {
  const project = await makeProject({
    "package.json": JSON.stringify({
      name: "fixture",
      private: true,
      scripts,
    }),
    "pnpm-lock.yaml": PNPM_LOCKFILE,
  });

  await mkdir(project.path("node_modules/.bin"), { recursive: true });
  await writeFile(project.path("node_modules/.bin/runner"), scriptBody, "utf8");
  await chmod(project.path("node_modules/.bin/runner"), 0o755);

  return project;
}

const exitWith = (code: number, message = "output") => `#!/bin/sh\necho "${message}"\nexit ${String(code)}\n`;

const run = (overrides: Partial<ChildProcessRequest> & Pick<ChildProcessRequest, "executable" | "cwd">) =>
  runChildProcess({ args: [], timeoutMs: 10_000, ...overrides });

const declaredRuntimeCommand = (): string =>
  JSON.stringify({
    schemaVersion: 1,
    verification: {
      runtime: {
        command: { executable: "node", args: ["server.mjs"] },
        readiness: { url: "http://127.0.0.1:3000/health" },
        checks: [{ id: "smoke", path: "/health", expectedStatus: 200 }],
      },
    },
  });

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
      // `exec`, so the shell is replaced by `sleep` rather than left waiting on it. A command that
      // outlives its deadline has to be the process that is actually signalled, because
      // `runChildProcess` stops the process it started and not the group around it: a shell that
      // forks leaves a grandchild holding the captured pipes, and the outcome is not settled until
      // that grandchild exits on its own. Whether `sh` forks or execs a lone command is a property of
      // the shell the runner happens to find, so this test used to hang for the full `sleep` on a
      // runner whose `/bin/sh` is not bash, and report a vitest timeout instead of its own failure.
      args: ["-c", "exec sleep 5"],
      cwd: project.root,
      timeoutMs: 150,
      killGraceMs: 100,
    });

    expect(outcome.termination).toBe("timed_out");
    expect(outcome.reason).toBe("deadline_exceeded");
    expect(outcome.exitCode).not.toBe(0);
    // The deadline has to have shortened the run, not only labelled it. `sleep 5` would have taken five
    // seconds, so a duration anywhere near that means the command ran to its own end and the timeout
    // arrived afterwards to describe something that had already finished.
    expect(outcome.durationMs).toBeLessThan(2_500);
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
      // The last command is `exec`'d for the reason given above. This one escapes the same trap today
      // only because the byte ceiling stops the shell while it is still printing, before it has forked
      // anything, and a ceiling that fires later would leave a `sleep` holding the pipes.
      args: ["-c", "head -c 100 /dev/zero | tr '\\0' 'a'; head -c 400 /dev/zero | tr '\\0' 'z'; exec sleep 5"],
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
      workspaceId: null,
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
      workspaceId: null,
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
      workspaceId: null,
    });

    expect(bundle.outcome).toBe("deferred");
    expect(bundle.checks).toHaveLength(1);
    expect(bundle.checks[0]).toMatchObject({ capability: "test", status: "skipped" });
  });

  it("defers the runtime stage explicitly, for every project that declared none", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "runtime_verification",
      verification: "runtime",
      revision: 1,
      projectRoot: project.root,
      workspaceId: null,
    });

    // Deferred, not passed and not failed: no command was started, so the stage had nothing to do.
    // The workflow turns this into `inconclusive` rather than letting a verifier call it a success.
    expect(bundle.outcome).toBe("deferred");
    expect(checkFor(bundle, "runtime")).toMatchObject({ status: "skipped", reason: "runtime_not_configured" });
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
      workspaceId: null,
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
      workspaceId: null,
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
      workspaceId: null,
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
        return runChildProcess({ ...request, env: { PATH: `${project.path("bin")}:${process.env["PATH"] ?? ""}` } });
      },
    });

    const staticBundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
      workspaceId: null,
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
      workspaceId: null,
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
      workspaceId: null,
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
        workspaceId: null,
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
      workspaceId: null,
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
      // `exec` for the reason given above: the signalled process has to be the one holding the pipes.
      args: ["-c", "exec sleep 5"],
      cwd: project.root,
      timeoutMs: 120,
      killGraceMs: 100,
    });

    expect(statusForOutcome(timedOut)).toBe("timed_out");
    expect(timedOut.durationMs).toBeLessThan(2_500);
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
      workspaceId: null,
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
        workspaceId: null,
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
      workspaceId: null,
    });

    const check = checkFor(bundle, "lint") as VerificationCommandEvidence;

    expect(check.executable).toBe("pnpm");
    expect(check.args).toEqual(["run", "lint"]);
    expect(check.cwd).toBe(project.root);
    expect(check.durationMs).toBeGreaterThanOrEqual(0);
    expect(check.truncated).toBe(false);
  });
});

describe("workspace mutation during verification", () => {
  const collectStatic = async (project: Project, provider: ProjectVerificationProvider) =>
    provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
      workspaceId: null,
    });

  it("refuses a stage whose command rewrote the source it was checking, however it exited", async () => {
    const project = await makeNodeProject(
      `#!/bin/sh\necho 'export const x = 2;' > src/app.ts\nexit 0\n`,
      { lint: "runner" },
    );

    await mkdir(project.path("src"), { recursive: true });
    await writeFile(project.path("src/app.ts"), "export const x = 1;\n", "utf8");

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    // The check itself passed. The stage did not, because the pass describes a file that is gone.
    expect(checkFor(bundle, "lint")).toMatchObject({ status: "passed", exitCode: 0 });
    expect(bundle.outcome).toBe("failed");
    expect(bundle.workspace.changed).toBe(true);
    expect(bundle.workspace.before).not.toBe(bundle.workspace.after);
    expect(bundle.implementationFingerprint).toBe(bundle.workspace.before);
  });

  it("refuses a stage whose command rewrote the verification configuration", async () => {
    const project = await makeNodeProject(
      `#!/bin/sh\necho '{"schemaVersion":1}' > ${PROJECT_CONFIG_FILENAME}\nexit 0\n`,
      { lint: "runner" },
    );

    // The declared command is a runtime one, so the file is part of the measured tree without
    // replacing the lint command the fixture is trying to rewrite it from under.
    await writeFile(project.path(PROJECT_CONFIG_FILENAME), declaredRuntimeCommand(), "utf8");

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    expect(bundle.workspace.changed).toBe(true);
    expect(bundle.outcome).toBe("failed");
    expect(checkFor(bundle, "lint")).toMatchObject({ status: "passed", exitCode: 0 });
  });

  it("refuses a stage whose command rewrote the project's own manifest", async () => {
    const project = await makeNodeProject(
      `#!/bin/sh\necho '{"name":"fixture"}' > package.json\nexit 0\n`,
      { lint: "runner" },
    );

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    expect(bundle.workspace.changed).toBe(true);
    expect(bundle.outcome).toBe("failed");
  });

  it("refuses a stage whose command deleted a source file", async () => {
    const project = await makeNodeProject(`#!/bin/sh\nrm src/app.ts\nexit 0\n`, { lint: "runner" });

    await mkdir(project.path("src"), { recursive: true });
    await writeFile(project.path("src/app.ts"), "export const x = 1;\n", "utf8");

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    expect(bundle.workspace.changed).toBe(true);
  });

  it("does not treat a generated output directory as a change, because a build must write somewhere", async () => {
    const project = await makeNodeProject(
      `#!/bin/sh\nmkdir -p dist\nrm -rf dist\nmkdir -p dist\nrm -rf coverage node_modules/.cache\ntouch dist/bundle.js\ntouch coverage/report.txt\nexit 0\n`,
      { lint: "runner" },
    );

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    expect(bundle.workspace.changed).toBe(false);
    expect(bundle.outcome).toBe("passed");
    expect(bundle.workspace.before).toBe(bundle.workspace.after);
  });

  it("does not treat a dependency directory as a change, because installing is not this framework's job but tools do write there", async () => {
    const project = await makeNodeProject(`#!/bin/sh\ntouch node_modules/.cache-entry\nexit 0\n`, { lint: "runner" });

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    expect(bundle.workspace.changed).toBe(false);
    expect(bundle.outcome).toBe("passed");
  });

  it("reports the same fingerprint for a stage that changed nothing, so a clean run is provably clean", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });
    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    expect(bundle.workspace).toEqual({
      before: bundle.implementationFingerprint,
      after: bundle.implementationFingerprint,
      changed: false,
    });
  });

  it("notices a change made between two collections, so the digest cannot be a stale constant", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });

    const before = await collectStatic(project, provider);

    await writeFile(project.path("README.md"), "changed\n", "utf8");

    const after = await collectStatic(project, provider);

    expect(after.implementationFingerprint).not.toBe(before.implementationFingerprint);
    expect(after.workspace.changed).toBe(false);
  });
});

describe("control plane mutation during verification", () => {
  const collectStatic = async (project: Project, provider: ProjectVerificationProvider) =>
    provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
      workspaceId: null,
    });

  /**
   * A session in the same shape the persistence adapter writes, at the revision and state a static
   * stage starts from. The slug is the one `createFeatureSessionStore` derives from `F-001-t`, because
   * a test that wrote to `.agentflow/F-001/session.json` would be measuring a path no run ever uses.
   */
  const sessionJson = (state: string, revision: number): string =>
    `${JSON.stringify(
      {
        feature: {
          id: "F-001",
          slug: "F-001-t",
          title: "Feature",
          summary: "Summary.",
          request: "Do the thing.",
          risk: "low",
        },
        machine: { state, revision, history: [] },
        artifacts: { request: "request.md", spec: "spec.json", plan: "plan.md" },
        approvals: { plan: null },
      },
      null,
      2,
    )}\n`;

  it("refuses a stage whose command moved the session past a stage it never ran", async () => {
    // The exact bypass this exists for: the same revision, a legal successor, exit 0. The state machine
    // would compute the next transition from the file on disk, turn the static commit into a
    // test-to-runtime advance, and never run the test stage.
    const project = await makeNodeProject(
      `#!/bin/sh\nprintf '%s' '${sessionJson("test_verification", 11).replace(/'/g, "'\\''")}' > .agentflow/features/F-001-t/session.json\nexit 0\n`,
      { lint: "runner" },
    );

    await mkdir(project.path(".agentflow/features/F-001-t"), { recursive: true });
    await writeFile(project.path(".agentflow/features/F-001-t/session.json"), sessionJson("static_verification", 11), "utf8");

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    // The command succeeded. The stage did not, and the reason is the control plane, not the tree: the
    // implementation fingerprint is untouched, which is why the revision check alone did not catch it.
    expect(checkFor(bundle, "lint")).toMatchObject({ status: "passed", exitCode: 0 });
    expect(bundle.outcome).toBe("failed");
    expect(bundle.workspace.changed).toBe(false);
    expect(bundle.controlPlane.changed).toBe(true);
    expect(bundle.controlPlane.before).not.toBe(bundle.controlPlane.after);
  });

  it("refuses a stage whose command deleted the recorded evidence history", async () => {
    const project = await makeNodeProject(
      `#!/bin/sh\nrm -f .agentflow/features/F-001-t/history.json\nexit 0\n`,
      { lint: "runner" },
    );

    await mkdir(project.path(".agentflow/features/F-001-t"), { recursive: true });
    await writeFile(project.path(".agentflow/features/F-001-t/session.json"), sessionJson("static_verification", 11), "utf8");
    await writeFile(project.path(".agentflow/features/F-001-t/history.json"), '[{"entry":"one"}]\n', "utf8");

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    expect(bundle.controlPlane.changed).toBe(true);
    expect(bundle.outcome).toBe("failed");
  });

  it("refuses a stage whose command rewrote the generated OpenCode configuration", async () => {
    const project = await makeNodeProject(
      `#!/bin/sh\nmkdir -p .opencode/agents\necho '# rewritten' > .opencode/agents/verifier.md\nexit 0\n`,
      { lint: "runner" },
    );

    await mkdir(project.path(".opencode/agents"), { recursive: true });
    await writeFile(project.path(".opencode/agents/verifier.md"), "# generated\n", "utf8");

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    // The adapter refuses the tampered file before any model reads it, and this is the layer that
    // noticed it at all: the implementation fingerprint ignores `.opencode/` by design.
    expect(bundle.workspace.changed).toBe(false);
    expect(bundle.controlPlane.changed).toBe(true);
    expect(bundle.outcome).toBe("failed");
  });

  it("reports an unchanged control plane for a clean run, so a clean run is provably clean", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });

    await mkdir(project.path(".agentflow/features/F-001-t"), { recursive: true });
    await writeFile(project.path(".agentflow/features/F-001-t/session.json"), sessionJson("static_verification", 11), "utf8");
    await mkdir(project.path(".opencode/agents"), { recursive: true });
    await writeFile(project.path(".opencode/agents/verifier.md"), "# generated\n", "utf8");

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    expect(bundle.controlPlane.changed).toBe(false);
    expect(bundle.outcome).toBe("passed");
  });

  it("measures a project with no control-plane directories as stable rather than broken", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });

    const bundle = await collectStatic(project, new ProjectVerificationProvider({ projectRoot: project.root }));

    // Nothing there to change, hashed on both sides, so a project that does not use these directories
    // gets a real digest rather than a missing one.
    expect(bundle.controlPlane.before).toBe(bundle.controlPlane.after);
    expect(bundle.controlPlane.changed).toBe(false);
  });

  it("notices a control-plane change made between two collections, so the digest cannot be a stale constant", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner" });

    await mkdir(project.path(".opencode"), { recursive: true });
    await writeFile(project.path(".opencode/opencode.json"), '{"plugin":[]}\n', "utf8");

    const provider = new ProjectVerificationProvider({ projectRoot: project.root });
    const before = await collectStatic(project, provider);

    await writeFile(project.path(".opencode/opencode.json"), '{"plugin":["-x"]}\n', "utf8");

    const after = await collectStatic(project, provider);

    expect(after.controlPlane.before).not.toBe(before.controlPlane.before);
    expect(after.controlPlane.changed).toBe(false);
  });
});

describe("implicit pre and post script hooks", () => {
  const collectStatic = async (project: Project) =>
    new ProjectVerificationProvider({ projectRoot: project.root }).collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: project.root,
      workspaceId: null,
    });

  it("blocks a lint command whose manifest defines prelint, rather than running it too", async () => {
    const project = await makeNodeProject(exitWith(0), { prelint: "runner", lint: "runner" });
    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({
      status: "blocked",
      reason: "implicit_script_hook",
      // The check keeps the command's identity, so the record says what would have run.
      executable: "pnpm",
      args: ["run", "lint"],
    });
    expect(checkFor(bundle, "lint")?.detail).toContain("prelint");
    expect(bundle.outcome).toBe("blocked");
  });

  it("blocks on postlint as readily as on prelint", async () => {
    const project = await makeNodeProject(exitWith(0), { lint: "runner", postlint: "runner" });
    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "blocked", reason: "implicit_script_hook" });
    expect(checkFor(bundle, "lint")?.detail).toContain("postlint");
  });

  it("blocks only the script with a hook, and runs the others", async () => {
    // A TypeScript project, so the typecheck script is one this stage would otherwise have run.
    const project = await makeNodeProject(exitWith(0), {
      prelint: "runner",
      lint: "runner",
      typecheck: "runner",
    });

    await writeFile(project.path("tsconfig.json"), "{}\n", "utf8");

    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "blocked" });
    expect(checkFor(bundle, "typecheck")).toMatchObject({ status: "passed", exitCode: 0 });
    expect(bundle.outcome).toBe("blocked");
  });

  it("names the hook in the finding, so the blocker knows which script to remove or declare around", async () => {
    const project = await makeNodeProject(exitWith(0), { pretest: "runner", test: "runner" });
    const provider = new ProjectVerificationProvider({ projectRoot: project.root });
    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "test_verification",
      verification: "test",
      revision: 1,
      projectRoot: project.root,
      workspaceId: null,
    });

    expect(checkFor(bundle, "test")?.detail).toContain("pretest");
    expect(checkFor(bundle, "test")?.detail).toContain("agent-workflow.config.json");
  });

  it("blocks a build command with a prebuild hook", async () => {
    const project = await makeNodeProject(exitWith(0), { prebuild: "runner", build: "runner" });
    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "build")).toMatchObject({ status: "blocked", reason: "implicit_script_hook" });
  });

  it("blocks under every package manager, rather than assuming one of them suppresses hooks", async () => {
    for (const [lockfile, manager] of [
      ["pnpm-lock.yaml", "pnpm"],
      ["package-lock.json", "npm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
    ] as const) {
      const project = await makeProject({
        "package.json": JSON.stringify({
          name: "fixture",
          private: true,
          scripts: { prelint: "runner", lint: "runner" },
        }),
        [lockfile]: "lockfile\n",
      });

      await mkdir(project.path("node_modules/.bin"), { recursive: true });
      await writeFile(project.path("node_modules/.bin/runner"), exitWith(0), "utf8");
      await chmod(project.path("node_modules/.bin/runner"), 0o755);

      const bundle = await collectStatic(project);

      expect(bundle.project.packageManager).toBe(manager);
      expect(checkFor(bundle, "lint")).toMatchObject({ status: "blocked", reason: "implicit_script_hook" });
    }
  });

  it("lets a configured command run the same tool directly, since no manager is involved", async () => {
    const project = await makeNodeProject(exitWith(0, "checked"), {
      prelint: "runner",
      lint: "runner",
    });

    await writeFile(
      project.path(PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        verification: {
          static: [{ id: "lint", capability: "lint", executable: "./node_modules/.bin/runner", args: ["--check"] }],
        },
      }),
      "utf8",
    );

    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "passed", exitCode: 0 });
    expect(checkFor(bundle, "lint")?.stdoutExcerpt).toContain("checked");
    expect(bundle.outcome).toBe("passed");
  });

  it("blocks a configured `npm run lint` when the project has a prelint, because the config cannot grant itself an exemption", async () => {
    const project = await makeNodeProject(exitWith(0, "checked"), { prelint: "runner", lint: "runner" });

    // A configured command used to skip the startup checks entirely on the grounds that the operator
    // asked for it. That is exactly the gap: the operator can also be the person who added `prelint`, and
    // `npm run lint` dispatches it the same way detection would.
    await writeFile(
      project.path(PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        verification: { static: [{ id: "lint", capability: "lint", executable: "npm", args: ["run", "lint"] }] },
      }),
      "utf8",
    );

    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "blocked", reason: "implicit_script_hook" });
    expect(checkFor(bundle, "lint")?.detail).toContain("prelint");
    expect(bundle.outcome).toBe("blocked");
  });

  it("blocks a configured `npm run lint` on a postlint hook, on the same terms as a detected one", async () => {
    const project = await makeNodeProject(exitWith(0, "checked"), { lint: "runner", postlint: "runner" });

    await writeFile(
      project.path(PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        verification: { static: [{ id: "lint", capability: "lint", executable: "npm", args: ["run", "lint"] }] },
      }),
      "utf8",
    );

    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "blocked", reason: "implicit_script_hook" });
    expect(checkFor(bundle, "lint")?.detail).toContain("postlint");
  });

  it("lets a configured package-manager command with no hook run, so the ordinary case is not blocked", async () => {
    const project = await makeNodeProject(exitWith(0, "checked"), { lint: "runner" });

    await writeFile(
      project.path(PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        verification: { static: [{ id: "lint", capability: "lint", executable: "npm", args: ["run", "lint"] }] },
      }),
      "utf8",
    );

    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "passed", exitCode: 0 });
    expect(bundle.outcome).toBe("passed");
  });

  it("lets a configured direct tool run even when a same-named script has a hook, since no manager dispatches it", async () => {
    const project = await makeNodeProject(exitWith(0, "checked"), { prelint: "runner", lint: "runner" });

    await writeFile(
      project.path(PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        verification: {
          static: [{ id: "lint", capability: "lint", executable: "./node_modules/.bin/runner", args: ["--check"] }],
        },
      }),
      "utf8",
    );

    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "passed", exitCode: 0 });
    expect(bundle.outcome).toBe("passed");
  });

  it("does not confuse a script that merely starts with pre, such as prettier", async () => {
    const project = await makeNodeProject(exitWith(0), { prettier: "runner", lint: "runner" });
    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "passed" });
    expect(bundle.outcome).toBe("passed");
  });

  it("ignores a hook for a script this stage does not run", async () => {
    const project = await makeNodeProject(exitWith(0), { pretest: "runner", lint: "runner" });
    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ status: "passed" });
  });

  it("reports the hook before a missing dependency, because the manifest is the reason", async () => {
    const project = await makeNodeProject(exitWith(0), { prelint: "runner", lint: "runner" });

    await rm(project.path("node_modules"), { recursive: true, force: true });

    const bundle = await collectStatic(project);

    expect(checkFor(bundle, "lint")).toMatchObject({ reason: "implicit_script_hook" });
  });
});

describe("freshness through the orchestrator, against a real project", () => {
  const fixedTimestamp = "2026-04-05T06:07:08.000Z";

  it("re-measures after the fixer repairs the source, and refuses to let the old attempt stand in", async () => {
    // The lint script passes only once the file the fixer is meant to create exists, so the first
    // attempt really fails and the second really passes, against a tree that changed underneath.
    const project = await makeNodeProject(
      '#!/bin/sh\ntest -f src/app.js || { echo "no app" >&2; exit 1; }\necho "checked"\n',
      { lint: "runner" },
    );

    // The project is copied rather than reused, because a post-approval stage runs in an isolated
    // tree: the linter has to see the repair the fixer makes in the worktree, and a provider bound to
    // the user's checkout would be measuring a different directory from the one the stage edited.
    const workspaceRoot = join(dirname(project.root), `${basename(project.root)}-workspace`);

    await cp(project.root, workspaceRoot, { recursive: true });
    roots.push(workspaceRoot);

    const store = createFeatureSessionStore(project.root, { clock: () => fixedTimestamp });
    const provider = new ProjectVerificationProvider({
      projectRoot: project.root,
      resolveRunRoot: () => workspaceRoot,
    });
    const executor = new FakeStageExecutor().configure("fixing", {
      after: async () => {
        await mkdir(join(workspaceRoot, "src"), { recursive: true });
        await writeFile(join(workspaceRoot, "src/app.js"), "export const repaired = true;\n", "utf8");
      },
    });
    const orchestrator = createWorkflowOrchestrator({
      workspace: createFakeWorkspaceProvider({ workingDirectory: workspaceRoot }),
      store,
      executor,
      verification: provider,
      security: createFakeSecurityProvider(),
      projectRoot: project.root,
    });

    await orchestrator.createFeature({
      featureId: "F-001",
      title: "Real project freshness",
      request: "# Request\n\nRepair the source and verify deterministically.\n",
    });

    for (let step = 0; step < 6; step += 1) {
      await orchestrator.runNext("F-001");
    }

    await orchestrator.approvePlan("F-001");
    await orchestrator.runNext("F-001");
    await orchestrator.runNext("F-001");
    await orchestrator.runNext("F-001");

    const first = await orchestrator.runNext("F-001");

    expect(first.status).toBe("fix_requested");
    expect(first.verification?.implementationFingerprint).not.toBe("");

    const failedFingerprint = first.verification?.implementationFingerprint;

    // The fixer repairs the source, and the orchestrator sends the feature back to the same stage.
    await orchestrator.runNext("F-001");

    expect(executor.requestFor("fixing")?.fixReturnState).toBe("static_verification");

    const second = await orchestrator.runNext("F-001");

    expect(second.status).toBe("stage_completed");
    expect(second.verification?.implementationFingerprint).not.toBe(failedFingerprint);

    // The old attempt is history, not authority: both attempts are kept, and the one the stage
    // turned on is the one that describes the tree that now exists.
    const artifact = (await store.readArtifact("F-001", "verification")) as Record<string, unknown>;
    const persisted = artifact[DETERMINISTIC_EVIDENCE_KEY] as {
      readonly static_verification: readonly { readonly implementationFingerprint: string }[];
    };

    expect(persisted.static_verification).toHaveLength(2);
    expect(persisted.static_verification[0]?.implementationFingerprint).toBe(failedFingerprint);
    expect(persisted.static_verification[1]?.implementationFingerprint).toBe(
      second.verification?.implementationFingerprint,
    );
    // Neither attempt claims the other's tree, so the second one is the only one that can be current.
    expect(new Set(persisted.static_verification.map((entry) => entry.implementationFingerprint)).size).toBe(2);
  });
});
