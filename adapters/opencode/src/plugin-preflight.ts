import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { OpenCodeAdapterError } from "./errors.js";

/**
 * The directory names OpenCode auto-discovers plugins under.
 *
 * These are not guesses. In a real 2.0.18 bundle the plugin source directory scan is a literal
 * `["plugin", "plugins"]` list applied to every OpenCode configuration directory, and the set of
 * configuration directories is the project itself plus each applicable ancestor. A project
 * directory is a configuration directory when it holds `.opencode/`, and `.opencode/` is itself a
 * configuration directory, which is where the two dotted forms come from. So for a project root
 * the complete set of auto-discovered plugin locations is these four relative paths.
 */
export const PROJECT_LOCAL_PLUGIN_DIRECTORIES: readonly string[] = [
  ".opencode/plugin",
  ".opencode/plugins",
  "plugin",
  "plugins",
];

export const REPOSITORY_ROOT_MARKER = ".git";

/**
 * Filename extensions and entry names that make a plugin directory hold executable content.
 *
 * A plugin directory is a loader directory: OpenCode imports every matching module it finds there,
 * so the presence of loadable code is the fact that matters, not the code's content. Anything that
 * cannot be loaded is not a risk, which is why documentation and licence files are ignored and an
 * empty or text-only directory is allowed.
 */
export const EXECUTABLE_PLUGIN_EXTENSIONS: readonly string[] = [
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
];

export const EXECUTABLE_PLUGIN_ENTRY_NAMES: readonly string[] = ["package.json"];

const MAX_SCAN_DEPTH = 8;

export type OpenCodeProjectPluginFindingKind = "executable_content" | "escaping_symlink";

export interface OpenCodeProjectPluginFinding {
  /** The plugin directory that was found, absolute and resolved. */
  readonly directory: string;
  /** The configuration directory the plugin directory sits under. */
  readonly configRoot: string;
  readonly kind: OpenCodeProjectPluginFindingKind;
  /**
   * Paths that made this a finding, relative to the plugin directory and POSIX-separated, sorted.
   * Empty for an escaping symlink, where the symlink itself is the finding.
   */
  readonly entries: readonly string[];
}

export interface FindProjectLocalPluginsOptions {
  /**
   * Extends the ancestor walk to an explicit workspace boundary. The walk starts at the working
   * directory and visits each parent up to and including this one.
   *
   * By default the walk stops at the repository root instead, found by looking for `.git` upward
   * from the project. That is the workspace boundary, and it is what keeps this from refusing a
   * project because of the developer's own global OpenCode configuration: `~/.opencode` is an
   * ancestor of a checkout on a workstation but is not repository-controlled, and a workflow stage
   * is exactly the thing that must not depend on machine-level state. A monorepo where the project
   * is a subdirectory is covered without this option, because the repository root is above the
   * project. Pass it when the workspace is wider than the repository.
   */
  readonly stopAt?: string;
  /**
   * How far above the working directory the walk may go, counted in parents. Defaults to the
   * repository root. Lower it to bound the work; the walk never passes the boundary either way.
   */
  readonly maxParentDepth?: number;
  /** Defaults to the working directory, and is the boundary a symlink may not escape. */
  readonly boundaryDirectory?: string;
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);

  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

function hasExecutableExtension(name: string): boolean {
  const lowered = name.toLowerCase();

  return EXECUTABLE_PLUGIN_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

async function pathKind(path: string): Promise<"missing" | "symlink" | "directory" | "other"> {
  let stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }

    throw new OpenCodeAdapterError(
      "project_plugin_detected",
      `Unable to inspect "${path}" while checking for project-local OpenCode plugins.`,
      { cause: error },
    );
  }

  if (stats.isSymbolicLink()) {
    return "symlink";
  }

  return stats.isDirectory() ? "directory" : "other";
}

/**
 * Lists what in a plugin directory OpenCode would be able to load.
 *
 * Returns POSIX paths relative to the directory, sorted. Recursion is bounded and each level is
 * visited once, so a symlinked loop cannot hang the preflight. A symlink found inside a plugin
 * directory is reported as an escaping symlink rather than followed, because following it is how a
 * repository smuggles loadable code in from outside the tree.
 */
