import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBaseline } from "@agent-workflow-kit/core";
import { GitWorkspaceProvider, runGit, sidecarPath } from "@agent-workflow-kit/workspace";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The Git adapter against real repositories.
 *
 * The fake provider in `fixtures/workspace-provider.ts` covers the orchestration; everything that could
 * only be faked — porcelain parsing, worktree creation, index state, symlinks, untracked files, the
 * sidecar on disk — is exercised here against repositories this file creates and destroys. A guarantee
 * that is only ever tested against a double is a guarantee nobody has checked.
 */

const roots: string[] = [];

interface Repository {
  readonly root: string;
  readonly cacheRoot: string;
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** For the queries whose non-zero exit is the answer, like a detached HEAD. */
function gitResult(cwd: string, ...args: readonly string[]): { readonly status: number; readonly stdout: string } {
  try {
    return { status: 0, stdout: execFileSync("git", [...args], { cwd, encoding: "utf8" }) };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };

    return { status: failure.status ?? 1, stdout: failure.stdout ?? "" };
  }
}

/** A repository with one commit, plus a sibling cache root that is deliberately not in the repository. */
async function makeRepository(): Promise<Repository> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-git-"));
  roots.push(base);

  const root = join(base, "repo");
  const cacheRoot = join(base, "cache");

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });

  git(root, "init", "--quiet", "--initial-branch=main", ".");
  git(root, "config", "user.email", "workspace@example.invalid");
  git(root, "config", "user.name", "Workspace Test");
  git(root, "config", "commit.gpgsign", "false");

  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "initial");

  return { root, cacheRoot };
}

function providerFor(repository: Repository, options: { readonly now?: () => number } = {}): GitWorkspaceProvider {
  return new GitWorkspaceProvider({
    cacheRoot: repository.cacheRoot,
    isoNow: () => "2026-04-05T06:07:08.000Z",
    ...options,
  });
}

async function baselineFor(repository: Repository): Promise<WorkspaceBaseline> {
  const capture = await providerFor(repository).captureBaseline(repository.root);

  if (!capture.ok) {
    throw new Error(`The fixture repository was refused: ${capture.message}`);
  }

  return {
    repositoryRoot: capture.capture.repositoryRoot,
    baselineCommit: capture.capture.headCommit,
    approvedRevision: 3,
    workspaceId: "f001",
    capturedAt: capture.capture.capturedAt,
  };
}

