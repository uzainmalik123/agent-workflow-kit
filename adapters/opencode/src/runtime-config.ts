import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  OPENCODE_PROJECT_CONFIG_PATH,
  type GeneratedOpenCodeFile,
  renderAgentMarkdown,
  renderOpenCodeProjectConfig,
} from "./agents.js";
import { OpenCodeAdapterError } from "./errors.js";
import { OPENCODE_PROFILES, type OpenCodeProfile } from "./roles.js";

/**
 * The framework-owned OpenCode configuration directory.
 *
 * ## Why it exists
 *
 * Agent Workflow Kit's two profiles used to be generated *into the target repository*, which made
 * configuring OpenCode a write to somebody's project. A repository then had to be prepared before a
 * workflow could run, the generated files showed up in diffs and in version control, and a target
 * that was read-only, or a checkout the workflow only wanted to inspect, could not be run at all.
 *
 * This module moves that configuration out of the repository and into a directory the framework
 * owns, and hands the CLI that directory through `OPENCODE_CONFIG_DIR` - the V2 configuration
 * directory the server reads as `config.directory`. The target repository stays the process working
 * directory, so OpenCode still reads and edits project code, but the repository no longer carries
 * anything Agent Workflow Kit wrote.
 *
 * ## What this does *not* do
 *
 * It does not isolate the repository's own OpenCode configuration. V2 still loads the target
 * repository's `opencode.json` and its `.opencode/` directory, and this module neither suppresses
 * that nor pretends to. The guarantee here is narrower and it is the one that was measured: the
 * permissions declared in a framework profile stay authoritative even when a repository config is
 * present, because a profile's own rules are not widened by the surrounding configuration.
 *
 * A repository can still define its own agents, and OpenCode still discovers them, so a repository
 * that defines an agent with a framework profile's id is handled explicitly rather than left to
 * precedence: `assertNoProjectProfileShadow` in `configuration-integrity.ts` refuses a repository
 * definition of a framework profile id unless its bytes are the framework's own. Silently letting a
 * repository win an id the framework then passes to `--agent` would mean the run used permissions
 * this framework never granted.
 */

/** The directory name used under the platform temporary directory. */
export const OPENCODE_RUNTIME_DIRECTORY_NAME = "agent-workflow-kit";

/**
 * Where inside the runtime root the generated agent files live.
 *
 * This is `agent/`, *not* the `.opencode/agents/` path used for a project-local installation. The two
 * are different discovery roots: in a project the loader looks under the repository's `.opencode/`,
 * while in a configuration directory it looks for `agent/` and `agents/` directly beneath that
 * directory. Writing the project-local path here would have produced a directory the loader never
 * reads, and the profiles would silently not exist.
 */
export const OPENCODE_RUNTIME_AGENT_DIRECTORY = "agent";

/**
 * The files that make up the framework-owned configuration.
 *
 * This is the two profiles and the minimum framework-controlled configuration they need. The
 * per-role prose is deliberately absent for the same reason it is absent from the generated project
 * files: the job arrives in the stage prompt, and a profile file that carried instructions would say
 * the same thing to every stage that shares it.
 */
export function renderOpenCodeRuntimeConfigFiles(): readonly GeneratedOpenCodeFile[] {
  return [
    ...OPENCODE_PROFILES.map((profile) => ({
      path: runtimeAgentFileForProfile(profile),
      contents: renderAgentMarkdown(profile),
    })),
    { path: OPENCODE_PROJECT_CONFIG_PATH, contents: renderOpenCodeProjectConfig() },
  ];
}

/** The generated file that defines one profile inside the runtime directory. */
export function runtimeAgentFileForProfile(profile: OpenCodeProfile): string {
  return `${OPENCODE_RUNTIME_AGENT_DIRECTORY}/${profile}.md`;
}

/**
 * The environment entry that points OpenCode at the framework-owned configuration.
 *
 * `OPENCODE_CONFIG_DIR` is the variable the V2 server reads as `config.directory`. It is set by the
 * framework *after* the environment scrub rather than through it, because the scrub's whole job is
 * to stop an inherited or caller-supplied value from choosing which OpenCode configuration runs -
 * and this is the one value the framework itself has to set.
 */
export const OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE = "OPENCODE_CONFIG_DIR";

/**
 * A stable per-repository runtime directory, outside the target repository.
 *
 * The name is derived from the repository's absolute path so two repositories never share a
 * configuration directory, and the whole thing lives under the platform temporary directory so it is
 * not inside any checkout. A caller that wants a different location (a mounted volume, a temp
 * directory under test control) passes its own path instead.
 */