async function scanPluginDirectory(
  directory: string,
  boundary: string,
  depth = 0,
): Promise<{ readonly executable: readonly string[]; readonly escaped: boolean }> {
  const executable: string[] = [];
  let escaped = false;

  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = entry.name.split(sep).join("/");

    if (entry.isSymbolicLink()) {
      let resolvedTarget: string;

      try {
        resolvedTarget = await realpath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // A dangling symlink loads nothing.
          continue;
        }

        throw new OpenCodeAdapterError(
          "project_plugin_detected",
          `Unable to resolve the symbolic link "${path}" while checking for project-local OpenCode plugins.`,
          { cause: error },
        );
      }

      if (!isInside(boundary, resolvedTarget)) {
        // Reported, never followed: reading through it is exactly the thing being refused.
        if (hasExecutableExtension(entry.name) || EXECUTABLE_PLUGIN_ENTRY_NAMES.includes(entry.name)) {
          escaped = true;
        }

        continue;
      }

      const kind = await pathKind(resolvedTarget);

      if (kind === "other") {
        if (hasExecutableExtension(entry.name) || EXECUTABLE_PLUGIN_ENTRY_NAMES.includes(entry.name)) {
          executable.push(relativePath);
        }

        continue;
      }

      if (kind === "directory" && depth < MAX_SCAN_DEPTH) {
        const nested = await scanPluginDirectory(resolvedTarget, boundary, depth + 1);

        executable.push(...nested.executable.map((found) => `${relativePath}/${found}`));
        escaped = escaped || nested.escaped;
      }

      continue;
    }

    if (EXECUTABLE_PLUGIN_ENTRY_NAMES.includes(entry.name)) {
      executable.push(relativePath);
      continue;
    }

    if (entry.isDirectory()) {
      if (depth < MAX_SCAN_DEPTH) {
        const nested = await scanPluginDirectory(path, boundary, depth + 1);

        executable.push(...nested.executable.map((found) => `${relativePath}/${found}`));
        escaped = escaped || nested.escaped;
      }

      continue;
    }

    if (hasExecutableExtension(entry.name)) {
      executable.push(relativePath);
    }
  }

  return { executable: executable.sort(), escaped };
}

async function inspectPluginDirectory(
  configRoot: string,
  relativeDirectory: string,
  boundary: string,
): Promise<OpenCodeProjectPluginFinding | null> {
  const path = join(configRoot, relativeDirectory);
  const kind = await pathKind(path);

  if (kind === "missing" || kind === "other") {
    return null;
  }

  if (kind === "symlink") {
    let resolvedTarget: string;

    try {
      resolvedTarget = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw new OpenCodeAdapterError(
        "project_plugin_detected",
        `Unable to resolve the plugin directory link "${path}".`,
        { cause: error },
      );
    }

    if (!isInside(boundary, resolvedTarget)) {
      return {
        directory: path,
        configRoot,
        kind: "escaping_symlink",
        entries: [],
      };
    }

    const scan = await scanPluginDirectory(resolvedTarget, boundary);

    if (scan.executable.length === 0 && !scan.escaped) {
      return null;
    }

    return {
      directory: path,
      configRoot,
      kind: scan.escaped && scan.executable.length === 0 ? "escaping_symlink" : "executable_content",
      entries: scan.executable,
    };
  }

  const scan = await scanPluginDirectory(path, boundary);

  if (scan.executable.length === 0 && !scan.escaped) {
    // An empty plugin directory, or one holding only text, loads nothing. Allowed on purpose: a
    // repository may legitimately keep a placeholder or a note there, and refusing it would be a
    // false alarm about a directory that cannot execute.
    return null;
  }

  return {
    directory: path,
    configRoot,
    kind: scan.escaped && scan.executable.length === 0 ? "escaping_symlink" : "executable_content",
    entries: scan.executable,
  };
}

/**
 * The nearest directory at or above `directory` holding a `.git` entry, or null.
 *
 * A `.git` *file* counts as well as a directory, because a worktree or submodule has one. This is
 * the workspace boundary for the ancestor walk.
 */