async function openWorkspace(
  repository: Repository,
  baseline: WorkspaceBaseline,
  provider: GitWorkspaceProvider = providerFor(repository),
) {
  const outcome = await provider.open({ featureId: "F-001", baseline, access: "read_write" });

  if (!outcome.ok) {
    throw new Error(`The workspace was refused: ${outcome.code}: ${outcome.message}`);
  }

  return outcome.workspace;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("capturing a baseline", () => {
  it("reports the repository root, the full commit, and a clean tree", async () => {
    const repository = await makeRepository();
    const outcome = await providerFor(repository).captureBaseline(repository.root);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) {
      return;
    }

    expect(outcome.capture).toMatchObject({
      repositoryRoot: repository.root,
      clean: true,
      stagedPaths: [],
      unstagedPaths: [],
    });
    expect(outcome.capture.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repository.root, "rev-parse", "HEAD").trim()).toBe(outcome.capture.headCommit);
  });

  it("refuses a repository with uncommitted tracked work, and names the paths", async () => {
    const repository = await makeRepository();
    await writeFile(join(repository.root, "src", "app.ts"), "export const value = 2;\n", "utf8");

    const outcome = await providerFor(repository).captureBaseline(repository.root);

    expect(outcome).toMatchObject({ ok: false, code: "tracked_workspace_dirty" });
    expect((outcome.ok ? undefined : outcome.message)).toContain("src/app.ts");
    expect((outcome.ok ? undefined : outcome.capture?.unstagedPaths)).toEqual(["src/app.ts"]);
  });

  it("refuses a staged change, which is work the human has not committed either", async () => {
    const repository = await makeRepository();
    await writeFile(join(repository.root, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
    git(repository.root, "add", "src/extra.ts");

    const outcome = await providerFor(repository).captureBaseline(repository.root);

    expect(outcome).toMatchObject({ ok: false, code: "tracked_workspace_dirty" });
    expect((outcome.ok ? undefined : outcome.capture?.stagedPaths)).toEqual(["src/extra.ts"]);
  });

  it("does not care about untracked files, which is how the framework's own state is stored", async () => {
    const repository = await makeRepository();
    await mkdir(join(repository.root, ".agentflow", "features"), { recursive: true });
    await writeFile(join(repository.root, ".agentflow", "features", "F-001.json"), "{}\n", "utf8");

    const outcome = await providerFor(repository).captureBaseline(repository.root);

    expect(outcome).toMatchObject({ ok: true });
  });

  it("refuses a directory that is not a repository", async () => {
    const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-plain-"));
    roots.push(base);
    const plain = join(base, "not-a-repo");
    await mkdir(plain);

    const outcome = await providerFor({ root: plain, cacheRoot: join(base, "cache") }).captureBaseline(plain);

    expect(outcome).toMatchObject({ ok: false, code: "not_a_git_repository" });
  });
});

describe("opening an isolated workspace", () => {
  it("creates a detached worktree at the approved commit, outside the repository", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const workspace = await openWorkspace(repository, baseline);

    expect(workspace.workingDirectory).toBe(join(repository.cacheRoot, "f001"));
    expect(workspace.workingDirectory.startsWith(repository.root)).toBe(false);
    expect(git(workspace.workingDirectory, "rev-parse", "HEAD").trim()).toBe(baseline.baselineCommit);
    // Detached means no branch is checked out, so nothing here can move a human's branch.
    // A detached worktree has no symbolic HEAD, which is what "nothing here can move a branch" means.
    expect(gitResult(workspace.workingDirectory, "symbolic-ref", "-q", "HEAD").status).toBe(1);
    expect(await readFile(join(workspace.workingDirectory, "src", "app.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  it("hands the same directory back to the next run, and registers one worktree", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const first = await openWorkspace(repository, baseline, provider);

    await provider.close(first);

    // A second run of the same feature: a new provider instance with no memory of the first.
    const second = await openWorkspace(repository, baseline, providerFor(repository));

    expect(second.workingDirectory).toBe(first.workingDirectory);
    expect(git(repository.root, "worktree", "list").split("\n").filter((line) => line.includes("f001"))).toHaveLength(1);
  });

  it("refuses a second open in one process, because two stages would interleave in one worktree", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    await openWorkspace(repository, baseline);

    const outcome = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome).toMatchObject({ ok: false, code: "lease_unavailable" });
    expect((outcome.ok ? undefined : outcome.message)).toContain("already leased by this process");
  });

  it("refuses when the repository has moved past the approved commit", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    await writeFile(join(repository.root, "README.md"), "# Moved on\n", "utf8");
    git(repository.root, "commit", "--quiet", "-am", "moved on");

    const outcome = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome).toMatchObject({ ok: false, code: "head_changed" });
    expect((outcome.ok ? undefined : outcome.message)).toContain("Re-approve the plan");
  });

  it("refuses an existing directory it did not create, and leaves it alone", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    await mkdir(join(repository.cacheRoot, "f001"), { recursive: true });
    await writeFile(join(repository.cacheRoot, "f001", "someone-elses.txt"), "not ours\n", "utf8");

    const outcome = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome).toMatchObject({ ok: false, code: "workspace_path_occupied" });
    expect(await readFile(join(repository.cacheRoot, "f001", "someone-elses.txt"), "utf8")).toBe("not ours\n");
  });

  it("refuses a cache root inside the repository", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const inside = new GitWorkspaceProvider({ cacheRoot: join(repository.root, ".worktrees") });

    const outcome = await inside.open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome).toMatchObject({ ok: false, code: "workspace_path_occupied" });
    expect((outcome.ok ? undefined : outcome.message)).toContain("inside the repository");
  });

  it("refuses a workspace whose metadata says it belongs to another repository", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const workspace = await openWorkspace(repository, baseline);

    const metadata = sidecarPath(workspace.workingDirectory);
    const sidecar = JSON.parse(await readFile(metadata, "utf8")) as Record<string, unknown>;
    sidecar["repositoryRoot"] = "/somewhere/else";
    await writeFile(metadata, JSON.stringify(sidecar), "utf8");

    const outcome = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome).toMatchObject({ ok: false, code: "workspace_registered_elsewhere" });
  });

  it("refuses corrupt metadata instead of rewriting it", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const workspace = await openWorkspace(repository, baseline);

    const metadata = sidecarPath(workspace.workingDirectory);
    await writeFile(metadata, "{ this is not json", "utf8");

    const outcome = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome).toMatchObject({ ok: false, code: "workspace_metadata_corrupt" });
    // The unreadable file is still exactly as it was, for a human to look at.
    expect(await readFile(metadata, "utf8")).toBe("{ this is not json");
  });

  it("refuses a workspace that was committed to inside, rather than resetting it", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const first = await openWorkspace(repository, baseline);
    await writeFile(join(first.workingDirectory, "src", "app.ts"), "export const value = 9;\n", "utf8");
    git(first.workingDirectory, "commit", "--quiet", "-am", "committed in the workspace");
    const commit = git(first.workingDirectory, "rev-parse", "HEAD").trim();

    const outcome = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome).toMatchObject({ ok: false, code: "head_changed" });
    // The commit is still there. Overwriting it would have destroyed the only record of it.
    expect(git(first.workingDirectory, "rev-parse", "HEAD").trim()).toBe(commit);
  });
});

