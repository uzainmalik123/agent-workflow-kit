import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commitCarriesOwnership,
  unsafeBranchNameReason,
  verifyRemoteName,
  type FeaturePublisher,
  type PublishBranchOwnership,
  type PublishCommitOutcome,
  type PublishCommitRequest,
  type PublishPushOutcome,
  type PublishPushRequest,
  type PublishRefusalCode,
} from "@agent-workflow-kit/orchestration";

import { tryPublishGit, type GitResult } from "./git.js";
import { assertRepositoryRelative } from "./paths.js";

/**
 * Git publishing: the mechanism half of the two operations the workflow runs after a push approval.
 *
 * Everything the framework decides has already been decided before a call arrives here. The branch name,
 * the commit message, the paths, the commit to push, the remote to push it to, and whether any of this
 * should happen at all are all policy, and all of it is decided in the orchestration layer. What is left
 * is the part that has to talk to a repository, and this file exists to make that part as small as
 * possible: read the state, write one commit, move one ref, read one ref, push one ref.
 *
 * ## Why the commit step does not use `git commit`
 *
 * The obvious way to write a commit is `git switch -c`, `git add`, `git commit`, which leaves the
 * worktree on a branch. This adapter does not, and the reason is a contract one level up: the workspace
 * provider refuses to reopen a worktree whose HEAD is no longer the approved commit, because it cannot
 * tell that commit from work nobody approved. A commit step that moved HEAD would therefore make its own
 * workspace unusable — including on the retry a failed session write would need, which is exactly when
 * being able to retry matters most.
 *
 * So the commit is assembled from plumbing instead, in a temporary index, and nothing about the
 * workspace changes:
 *
 * ```
 * GIT_INDEX_FILE=<temporary> git read-tree <approved commit>    the index starts as the approved tree
 * GIT_INDEX_FILE=<temporary> git add -- <approved paths>          the change set, and nothing else
 * GIT_INDEX_FILE=<temporary> git diff --cached --name-only       read back, and compared to what was asked for
 * GIT_INDEX_FILE=<temporary> git write-tree                     one tree: the approved tree plus those paths
 * git commit-tree <tree> -p <approved commit> -m …               one commit, parented on the approved commit
 * git update-ref refs/heads/<branch> <commit> <zero>            one branch, created only if it is absent
 * ```
 *
 * The worktree's HEAD, its files, and its own index are untouched by all of that, so the workspace the
 * provider opened is the workspace it can open again — and a retry of a failed attempt finds the same
 * approved tree, uncommitted and unstaged, exactly as it was. The commit is still an ordinary commit: an
 * ordinary parent, an ordinary message, ordinary trailers, no hooks, nothing signed. The branch is still
 * created by Git's own ref machinery, atomically, and only where the policy said to put it.
 *
 * `update-ref`'s third argument is what makes this safe to retry: it is the value the ref must hold
 * before the update, and the all-zero object name means "must not exist". A second attempt at the same
 * approval cannot overwrite a branch that appeared in between, and it cannot overwrite its own commit
 * either. When the ref does exist, this adapter reads its tip and asks a question rather than assuming:
 * if the tip carries this approval's trailers and sits directly on the approved commit, it *is* this
 * approval's commit and is reused; otherwise it is somebody else's branch and is refused.
 */

/** A push is a network operation and gets longer than a local one, while staying bounded. */
export const PUBLISH_PUSH_TIMEOUT_MS = 120_000;

/** A full, unabbreviated object name, for either hash size. Abbreviations are never pushed or recorded. */
const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** What one refusal looks like, as the two outcome types share its shape. */
type PublishRefusal = {
  readonly ok: false;
  readonly code: PublishRefusalCode;
  readonly message: string;
};

/** What a git call reported when it did not succeed. */
type GitFailure = Extract<GitResult, { readonly ok: false }>;

/** The object name that means "this ref must not exist yet" to `update-ref`. */
function absentObjectName(commit: string): string {
  return "0".repeat(commit.length);
}

/**
 * Characters a pathspec would read as a pattern.
 *
 * `*` and `?` would match files nobody approved, and `[` opens a character class. Refusing them costs a
 * feature whose file is literally named `a*b`, which is vanishingly rare; the alternative is a commit
 * that contains a file the approval never described, which is invisible to everyone who reads the branch
 * afterwards. Paths out of a measured change set are ordinary names in every repository this framework is
 * likely to run in, and a refusal here is a sentence a human can act on.
 */
const PATHSEC_PATTERN = /[*?[\]{}]/u;

