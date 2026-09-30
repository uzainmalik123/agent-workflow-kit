import { rm, rmdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceBaseline } from "@agent-workflow-kit/core";
import type {
  BaselineCapture,
  BaselineCaptureOutcome,
  EnforceScopeOutcome,
  EnforceScopeRequest,
  InspectWorkspaceOutcome,
  InspectWorkspaceRequest,
  OpenWorkspaceOutcome,
  OpenWorkspaceRequest,
  ProjectWorkspace,
  ProjectWorkspaceProvider,
  WorkspaceAccessLevel,
  WorkspaceChanges,
  WorkspaceRefusalCode,
  WorkspaceUnauthorizedPath,
} from "@agent-workflow-kit/orchestration";

import { WorkspaceAdapterError } from "./errors.js";
import { tryGit } from "./git.js";
import { acquireLease, releaseLease, DEFAULT_LEASE_TTL_MS } from "./lease.js";
import { assertRepositoryRelative, resolveRealPathInside } from "./paths.js";
import { parseStatus, trackedStateFrom, type ParsedStatus } from "./status.js";
import { readSidecar, writeSidecar, type WorkspaceSidecar } from "./sidecar.js";

/**
 * The Git-backed isolated workspace.
 *
 * A post-approval stage runs in `git worktree add --detach <dir> <approved commit>`, and that is the
 * only construction with the three properties this milestone needs:
 *
 * - it is detached, so nothing the agent does can move a branch or touch a human's checkout;
 * - it starts at exactly the commit the approval froze, so the tree the stage reads is the tree the
 *   human reviewed rather than whatever the branch has become since;
 * - it is a real worktree, so the project still looks like a project: `.git` resolves, ignore rules
 *   still apply, and the repository's own toolchain runs the way it is written to run.
 *
 * The workspace lives outside the repository, in a cache directory the framework owns, because a
 * worktree inside the repository is a directory the human's own tooling will find, lint, and commit.
 */
export interface GitWorkspaceProviderOptions {
  /**
   * Where worktrees are created. Must be outside the repository it serves. Defaults to
   * `$XDG_CACHE_HOME/agent-workflow-kit/workspaces`, or `~/.cache/agent-workflow-kit/workspaces`.
   */
  readonly cacheRoot?: string;
  readonly leaseTtlMs?: number;
  /** Injectable millisecond clock, so lease deadlines are reproducible in tests. */
  readonly now?: () => number;
  /** Injectable clock for the timestamps in records. */
  readonly isoNow?: () => string;
}

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** Git's own answer to "is this a repository, and which one", as a filesystem path. */
const REPOSITORY_ROOT_QUERY = ["rev-parse", "--path-format=absolute", "--show-toplevel"];

/** The worktree's HEAD as a full object name, never a symbolic reference. */
const HEAD_QUERY = ["rev-parse", "HEAD"];

/** Every path the approved commit contains, so a new file can be told from a changed one. */
const BASELINE_TREE_QUERY = ["ls-tree", "-r", "--name-only", "-z"];

export class GitWorkspaceProvider implements ProjectWorkspaceProvider {
  readonly #options: GitWorkspaceProviderOptions;

  /** The lease token this process holds per workspace, so `close` releases only its own lease. */
  readonly #heldLeases = new Map<string, string>();

  constructor(options: GitWorkspaceProviderOptions = {}) {
    this.#options = options;
  }