describe("inspecting a workspace", () => {
  it("reports a modified path as tracked and a new file as untracked, against the approved commit", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    await writeFile(join(workspace.workingDirectory, "src", "app.ts"), "export const value = 3;\n", "utf8");
    await writeFile(join(workspace.workingDirectory, "src", "new.ts"), "export const fresh = 1;\n", "utf8");

    const inspected = await provider.inspect({ workspace });

    expect(inspected.ok).toBe(true);

    if (!inspected.ok) {
      return;
    }

    expect(inspected.inspection.changes).toEqual({
      modified: ["src/app.ts"],
      added: [],
      deleted: [],
      renamed: [],
      untracked: ["src/new.ts"],
    });
    expect(inspected.inspection.gitState).toEqual({ headCommit: baseline.baselineCommit, stagedPaths: [] });
  });

  it("reports a deletion, and a rename as a pair", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    await rm(join(workspace.workingDirectory, "README.md"));
    git(workspace.workingDirectory, "mv", "src/app.ts", "src/main.ts");

    const inspected = await provider.inspect({ workspace });

    expect(inspected.ok && inspected.inspection.changes.deleted).toContain("README.md");
    expect(inspected.ok && inspected.inspection.changes.renamed).toEqual([{ from: "src/app.ts", to: "src/main.ts" }]);
  });

  it("reads a path with a space and a quote in it as one path", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    const name = `weird name with spaces and "quotes".ts`;
    await writeFile(join(workspace.workingDirectory, "src", name), "export const odd = 1;\n", "utf8");

    const inspected = await provider.inspect({ workspace });

    expect(inspected.ok && inspected.inspection.changes.untracked).toEqual([`src/${name}`]);
  });

  it("refuses a subcommand that could move a branch, rewrite history, or delete what it was not told to", async () => {
    const repository = await makeRepository();

    // The refusal is a thrown programming error rather than a result, because nothing in this package
    // can be the reason a `push` is attempted: there is no call site that would want one.
    for (const verb of ["commit", "push", "reset", "clean", "rebase", "merge", "stash", "branch", "update-ref", "gc"]) {
      expect(() => runGit({ cwd: repository.root, args: [verb, "--dry-run"] })).toThrow(/refuses to run git/);
    }
  });

  it("refuses a read that a repository's own configuration could turn into something else", async () => {
    const repository = await makeRepository();

    for (const argument of ["--upload-pack", "--config", "--git-dir", "--exec", "--namespace"]) {
      expect(() => runGit({ cwd: repository.root, args: ["status", argument, "x"] })).toThrow(/refuses to run git/);
    }
  });

  it("reports a staged new file as added, and not as a modification of something approved", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    await writeFile(join(workspace.workingDirectory, "src", "staged.ts"), "export const staged = 1;\n", "utf8");
    git(workspace.workingDirectory, "add", "src/staged.ts");

    const inspected = await provider.inspect({ workspace });

    expect(inspected.ok && inspected.inspection.changes).toMatchObject({
      added: ["src/staged.ts"],
      modified: [],
      untracked: [],
    });
  });

  it("reports a staged path, because a moved index is what a commit is made of", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    await writeFile(join(workspace.workingDirectory, "src", "app.ts"), "export const value = 4;\n", "utf8");
    git(workspace.workingDirectory, "add", "src/app.ts");

    const inspected = await provider.inspect({ workspace });

    expect(inspected.ok && inspected.inspection.gitState.stagedPaths).toEqual(["src/app.ts"]);
  });
});

