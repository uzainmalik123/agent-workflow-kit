/**
 * The stage-run environment.
 *
 * A framework-controlled run inherits the operator's shell environment because a provider credential
 * is required for a real run: `PATH`, `HOME`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENCODE_API_KEY`,
 * `AWS_*`, and everything else the CLI needs are deliberately kept. Inheritance is necessary and it is
 * also the one part of the run this framework does not control, so this module is where that gap is
 * closed as far as it can be: the variables that can hand the CLI a *different* OpenCode than the one
 * this adapter generated, or a *different* permission policy, are removed from every stage run.
 *
 * The three groups below are the complete list, and each entry has a reason, because a scrub without a
 * stated reason is indistinguishable from superstition.
 *
 * 1. Alternate configuration injection. `OPENCODE_CONFIG` points the CLI at a replacement config file,
 *    `OPENCODE_CONFIG_DIR` replaces the directory agents, commands, and plugins are discovered in, and
 *    `OPENCODE_CONFIG_CONTENT` supplies an entire configuration inline, which outranks the file the
 *    adapter wrote. `OPENCODE_TUI_CONFIG` is a TUI-only file; `opencode run` never reads it, and it is
 *    removed only so that the same recorded environment is valid for every entry point.
 * 2. Configuration-suppressing flags. `OPENCODE_DISABLE_PROJECT_CONFIG` makes the CLI skip the
 *    generated project config, so the generated agents and permission rules would silently not exist;
 *    `OPENCODE_PURE` and `OPENCODE_DISABLE_DEFAULT_PLUGINS` change which plugins load, and the
 *    generated `plugins` allowlist is only meaningful under the default plugin set; `OPENCODE_AUTO_SHARE`
 *    is a shortcut for the `share` setting. Each is a behavior change a developer's shell could make
 *    silently, so each is removed rather than pinned to a value, and the default the adapter was
 *    written against is what actually runs. The `OPENCODE_DISABLE_` prefix is covered as a whole for
 *    the same reason.
 * 3. Experimental gates. Every `OPENCODE_EXPERIMENTAL_*` variable switches on a feature that can add a
 *    tool, change tool behavior, or change how a run is planned, and the framework's generated
 *    configuration sets none of them. An inherited value would change what a role can do between two
 *    developers' machines while the recorded configuration stayed identical. The prefix is removed
 *    whole, and a new experimental flag needs no change here.
 *
 * What is deliberately not scrubbed:
 *
 * - Credentials, always. There is no name-based removal of `*_API_KEY`, `*_TOKEN`, `*_SECRET`, or
 *   anything else, and `OPENCODE_API_KEY` is a real credential variable that shares the `OPENCODE_`
 *   prefix. The two prefix rules above are chosen so that neither can match a credential.
 * - `HOME`, `PATH`, `XDG_DATA_HOME`, and the rest of the toolchain environment, which a real run needs.
 * - Everything the project itself declares, such as `CI`, which is part of the project's contract with
 *   its own tooling rather than an injection into this framework.
 *
 * The final environment is computed by removing these names from the merged result, so a caller cannot
 * reintroduce a scrubbed name through the transport's `env` option: the framework's stage environment
 * has the last word. A run is reproducible across operators only if the part that decides what the
 * model may do is not left to the shell.
 *
 * One entry is deliberately exempt, and it is the smoke test's own: `OPENCODE_DISABLE_MODELS_FETCH` and
 * `OPENCODE_DISABLE_AUTOUPDATE` match the `OPENCODE_DISABLE_` prefix, and a framework-forced entry is
 * applied after the scrub instead of before it. The prefix rule exists so that nothing can *suppress*
 * the generated configuration; those two suppress a network call, which is the opposite direction, and
 * the framework sets them for every smoke-test child so a local configuration check stays local. An
 * exemption that is written here, in one place, with a stated reason, is a rule; an exemption discovered
 * later by noticing a test failed is a hole.
 */