  async captureBaseline(repositoryRoot: string): Promise<BaselineCaptureOutcome> {
    const root = resolve(repositoryRoot);
    const capturedAt = this.#isoNow();

    const top = await tryGit({ cwd: root, args: REPOSITORY_ROOT_QUERY });

    if (!top.ok) {
      return {
        ok: false,
        code: "not_a_git_repository",
        message: `${top.detail}. A baseline is a commit, and a directory that is not a git repository has none to freeze.`,
        capture: null,
      };
    }

    const repository = top.stdout.trim();

    if (!isAbsolute(repository)) {
      return {
        ok: false,
        code: "repository_unreadable",
        message: `git reported the repository root as "${repository}", which is not an absolute path. Refusing rather than guessing which repository this is.`,
        capture: null,
      };
    }

    const head = await tryGit({ cwd: root, args: HEAD_QUERY });

    if (!head.ok) {
      return {
        ok: false,
        code: "head_unborn",
        message: `${head.detail}. A repository with no commit has no approved starting point to create a worktree from.`,
        capture: null,
      };
    }

    const headCommit = head.stdout.trim();

    if (!FULL_COMMIT.test(headCommit)) {
      return {
        ok: false,
        code: "repository_unreadable",
        message: `git reported HEAD as "${headCommit}", which is not a full commit id. A worktree is detached from a commit rather than from a name that can be moved, so an abbreviated or symbolic HEAD is refused.`,
        capture: null,
      };
    }

    const status = await this.#status(root);
    const state = trackedStateFrom(status);
    const capture: BaselineCapture = {
      repositoryRoot: repository,
      headCommit,
      clean: state.staged.length === 0 && state.unstaged.length === 0,
      stagedPaths: state.staged,
      unstagedPaths: state.unstaged,
      capturedAt,
    };

    if (!capture.clean) {
      return {
        ok: false,
        code: "tracked_workspace_dirty",
        message: [
          state.staged.length > 0 ? `Staged: ${state.staged.join(", ")}.` : "",
          state.unstaged.length > 0 ? `Unstaged: ${state.unstaged.join(", ")}.` : "",
        ]
          .filter((part) => part !== "")
          .join(" "),
        capture,
      };
    }

    return { ok: true, capture };
  }

  async open(request: OpenWorkspaceRequest): Promise<OpenWorkspaceOutcome> {
    const baseline = request.baseline;
    const repositoryRoot = resolve(baseline.repositoryRoot);
    const cacheRoot = this.#cacheRoot(repositoryRoot);

    if (cacheRoot === null) {
      return {
        ok: false,
        code: "workspace_path_occupied",
        message: `The workspace cache root is inside the repository it serves, so a worktree created there would be a directory the human's own tooling can find, lint, and commit. Point the cache root outside the repository, or let it default to the user cache directory.`,
      };
    }

    if (!FULL_COMMIT.test(baseline.baselineCommit)) {
      return {
        ok: false,
        code: "baseline_missing",
        message: `The approval baseline records commit "${baseline.baselineCommit}", which is not a full 40-character commit id. A worktree is detached from a commit, so this is refused rather than resolved against whatever that name points at now.`,
      };
    }

    try {
      return await this.#open({ request, repositoryRoot, directory: join(cacheRoot, baseline.workspaceId) });
    } catch (error) {
      return refusalFor(error);
    }
  }

