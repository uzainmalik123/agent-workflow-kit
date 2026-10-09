import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  OPENCODE_PROJECT_CONFIG_PATH,
  type GeneratedOpenCodeFile,
  renderAgentMarkdown,
  renderOpenCodeProjectConfig,
} from "./agents.js";
import { OpenCodeAdapterError } from "./errors.js";
import {
  permissionRulesForProfile,
  type OpenCodePermissionRule,
} from "./permissions.js";
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

  // Re-read, parse, and compare what is now on disk, after every write and before the caller
  // hands the directory to OpenCode. See `assertOpenCodeRuntimeConfigIntegrity` for why a write
  // that cannot be read back into the intended rules has to stop here rather than at the model.
  await assertOpenCodeRuntimeConfigIntegrity(directory);

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

/* -------------------------------------------------------------------------- *
 * Fail-closed verification of what was just written (decision D-1, condition 2)
 * -------------------------------------------------------------------------- */

/**
 * A structural problem in an agent file's frontmatter.
 *
 * Internal to this module: every one of these is converted into an `OpenCodeAdapterError` before it
 * leaves {@link assertOpenCodeRuntimeConfigIntegrity}, so a caller only ever sees a refusal.
 */
class FrontmatterProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterProblem";
  }
}

/** The keys of one rule, and the only order this framework writes them in. */
const RULE_KEYS = ["action", "resource", "effect"] as const;
type RuleKey = (typeof RULE_KEYS)[number];