function refusal(code: PublishRefusalCode, message: string): PublishRefusal {
  return { ok: false, code, message };
}

/**
 * Turns a git failure into a refusal, and a spawn failure into the one code that means "git is missing".
 *
 * A timeout keeps its own wording rather than being folded into the command's diagnostic, because "did not
 * finish and was stopped" and "exited 1 because…" are different answers, and reporting the second for the
 * first would hide a hung push behind a plausible message.
 */
function gitRefusal(failure: GitFailure, code: PublishRefusalCode, context: string): PublishRefusal {
  if (failure.spawnFailed) {
    return refusal(
      "git_unavailable",
      `git could not be started while ${context}. Publishing needs git, and there is nothing to fall back to.`,
    );
  }

  return refusal(
    code,
    failure.timedOut
      ? `git did not finish and was stopped while ${context}.`
      : `git failed while ${context}: ${failure.detail}`,
  );
}

/** Why a path cannot be staged safely, or null when every path is a plain, literal, relative name. */
function pathRefusalReason(paths: readonly string[]): string | null {
  for (const path of paths) {
    try {
      // The repository's own rule set, which refuses absolute paths, empty and `..` segments, NUL bytes,
      // and — because it refuses a colon — pathspec magic such as `:(exclude)`.
      assertRepositoryRelative(path);
    } catch {
      return `the path "${path}" is not a plain repository-relative path`;
    }

    if (path.startsWith("-")) {
      return `the path "${path}" begins with "-", which git could read as an option rather than as a path`;
    }

    if (PATHSEC_PATTERN.test(path)) {
      return `the path "${path}" contains a character git would read as a pattern`;
    }
  }

  return null;
}

/** A branch's tip: which commit it points at, and the message that commit carries. */
interface BranchTip {
  readonly commit: string;
  readonly message: string;
}

type TipOutcome =
  | { readonly ok: true; readonly tip: BranchTip | null }
  | { readonly ok: false; readonly refusal: PublishRefusal };

/** Git publishing for a repository this adapter already manages, over the publishing allowlist. */
export class GitFeaturePublisher implements FeaturePublisher {
  /**
   * Writes this approval's commit on this approval's branch, or reports the commit already there.
   *
   * Never throws: every outcome, including a repository in a state nobody anticipated, is a refusal with
   * a code, because what a refusal means for a workflow is the orchestration layer's decision and not this
   * one's.
   */
  async commitFeature(request: PublishCommitRequest): Promise<PublishCommitOutcome> {
    const cwd = request.workspace.workingDirectory;
    const signal = request.signal ?? null;

    const branchReason = unsafeBranchNameReason(request.branch);

    if (branchReason !== null) {
      return refusal("branch_unsafe", `Refusing to publish to "${request.branch}" because ${branchReason}.`);
    }

    if (request.paths.length === 0) {
      return refusal(
        "commit_failed",
        "No paths were given to commit, so there is nothing to write. An empty commit is not written to make a push look as though it did something.",
      );
    }

    const pathReason = pathRefusalReason(request.paths);

    if (pathReason !== null) {
      return refusal(
        "path_unsafe",
        `Refusing to commit because ${pathReason}. Every path handed to this adapter was supposed to be a literal name from the approved change set.`,
      );
    }

    const head = await tryPublishGit({ cwd, args: ["rev-parse", "HEAD"], signal });

    if (!head.ok) {
      return gitRefusal(head, "head_moved", "reading the worktree's HEAD");
    }

    if (head.stdout.trim() !== request.expectedHead) {
      return refusal(
        "head_moved",
        `The worktree is at ${head.stdout.trim()}, not at the approved commit ${request.expectedHead}. Something moved this workspace's HEAD after it was opened, and a commit built on it would not be the approved tree.`,
      );
    }

    const identity = await this.#identity(cwd, signal);

    if (identity !== null) {
      return identity;
    }

    const existing = await this.#tip(cwd, request.branch, signal);

    if (!existing.ok) {
      return existing.refusal;
    }

    if (existing.tip !== null) {
      return await this.#reuseOrRefuse(existing.tip, request);
    }

    const written = await this.#writeCommit(cwd, request, signal);

    if (!written.ok) {
      return written;
    }

    const created = await tryPublishGit({
      cwd,
      args: ["update-ref", `refs/heads/${request.branch}`, written.commit, absentObjectName(written.commit)],
      signal,
    });

    if (!created.ok) {
      // The branch was absent a moment ago, so a failure here is either a repository that will not write
      // refs or something that created it in between. The second deserves one more look rather than a
      // refusal: it is the shape of a retry that raced another attempt, and the same question settles it.
      const raced = await this.#tip(cwd, request.branch, signal);

      if (!raced.ok) {
        return raced.refusal;
      }

      if (raced.tip !== null) {
        return await this.#reuseOrRefuse(raced.tip, request);
      }

      return gitRefusal(created, "branch_failed", `creating the branch "${request.branch}"`);
    }

    // The ref is read back rather than assumed: the publish record names this commit, and the push step
    // will push it on the strength of it.
    const confirmed = await this.#tip(cwd, request.branch, signal);

    if (!confirmed.ok) {
      return confirmed.refusal;
    }

    if (confirmed.tip === null || confirmed.tip.commit !== written.commit) {
      return refusal(
        "branch_failed",
        `The branch "${request.branch}" was created but does not point at the commit ${written.commit}. Nothing was pushed, and the branch is left as it is rather than moved to match.`,
      );
    }

    return { ok: true, commit: written.commit, reused: false };
  }

