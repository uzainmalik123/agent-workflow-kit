import { WorkspaceAdapterError } from "./errors.js";
import { assertRepositoryRelative, toRepositoryRelative } from "./paths.js";

/**
 * Reading Git's structural report of a working tree.
 *
 * This is the adapter's only view of what changed, so the parsing is strict in one direction and
 * forgiving in the other. Paths are taken exactly as Git printed them, because the one thing a status
 * parser must never do is guess: an unfamiliar record is a refusal, and a path that fails the
 * repository-relative check is a refusal, rather than something normalized into a plausible shape. The
 * forgiving direction is status letters, which only ever grow — an unrecognised letter lands in
 * `modified`, the conservative category, instead of being treated as "nothing changed".
 */

export interface ParsedStatus {
  /** Tracked paths whose content differs from the baseline, including deletions. */
  readonly modified: readonly string[];
  /** Staged new paths, which is to say paths `git add` created. */
  readonly added: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  readonly untracked: readonly string[];
  /**
   * Paths with content in the index, which is not the same set as `modified`: a file can be modified
   * in the working tree alone. The baseline capture refuses on a staged path and permits an unstaged
   * one, so the two have to be distinguishable here or the capture cannot decide.
   */
  readonly staged: readonly string[];
}

/** Staged (index versus HEAD) letters, from the first column of a status record. */
const STAGED_LETTERS = new Set([
  "M",
  "T",
  "A",
  "D",
  "R",
  "C",
  "U",
]);

/** Unstaged (worktree versus index) letters, from the second column. */
const UNSTAGED_LETTERS = new Set(["M", "T", "D"]);

function add(target: Set<string>, path: string): void {
  target.add(toRepositoryRelative(path));
}

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * `-z` is not optional here. Without it, a path containing a space, a quote, or a non-ASCII character
 * is emitted inside a C-quoted string with escape sequences, and reversing that is a parser with bugs
 * in it. With it, every path is one NUL-terminated field of literal bytes, and a rename is two
 * consecutive fields: the new path, then the old one.
 */
export function parseStatus(output: string): ParsedStatus {
  const modified = new Set<string>();
  const added = new Set<string>();
  const deleted = new Set<string>();
  const untracked = new Set<string>();
  const staged = new Set<string>();
  const renamed: { from: string; to: string }[] = [];

  const fields = output.split("\0");
  let index = 0;

  while (index < fields.length) {
    const record = fields[index] ?? "";
    index += 1;

    // A trailing NUL leaves one empty field behind, and an empty field is never a record.
    if (record === "") {
      continue;
    }

    if (record.length < 4 || record[2] !== " ") {
      throw new WorkspaceAdapterError(
        "git_failed",
        "git reported a status record this adapter cannot read. Refusing to guess which paths changed.",
      );
    }

    const stagedLetter = record[0] ?? " ";
    const unstagedLetter = record[1] ?? " ";
    const path = record.slice(3);
    const kind = stagedLetter;

    assertRepositoryRelative(path);

    if (kind === "?" && unstagedLetter === "?") {
      add(untracked, path);
      continue;
    }

    if (kind === "!" && unstagedLetter === "!") {
      // `--untracked-files=all` does not emit ignored paths, but if a caller ever adds them this is
      // where they would be dropped: an ignored file is not a change to the approved starting point.
      continue;
    }

    if (kind === "R" || kind === "C") {
      const from = fields[index] ?? "";
      index += 1;

      if (from === "") {
        throw new WorkspaceAdapterError(
          "git_failed",
          "git reported a rename without the path it came from. Refusing to restore a path pair half of which is unknown.",
        );
      }

      assertRepositoryRelative(from);
      renamed.push({ from: toRepositoryRelative(from), to: toRepositoryRelative(path) });

      if (kind === "R") {
        add(staged, path);
      }

      continue;
    }

    if (STAGED_LETTERS.has(stagedLetter) || UNSTAGED_LETTERS.has(unstagedLetter)) {
      // A deletion is a deletion whichever column says so, and a staged addition is the only thing
      // that can be called "added": an untracked file did not come from an index write.
      if (stagedLetter !== " " && stagedLetter !== "?") {
        add(staged, path);
      }

      if (stagedLetter === "D" || unstagedLetter === "D") {
        add(deleted, path);
      } else if (stagedLetter === "A") {
        add(added, path);
      } else {
        add(modified, path);
      }
    }
  }

  return {
    modified: [...modified].sort(),
    added: [...added].sort(),
    deleted: [...deleted].sort(),
    renamed: renamed.sort((left, right) =>
      left.from === right.from ? left.to.localeCompare(right.to) : left.from.localeCompare(right.from),
    ),
    untracked: [...untracked].sort(),
    staged: [...staged].sort(),
  };
}

/** The repository-relative staged and unstaged path lists, as a baseline capture reports them. */
export interface TrackedState {
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
}

/**
 * Splits a status report into the two lists a baseline capture needs.
 *
 * Untracked and ignored paths are absent by construction: they are not tracked content, so an
 * untracked file does not make a tree dirty. That is also why `.agentflow/`, which is normally
 * untracked or ignored, never blocks approving a plan. The unstaged list deliberately includes the
 * staged ones, because a path that is both is still work the human has not committed.
 */
export function trackedStateFrom(status: ParsedStatus): TrackedState {
  const unstaged = new Set<string>([...status.modified, ...status.deleted, ...status.added]);

  for (const rename of status.renamed) {
    unstaged.add(rename.to);
  }

  return {
    staged: [...status.staged].sort(),
    unstaged: [...unstaged].sort(),
  };
}
