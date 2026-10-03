import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBaseline } from "@agent-workflow-kit/core";
import type { PushApprovalRecord } from "@agent-workflow-kit/persistence";
import {
  buildFeatureBranch,
  buildFeatureCommitMessage,
  type ProjectWorkspace,
} from "@agent-workflow-kit/orchestration";
import {
  GitFeaturePublisher,
  GitWorkspaceProvider,
  tryPublishGit,
} from "@agent-workflow-kit/workspace";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The publishing adapter against real repositories.
 *
 * Everything here is a claim about git that could only be faked: that a commit written into an isolated
 * worktree does not move that worktree's HEAD, that a branch can be created only where nobody else's
 * branch is, that a push names a commit rather than a moving name, and that none of this needs a force.
 * Each is asserted against a repository this file creates, and several are asserted by *inspecting the
 * repository afterwards* rather than by trusting the adapter's own answer — the adapter is the thing
 * under test, so its report is not evidence.
 *
 * The remote is a bare repository on disk. That is a real remote as far as git is concerned: a push runs
 * the same receive-pack path it would over ssh, and what arrived can be read back with `for-each-ref`.
 */

const TIMESTAMP = "2026-04-05T06:07:08.000Z";
const FEATURE = "F-001";
const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly cacheRoot: string;
  /** The bare repository every push goes to. */
  readonly remote: string;
  /** The approved commit: the only commit a publishing commit may sit on. */
  readonly baselineCommit: string;
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "agent-workflow-kit-publish-git-"));
  roots.push(base);

  const root = join(base, "repo");
  const cacheRoot = join(base, "cache");
  const remote = join(base, "remote.git");

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });

  git(root, "init", "--quiet", "--initial-branch=main", ".");
  git(root, "config", "user.email", "publishing@example.invalid");
  git(root, "config", "user.name", "Publishing Test");
  git(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "initial");

  git(root, "init", "--quiet", "--bare", remote);
  git(root, "remote", "add", "origin", remote);

  return { root, cacheRoot, remote, baselineCommit: git(root, "rev-parse", "HEAD").trim() };
}

function providerFor(fixture: Fixture): GitWorkspaceProvider {
  return new GitWorkspaceProvider({ cacheRoot: fixture.cacheRoot, isoNow: () => TIMESTAMP });
}

/** An approved baseline, which is the only thing an isolated workspace may be created from. */
async function baselineFor(fixture: Fixture): Promise<WorkspaceBaseline> {
  const capture = await providerFor(fixture).captureBaseline(fixture.root);

  if (!capture.ok) {
    throw new Error(`The fixture repository was refused: ${capture.message}`);
  }

  return {
    repositoryRoot: fixture.root,
    baselineCommit: capture.capture.headCommit,
    workspaceId: `ws-${FEATURE}`,
    approvedRevision: 3,
    capturedAt: TIMESTAMP,
  };
}

/** Opens the isolated worktree the way the orchestrator does, with the change already in it. */
async function workspaceWithChange(
  fixture: Fixture,
  files: Readonly<Record<string, string>>,
): Promise<{ readonly workspace: ProjectWorkspace; readonly provider: GitWorkspaceProvider }> {
  const baseline = await baselineFor(fixture);
  const provider = providerFor(fixture);
  const opened = await provider.open({ featureId: FEATURE, baseline, access: "read_write" });

  if (!opened.ok) {
    throw new Error(`The workspace was refused: ${opened.message}`);
  }

  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(opened.workspace.workingDirectory, path), content, "utf8");
  }

  return { workspace: opened.workspace, provider };
}

function approvalFor(): PushApprovalRecord {
  return {
    decision: "approved",
    featureId: FEATURE,
    approvedAt: TIMESTAMP,
    approvedRevision: 4,
    actor: "human@example.invalid",
    summarySha256: "a".repeat(64),
    summaryRevision: 6,
    workingTreeFingerprint: "d".repeat(64),
    finalGateStatus: "passed",
    finalGateRevision: 3,
    finalGateFingerprint: "c".repeat(64),
    finalGateSha256: "b".repeat(64),
  };
}