  /**
   * Pushes the recorded commit to the recorded branch on the configured remote.
   *
   * The refspec names the commit rather than the branch, so a branch that moved between the commit and the
   * push cannot change what ships — and the branch is checked against the recorded commit first, so the
   * push is refused outright rather than sending something the record does not describe. Nothing here can
   * force: the allowlist has no `--force` in it, and a remote that would need one rejects the push.
   */
  async pushBranch(request: PublishPushRequest): Promise<PublishPushOutcome> {
    const cwd = request.repositoryRoot;
    const signal = request.signal ?? null;

    const branchReason = unsafeBranchNameReason(request.branch);

    if (branchReason !== null) {
      return refusal("branch_unsafe", `Refusing to push to "${request.branch}" because ${branchReason}.`);
    }

    const remote = verifyRemoteName(request.remote);

    if (!remote.ok) {
      return refusal("remote_unavailable", remote.error.message);
    }

    if (!FULL_OBJECT_NAME.test(request.commit)) {
      return refusal(
        "commit_missing",
        `Refusing to push "${request.commit}", which is not a full object name. A record naming an abbreviated commit is refused rather than resolved against whatever else shares the prefix.`,
      );
    }

    const exists = await tryPublishGit({
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${request.commit}^{commit}`],
      signal,
    });

    if (!exists.ok) {
      return exists.spawnFailed || exists.timedOut
        ? gitRefusal(exists, "commit_missing", `reading commit ${request.commit}`)
        : refusal(
            "commit_missing",
            `This repository has no commit ${request.commit}, so there is nothing to push. The commit was written inside the workspace this feature used, and it is in this repository's object store as well as that one; nothing was sent.`,
          );
    }

    if (exists.stdout.trim() !== request.commit) {
      return refusal(
        "commit_missing",
        `This repository resolved ${request.commit} to ${exists.stdout.trim()}, which is a different object.`,
      );
    }

    const remotes = await tryPublishGit({ cwd, args: ["remote"], signal });

    if (!remotes.ok) {
      return gitRefusal(remotes, "remote_unavailable", "listing this repository's remotes");
    }

    if (!remotes.stdout.split("\n").map((name) => name.trim()).includes(remote.remote)) {
      return refusal(
        "remote_unavailable",
        `This repository has no remote named "${remote.remote}". The push names a remote rather than letting git pick one, so nothing was sent: configure the remote, or name a different one in the orchestrator's publishing options.`,
      );
    }

    const tip = await this.#tip(cwd, request.branch, signal);

    if (!tip.ok) {
      return tip.refusal;
    }

    if (tip.tip === null || tip.tip.commit !== request.commit) {
      return refusal(
        "branch_moved",
        tip.tip === null
          ? `The branch "${request.branch}" does not exist in this repository, so there is no branch to push the recorded commit ${request.commit} to. Nothing was sent.`
          : `The branch "${request.branch}" points at ${tip.tip.commit}, not at the recorded commit ${request.commit}. Nothing was pushed: a branch that moved after its commit was recorded is a repository somebody else is using.`,
      );
    }

    const pushed = await tryPublishGit({
      cwd,
      args: ["push", "--porcelain", remote.remote, `${request.commit}:refs/heads/${request.branch}`],
      timeoutMs: PUBLISH_PUSH_TIMEOUT_MS,
      // A push that needs a credential must fail rather than wait: this process has no terminal to
      // answer a prompt on, and a framework that blocks on one is a framework that appears to hang.
      env: { GIT_TERMINAL_PROMPT: "0" },
      signal,
    });

    if (!pushed.ok) {
      return gitRefusal(
        pushed,
        "push_rejected",
        `pushing ${request.commit} to "${request.branch}" on "${remote.remote}"`,
      );
    }

    return { ok: true, branch: request.branch, commit: request.commit, remote: remote.remote };
  }