  async inspect(request: InspectWorkspaceRequest): Promise<InspectWorkspaceOutcome> {
    const workspace = request.workspace;
    const directory = workspace.workingDirectory;

    try {
      const status = await this.#status(directory);
      const head = await this.#head(directory);
      const baselineTree = await this.#baselineTree(workspace);

      return {
        ok: true,
        inspection: {
          workspaceId: workspace.workspaceId,
          changes: this.#changes(status, baselineTree),
          gitState: { headCommit: head, stagedPaths: status.staged },
          fingerprint: fingerprintOfChanges(status, head),
          collectedAt: this.#isoNow(),
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: "workspace_failed",
        message: `The workspace at ${directory} could not be inspected: ${describe(error)}`,
      };
    }
  }

  async enforceScope(request: EnforceScopeRequest): Promise<EnforceScopeOutcome> {
    const workspace = request.workspace;
    const directory = workspace.workingDirectory;
    const baselineCommit = workspace.baseline?.baselineCommit ?? null;
    const restored: string[] = [];
    const removed: string[] = [];
    const unsafePaths: string[] = [];
    const enforcementErrors: string[] = [];

    for (const entry of request.paths) {
      try {
        const outcome = await this.#reverse(directory, baselineCommit, entry);

        if (outcome === "restored") {
          restored.push(entry.path);
        } else {
          removed.push(entry.path);
        }
      } catch (error) {
        // A path that could not be proved safe is named as unsafe and left exactly as it is. Reporting
        // it is the whole point: a silent partial cleanup is how an unapproved file survives into a
        // commit the human reads as approved work.
        unsafePaths.push(entry.path);
        enforcementErrors.push(`${entry.path}: ${describe(error)}`);
      }
    }

    return {
      ok: true,
      enforcement: {
        restored,
        removed,
        unsafePaths,
        enforcementErrors,
        enforcedAt: this.#isoNow(),
      },
    };
  }

  async close(workspace: ProjectWorkspace): Promise<void> {
    const token = this.#heldLeases.get(workspace.workspaceId);

    if (token === undefined) {
      return;
    }

    this.#heldLeases.delete(workspace.workspaceId);

    // A release that fails leaves a lease to time out rather than a stuck directory, and the worktree
    // itself is deliberately kept: what is in it may be the only copy of the stage's work.
    await releaseLease(workspace.workingDirectory, token, {
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
    });
  }

  async #open(input: {
    readonly request: OpenWorkspaceRequest;
    readonly repositoryRoot: string;
    readonly directory: string;
  }): Promise<OpenWorkspaceOutcome> {
    const { request, repositoryRoot, directory } = input;
    const baseline = request.baseline;
    const head = await this.#head(repositoryRoot);

    if (head !== baseline.baselineCommit) {
      // The human approved commit A and the repository is now at B. A worktree from A is the approved
      // tree; a worktree from B is not. The framework does not get to choose which of the two a human
      // meant, and it certainly does not move a checkout to make the question go away.
      return {
        ok: false,
        code: "head_changed",
        message: `The plan was approved at commit ${baseline.baselineCommit} and the repository is now at ${head}. An isolated workspace can only be created from the approved commit. Re-approve the plan from the current state, or finish the work already in progress first.`,
      };
    }

    const existing = await this.#existing(directory, repositoryRoot, baseline, request.access);

    if (existing !== null) {
      return existing;
    }

    if (await pathExists(directory)) {
      return {
        ok: false,
        code: "workspace_path_occupied",
        message: `${directory} exists and is not a workspace this adapter created. Refusing to write into a directory of unknown provenance, and refusing to delete one.`,
      };
    }

    const created = await tryGit({
      cwd: repositoryRoot,
      args: ["worktree", "add", "--detach", directory, baseline.baselineCommit],
    });

    if (!created.ok) {
      return {
        ok: false,
        code: "workspace_failed",
        message: `git worktree add could not create a workspace at ${directory}: ${created.detail}`,
      };
    }

    const sidecar: WorkspaceSidecar = {
      version: 1,
      workspaceId: baseline.workspaceId,
      featureId: request.featureId,
      repositoryRoot,
      baselineCommit: baseline.baselineCommit,
      approvedRevision: baseline.approvedRevision,
      createdAt: this.#isoNow(),
      lease: null,
    };

    try {
      await writeSidecar(directory, sidecar);
    } catch (error) {
      // A worktree with no metadata is a directory the next run cannot identify, so it would be refused
      // as occupied. Removing it here is the one deletion this adapter performs, and it is only safe
      // because the worktree was created by this call, seconds ago, and holds nothing but the approved
      // commit.
      await rm(directory, { recursive: true, force: true });

      return {
        ok: false,
        code: "workspace_metadata_missing",
        message: `The worktree at ${directory} was created but its metadata could not be written (${describe(error)}), so it was removed again rather than left as a directory the next run would refuse. Nothing was in it but the approved commit.`,
      };
    }

    return this.#leased(baseline, directory, request.access, sidecar);
  }

  /**
   * The idempotent half of `open`.
   *
   * A workspace that already exists for this baseline is either valid and leasable, or refused. The
   * third option — adopting whatever is there — does not exist, because the contents of a directory
   * nobody vouches for are not the approved tree, and a provider that adopted them would be promising a
   * guarantee it cannot keep.
   */
  async #existing(
    directory: string,
    repositoryRoot: string,
    baseline: WorkspaceBaseline,
    access: WorkspaceAccessLevel,
  ): Promise<OpenWorkspaceOutcome | null> {
    if (!(await pathExists(directory))) {
      return null;
    }

    let sidecar: WorkspaceSidecar;

    try {
      sidecar = await readSidecar(directory);
    } catch (error) {
      if (error instanceof WorkspaceAdapterError && error.code === "metadata_missing") {
        return {
          ok: false,
          code: "workspace_path_occupied",
          message: `${directory} already exists and carries no workspace metadata. Refusing to adopt a directory this framework did not create, and leaving it untouched.`,
        };
      }

      throw error;
    }

    if (sidecar.repositoryRoot !== repositoryRoot) {
      return {
        ok: false,
        code: "workspace_registered_elsewhere",
        message: `${directory} is registered to repository ${sidecar.repositoryRoot}, not ${repositoryRoot}. Two features' workspaces are never shared, and a worktree belongs to exactly one repository.`,
      };
    }

    if (sidecar.baselineCommit !== baseline.baselineCommit) {
      return {
        ok: false,
        code: "workspace_registered_elsewhere",
        message: `${directory} was created from commit ${sidecar.baselineCommit} and this approval names ${baseline.baselineCommit}. The existing workspace is left alone; a worktree for the new commit needs a new workspace id.`,
      };
    }

    const head = await this.#head(directory);

    if (head !== sidecar.baselineCommit) {
      return {
        ok: false,
        code: "head_changed",
        message: `The workspace at ${directory} is at commit ${head} rather than the approved ${sidecar.baselineCommit}, so something committed inside it. Refusing rather than resetting it: that commit is a history no human approved, and overwriting it would destroy the only record that it happened.`,
      };
    }

    return this.#leased(baseline, directory, access, sidecar);
  }

  async #leased(
    baseline: WorkspaceBaseline,
    directory: string,
    access: WorkspaceAccessLevel,
    sidecar: WorkspaceSidecar,
  ): Promise<OpenWorkspaceOutcome> {
    const lease = await acquireLease(directory, sidecar, {
      ttlMs: this.#options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
    });

    if (!lease.ok) {
      return { ok: false, code: "lease_unavailable", message: lease.message };
    }

    this.#heldLeases.set(baseline.workspaceId, lease.lease.token);

    return {
      ok: true,
      workspace: {
        workspaceId: baseline.workspaceId,
        repositoryRoot: baseline.repositoryRoot,
        workingDirectory: directory,
        baseline,
        access: { level: access },
        gitState: { headCommit: baseline.baselineCommit, stagedPaths: [] },
      } satisfies ProjectWorkspace,
    };
  }

  /**
   * The one reversal this adapter performs.
   *
   * A path the approved commit contained is restored with `git checkout` against that commit, so the
   * content is the approved content rather than a remembered copy of it. A path it did not contain is
   * removed, and a staged one has its index entry dropped first, because leaving a staged path behind
   * leaves the index moved — which is the thing the integrity check exists to catch.
   */
  async #reverse(
    directory: string,
    baselineCommit: string | null,
    entry: WorkspaceUnauthorizedPath,
  ): Promise<"restored" | "removed"> {
    assertRepositoryRelative(entry.path);
    const target = await resolveRealPathInside(directory, entry.path);

    if (entry.existedAtBaseline) {
      if (baselineCommit === null) {
        throw new WorkspaceAdapterError(
          "metadata_missing",
          `"${entry.path}" is recorded as having existed at the baseline, but this workspace carries no baseline to restore it from.`,
        );
      }

      const restored = await tryGit({
        cwd: directory,
        args: ["checkout", baselineCommit, "--", entry.path],
      });

      if (!restored.ok) {
        throw new WorkspaceAdapterError(
          "git_failed",
          `git checkout could not return "${entry.path}" to its content in ${baselineCommit}: ${restored.detail}`,
        );
      }

      return "restored";
    }

    if (entry.category === "tracked") {
      const unstaged = await tryGit({ cwd: directory, args: ["rm", "--cached", "--quiet", "--", entry.path] });

      if (!unstaged.ok) {
        throw new WorkspaceAdapterError(
          "git_failed",
          `git rm --cached could not drop "${entry.path}" from the index: ${unstaged.detail}`,
        );
      }
    }

    await rm(target, { force: true, recursive: true });
    await pruneEmptyParents(directory, dirname(target));

    return "removed";
  }

  async #status(directory: string): Promise<ParsedStatus> {
    const outcome = await tryGit({
      cwd: directory,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    });

    if (!outcome.ok) {
      throw new WorkspaceAdapterError("git_failed", `git status could not be read: ${outcome.detail}`);
    }

    return parseStatus(outcome.stdout);
  }

  async #head(directory: string): Promise<string> {
    const outcome = await tryGit({ cwd: directory, args: HEAD_QUERY });

    if (!outcome.ok) {
      throw new WorkspaceAdapterError("git_failed", `git rev-parse HEAD failed: ${outcome.detail}`);
    }

    const head = outcome.stdout.trim();

    if (!FULL_COMMIT.test(head)) {
      throw new WorkspaceAdapterError("git_failed", `git reported HEAD as "${head}", which is not a full commit id.`);
    }

    return head;
  }

  /** Every path the approved commit holds, which is how a new file is told from a changed one. */
  async #baselineTree(workspace: ProjectWorkspace): Promise<ReadonlySet<string>> {
    const baselineCommit = workspace.baseline?.baselineCommit;

    if (baselineCommit === undefined) {
      return new Set();
    }

    const outcome = await tryGit({
      cwd: workspace.workingDirectory,
      args: [...BASELINE_TREE_QUERY, baselineCommit],
    });

    if (!outcome.ok) {
      throw new WorkspaceAdapterError("git_failed", `git ls-tree could not read the approved tree: ${outcome.detail}`);
    }

    return new Set(
      outcome.stdout
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
    );
  }

  /**
   * The change set, with `added` and `untracked` told apart by the approved commit.
   *
   * A file an agent creates in a worktree is untracked as far as the index is concerned, and calling it
   * "added" would put it in the staged category, which the integrity check refuses outright — so a
   * stage that legitimately creates a file would be reported as having moved the index. The baseline
   * tree is the authority instead: a path the approved commit does not contain is `untracked`, and one
   * it does contain is `modified`, whatever the index says.
   */
  #changes(status: ParsedStatus, baselineTree: ReadonlySet<string>): WorkspaceChanges {
    const modified = new Set<string>();
    const untracked = new Set<string>();
    const deleted = new Set<string>(status.deleted);
    const renamed: { readonly from: string; readonly to: string }[] = [];

    for (const path of status.modified) {
      if (baselineTree.has(path)) {
        modified.add(path);
      } else {
        untracked.add(path);
      }
    }

    for (const path of status.added) {
      // A staged new path is the one case where the index was written, so it stays `added`: tracked,
      // because something staged it, and not in the approved commit, so there is nothing to restore it
      // from. Reading it as `untracked` would hide the index write, and reading it as `modified` would
      // claim the approved commit contains a file it does not.
      untracked.delete(path);
    }

    for (const path of status.untracked) {
      untracked.add(path);
    }

    for (const rename of status.renamed) {
      renamed.push(rename);

      if (baselineTree.has(rename.from)) {
        modified.add(rename.to);
        continue;
      }

      // A rename the approved commit never contained is a new file with a new name, and the old name
      // did not exist there either — so both halves are unapproved and both have to be reversible.
      untracked.add(rename.to);
      untracked.add(rename.from);
    }

    return {
      modified: [...modified].sort(),
      added: [...new Set(status.added)].sort(),
      deleted: [...deleted].sort(),
      renamed,
      untracked: [...untracked].filter((path) => !modified.has(path)).sort(),
    };
  }

  /**
   * The cache directory, or null when it would put worktrees inside the repository.
   *
   * Both directions are refused: a cache root that the repository contains would place worktrees in the
   * checkout, and a cache root that contains the repository would make the repository a subdirectory of
   * a directory Git now considers disposable.
   */
  #cacheRoot(repositoryRoot: string): string | null {
    const root = resolve(this.#options.cacheRoot ?? defaultCacheRoot());
    const fromCache = relative(root, resolve(repositoryRoot));
    const fromRepository = relative(resolve(repositoryRoot), root);

    if (fromCache === "" || !fromCache.startsWith(`..${sep}`)) {
      return null;
    }

    if (fromRepository === "" || !fromRepository.startsWith(`..${sep}`)) {
      return null;
    }

    return root;
  }

  #isoNow(): string {
    return this.#options.isoNow?.() ?? new Date().toISOString();
  }
}