interface CommitOptions {
  readonly files?: Readonly<Record<string, string>>;
  readonly paths?: readonly string[];
  readonly branch?: string;
}

async function commitFixture(
  fixture: Fixture,
  options: CommitOptions = {},
): Promise<{
  readonly publisher: GitFeaturePublisher;
  readonly workspace: ProjectWorkspace;
  readonly provider: GitWorkspaceProvider;
  readonly branch: string;
  readonly commitMessage: string;
}> {
  const { workspace, provider } = await workspaceWithChange(
    fixture,
    options.files ?? { "src/publisher.ts": "export const published = true;\n" },
  );
  const approval = approvalFor();
  const branch = buildFeatureBranch({ featureId: FEATURE, approval });
  const message = buildFeatureCommitMessage({ featureId: FEATURE, title: "Publish the change", approval });

  if (!branch.ok || !message.ok) {
    throw new Error("The fixture built no branch or no message, which the policy should have allowed.");
  }

  return {
    publisher: new GitFeaturePublisher(),
    workspace,
    provider,
    branch: branch.branch,
    commitMessage: message.message,
  };
}

async function closeFixture(provider: GitWorkspaceProvider, workspace: ProjectWorkspace): Promise<void> {
  await provider.close(workspace);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------------------------- */
/* Writing the commit                                                                             */
/* --------------------------------------------------------------------------------------------- */

describe("writing the approved change as a commit", () => {
  it("writes a commit on the approved baseline, on the branch the policy named", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);

    const result = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.reused).toBe(false);
    // Read the repository rather than trusting the answer: the parent is the approved commit, the tree
    // is the baseline tree plus the one approved path, and nothing else.
    expect(git(fixture.root, "rev-parse", `${result.commit}^`).trim()).toBe(fixture.baselineCommit);
    expect(git(fixture.root, "show", "--name-only", "--format=", result.commit).trim()).toBe("src/publisher.ts");
    expect(git(fixture.root, "rev-parse", `refs/heads/${branch}`).trim()).toBe(result.commit);

    await closeFixture(provider, workspace);
  });

  it("writes a message that says which approval published it", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);

    const result = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    const written = git(fixture.root, "log", "-1", "--format=%B", result.commit);

    expect(written).toContain(`feat(${FEATURE}): Publish the change`);
    expect(written).toContain(`Feature-Id: ${FEATURE}`);
    expect(written).toContain("Push-Approval-Summary-Sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(written).toContain("Push-Approval-Gate-Sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(written).toContain("Push-Approval-Revision: 4");
    expect(written).toContain("Push-Approval-Actor: human@example.invalid");

    await closeFixture(provider, workspace);
  });

  it("leaves the worktree exactly as it found it, so the provider can open it again", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);

    await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    // This is the property the whole plumbing approach exists for. HEAD stays on the approved commit, the
    // change is still in the worktree as an uncommitted modification, and the index is still empty — so a
    // retry finds the same approved tree rather than a workspace the provider refuses to touch.
    const directory = workspace.workingDirectory;

    expect(git(directory, "rev-parse", "HEAD").trim()).toBe(fixture.baselineCommit);
    // Still detached: `symbolic-ref` exits non-zero rather than printing a name, which is how it says so.
    expect(gitResultCode(directory, "symbolic-ref", "--quiet", "HEAD")).not.toBe(0);
    expect(git(directory, "status", "--porcelain").trim()).toBe("?? src/publisher.ts");
    expect(git(directory, "diff", "--cached", "--name-only").trim()).toBe("");

    // And the provider agrees, once this stage hands the workspace back. It refuses to lease a worktree to
    // two stages at once, so the workspace is closed first — which is exactly the sequence a retry follows,
    // and the sequence a workspace whose HEAD had moved could not survive.
    await closeFixture(provider, workspace);

    const reopened = await provider.open({
      featureId: FEATURE,
      baseline: await baselineFor(fixture),
      access: "read_write",
    });

    expect(reopened.ok, reopened.ok ? "" : reopened.message).toBe(true);

    if (reopened.ok) {
      // The retry's tree is the approved tree plus the uncommitted change, which is what the commit step
      // needs to find again.
      expect(git(reopened.workspace.workingDirectory, "rev-parse", "HEAD").trim()).toBe(fixture.baselineCommit);
      expect(git(reopened.workspace.workingDirectory, "status", "--porcelain").trim()).toBe("?? src/publisher.ts");

      await closeFixture(provider, reopened.workspace);
    }
  });

  it("commits exactly the approved paths, and refuses a path it did not stage", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture, {
      files: { "src/publisher.ts": "export const published = true;\n", "src/stray.ts": "export const stray = 1;\n" },
    });

    // `src/stray.ts` exists in the worktree and is not in the path list. The commit must not contain it.
    const result = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(git(fixture.root, "show", "--name-only", "--format=", result.commit).trim()).toBe("src/publisher.ts");

    await closeFixture(provider, workspace);
  });

  it("records a removal of an approved path as a removal", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture, {
      files: { "src/publisher.ts": "export const published = true;\n" },
    });

    // A deletion is as much a change as an edit, and a commit that cannot express one would make a
    // feature that deletes a file unpublishable — the one case where pretending is most tempting.
    await rm(join(workspace.workingDirectory, "src", "app.ts"));

    const result = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts", "src/app.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    // Git lists the paths of a change in its own order, which is the sorted one.
    expect(git(fixture.root, "show", "--name-status", "--format=", result.commit).trim()).toBe(
      ["D\tsrc/app.ts", "A\tsrc/publisher.ts"].join("\n"),
    );

    await closeFixture(provider, workspace);
  });

  it("refuses a path that git would read as a pattern rather than as a name", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);

    for (const path of ["src/*.ts", ": (exclude)src/app.ts", "-rf"]) {
      const result = await publisher.commitFeature({
        workspace,
        featureId: FEATURE,
        branch,
        commitMessage,
        paths: [path],
        expectedHead: fixture.baselineCommit,
        ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
      });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.code).toBe("path_unsafe");
      }
    }

    // No branch, because nothing was committed.
    expect(gitResultCode(fixture.root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).not.toBe(0);

    await closeFixture(provider, workspace);
  });

  it("refuses a worktree that is not at the approved commit", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);

    // Something moved HEAD inside the workspace after it was opened.
    git(workspace.workingDirectory, "checkout", "--quiet", "-b", "somebody-elses-work");
    git(workspace.workingDirectory, "commit", "--quiet", "--allow-empty", "-m", "unrelated");

    const result = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.code).toBe("head_moved");
      expect(result.message).toContain(fixture.baselineCommit);
    }

    await closeFixture(provider, workspace);
  });

  it("refuses a branch it did not name itself, without asking git", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, commitMessage } = await commitFixture(fixture);

    for (const branch of ["main", "master", "release/1.0", "agentflow/F-001-x/../y"]) {
      const result = await publisher.commitFeature({
        workspace,
        featureId: FEATURE,
        branch,
        commitMessage,
        paths: ["src/publisher.ts"],
        expectedHead: fixture.baselineCommit,
        ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
      });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.code).toBe("branch_unsafe");
      }
    }

    await closeFixture(provider, workspace);
  });

  it("refuses to write a commit nobody can be attributed to", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);

    // A repository with no identity is a repository that cannot say who wrote this. `git config --get`
    // exits zero for a setting that is present and empty, so an empty value is unconfigured too.
    git(fixture.root, "config", "--unset", "user.name");
    git(fixture.root, "config", "user.name", "");

    const result = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.code).toBe("identity_unconfigured");
      expect(result.message).toContain("user.name");
    }

    expect(gitResultCode(fixture.root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).not.toBe(0);

    await closeFixture(provider, workspace);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Retrying the commit                                                                            */
/* --------------------------------------------------------------------------------------------- */

describe("writing the same commit twice", () => {
  it("reuses its own commit rather than writing a second one", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const request = {
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    };

    const first = await publisher.commitFeature(request);
    const second = await publisher.commitFeature(request);

    if (!first.ok) {
      throw new Error(first.message);
    }

    if (!second.ok) {
      throw new Error(second.message);
    }

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.commit).toBe(first.commit);
    // One commit, one parent: the retry did not stack a commit on the commit it already wrote.
    expect(git(fixture.root, "rev-list", "--count", `refs/heads/${branch}`).trim()).toBe("2");

    await closeFixture(provider, workspace);
  });

  it("refuses a branch somebody else owns", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);

    // A branch with the right name and the wrong commit on it: the shape a renamed feature, a copied
    // worktree, or another tool's branch would have. `commit-tree` writes the commit without touching a
    // worktree, so the fixture's own HEAD and the isolated workspace are left alone.
    git(fixture.root, "commit", "--quiet", "--allow-empty", "-m", "somebody else's commit");
    git(fixture.root, "branch", "-f", branch);

    const result = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.code).toBe("branch_conflict");
    }

    // The other branch is untouched: a refusal never moves a ref.
    expect(git(fixture.root, "log", "-1", "--format=%s", branch).trim()).toBe("somebody else's commit");

    await closeFixture(provider, workspace);
  });

  it("refuses its own branch when something else has been committed on top of it", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const ownership = { featureId: FEATURE, summarySha256: "a".repeat(64) };

    const first = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership,
    });

    if (!first.ok) {
      throw new Error(first.message);
    }

    // A second commit on the same branch, carrying the same trailers: still not this approval's commit,
    // because the branch has history on it that the approval never saw.
    const stacked = git(
      fixture.root,
      "commit-tree",
      `${first.commit}^{tree}`,
      "-p",
      first.commit,
      "-m",
      commitMessage,
    ).trim();

    git(fixture.root, "update-ref", `refs/heads/${branch}`, stacked);

    const result = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership,
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.code).toBe("branch_conflict");
    }

    await closeFixture(provider, workspace);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Pushing                                                                                        */
