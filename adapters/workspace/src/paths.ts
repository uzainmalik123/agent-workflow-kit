import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { WorkspaceAdapterError } from "./errors.js";

/**
 * Path handling for a directory the agent is about to be pointed at.
 *
 * Everything here exists because the paths arrive from two untrusted directions at once: a Git
 * status line can name any path in the repository, including one inside a symlinked directory, and a
 * caller can name any repository-relative path at all. A path that resolves outside the workspace, or
 * whose final component is a symlink, is refused rather than followed. There is no normalization that
 * makes those safe, because the only safe reading of "restore this file" when the file might be a link
 * is "do not touch it".
 */

/** One path component ceiling, so a deep or wide repository cannot be walked by accident. */
export const MAX_PATH_LENGTH = 4_096;

/** The separator Git always uses in `status` output, whatever the platform's own separator is. */
export function toRepositoryRelative(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Rejects anything that is not a plain repository-relative path.
 *
 * Absolute paths, drive letters, `.` and `..` segments, NUL bytes, and empty components are all
 * refused. A path is not repaired into shape here, because a caller that passed `../` is either
 * confused or hostile and neither deserves a guess.
 */
export function assertRepositoryRelative(path: string): void {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new WorkspaceAdapterError("unsafe_path", `Refusing a path of length ${String(path.length)}.`);
  }

  if (path.includes("\0")) {
    throw new WorkspaceAdapterError("unsafe_path", "Refusing a path containing a NUL byte.");
  }

  if (isAbsolute(path) || path.includes(":")) {
    throw new WorkspaceAdapterError("unsafe_path", `Refusing the absolute path "${path}".`);
  }

  const segments = path.split("/");

  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new WorkspaceAdapterError("unsafe_path", `Refusing the path "${path}": it has an empty or relative segment.`);
    }
  }
}

/** Resolves a repository-relative path inside `root`, refusing anything that leaves it. */
export function resolveInside(root: string, repositoryRelativePath: string): string {
  assertRepositoryRelative(repositoryRelativePath);

  const rootPath = resolve(root);
  const target = resolve(rootPath, repositoryRelativePath);
  const fromRoot = relative(rootPath, target);

  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === "..") {
    throw new WorkspaceAdapterError(
      "path_escapes_workspace",
      `The path "${repositoryRelativePath}" resolves outside ${rootPath}.`,
    );
  }

  return target;
}

/**
 * The real directory a path lives in, or a refusal.
 *
 * Git will happily report a path whose parent is a symlink, and a repository can contain one. Reading
 * or deleting through it would operate on a target outside the workspace, so the whole prefix is
 * checked: if any component below the root is a symlink, the path is refused.
 */
export async function resolveRealPathInside(root: string, repositoryRelativePath: string): Promise<string> {
  const target = resolveInside(root, repositoryRelativePath);
  const rootPath = resolve(root);
  const segments = repositoryRelativePath.split("/");
  let current = rootPath;

  for (const segment of segments) {
    current = resolve(current, segment);

    let stats;

    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return target;
      }

      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new WorkspaceAdapterError(
        "symlink_refused",
        `The path "${repositoryRelativePath}" is a symlink, or is inside one, and this adapter does not follow links out of the workspace.`,
      );
    }
  }

  return target;
}