/** Variables that let the environment supply a different OpenCode configuration. */
export const OPENCODE_CONFIG_INJECTION_VARIABLES: readonly string[] = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_TUI_CONFIG",
];

/** Variables that suppress or rewrite the configuration the adapter generated. */
export const OPENCODE_CONFIG_SUPPRESSING_VARIABLES: readonly string[] = [
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_PURE",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_AUTO_SHARE",
];

/** Prefixes whose every variable changes tool availability or run behavior. */
export const OPENCODE_SCRUBBED_PREFIXES: readonly string[] = [
  "OPENCODE_DISABLE_",
  "OPENCODE_EXPERIMENTAL_",
];

/** Every exact name removed from a stage run, in the order the groups are documented. */
export const OPENCODE_SCRUBBED_VARIABLES: readonly string[] = [
  ...OPENCODE_CONFIG_INJECTION_VARIABLES,
  ...OPENCODE_CONFIG_SUPPRESSING_VARIABLES,
  ...OPENCODE_SCRUBBED_PREFIXES.map((prefix) => `${prefix}*`),
];

/**
 * Whether one environment name is removed from a stage run.
 *
 * A prefix match is only ever applied to the two prefixes above, neither of which can match a
 * credential name, so this predicate cannot report a secret as scrubbable by accident.
 */
export function isScrubbedEnvironmentName(name: string): boolean {
  if (OPENCODE_CONFIG_INJECTION_VARIABLES.includes(name) || OPENCODE_CONFIG_SUPPRESSING_VARIABLES.includes(name)) {
    return true;
  }

  return OPENCODE_SCRUBBED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface StageRunEnvironmentOptions {
  /** The environment to start from. Inherited shell environment in production; a fixed record in tests. */
  readonly base?: Readonly<Record<string, string | undefined>>;
  /** Extra entries, merged over the base before the scrub. They cannot reintroduce a scrubbed name. */
  readonly overrides?: Readonly<Record<string, string>>;
  /**
   * Entries the framework itself sets, applied after the scrub and exempt from it. Used for the smoke
   * test's offline guarantees, which match a scrubbed prefix on purpose.
   */
  readonly forced?: Readonly<Record<string, string>>;
}

export interface StageRunEnvironment {
  /** The environment to spawn with. Undefined values are dropped, as `spawn` requires. */
  readonly env: Readonly<Record<string, string>>;
  /** Sorted names removed from the base, for evidence and for a test that asserts the list. Never a value. */
  readonly scrubbed: readonly string[];
}

/**
 * Environment entries forced on every configuration smoke-test child.
 *
 * `OPENCODE_DISABLE_MODELS_FETCH` stops OpenCode fetching the model catalog from models.dev, and
 * `OPENCODE_DISABLE_AUTOUPDATE` stops it checking for a new release. Without them, a configuration
 * check that is supposed to be local and offline would quietly reach the network.
 */
export const OPENCODE_SMOKE_TEST_FORCED_ENVIRONMENT: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
};

/**
 * Builds the environment for one OpenCode child process.
 *
 * Values are never read, logged, or returned except inside `env`; the removed names are reported so a
 * caller can record that the run was framework-controlled. `NODE_ENV` is deliberately left alone: it
 * is the one commonly-inherited name that a project sets on purpose, and OpenCode does not read it.
 */
export function buildStageRunEnvironment(options: StageRunEnvironmentOptions = {}): StageRunEnvironment {
  const base = options.base ?? process.env;
  const overrides = options.overrides ?? {};
  const forced = options.forced ?? {};
  const merged: Record<string, string | undefined> = { ...base };

  for (const [name, value] of Object.entries(overrides)) {
    merged[name] = value;
  }

  const scrubbed: string[] = [];
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(merged)) {
    if (isScrubbedEnvironmentName(name)) {
      scrubbed.push(name);
      continue;
    }

    if (typeof value === "string") {
      env[name] = value;
    }
  }

  for (const [name, value] of Object.entries(forced)) {
    env[name] = value;
  }

  scrubbed.sort();

  return { env, scrubbed };
}
