# Workspace adapter

The workspace adapter is the one place in this repository that is allowed to put a coding agent's
writes somewhere other than a human's working tree. It answers one question for the orchestrator:
for this feature, on the commit the human approved, where does a stage run, what did it change, and
how do those changes get put back?

It depends on `@agent-workflow-kit/core` and `@agent-workflow-kit/orchestration` for contracts, and
on nothing else. It does not import an agent adapter, and the orchestrator never imports it: the
connection between them is the `ProjectWorkspaceProvider` port.

## The path, in order

```
captureBaseline   read the human's tree; refuse uncommitted tracked work
open              worktree add --detach at the approved commit, then take a lease
inspect           git status --porcelain -z, read into a normalised change set
enforceScope      restore or delete exactly the paths the framework named
close             release the lease. The worktree and its changes stay
```

A model never appears in it. Nothing here reads a stage response, and a stage response cannot add a
path to the list that gets restored: the framework sends the exact set of unauthorized paths, and the
adapter's only discretion is how safely to reverse each one.

## Where a stage runs

| Phase | Directory | Access | Baseline |
| --- | --- | --- | --- |
| Pre-approval (`grill`, `planning`, `plan_review`) | the human's own checkout | `read_only` | none |
| Post-approval (everything after the plan gate) | a detached worktree in the cache | `read_write` | the approved commit |

A pre-approval stage is a conversation about a repository, so it is given the repository itself and a
read-only access level, and it is given no baseline: there is nothing to compare it against, because
nothing has been approved. Writes that appear anyway are reported as a violation and are **not** put
back — reversing a file would mean overwriting work the framework did not cause and cannot attribute.

A post-approval stage is a change to an approved starting point, so it runs in a worktree created with
`git worktree add --detach` at the full 40-character baseline SHA. Detached, because a branch is a
decision no one in this milestone has been asked to make. Full-length, because an abbreviated SHA is
ambiguous and a baseline that cannot be named exactly cannot be approved exactly.

The worktree is created in a cache directory **outside** the repository. A worktree inside the
repository would be a directory full of files that the human did not write, sitting in the tree the
human is working in, and `git status` would report it. The cache root is checked on every operation:
if it resolves inside the repository, everything here refuses rather than tidying up a human's
checkout on the way to failing.

## The sidecar

The record of what a workspace is lives *beside* the worktree, at `<workspaceId>.workspace.json` in
the cache root, not inside it:

```json
{
  "schemaVersion": 1,
  "workspaceId": "c4a7a1f4e51718a77d91753437f0e131",
  "featureId": "F-001",
  "repositoryRoot": "/home/dev/project",
  "baselineCommit": "40-char-sha",
  "branch": null,
  "createdAt": "2026-04-05T06:07:08.000Z"
}
```

Metadata inside the worktree would be a file the worktree's own `git status` reports, which would
then appear in the change set, and which a stage could edit. Writes are atomic: a temporary file in
the same directory, then a rename.

Anything about a workspace that is not exactly what the sidecar says is a refusal, not a repair:

- no sidecar, or one that will not parse, for a directory that exists
- a sidecar naming a different repository, feature, or baseline commit
- a repository `HEAD` that is not the approved commit
- a worktree `HEAD` that has moved, or an index with anything staged in it
- a directory that is occupied by something this adapter did not create
- a worktree Git knows about that has been moved or replaced behind its back

Each of those would otherwise be "create a fresh worktree and carry on", which silently discards
whatever the previous run was doing, and discards it *into a result that describes the new empty
state*. A missing workspace is created; an unrecognised one is refused.

## The lease

Two stages of one feature running at once, in one worktree, would interleave their writes and produce
a result describing neither. The lease is the only thing standing between that and a plausible-looking
answer.

A lease is a file naming a random owner token, the holder's PID and hostname, and an expiry.

- `open` takes the lease for the workspace, atomically, with `O_EXCL`.
- A second `open` in the **same process** for the same workspace is refused, even by a different
  provider instance, so a caller cannot interleave two stages through two objects.
- A lease held by a live process on this host is refused.
- A lease held by a process on another host is refused too. The adapter cannot reach into another
  machine to ask, so it assumes the worst and refuses rather than guessing from a clock.
- A lease whose process is gone on this host, or whose expiry has passed, is stale and may be taken.
  The record keeps the previous holder, so a takeover is visible afterwards.
- `close` releases only the lease this process took. A caller that forgets leaves a lease that times
  out, which is recoverable, rather than one that is stolen on sight, which is not.

## Reading changes

`git status --porcelain=v1 -z --untracked-files=all` is the only read. NUL-separated, so a filename
containing a space, a quote, a newline, or a non-ASCII character is one field rather than a guess.
The output is parsed into a normalised change set: added, modified, deleted, renamed pairs, untracked,
plus the staged and unstaged path lists and `HEAD`.