describe("reversing an unauthorized change", () => {
  it("returns a tracked path to the approved content, not to something remembered", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    await writeFile(join(workspace.workingDirectory, "src", "app.ts"), "export const value = 99;\n", "utf8");

    const enforced = await provider.enforceScope({
      workspace,
      paths: [{ path: "src/app.ts", category: "tracked", existedAtBaseline: true }],
    });

    expect(enforced.ok && enforced.enforcement.restored).toEqual(["src/app.ts"]);
    expect(await readFile(join(workspace.workingDirectory, "src", "app.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  it("removes a file the approved commit never had", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    await mkdir(join(workspace.workingDirectory, "src", "deep"), { recursive: true });
    await writeFile(join(workspace.workingDirectory, "src", "deep", "sneaky.ts"), "export const sneaky = 1;\n", "utf8");

    const enforced = await provider.enforceScope({
      workspace,
      paths: [{ path: "src/deep/sneaky.ts", category: "untracked", existedAtBaseline: false }],
    });

    expect(enforced.ok && enforced.enforcement.removed).toEqual(["src/deep/sneaky.ts"]);
    // The directory the agent created goes with it, so nothing is left for a later `git add -A`.
    await expect(readFile(join(workspace.workingDirectory, "src", "deep", "sneaky.ts"), "utf8")).rejects.toThrow();
  });

  it("refuses to follow a symlink out of the workspace", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    const outside = join(repository.root, "precious.txt");
    await writeFile(outside, "a human's file\n", "utf8");
    await symlink(outside, join(workspace.workingDirectory, "link.txt"));

    const enforced = await provider.enforceScope({
      workspace,
      paths: [{ path: "link.txt", category: "untracked", existedAtBaseline: false }],
    });

    expect(enforced.ok && enforced.enforcement.removed).toEqual([]);
    expect(enforced.ok && enforced.enforcement.unsafePaths).toEqual(["link.txt"]);
    // The file on the other side of the link is still there, which is the entire point.
    expect(await readFile(outside, "utf8")).toBe("a human's file\n");
  });

  it("refuses a path that tries to leave the workspace", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    const enforced = await provider.enforceScope({
      workspace,
      paths: [{ path: "../repo/README.md", category: "tracked", existedAtBaseline: true }],
    });

    expect(enforced.ok && enforced.enforcement.unsafePaths).toEqual(["../repo/README.md"]);
    expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe("# Fixture\n");
  });
});

describe("holding and releasing the lease", () => {
  it("refuses a second holder while the first process is alive", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    await openWorkspace(repository, baseline, provider);

    const outcome = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome).toMatchObject({ ok: false, code: "lease_unavailable" });
  });

  it("hands the workspace back on close, so a later run can take it", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    await provider.close(workspace);

    const again = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });
    expect(again.ok).toBe(true);
  });

  it("takes over a lease whose owner is gone", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    // A lease owned by a process that no longer exists, on this host: the crash case the deadline and
    // the process table exist for.
    const metadata = sidecarPath(workspace.workingDirectory);
    const sidecar = JSON.parse(await readFile(metadata, "utf8")) as Record<string, unknown>;
    sidecar["lease"] = {
      token: "0123456789abcdef0123",
      pid: 999_999,
      host: hostname(),
      acquiredAt: "2026-04-05T06:00:00.000Z",
      expiresAt: Date.now() + 3_600_000,
    };
    await writeFile(metadata, JSON.stringify(sidecar), "utf8");

    const outcome = await providerFor(repository).open({ featureId: "F-001", baseline, access: "read_write" });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.workspace.workingDirectory).toBe(workspace.workingDirectory);
  });
});

describe("workspace cleanup", () => {
  it("leaves the worktree registered so the next run finds it", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const workspace = await openWorkspace(repository, baseline);

    expect(git(repository.root, "worktree", "list")).toContain(workspace.workingDirectory);
    expect(git(repository.root, "worktree", "list", "--porcelain")).toContain("detached");
  });

  it("prunes an empty directory it created, without touching the workspace root", async () => {
    const repository = await makeRepository();
    const baseline = await baselineFor(repository);
    const provider = providerFor(repository);
    const workspace = await openWorkspace(repository, baseline, provider);

    await mkdir(join(workspace.workingDirectory, "empty", "deeper"), { recursive: true });
    await writeFile(join(workspace.workingDirectory, "empty", "deeper", "file.ts"), "x\n", "utf8");

    await provider.enforceScope({
      workspace,
      paths: [{ path: "empty/deeper/file.ts", category: "untracked", existedAtBaseline: false }],
    });

    const inspected = await provider.inspect({ workspace });
    expect(inspected.ok && inspected.inspection.changes.untracked).toEqual([]);
    expect(git(workspace.workingDirectory, "status", "--porcelain", "-z", "--untracked-files=all").trim()).toBe("");
  });
});
