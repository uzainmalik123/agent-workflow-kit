import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { OpenCodeAdapterError } from "./errors.js";

export const PROJECT_INSTRUCTIONS_FILENAME = "AGENTS.md";

export const DEFAULT_MAX_PROJECT_INSTRUCTION_CHARS = 20_000;

export interface ProjectInstructions {
  /** Repository-relative POSIX path the guidance was read from. */
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

export interface LoadProjectInstructionsOptions {
  /** Repository-relative path of the guidance file. Defaults to `AGENTS.md`. */
  readonly relativePath?: string;
  readonly maxChars?: number;
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);

  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

async function readGuardedFile(path: string): Promise<string | null> {
  let stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Unable to inspect "${path}" while reading project instructions.`,
      { cause: error },
    );
  }

  if (stats.isSymbolicLink()) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Refusing to read project instructions through the symbolic link "${path}".`,
    );
  }

  if (!stats.isFile()) {
    return null;
  }

  return readFile(path, "utf8");
}

/**
 * Reads the repository's own guidance.
 *
 * The guidance is optional and it is project convenience, not framework policy: the adapter sends
 * it with an explicit precedence statement, and the framework rules are re-sent after it, so a
 * repository cannot grant itself approval authority, write access, Git access, or permission to
 * disable verification.
 */
export async function loadProjectInstructions(
  repositoryRoot: string,
  options?: LoadProjectInstructionsOptions,
): Promise<ProjectInstructions | null> {
  const root = resolve(repositoryRoot);
  const relativePath = options?.relativePath ?? PROJECT_INSTRUCTIONS_FILENAME;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_PROJECT_INSTRUCTION_CHARS;

  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Project instructions must be a repository-relative path, received "${relativePath}".`,
    );
  }

  const path = join(root, relativePath);

  if (!isInside(root, resolve(path))) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Refusing to read project instructions outside the repository root: "${relativePath}".`,
    );
  }

  const text = await readGuardedFile(path);

  if (text === null || text.trim().length === 0) {
    return null;
  }

  const normalized = text.replace(/\r\n/gu, "\n").trimEnd();
  const truncated = normalized.length > maxChars;
  const content = truncated
    ? `${normalized.slice(0, maxChars)}\n\n[Agent Workflow Kit truncated ${relativePath} after ${String(maxChars)} of ${String(normalized.length)} characters. The remainder was not sent to the agent.]`
    : normalized;

  return {
    path: relativePath.split(sep).join("/"),
    content,
    truncated,
    originalLength: normalized.length,
  };
}