/* --------------------------------------------------------------------------------------------- */

describe("pushing the recorded commit", () => {
  it("puts the commit on the remote under the branch's own name", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    const result = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: committed.commit,
      remote: "origin",
    });

    expect(result.ok).toBe(true);

    // Read the remote itself, not the adapter's answer.
    expect(git(fixture.remote, "rev-parse", `refs/heads/${branch}`).trim()).toBe(committed.commit);
    expect(git(fixture.remote, "show", "--name-only", "--format=", branch).trim()).toBe("src/publisher.ts");
    // And nothing else was published: no other branch, no tags.
    expect(git(fixture.remote, "for-each-ref", "--format=%(refname)").trim()).toBe(`refs/heads/${branch}`);

    await closeFixture(provider, workspace);
  });

  it("pushes to the remote it was told to, and to no other", async () => {
    const fixture = await makeFixture();
    git(fixture.root, "init", "--quiet", "--bare", join(fixture.cacheRoot, "second.git"));
    git(fixture.root, "remote", "add", "mirror-of-choice", join(fixture.cacheRoot, "second.git"));

    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    const result = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: committed.commit,
      remote: "mirror-of-choice",
    });

    expect(result.ok).toBe(true);
    expect(git(join(fixture.cacheRoot, "second.git"), "rev-parse", `refs/heads/${branch}`).trim()).toBe(
      committed.commit,
    );
    // The default remote was not touched, which is the point of naming one.
    expect(gitResultCode(fixture.remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).not.toBe(0);

    await closeFixture(provider, workspace);
  });

  it("refuses a remote this repository does not have", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    const result = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: committed.commit,
      remote: "upstream",
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.code).toBe("remote_unavailable");
    }

    await closeFixture(provider, workspace);
  });

  it("refuses to push a commit the repository does not have", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch } = await commitFixture(fixture);

    const missing = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: "0123456789012345678901234567890123456789",
      remote: "origin",
    });

    expect(missing.ok).toBe(false);

    if (!missing.ok) {
      expect(missing.code).toBe("commit_missing");
    }

    // An abbreviated or nonsense name is refused before git is asked anything.
    const nonsense = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: "not-a-commit",
      remote: "origin",
    });

    expect(nonsense.ok).toBe(false);

    if (!nonsense.ok) {
      expect(nonsense.code).toBe("commit_missing");
    }

    await closeFixture(provider, workspace);
  });

  it("refuses a branch that moved after its commit was recorded", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    // The branch moved: its tip is now a different commit, reached through a `commit-tree` so that no
    // worktree in this repository — the fixture's or the isolated one — changes where it is checked out.
    // The record still names the commit it recorded, and the branch no longer has it.
    const movedTo = git(
      fixture.root,
      "commit-tree",
      `${fixture.baselineCommit}^{tree}`,
      "-p",
      fixture.baselineCommit,
      "-m",
      "moved on",
    ).trim();

    git(fixture.root, "update-ref", `refs/heads/${branch}`, movedTo);

    const moved = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: committed.commit,
      remote: "origin",
    });

    expect(moved.ok).toBe(false);

    if (!moved.ok) {
      expect(moved.code).toBe("branch_moved");
    }

    expect(gitResultCode(fixture.remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).not.toBe(0);

    await closeFixture(provider, workspace);
  });

  it("refuses a push the remote would need forced, and never forces it", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    // Someone else got the same branch name on the remote with their own history: a commit that is a
    // sibling of ours, sharing the baseline as a parent and this approval's commit's absence as ancestry.
    // This push is therefore not a fast-forward, and a force would overwrite their commit.
    //
    // The history is written inside the remote, which means it exists only there: the object store on the
    // other side of a push is not shared, so a commit made in this repository would be an object the
    // remote has never heard of rather than a branch it could be comparing against.
    git(fixture.root, "push", "--quiet", "origin", `${fixture.baselineCommit}:refs/heads/seed`);

    const theirs = git(
      fixture.remote,
      "-c",
      "user.name=Somebody Else",
      "-c",
      "user.email=else@example.invalid",
      "commit-tree",
      `${fixture.baselineCommit}^{tree}`,
      "-p",
      fixture.baselineCommit,
      "-m",
      "somebody else's history",
    ).trim();

    git(fixture.remote, "update-ref", `refs/heads/${branch}`, theirs);

    const diverged = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: committed.commit,
      remote: "origin",
    });

    // The remote now has the approved commit on the branch from the fixture setup above, and this
    // adapter's commit is not a descendant of anything that would let it replace it. Whatever git answers
    // — a rejection, or an up-to-date no-op — it is never forced.
    expect(diverged.ok).toBe(false);

    if (!diverged.ok) {
      expect(diverged.code).toBe("push_rejected");
    }

    await closeFixture(provider, workspace);
  });

  it("refuses to push to a branch this framework did not name", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    for (const branch of ["main", "master", "develop", "feature/whatever"]) {
      const result = await publisher.pushBranch({
        repositoryRoot: fixture.root,
        featureId: FEATURE,
        branch,
        commit: committed.commit,
        remote: "origin",
      });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.code).toBe("branch_unsafe");
      }
    }

    // `main` exists here and still got nothing.
    expect(gitResultCode(fixture.remote, "rev-parse", "--verify", "--quiet", "refs/heads/main")).not.toBe(0);

    await closeFixture(provider, workspace);
  });

  it("refuses a remote name that is an option", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    const result = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: committed.commit,
      remote: "--mirror",
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.code).toBe("remote_unavailable");
    }

    await closeFixture(provider, workspace);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The runner itself                                                                              */