  /**
   * The repository's commit identity, or the refusal that says it has none.
   *
   * Checked rather than supplied. `git commit-tree` fails with an opaque "empty ident name" when neither
   * setting is configured, and an adapter that answered that by inventing a name would put commits into
   * the world claiming an authorship nobody chose. A repository without an identity is told so, and the
   * person running it decides whose name goes on the commit.
   *
   * An empty value counts as unconfigured, because `git config --get` exits zero for a setting that is
   * present and empty — and an empty name is exactly what git rejects two commands later.
   */
  async #identity(cwd: string, signal: AbortSignal | null): Promise<PublishRefusal | null> {
    for (const setting of ["user.name", "user.email"]) {
      const read = await tryPublishGit({ cwd, args: ["config", "--get", setting], signal });

      if (!read.ok) {
        return gitRefusal(read, "identity_unconfigured", `reading ${setting}`);
      }

      if (read.stdout.trim() === "") {
        return refusal(
          "identity_unconfigured",
          `This repository has no ${setting}, so a commit written here could not be attributed to anyone. Set ${setting} for this repository or globally, then publish again; the framework does not invent an identity for a commit.`,
        );
      }
    }

    return null;
  }

  /**
   * The branch's tip and message, or null when the branch does not exist.
   *
   * `for-each-ref` is the reader rather than `rev-parse --verify` because it matches a full ref name with
   * no revision syntax in it at all, which is what "does this exact branch exist" means; `rev-parse` is
   * only ever asked for one commit by name, and only where peeling is wanted.
   */
  async #tip(cwd: string, branch: string, signal: AbortSignal | null): Promise<TipOutcome> {
    const found = await tryPublishGit({
      cwd,
      args: ["for-each-ref", "--count=1", "--format=%(objectname)", `refs/heads/${branch}`],
      signal,
    });

    if (!found.ok) {
      return { ok: false, refusal: gitRefusal(found, "branch_failed", `reading the branch "${branch}"`) };
    }

    const commit = found.stdout.trim();

    if (commit === "") {
      return { ok: true, tip: null };
    }

    if (!FULL_OBJECT_NAME.test(commit)) {
      return {
        ok: false,
        refusal: refusal("branch_failed", `The branch "${branch}" resolved to "${commit}", which is not a full object name.`),
      };
    }

    const message = await tryPublishGit({
      cwd,
      args: ["log", "-1", "--format=%B", "--no-mailmap", commit],
      signal,
    });

    if (!message.ok) {
      return { ok: false, refusal: gitRefusal(message, "branch_failed", `reading the tip message of "${branch}"`) };
    }

    return { ok: true, tip: { commit, message: message.stdout.trimEnd() } };
  }

  /**
   * Whether an existing branch tip is this approval's commit, and what to do when it is not.
   *
   * Two conditions, both required. The trailers say the commit was written under this approval, and the
   * parent being the approved commit says it is that approval's commit *and nothing else* — a branch with
   * anything else on top, however well labelled, is a branch somebody is still working in.
   */
  async #reuseOrRefuse(tip: BranchTip, request: PublishCommitRequest): Promise<PublishCommitOutcome> {
    const ownership: PublishBranchOwnership = {
      featureId: request.ownership.featureId,
      summarySha256: request.ownership.summarySha256,
    };

    if (!commitCarriesOwnership(tip.message, ownership)) {
      return refusal(
        "branch_conflict",
        `The branch "${request.branch}" already exists, and its tip was not written under this approval, so it belongs to something else. Refusing rather than pushing over it: a framework that made its way past an existing branch would lose whatever was on it.`,
      );
    }

    const parent = await tryPublishGit({
      cwd: request.workspace.workingDirectory,
      args: ["rev-parse", "--verify", "--quiet", `${tip.commit}^`],
      signal: request.signal ?? null,
    });

    if (!parent.ok) {
      return gitRefusal(parent, "commit_failed", `reading the parent of commit ${tip.commit}`);
    }

    if (parent.stdout.trim() !== request.expectedHead) {
      return refusal(
        "branch_conflict",
        `The branch "${request.branch}" already holds commit ${tip.commit}, which does not sit directly on the approved commit ${request.expectedHead}. Refusing rather than pushing a branch that has other history on it.`,
      );
    }

    return { ok: true, commit: tip.commit, reused: true };
  }

  /**
   * Writes the commit, in a temporary index, without touching the workspace.
   *
   * The staged set is read back and compared against the paths that were asked for. That comparison is
   * the belt to the pathspec braces: were anything this adapter did not anticipate to stage a path
   * nobody approved, the commit is refused here rather than created.
   *
   * `add -- <paths>` rather than `add --all -- <paths>`. Both stage the removals of the paths they name —
   * `git add` has done so since 2.0 — but `--all` is refused by this adapter's own policy, because the
   * same option on `push` means "every branch" and a policy that has to keep one spelling of an argument
   * means something has to be re-checked at every call site. Scoping by pathspec is the same work.
   */
  async #writeCommit(
    cwd: string,
    request: PublishCommitRequest,
    signal: AbortSignal | null,
  ): Promise<PublishCommitOutcome> {
    const directory = await mkdtemp(join(tmpdir(), "agent-workflow-publish-"));
    const env = { GIT_INDEX_FILE: join(directory, "index") };

    try {
      const seed = await tryPublishGit({ cwd, args: ["read-tree", request.expectedHead], env, signal });

      if (!seed.ok) {
        return gitRefusal(seed, "commit_failed", "building a temporary index from the approved commit");
      }

      const staged = await tryPublishGit({
        cwd,
        args: ["add", "--", ...request.paths],
        env,
        signal,
      });

      if (!staged.ok) {
        return gitRefusal(staged, "commit_failed", `staging ${String(request.paths.length)} approved path(s)`);
      }

      const listed = await tryPublishGit({ cwd, args: ["diff", "--cached", "--name-only"], env, signal });

      if (!listed.ok) {
        return gitRefusal(listed, "commit_failed", "reading the staged change set back");
      }

      const stagedPaths = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      const wanted = [...request.paths].sort();
      const unexpected = stagedPaths.filter((path) => !wanted.includes(path));
      const absent = wanted.filter((path) => !stagedPaths.includes(path));

      if (unexpected.length > 0 || absent.length > 0) {
        return refusal(
          "path_unsafe",
          `The staged change set is not the approved one: ${
            unexpected.length > 0
              ? `it includes ${unexpected.join(", ")}, which were not approved`
              : `it is missing ${absent.join(", ")}`
          }. Nothing was committed.`,
        );
      }

      const tree = await tryPublishGit({ cwd, args: ["write-tree"], env, signal });

      if (!tree.ok) {
        return gitRefusal(tree, "commit_failed", "writing the commit's tree");
      }

      const treeId = tree.stdout.trim();

      if (!FULL_OBJECT_NAME.test(treeId)) {
        return refusal("commit_failed", `git wrote a tree as "${treeId}", which is not a full object name.`);
      }

      // One `-m` per paragraph, because that is how git joins them: a subject, a blank line, a body.
      const paragraphs = request.commitMessage
        .split(/\n[ \t]*\n/u)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== "");

      const commit = await tryPublishGit({
        cwd,
        args: [
          "commit-tree",
          treeId,
          "-p",
          request.expectedHead,
          ...paragraphs.flatMap((paragraph) => ["-m", paragraph]),
        ],
        signal,
      });

      if (!commit.ok) {
        return gitRefusal(commit, "commit_failed", "writing the commit");
      }

      const commitId = commit.stdout.trim();

      if (!FULL_OBJECT_NAME.test(commitId)) {
        return refusal("commit_failed", `git wrote a commit as "${commitId}", which is not a full object name.`);
      }

      // The branch will be recognised by these trailers later, including by a retry of this very call, so
      // their presence in what was actually written is confirmed rather than assumed.
      const written = await tryPublishGit({
        cwd,
        args: ["log", "-1", "--format=%B", "--no-mailmap", commitId],
        signal,
      });

      if (!written.ok) {
        return gitRefusal(written, "commit_failed", `reading back commit ${commitId}`);
      }

      if (!commitCarriesOwnership(written.stdout, request.ownership)) {
        return refusal(
          "commit_failed",
          `The commit written as ${commitId} does not carry this approval's trailers, so no branch could later be recognised as this feature's. Nothing was published, and the unreferenced commit is left for git to expire rather than pointed at by anything.`,
        );
      }

      return { ok: true, commit: commitId, reused: false };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}