function defaultCacheRoot(): string {
  const xdg = process.env["XDG_CACHE_HOME"];

  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) {
    return join(xdg, "agent-workflow-kit", "workspaces");
  }

  return join(homedir(), ".cache", "agent-workflow-kit", "workspaces");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

/**
 * Removes the empty directories a removed file leaves behind, stopping at the workspace root.
 *
 * A directory Git never tracked is not part of the approved tree, so leaving one behind would leave a
 * path the scope record has no entry for. Only an empty one is removed, and never the workspace root
 * itself, so a directory the agent put something real in is left for a human to look at.
 */
async function pruneEmptyParents(workspaceDirectory: string, start: string): Promise<void> {
  const root = resolve(workspaceDirectory);
  let current = resolve(start);

  while (current !== root && current.startsWith(`${root}${sep}`)) {
    const entries = await readdir(current).catch(() => null);

    if (entries === null || entries.length > 0) {
      return;
    }

    try {
      await rmdir(current);
    } catch {
      return;
    }

    current = dirname(current);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fingerprintOfChanges(status: ParsedStatus, headCommit: string): string {
  return [
    headCommit,
    ...status.modified.map((path) => `M ${path}`),
    ...status.added.map((path) => `A ${path}`),
    ...status.deleted.map((path) => `D ${path}`),
    ...status.renamed.map((rename) => `R ${rename.from} -> ${rename.to}`),
    ...status.untracked.map((path) => `? ${path}`),
  ].join("\n");
}

/** Maps an adapter error onto the port's refusal vocabulary, which is what callers match on. */
function refusalFor(error: unknown): { readonly ok: false; readonly code: WorkspaceRefusalCode; readonly message: string } {
  const codes: Readonly<Record<string, WorkspaceRefusalCode>> = {
    metadata_corrupt: "workspace_metadata_corrupt",
    metadata_missing: "workspace_metadata_missing",
    workspace_registered_elsewhere: "workspace_registered_elsewhere",
    lease_held: "lease_unavailable",
    git_failed: "workspace_failed",
    git_unavailable: "repository_unavailable",
    not_a_repository: "repository_unavailable",
    unsafe_path: "workspace_failed",
    path_escapes_workspace: "workspace_failed",
    symlink_refused: "workspace_failed",
  };

  if (error instanceof WorkspaceAdapterError) {
    return { ok: false, code: codes[error.code] ?? "workspace_failed", message: error.message };
  }

  return { ok: false, code: "workspace_failed", message: describe(error) };
}