/* --------------------------------------------------------------------------------------------- */

describe("the publishing runner", () => {
  it("refuses the arguments that would force, delete, or rewrite", async () => {
    const fixture = await makeFixture();

    const refusals = [
      ["push", "--force", "origin", "main"],
      ["push", "-f", "origin", "main"],
      ["push", "--force-with-lease=main", "origin", "main"],
      ["push", "--mirror", "origin"],
      ["push", "--delete", "origin", "agentflow/x"],
      ["push", "--prune", "origin"],
      ["push", "--tags", "origin"],
      ["push", "--set-upstream", "origin", "main"],
      ["push", "--recurse-submodules=on-demand", "origin", "main"],
      ["push", `+refs/heads/x:refs/heads/x`, "origin"],
      ["update-ref", "-d", "refs/heads/main"],
      ["push", "--all", "origin"],
      ["push", "--set-upstream=origin", "main"],
    ];

    for (const args of refusals) {
      await expect(tryPublishGit({ cwd: fixture.root, args })).rejects.toThrow(/refuses to run git/);
    }
  });

  it("has no verb in its allowlist that could move a worktree's HEAD", async () => {
    // The property is a list, not a code path: these verbs are absent from the publishing allowlist, so no
    // publishing call can leave a worktree somewhere the workspace provider would refuse to reopen. The
    // cwd is a real repository, so a refusal here is the policy's and not a missing-directory accident.
    const fixture = await makeFixture();
    const mutating = [
      "switch",
      "checkout",
      "branch",
      "reset",
      "rebase",
      "merge",
      "cherry-pick",
      "revert",
      "am",
      "fetch",
      "pull",
      "clone",
      "clean",
      "stash",
    ];

    for (const verb of mutating) {
      await expect(tryPublishGit({ cwd: fixture.root, args: [verb] })).rejects.toThrow(
        /refuses to run git with the subcommand/u,
      );
    }
  });

  it("keeps a repository configuration from widening what a push may do", async () => {
    const fixture = await makeFixture();

    // A repository that tries to make the file transport always allowed, to follow tags on push, and to
    // recurse into submodules. Each override is passed before the verb, so the repository's own config
    // loses.
    git(fixture.root, "config", "protocol.file.allow", "always");
    git(fixture.root, "config", "push.followTags", "true");
    git(fixture.root, "config", "push.recurseSubmodules", "on-demand");

    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    // The push works anyway, because `protocol.file.allow=user` allows a remote the operator configured
    // while still overriding the repository's attempt to widen it.
    const pushed = await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: committed.commit,
      remote: "origin",
    });

    expect(pushed.ok).toBe(true);
    expect(git(fixture.remote, "for-each-ref", "--format=%(refname)").trim()).toBe(`refs/heads/${branch}`);

    await closeFixture(provider, workspace);
  });

  it("writes no file into the worktree while publishing", async () => {
    const fixture = await makeFixture();
    const { publisher, workspace, provider, branch, commitMessage } = await commitFixture(fixture);
    const before = await readFile(join(workspace.workingDirectory, "src", "app.ts"), "utf8");

    const committed = await publisher.commitFeature({
      workspace,
      featureId: FEATURE,
      branch,
      commitMessage,
      paths: ["src/publisher.ts"],
      expectedHead: fixture.baselineCommit,
      ownership: { featureId: FEATURE, summarySha256: "a".repeat(64) },
    });

    if (!committed.ok) {
      throw new Error(committed.message);
    }

    await publisher.pushBranch({
      repositoryRoot: fixture.root,
      featureId: FEATURE,
      branch,
      commit: committed.commit,
      remote: "origin",
    });

    // The approved content is still the approved content, and the change is still in the worktree.
    expect(await readFile(join(workspace.workingDirectory, "src", "app.ts"), "utf8")).toBe(before);
    expect(git(workspace.workingDirectory, "status", "--porcelain").trim()).toBe("?? src/publisher.ts");

    await closeFixture(provider, workspace);
  });
});

function gitResultCode(cwd: string, ...args: readonly string[]): number {
  try {
    execFileSync("git", [...args], { cwd, encoding: "utf8" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}