export async function findRepositoryRoot(directory: string): Promise<string | null> {
  let current = resolve(directory);

  for (;;) {
    if ((await pathKind(join(current, REPOSITORY_ROOT_MARKER))) !== "missing") {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

/**
 * The directories to inspect: the project, then every ancestor up to the workspace boundary.
 *
 * Ancestors are included unconditionally rather than only when they look like OpenCode
 * configuration directories, because OpenCode's own candidate list is unconditional too: in a real
 * 2.0.18 bundle the per-instance and per-ancestor candidates are built by mapping every one of them
 * to a `plugins` subdirectory, with no test for whether the directory holds any OpenCode
 * configuration. Gating on a configuration marker would have been less protective than the thing
 * being defended against, which is the wrong direction for a security check.
 *
 * The workspace boundary is what keeps that from becoming a filesystem scan. The walk stops at the
 * repository root, so a developer's global `~/.opencode` is never reached from a checkout.
 */
async function* candidateConfigRoots(
  workingDirectory: string,
  options?: FindProjectLocalPluginsOptions,
): AsyncGenerator<string> {
  yield workingDirectory;

  const maxParentDepth = options?.maxParentDepth ?? Number.POSITIVE_INFINITY;
  const stopAt = options?.stopAt === undefined
    ? await findRepositoryRoot(workingDirectory)
    : resolve(options.stopAt);

  if (stopAt === null || stopAt === workingDirectory) {
    return;
  }

  let current = dirname(workingDirectory);
  let depth = 0;

  // `depth` counts parents above the project, so depth 0 is the immediate parent.
  while (depth <= maxParentDepth) {
    yield current;

    if (current === stopAt) {
      return;
    }

    const parent = dirname(current);

    if (parent === current) {
      // Filesystem root: there is no parent left inside the boundary.
      return;
    }

    depth += 1;
    current = parent;
  }
}

/**
 * Finds every auto-discovered plugin location that holds loadable code, starting at the project and
 * walking up through applicable OpenCode configuration directories.
 *
 * Only plugin directories are examined. `.opencode/agents/` and `.opencode/commands/` are the
 * framework's own generated output and are not reported, so a correctly generated project passes.
 */
export async function findProjectLocalPlugins(
  workingDirectory: string,
  options?: FindProjectLocalPluginsOptions,
): Promise<readonly OpenCodeProjectPluginFinding[]> {
  const project = resolve(workingDirectory);
  const boundary = resolve(options?.boundaryDirectory ?? workingDirectory);
  const findings: OpenCodeProjectPluginFinding[] = [];

  for await (const configRoot of candidateConfigRoots(project, options)) {
    for (const relativeDirectory of PROJECT_LOCAL_PLUGIN_DIRECTORIES) {
      const finding = await inspectPluginDirectory(configRoot, relativeDirectory, boundary);

      if (finding !== null) {
        findings.push(finding);
      }
    }
  }

  return findings;
}

export function describeProjectLocalPluginFindings(
  findings: readonly OpenCodeProjectPluginFinding[],
): string {
  return findings
    .map((finding) => {
      const where = finding.entries.length === 0
        ? "is a symbolic link leaving the repository"
        : `contains executable plugin code: ${finding.entries.join(", ")}`;

      return `${finding.directory} (${where})`;
    })
    .join("; ");
}

/**
 * Refuses to start an OpenCode stage in a project that ships its own OpenCode plugin.
 *
 * This is the half of plugin safety that configuration cannot do. The generated `opencode.json`
 * disables every plugin and re-enables the `opencode.` namespace, and that is a real defence against
 * third-party plugin integrations OpenCode would otherwise load. It is not a defence against a
 * repository that names its own plugin `opencode.evil`: plugin directives are matched against the
 * id a plugin *declares*, and a repository chooses that string. So the namespace re-enable and a
 * repository-chosen id are the same rule seen from two sides, and only one of them is under the
 * framework's control.
 *
 * The two mechanisms are therefore complementary, and this check is deliberately the stricter one:
 *
 * - preflight: refuse executable repository plugin code *before* OpenCode is started, so a plugin
 *   that matches the trusted namespace is never loaded in the first place;
 * - configuration: disable other non-framework plugin integrations OpenCode may load from
 *   `node_modules`, a global config, or an explicit `plugins` entry in a config file.
 *
 * Nothing is deleted, renamed, or ignored. The caller gets a structured refusal listing the
 * offending paths, and the stage does not run.
 */
export async function assertNoProjectLocalPlugins(
  workingDirectory: string,
  options?: FindProjectLocalPluginsOptions,
): Promise<void> {
  const findings = await findProjectLocalPlugins(workingDirectory, options);

  if (findings.length === 0) {
    return;
  }

  throw new OpenCodeAdapterError(
    "project_plugin_detected",
    `Refusing to run an OpenCode workflow stage in "${resolve(workingDirectory)}": the repository ships executable OpenCode plugin code, and a repository-chosen plugin id can match the trusted opencode.* namespace the generated configuration re-enables. ${describeProjectLocalPluginFindings(findings)}. Nothing was modified: remove or disable the plugin, or run the stage somewhere else.`,
  );
}