Three distinctions are load-bearing:

- **A staged new file is `added`, not `untracked` and not `modified`.** It is tracked because something
  staged it, and it is not in the approved commit, so there is nothing to restore it from. Calling it a
  modification would claim the baseline contains a file it does not.
- **`added` and `modified` differ only in whether the approved commit has the path.** Both are tracked.
- **An untracked file is not in the approved commit either**, so reversing it means deletion, not
  `git checkout`. `git checkout` of a path Git does not track does nothing, silently, and the record
  would then claim a restoration that never happened.

A renamed path is both of its names: `from` is a deletion and `to` is an addition, and both are
reported, because restoring only one of them leaves a rename's two halves inconsistent.

## Putting a path back

The framework decides which paths are unauthorized and sends that exact list. The adapter reverses
each one and reports what it actually achieved, which is not always the same thing:

| Path at the baseline | Reversal | Reported as |
| --- | --- | --- |
| present, tracked | `git checkout` from the baseline commit | restored |
| absent, or untracked | delete, then prune the directory if that emptied it | removed |
| a symlink, or reached through one | nothing | unsafe |
| a path Git cannot name safely | nothing | an enforcement error |

Paths are validated before anything is run: a path that is absolute, that contains `..`, that begins
with `/dev/null`, that is a symlink, or that resolves outside the worktree is refused. It is deleted
with `git rm` or unlinked directly, never through a shell, and directories are removed only when
removing their last entry emptied them.

An `unsafePaths` entry is the important one. It means the framework found a path it did not approve
and declined to touch it, so the workspace may still contain it, so the stage's result is discarded
rather than recorded as clean. Refusing to act and saying so is the whole point: a reversal that
quietly does nothing is worse than no reversal, because the record would claim the worktree is clean.

## Closing

`close` releases the lease. It does not remove the worktree and does not revert its changes.

A failed or scope-violating stage is exactly when a half-written worktree is worth reading, and the
next run of the same feature reopens the same worktree at the same baseline and finds the previous
run's work. The cost is a cache directory that grows until a human prunes it, which is visible and
recoverable, rather than work that disappeared with no record of where it went.

## What the Git runner will not do

`runGit` builds an argument array, passes it to `spawn` with `shell: false`, and scrubs the
environment. There is no path in this package that builds a command string, and no path that shells
out.

- **A subcommand allowlist, not a denylist.** Only `rev-parse`, `ls-tree`, `status`, `worktree`,
  `checkout`, and `rm` are runnable. The first four are reads or the worktree creation; `checkout` and
  `rm` exist only to restore one framework-named path and are always called after a `--` with a
  validated path. `commit`, `push`, `fetch`, `pull`, `reset`, `clean`, `rebase`, `merge`, `stash`,
  `branch`, `switch`, `update-ref`, `symbolic-ref`, `gc`, and `prune` are not in the list, so no
  argument a repository, a stage, or a future edit reaches can move a branch, rewrite history, or
  delete anything the framework did not name itself. A subcommand outside the list is a thrown
  programming error rather than a result, because there is no call site in this package that would
  want one.
- **`GIT_*` variables are removed, and configuration that can run something is neutralized.**
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG*`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and
  the rest of the retargeting set are dropped, so a variable in the human's shell cannot point a
  command at a different repository. `core.hooksPath`, `include.path`, `core.fsmonitor`,
  `core.untrackedCache`, `gc.auto`, and `protocol.file.allow` are pinned as `-c` overrides that beat
  the repository's own config, so a hook is never run, an included config is never pulled in, and a
  stale read cache cannot make Git report "nothing changed" about a tree an agent just changed.
- **Arguments that change what Git does rather than what it reports are refused**: `--config`, `-c`,
  `--upload-pack`, `--receive-pack`, `--exec`, `--git-dir`, `--namespace`, `--super-prefix`,
  `--exec-path`.
- Every command has a timeout, and a timeout kills the process with `SIGKILL` instead of leaving it
  running. Output is bounded, and a command that exceeds the cap is killed rather than buffered: an
  unbounded read of `git status` in a repository with a large untracked tree is a way to exhaust
  memory. The environment is otherwise inherited, because a coding agent's toolchain depends on it.

## Failure is a refusal, not a repair

Every operation returns a discriminated result, and the refusal codes are specific on purpose:
`not_a_git_repository`, `head_unborn`, `tracked_workspace_dirty`, `baseline_missing`,
`workspace_path_occupied`, `workspace_metadata_missing`, `workspace_registered_elsewhere`,
`head_changed`, `lease_unavailable`, `workspace_failed`.

`head_changed` is worth its own code. A moved `HEAD` is not a scope violation, and reporting it as
one would send whoever reads the record looking for a path problem that does not exist — while saying
nothing about the commit a stage made without anyone approving it. The commit is left where it is, in
the worktree, where a human can read it.
