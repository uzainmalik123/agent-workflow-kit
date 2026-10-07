import { mkdir, mkdtemp, rm, writeFile, readFile, lstat, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
const cliPath = join(__dirname, "../apps/cli/dist/cli.js");

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-init-"));
  roots.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }

  return root;
}

async function gitInit(root: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", "."], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
}

async function runInit(root: string): Promise<ExecResult> {
  try {
    const result = await execFileAsync("node", [cliPath, "init"], { cwd: root });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const err = error as Partial<ExecResult>;
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

/** Any git invocation, with its exit code, so a non-zero result (as `check-ignore` gives) is data. */
async function gitResult(root: string, ...args: string[]): Promise<ExecResult> {
  try {
    const result = await execFileAsync("git", args, { cwd: root });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const err = error as Partial<ExecResult>;
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("agentflow init", () => {
  it("initializes a TypeScript Node project", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({
        name: "test-project",
        private: true,
        scripts: { lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc -b", test: "vitest run" },
        devDependencies: { eslint: "^9.0.0", typescript: "^5.0.0", vitest: "^3.0.0" },
      }, null, 2),
      "tsconfig.json": "{}",
      "eslint.config.js": "export default [];",
      "pnpm-lock.yaml": "lockfileVersion: 9.0\n",
    });

    await gitInit(root);

    const result = await runInit(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Created agent-workflow.config.json");
    expect(result.stdout).toContain("Initialized Agent Workflow Kit project");

    const configPath = join(root, "agent-workflow.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { schemaVersion: number; verification: { static: unknown[]; test: unknown[] } };
    expect(config).toEqual({
      schemaVersion: 1,
      verification: { static: [], test: [] },
    });

    const featuresDir = join(root, ".agentflow", "features");
    const stats = await lstat(featuresDir);
    expect(stats.isDirectory()).toBe(true);

    const existingFiles = await readdir(root);
    expect(existingFiles).toContain("package.json");
    expect(existingFiles).toContain("tsconfig.json");
    expect(existingFiles).toContain("eslint.config.js");
    expect(existingFiles).toContain("pnpm-lock.yaml");
  });

  it("is idempotent: running twice preserves existing config", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
      "tsconfig.json": "{}",
      "package-lock.json": "{}",
    });

    await gitInit(root);

    await runInit(root);
    const firstConfig = JSON.parse(await readFile(join(root, "agent-workflow.config.json"), "utf8")) as { schemaVersion: number; verification: { static: unknown[]; test: unknown[] } };

    const result = await runInit(root);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Created agent-workflow.config.json");
    expect(result.stdout).toContain("Initialized Agent Workflow Kit project");

    const secondConfig = JSON.parse(await readFile(join(root, "agent-workflow.config.json"), "utf8")) as { schemaVersion: number; verification: { static: unknown[]; test: unknown[] } };
    expect(secondConfig).toEqual(firstConfig);
  });

  it("refuses to run outside a Git repository", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
    });

    const result = await runInit(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Not a Git repository");
  });

  it("refuses to run from a subdirectory of a Git repository", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
      "tsconfig.json": "{}",
      "package-lock.json": "{}",
    });

    await gitInit(root);

    const subdir = join(root, "subdir");
    await mkdir(subdir);

    const result = await runInit(subdir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Git repository root is at");
    expect(result.stderr).toContain("Run 'agentflow init' from the repository root");
  });

  it("initializes a Python project (unsupported ecosystem)", async () => {
    const root = await makeProject({
      "pyproject.toml": "[project]\nname = \"fixture\"\n",
    });

    await gitInit(root);

    const result = await runInit(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Initialized Agent Workflow Kit project");
  });

  it("does not modify existing project files", async () => {
    const originalPackageJson = JSON.stringify({ name: "test-project", private: true, version: "1.0.0" }, null, 2);
    const originalTsconfig = '{"compilerOptions": {"strict": true}}';

    const root = await makeProject({
      "package.json": originalPackageJson,
      "tsconfig.json": originalTsconfig,
      "package-lock.json": "{}",
    });

    await gitInit(root);

    await runInit(root);

    const packageJson = await readFile(join(root, "package.json"), "utf8");
    const tsconfig = await readFile(join(root, "tsconfig.json"), "utf8");

    expect(packageJson).toBe(originalPackageJson);
    expect(tsconfig).toBe(originalTsconfig);
  });

  it("preserves existing Git state", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
      "tsconfig.json": "{}",
      "package-lock.json": "{}",
    });

    await gitInit(root);
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });

    const beforeStatus = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });
    expect(beforeStatus.stdout.trim()).toBe("");

    await runInit(root);

    const afterStatus = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });
    expect(afterStatus.stdout.trim()).toContain("agent-workflow.config.json");
    expect(afterStatus.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("allows status command to read initialized project", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
      "tsconfig.json": "{}",
      "package-lock.json": "{}",
    });

    await gitInit(root);
    await runInit(root);

    // status exits with code 1 when no sessions exist, which is expected behavior
    let result: ExecResult;
    try {
      const execResult = await execFileAsync("node", [cliPath, "status"], { cwd: root });
      result = { stdout: execResult.stdout, stderr: execResult.stderr, code: 0 };
    } catch (error: unknown) {
      const err = error as Partial<ExecResult>;
      result = { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
    }
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No workflow sessions found");
  });

  it("makes .agentflow/ impossible to commit by accident: nothing shows in status, everything is ignored", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
      "tsconfig.json": "{}",
      "package-lock.json": "{}",
    });

    await gitInit(root);
    const init = await runInit(root);
    expect(init.code).toBe(0);

    // What a real run leaves behind under .agentflow/: runtime records and persisted sessions.
    await mkdir(join(root, ".agentflow", "recordings", "F-001", "grill", "t"), { recursive: true });
    await writeFile(join(root, ".agentflow", "recordings", "F-001", "grill", "t", "stdout.txt"), "captured\n", "utf8");
    await mkdir(join(root, ".agentflow", "features", "F-001"), { recursive: true });
    await writeFile(join(root, ".agentflow", "features", "F-001", "session.json"), "{}\n", "utf8");

    const status = await gitResult(root, "status", "--porcelain");
    expect(status.code).toBe(0);
    expect(status.stdout.split("\n").filter((line) => line.includes(".agentflow"))).toEqual([]);

    for (const path of [
      ".agentflow/.gitignore",
      ".agentflow/recordings/F-001/grill/t/stdout.txt",
      ".agentflow/features/F-001/session.json",
    ]) {
      const check = await gitResult(root, "check-ignore", "-v", path);
      expect(check.code, `${path} should be reported as ignored`).toBe(0);
      expect(check.stdout).toContain(path);
    }

    // The config stays committable: it is outside .agentflow/ and still shows up.
    const configStatus = await gitResult(root, "status", "--porcelain", "agent-workflow.config.json");
    expect(configStatus.stdout).toContain("agent-workflow.config.json");
  });

  it("leaves an existing .agentflow/.gitignore with other content untouched, and reports it", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
      "tsconfig.json": "{}",
      "package-lock.json": "{}",
    });

    await gitInit(root);
    await mkdir(join(root, ".agentflow"), { recursive: true });
    await writeFile(join(root, ".agentflow", ".gitignore"), "state/\n!state/keep.json\n", "utf8");

    const init = await runInit(root);
    expect(init.code).toBe(0);
    expect(await readFile(join(root, ".agentflow", ".gitignore"), "utf8")).toBe("state/\n!state/keep.json\n");

    const reported = `${init.stdout}\n${init.stderr}`;
    expect(reported).toContain(".agentflow/.gitignore");
    expect(reported).toContain("untouched");

    // And a re-run over the framework's own file is idempotent: same content, success, no churn.
    const second = await runInit(root);
    expect(second.code).toBe(0);
    expect(await readFile(join(root, ".agentflow", ".gitignore"), "utf8")).toBe("state/\n!state/keep.json\n");
  });

  it("writes .agentflow/.gitignore only through a real directory, never through a symlink", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
      "tsconfig.json": "{}",
      "package-lock.json": "{}",
    });

    await gitInit(root);
    await mkdir(join(root, "link-target"), { recursive: true });
    await symlink(join(root, "link-target"), join(root, ".agentflow"));

    const init = await runInit(root);
    expect(init.code).not.toBe(0);
    expect(init.stderr).toContain("symbolic link");

    // Nothing was created through the link.
    expect(await readdir(join(root, "link-target"))).toEqual([]);
  });

  it("is idempotent: a second init keeps .agentflow/.gitignore exactly as it wrote it", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "test", private: true }),
      "tsconfig.json": "{}",
      "package-lock.json": "{}",
    });

    await gitInit(root);
    const first = await runInit(root);
    expect(first.code).toBe(0);
    expect(await readFile(join(root, ".agentflow", ".gitignore"), "utf8")).toBe("*\n");

    const second = await runInit(root);
    expect(second.code).toBe(0);
    expect(await readFile(join(root, ".agentflow", ".gitignore"), "utf8")).toBe("*\n");
  });
});