export function defaultRuntimeConfigDirectory(repositoryRoot: string): string {
  const root = resolve(repositoryRoot);
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 32);

  return join(tmpdir(), OPENCODE_RUNTIME_DIRECTORY_NAME, `opencode-${digest}`);
}

export interface CreateRuntimeConfigOptions {
  /** Overrides {@link defaultRuntimeConfigDirectory}. A path under the repository is refused. */
  readonly directory?: string;
  /** Wipe an existing directory before writing, so a previous run's files cannot survive. */
  readonly fresh?: boolean;
}

export interface OpenCodeRuntimeConfig {
  /** The absolute directory to hand to OpenCode as `OPENCODE_CONFIG_DIR`. */
  readonly directory: string;
  /** The repository the configuration was built for, resolved. */
  readonly repositoryRoot: string;
  /** Paths written, relative to `directory`, POSIX-separated. */
  readonly files: readonly string[];
}

/**
 * Whether `directory` is inside `repositoryRoot`.
 *
 * Relative paths are compared after resolution, so `../` cannot disguise an inside-the-repository
 * path, and a sibling directory with a shared prefix (`/repo` vs `/repo-other`) is correctly treated
 * as outside. The repository root itself counts as inside: naming the checkout as the configuration
 * directory would put every generated file back exactly where this module exists to keep them out of.
 */
export function isInsideRepository(directory: string, repositoryRoot: string): boolean {
  const root = resolve(repositoryRoot);
  const target = resolve(directory);
  const path = relative(root, target);

  // An empty `path` means the two resolve to the same directory, which counts as inside: naming the
  // checkout as the configuration directory would put every generated file back where this module
  // exists to keep them out of.
  return path.length === 0 || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * Creates the framework-owned OpenCode configuration for one repository.
 *
 * The directory is created if it is absent, and each generated file is rewritten so the contents are
 * always the framework's own. `fresh` additionally removes the directory first, which is what a caller
 * wants when a directory from an earlier run cannot be trusted.
 *
 * The directory must be outside the repository. That is checked here rather than trusted from the
 * caller, because the whole point of this module is that configuring OpenCode does not write to the
 * project, and a configuration directory that landed inside the checkout would reintroduce exactly the
 * coupling this exists to remove.
 */
export async function createOpenCodeRuntimeConfig(
  repositoryRoot: string,
  options?: CreateRuntimeConfigOptions,
): Promise<OpenCodeRuntimeConfig> {
  const root = resolve(repositoryRoot);
  const directory = resolve(options?.directory ?? defaultRuntimeConfigDirectory(root));

  if (isInsideRepository(directory, root)) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Refusing to use "${directory}" as the framework OpenCode configuration directory: it is inside the target repository "${root}". Agent Workflow Kit's own configuration must live outside the repository it configures.`,
    );
  }

  if (options?.fresh === true) {
    await removeOpenCodeRuntimeConfig(directory);
  }

  await mkdir(join(directory, OPENCODE_RUNTIME_AGENT_DIRECTORY), { recursive: true });

  const files: string[] = [];
  const rendered = renderOpenCodeRuntimeConfigFiles();

  for (const file of rendered) {
    const target = join(directory, file.path);

    // Checked before writing rather than after, because writing through a symbolic link is how a
    // generated file ends up somewhere other than where the caller asked for it. The parent is checked
    // as well as the file, since a link on either is enough to redirect the write.
    await assertNotSymlink(dirname(target));
    await assertNotSymlink(target);
    await writeFile(target, file.contents, "utf8");
    files.push(file.path);
  }

  return { directory, repositoryRoot: root, files };
}

async function assertNotSymlink(path: string): Promise<void> {
  let stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Unable to inspect "${path}" while preparing the framework OpenCode configuration.`,
      { cause: error },
    );
  }

  if (stats.isSymbolicLink()) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Refusing to prepare the framework OpenCode configuration: "${path}" is a symbolic link.`,
    );
  }
}

/**
 * Removes a runtime configuration directory.
 *
 * Best effort about a directory that was never created - `rm` with `force` already treats that as
 * success - and strict about anything else, because a caller cleaning up after a run should not have
 * to distinguish "already gone" from "something is wrong with the path I was handed".
 */
export async function removeOpenCodeRuntimeConfig(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Unable to remove the framework OpenCode configuration directory "${directory}".`,
      { cause: error },
    );
  }
}
