import type { Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { ProjectAdapterError } from "./errors.js";

/**
 * Filesystem reads for discovery.
 *
 * Discovery only ever *reads* a fixed list of well-known filenames, so this module is deliberately
 * small and deliberately paranoid: every path component is `lstat`-ed before it is used, a symlink
 * anywhere below the project root is a refusal rather than a redirect, and a file larger than the
 * manifest ceiling is refused instead of buffered. A repository that puts a symlink where a manifest
 * is expected gets an explicit refusal, not the contents of wherever the link points.
 */

/** A manifest is configuration, not a payload. Anything larger is refused unread. */
export const MAX_MANIFEST_BYTES = 2_000_000;

export interface ExistingPath {
  readonly kind: "file" | "directory";
  readonly size: number;
}

/**
 * Resolves `relativePath` under `root` and refuses anything that leaves it.
 *
 * A configured subdirectory is project data, and `../` in it must not become a command's working
 * directory somewhere else on the machine.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, relativePath);
  const relativeTarget = relative(rootPath, target);

  if (relativeTarget === "" || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new ProjectAdapterError(
      "unsafe_path",
      `The configured path "${relativePath}" resolves outside the project root.`,
    );
  }

  return target;
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingEntry(error)) {
      return undefined;
    }

    throw new ProjectAdapterError("unsafe_path", `Unable to inspect "${path}".`, { cause: error });
  }
}

function isMissingEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** `undefined` when the path does not exist, and a refusal for a symlink or a special file. */
export async function inspectPath(path: string): Promise<ExistingPath | undefined> {
  const stats = await lstatOrUndefined(path);

  if (stats === undefined) {
    return undefined;
  }

  if (stats.isSymbolicLink()) {
    throw new ProjectAdapterError(
      "unsafe_path",
      `"${path}" is a symbolic link, and discovery does not follow links out of the project.`,
    );
  }

  if (stats.isDirectory()) {
    return { kind: "directory", size: 0 };
  }

  if (!stats.isFile()) {
    throw new ProjectAdapterError("unsafe_path", `"${path}" is not a regular file.`);
  }

  return { kind: "file", size: stats.size };
}

export async function isDirectory(path: string): Promise<boolean> {
  const inspected = await inspectPath(path);

  return inspected !== undefined && inspected.kind === "directory";
}

export async function isFile(path: string): Promise<boolean> {
  const inspected = await inspectPath(path);

  return inspected !== undefined && inspected.kind === "file";
}

/**
 * Reads a project file that must exist and be a regular file of a sane size, or throws a refusal
 * carrying which of those two conditions failed.
 */
export async function readProjectFile(path: string, what: string): Promise<string> {
  const inspected = await inspectPath(path);

  if (inspected === undefined || inspected.kind !== "file") {
    throw new ProjectAdapterError("manifest_unreadable", `${what} is not a readable file at "${path}".`);
  }

  if (inspected.size > MAX_MANIFEST_BYTES) {
    throw new ProjectAdapterError(
      "manifest_unreadable",
      `${what} at "${path}" is ${String(inspected.size)} bytes, above the ${String(MAX_MANIFEST_BYTES)} byte ceiling.`,
    );
  }

  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ProjectAdapterError("manifest_unreadable", `${what} at "${path}" could not be read.`, {
      cause: error,
    });
  }
}

export function parseJsonFile(text: string, path: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProjectAdapterError(
      "manifest_malformed",
      `${what} at "${path}" is not valid JSON.`,
      { cause: error },
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project-relative, forward-slash form, which is what every profile and evidence record uses. */
export function relativeToRoot(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

/** Names of the entries in a directory, sorted, ignoring anything that is not a plain entry. */
export async function readDirectoryNames(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    throw new ProjectAdapterError("unsafe_path", `Unable to list "${path}".`, { cause: error });
  });

  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

export function joinWithin(root: string, ...segments: readonly string[]): string {
  return join(root, ...segments);
}