/** `  - action: "..."` - the first key of a rule entry, at the sequence's own indentation. */
const SEQUENCE_KEY_LINE = /^ {2}- ([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u;
/** `    resource: "..."` - a continuation key of the open rule. */
const NESTED_KEY_LINE = /^ {4}([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u;
/** `description: "..."` - a top-level frontmatter field. */
const TOP_LEVEL_KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u;

const RULE_EFFECTS: readonly string[] = ["allow", "deny", "ask"];

interface ParsedAgentFrontmatter {
  /** The permission rules, in the order the file declares them. */
  readonly rules: readonly OpenCodePermissionRule[];
}

/**
 * Reads one scalar the way the emitter writes it: a JSON double-quoted string, which is also a
 * valid YAML double-quoted scalar.
 *
 * A plain scalar such as `deny` is valid YAML, so this is deliberately stricter than YAML: the
 * framework never writes one, and accepting it here would mean "the file parses" said nothing about
 * "the file is the file we generated". Anything that is not a quoted string is a problem, not a
 * value.
 */
function quotedScalar(value: string, where: string): string {
  const trimmed = value.trim();

  try {
    const parsed: unknown = JSON.parse(trimmed);

    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Fall through to the refusal, which reports the text the file actually carries.
  }

  throw new FrontmatterProblem(
    `${where} is not a quoted scalar the way this framework writes them, but is: ${trimmed}`,
  );
}

/**
 * Parses an agent file's frontmatter into the permission rules it declares.
 *
 * This is a strict reader for one exact shape - the shape `renderFrontmatter` writes - rather than a
 * general YAML parser, and the strictness is the point. A YAML library would accept a document it
 * can interpret, and OpenCode's own reader accepts a document it can interpret *or* silently
 * discards one it cannot, which is how Task E's hand-broken config became an unrestricted agent.
 * Here every line is either a field this framework writes, a rule entry in the order it writes them,
 * a blank line, or a refusal. Duplicate keys are refused rather than resolved, because a duplicate
 * key means two different intentions are in the file and only one of them will be enforced.
 */
function parseAgentFrontmatter(contents: string): ParsedAgentFrontmatter {
  if (!contents.startsWith("---\n")) {
    throw new FrontmatterProblem(
      "the file does not open with a `---` frontmatter delimiter, so OpenCode would read no permissions from it at all",
    );
  }

  const close = contents.indexOf("\n---", 3);

  if (close === -1) {
    throw new FrontmatterProblem("the `---` frontmatter is never closed");
  }

  const afterDelimiter = contents.slice(close + 4);

  if (afterDelimiter !== "" && !afterDelimiter.startsWith("\n")) {
    throw new FrontmatterProblem("the closing `---` delimiter is not on a line of its own");
  }

  const lines = contents.slice(4, close).split("\n");
  const topLevelKeys = new Set<string>();
  const rules: OpenCodePermissionRule[] = [];
  let block: "permissions" | null = null;
  let sawPermissions = false;
  let open: { readonly keys: RuleKey[]; readonly values: Partial<Record<RuleKey, string>> } | null =
    null;

  const closeRule = (): void => {
    if (open === null) {
      return;
    }

    const missing = RULE_KEYS.filter((key) => open?.values[key] === undefined);

    if (missing.length > 0) {
      throw new FrontmatterProblem(
        `the rule at entry ${String(rules.length + 1)} is incomplete: it has no ${missing.join(", ")}`,
      );
    }

    const effect = open.values.effect;

    if (effect === undefined || !RULE_EFFECTS.includes(effect)) {
      throw new FrontmatterProblem(
        `the effect of rule ${String(rules.length + 1)} is "${effect ?? ""}", which is not one of allow, deny, ask`,
      );
    }

    rules.push({
      action: open.values.action ?? "",
      resource: open.values.resource ?? "",
      effect: effect as OpenCodePermissionRule["effect"],
    });
    open = null;
  };

  for (const [index, line] of lines.entries()) {
    const at = String(index + 1);

    if (line.trim() === "") {
      continue;
    }

    const sequence = SEQUENCE_KEY_LINE.exec(line);

    if (sequence !== null) {
      if (block !== "permissions") {
        throw new FrontmatterProblem(
          `line ${at} starts a rule entry outside the permissions list: ${line}`,
        );
      }

      closeRule();

      const key = sequence[1] ?? "";

      if (key !== RULE_KEYS[0]) {
        throw new FrontmatterProblem(
          `line ${at} starts a rule with "${key}"; a rule entry begins with "action": ${line}`,
        );
      }

      open = {
        keys: [RULE_KEYS[0]],
        values: {
          action: quotedScalar(sequence[2] ?? "", `the action of rule ${String(rules.length + 1)}`),
        },
      };
      continue;
    }

    const nested = NESTED_KEY_LINE.exec(line);

    if (nested !== null) {
      if (open === null) {
        throw new FrontmatterProblem(
          `line ${at} continues a rule that is not open, so which entry it belongs to is undecidable: ${line}`,
        );
      }

      const key = nested[1] ?? "";

      if (!RULE_KEYS.includes(key as RuleKey)) {
        throw new FrontmatterProblem(
          `line ${at} is not one of the keys a rule has (${RULE_KEYS.join(", ")}): ${line}`,
        );
      }

      if (open.keys.includes(key as RuleKey)) {
        throw new FrontmatterProblem(
          `line ${at} repeats the key "${key}" in a single rule, which YAML rejects as a duplicate key and a reader would otherwise resolve in either direction: ${line}`,
        );
      }

      const expected = RULE_KEYS[open.keys.length];

      if (key !== expected) {
        throw new FrontmatterProblem(
          `line ${at} writes "${key}" where "${expected ?? "no further key"}" belongs; this framework writes a rule as action, resource, effect, in that order: ${line}`,
        );
      }

      open.keys.push(key);
      open.values[key] = quotedScalar(
        nested[2] ?? "",
        `the ${key} of rule ${String(rules.length + 1)}`,
      );
      continue;
    }

    const top = TOP_LEVEL_KEY_LINE.exec(line);

    if (top !== null) {
      closeRule();

      const key = top[1];

      if (key === undefined) {
        throw new FrontmatterProblem(`line ${at} carries a key this reader cannot read: ${line}`);
      }

      if (topLevelKeys.has(key)) {
        throw new FrontmatterProblem(
          `line ${at} repeats the top-level key "${key}", which YAML rejects as a duplicate key: ${line}`,
        );
      }

      topLevelKeys.add(key);

      if (key === "permissions") {
        if ((top[2] ?? "").trim() !== "") {
          throw new FrontmatterProblem(
            `line ${at} gives "permissions" a value; this framework writes it as a bare key followed by the rule list: ${line}`,
          );
        }

        block = "permissions";
        sawPermissions = true;
        continue;
      }

      // Validated rather than collected: a `description:` or a `mode:` written any other way than
      // the emitter writes it means the file is not the file this framework generated, and that is a
      // refusal. What the comparison below needs from the frontmatter is the rules alone.
      quotedScalar(top[2] ?? "", `the "${key}" field on line ${at}`);
      block = null;
      continue;
    }

    throw new FrontmatterProblem(
      `line ${at} is neither a field nor a rule entry the way this framework writes them: ${line}`,
    );
  }

  closeRule();

  if (!sawPermissions) {
    throw new FrontmatterProblem(
      "the frontmatter declares no permissions list, so OpenCode would resolve this agent from its own policy instead of the framework's",
    );
  }

  if (rules.length === 0) {
    throw new FrontmatterProblem("the permissions list is empty");
  }

  return { rules };
}

function ruleKey(rule: OpenCodePermissionRule): string {
  return `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`;
}

function describeRule(rule: OpenCodePermissionRule): string {
  return `{ action: ${JSON.stringify(rule.action)}, resource: ${JSON.stringify(rule.resource)}, effect: ${JSON.stringify(rule.effect)} }`;
}

/**
 * Compares the rules read off disk with the rules this profile is meant to carry.
 *
 * The failures are reported separately because they are different mistakes: a missing or extra rule
 * is a different capability set, a repeated rule is two intentions in one file, and a pure reorder
 * is the same capabilities under a different last-match-wins outcome. The order message says so
 * explicitly, because "the same rules in a different order" reads as harmless to anyone who has not
 * internalized that in V2 the order *is* the policy.
 */
function assertRulesMatch(
  profile: OpenCodeProfile,
  path: string,
  actual: readonly OpenCodePermissionRule[],
): void {
  const intended = permissionRulesForProfile(profile);

  const actualKeys = new Set(actual.map(ruleKey));
  const intendedKeys = new Set(intended.map(ruleKey));
  const missing = intended.filter((rule) => !actualKeys.has(ruleKey(rule)));
  const unexpected = actual.filter((rule) => !intendedKeys.has(ruleKey(rule)));

  if (missing.length > 0 || unexpected.length > 0) {
    const parts: string[] = [];

    if (actual.length !== intended.length) {
      parts.push(
        `the file carries ${String(actual.length)} rules and the framework generates ${String(intended.length)}`,
      );
    }

    if (missing.length > 0) {
      parts.push(`a rule the file does not carry: ${missing.map(describeRule).join(", ")}`);
    }

    if (unexpected.length > 0) {
      parts.push(
        `a rule the file carries that is not generated: ${unexpected.map(describeRule).join(", ")}`,
      );
    }

    throw new FrontmatterProblem(`${parts.join("; ")} (compared against "${path}")`);
  }

  if (actual.length !== intended.length) {
    throw new FrontmatterProblem(
      `the file carries ${String(actual.length)} rules and the framework generates ${String(intended.length)}, and every intended rule is already present, so one of them is written twice (compared against "${path}")`,
    );
  }

  for (const [index, intendedRule] of intended.entries()) {
    const found = actual[index];

    if (found === undefined || ruleKey(found) !== ruleKey(intendedRule)) {
      throw new FrontmatterProblem(
        `the same rules are present in a different order at entry ${String(index)}, and order is the policy: it should be ${describeRule(intendedRule)} but is ${found === undefined ? "missing" : describeRule(found)}. Under last-match-wins that changes what is allowed.`,
      );
    }
  }
}

function refuseIntegrity(profile: OpenCodeProfile, path: string, detail: string): never {
  throw new OpenCodeAdapterError(
    "opencode_configuration_tampered",
    `Refusing to run the "${profile}" agent: the framework-written configuration at "${path}" could not be read back into the permission rules Agent Workflow Kit generates. ${detail} This check runs after the file is written and before OpenCode is started, because a frontmatter OpenCode cannot parse is read as absent, which leaves the base allow-everything policy in force - the failure Task E observed. Restore the file rather than bypassing this check; Agent Workflow Kit rewrites it on the next configuration write.`,
  );
}

/**
 * Re-reads the generated agent files in `directory` and refuses unless each one parses back into
 * exactly the rules its profile is meant to carry, in the same order.
 *
 * ## Why re-reading is a separate step
 *
 * Writing a file proves the bytes left this process; it does not prove the bytes on disk are the
 * ones OpenCode will read, and it says nothing about whether those bytes still *mean* what they
 * meant. Every failure this catches ends the same way in OpenCode: a frontmatter the loader cannot
 * parse is skipped, the agent falls back to the base `{"*","*","allow"}` policy, and a restricted
 * profile becomes an unrestricted one with no error and no log line. That is Task E's observation,
 * and it is why this reads the file back instead of trusting the write.
 *
 * What it refuses: a missing, symlinked, or unreadable file; malformed structure (a line that is
 * neither a field nor a rule entry, a rule in the wrong key order, an incomplete rule, an unquoted
 * scalar, an unclosed or absent `---`); duplicate keys, at the top level and inside a rule; a
 * missing rule or an extra one; and the same rules in a different order.
 *
 * It runs inside {@link createOpenCodeRuntimeConfig}, after every write and before the directory is
 * returned to the executor, which passes it to the transport as `OPENCODE_CONFIG_DIR` immediately
 * before `opencode run` is spawned. A stage that reaches the model therefore reaches it with a
 * ruleset that was proven to be the intended one, and a stage that cannot be proven refuses instead.
 *
 * This is not a substitute for the repository-side check in `configuration-integrity.ts`: that one
 * proves a repository has not redefined a profile, and this one proves the framework's own bytes
 * still say what the framework means.
 */
export async function assertOpenCodeRuntimeConfigIntegrity(directory: string): Promise<void> {
  const root = resolve(directory);

  for (const profile of OPENCODE_PROFILES) {
    const relativePath = runtimeAgentFileForProfile(profile);
    const path = join(root, relativePath);
    let contents: string;

    try {
      const stats = await lstat(path);

      if (stats.isSymbolicLink()) {
        refuseIntegrity(
          profile,
          path,
          "The path is a symbolic link, so what would be loaded is not the file this framework wrote.",
        );
      }

      if (!stats.isFile()) {
        refuseIntegrity(profile, path, "The path is not a regular file.");
      }

      contents = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof OpenCodeAdapterError) {
        throw error;
      }

      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";

      refuseIntegrity(
        profile,
        path,
        missing
          ? "The file does not exist, so the profile would resolve from some other definition or not at all."
          : "The file could not be read, so what OpenCode would load from it is unknown.",
      );
    }

    try {
      assertRulesMatch(profile, path, parseAgentFrontmatter(contents).rules);
    } catch (error) {
      if (error instanceof FrontmatterProblem) {
        refuseIntegrity(profile, path, error.message);
      }

      throw error;
    }
  }
}
