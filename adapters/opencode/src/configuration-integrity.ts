import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  OPENCODE_AGENT_DIRECTORY,
  OPENCODE_PLUGIN_DISABLE_ALL,
  OPENCODE_PLUGIN_TRUSTED_NAMESPACE,
  OPENCODE_PROJECT_CONFIG_PATH,
  renderAgentMarkdown,
  renderOpenCodeProjectConfig,
  HARD_RULES_HEADING,
} from "./agents.js";
import { OpenCodeAdapterError } from "./errors.js";
import { FRAMEWORK_HARD_RULES } from "./hard-rules.js";
import type { StageRole } from "@agent-workflow-kit/orchestration";
import { agentFileNameForProfile, profileForRole, type OpenCodeProfile } from "./roles.js";

/**
 * The OpenCode control plane, checked immediately before a run.
 *
 * A verification command is repository-defined code and repository-defined code writes files. The
 * project implementation fingerprint cannot cover this, because `.opencode/` is not implementation: it
 * is excluded from the measured tree precisely so that a generated agent file is not a change to the
 * code under review. That exclusion is correct for judging the implementation and wrong for judging
 * the control plane, so this check is separate and is not derived from it.
 *
 * What it is protecting is a two-step escalation. A command rewrites the generated file for the
 * profile that is about to run - granting a shell, widening a permission, dropping a framework rule
 * - and exits 0. Deterministic verification records a pass, because the command did pass. The next
 * stage then loads the rewritten agent and runs with it. Nothing in the verification path looks at
 * `.opencode/`, so the second stage would consume the first stage's edit without a trace.
 *
 * Editing the generated file is the obvious way in and the one this module was written for. It is
 * not the only way, and the other ways share a property: OpenCode resolves an agent id and a project
 * configuration from more than one place, so a repository does not have to edit the file that is
 * checked in order to decide what the run loads. A second definition of the same agent id, a
 * `opencode.jsonc` next to the generated `opencode.json`, or an `agent` block in the root config are
 * all precedence, and precedence decided by the repository is precedence the framework does not
 * hold. So the check reads the *sources*, not only the file: it resolves the id the CLI will pass to
 * `--agent`, proves exactly one definition of that id exists and is the generated one, refuses the
 * alternate configuration files OpenCode would also load, and refuses the root config fields that
 * can redefine a profile, re-grant a tool, or add an instruction source.
 *
 * The response is to refuse, not to repair. Overwriting the file would destroy the evidence of what
 * happened, and regenerating it would make a tampered repository look untouched while the tampered
 * content is exactly what a reviewer needs to see. So the stage fails, the operator is told which file
 * and which part of the contract failed, and the decision to restore generated content stays theirs.
 *
 * ## What is framework-controlled
 *
 * The generated file mixes two things, and the check treats them differently:
 *
 * - **Framework-controlled, verified here.** The agent file's frontmatter, which is the `permissions`
 *   rule list and the `mode` that keeps these agents out of the subagent graph; every framework hard
 *   rule, which has to be present verbatim; the plugin-isolation and sharing directives in
 *   `opencode.json`; the uniqueness of the generated file as the only definition of the profile's
 *   agent id; the absence of any other repository-local project config; and the root config fields
 *   listed in {@link FRAMEWORK_SENSITIVE_CONFIG_FIELDS}. A repository edit cannot change any of these
 *   without being refused.
 * - **Project-owned, not verified.** `AGENTS.md`, unrelated custom agents under their own ids, and
 *   the remaining fields of `opencode.json` such as the model, provider, and display settings. These
 *   are customization surfaces and they are not part of the security contract, so editing them does
 *   not stop a workflow.
 *
 * Role prose is no longer project-owned in any sense: it is not in the generated files at all. One
 * profile file serves every role that shares its capabilities, so per-role instructions are rendered
 * into the stage prompt instead, and there is no agent file whose prose a repository could edit.
 */
export type ConfigurationIntegrityOptions = {
  /** The repository the agent runs in. The only project this check reads. */
  readonly workingDirectory: string;
} & (
  | {
      /** The physical profile about to run. Its agent file is the one that has to be intact. */
      readonly profile: OpenCodeProfile;
      readonly role?: never;
    }
  | {
      /**
       * @deprecated Pass `profile`. Several roles now share one profile, so the role only resolves
       * the profile whose file is checked.
       */
      readonly role: StageRole;
      readonly profile?: never;
    }
);

function profileOf(options: ConfigurationIntegrityOptions): OpenCodeProfile {
  // The `role` field is deprecated; reading it here is the whole point of accepting it.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return options.profile ?? profileForRole(options.role);
}

/** Why a file is not the configuration the framework requires. */
export type ConfigurationIntegrityReason =
  | "missing"
  | "unreadable"
  | "unsafe_path"
  | "frontmatter_changed"
  | "hard_rules_missing"
  | "project_config_changed"
  | "duplicate_agent_definition"
  | "alternate_project_config";

export interface ConfigurationIntegrityProblem {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly reason: ConfigurationIntegrityReason;
  readonly detail: string;
}

function refuse(problem: ConfigurationIntegrityProblem, profile: OpenCodeProfile): never {
  throw new OpenCodeAdapterError(
    "opencode_configuration_tampered",
    `Refusing to run the "${profile}" agent: the framework-controlled OpenCode configuration at "${problem.path}" does not match what Agent Workflow Kit generates (${problem.reason}). ${problem.detail} Agent Workflow Kit never overwrites or regenerates this file on its own, so a repository edit to a permission, a framework rule, a profile's agent definition, or the plugin-isolation configuration stops the workflow here rather than reaching the model. Inspect the difference, and restore the generated file with writeOpenCodeProjectFiles(root, { force: true }) if the edit was not yours.`,
  );
}

/**
 * Reads a repository file, treating a missing, symlinked, or unreadable path as a failure rather than
 * as an absent requirement.
 *
 * A missing file is a failure because its absence is the weaker configuration: OpenCode would fall back
 * to its own default agent or its own project config, neither of which carries these permissions. A
 * symlink is a failure because the file's contents would then be whatever the link points at, which is
 * not what the framework generated and is not what the check read.
 */
async function readControlledFile(
  root: string,
  relativePath: string,
  profile: OpenCodeProfile,
): Promise<string> {
  const absolute = join(root, relativePath);
  let stats;

  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      refuse(
        {
          path: relativePath,
          reason: "missing",
          detail: "The file does not exist.",
        },
        profile,
      );
    }

    refuse(
      {
        path: relativePath,
        reason: "unreadable",
        detail: "The file could not be inspected.",
      },
      profile,
    );
  }

  if (stats.isSymbolicLink()) {
    refuse(
      {
        path: relativePath,
        reason: "unsafe_path",
        detail: "The path is a symbolic link, so the contents are not the file this framework generated.",
      },
      profile,
    );
  }

  if (!stats.isFile()) {
    refuse(
      {
        path: relativePath,
        reason: "unsafe_path",
        detail: "The path is not a regular file.",
      },
      profile,
    );
  }

  try {
    return await readFile(absolute, "utf8");
  } catch {
    refuse(
      {
        path: relativePath,
        reason: "unreadable",
        detail: "The file exists but could not be read.",
      },
      profile,
    );
  }
}

/** The `---` delimited YAML block at the top of an agent file, without its delimiters. */
function frontmatterOf(contents: string): string | null {
  if (!contents.startsWith("---\n")) {
    return null;
  }

  const end = contents.indexOf("\n---", 3);

  return end === -1 ? null : contents.slice(4, end);
}

/** The text of one `##` section, so a rule can be located in the body rather than guessed at. */
function sectionOf(contents: string, heading: string): string | null {
  const start = contents.indexOf(`\n## ${heading}\n`);

  if (start === -1) {
    return null;
  }

  const bodyStart = start + `\n## ${heading}\n`.length;
  const next = contents.indexOf("\n## ", bodyStart);
  const body = next === -1 ? contents.slice(bodyStart) : contents.slice(bodyStart, next);

  return body;
}

function renderFrontmatterFor(profile: OpenCodeProfile): string {
  const generated = renderAgentMarkdown(profile);
  const frontmatter = frontmatterOf(generated);

  if (frontmatter === null) {
    throw new OpenCodeAdapterError(
      "opencode_configuration_tampered",
      `The generated agent file for the "${profile}" profile has no frontmatter, so there is nothing to verify the installed file against.`,
    );
  }

  return frontmatter;
}

/**
 * The generated file for a profile, as a repository-relative path.
 *
 * Detection builds the name through the same function the writer uses, so a profile whose filename were
 * ever renamed could not leave the check reading a path nothing generates.
 */
export function agentFilePathForProfile(profile: OpenCodeProfile): string {
  return agentFileNameForProfile(profile);
}

/**
 * @deprecated Use {@link agentFilePathForProfile} with {@link profileForRole}. A role no longer owns
 * a file, so this returns the path of the profile it runs as. Several roles resolve to the same
 * path.
 */
export function agentFilePathForRole(role: StageRole): string {
  return agentFilePathForProfile(profileForRole(role));
}

/** The extension every auto-discovered agent definition carries. */
const AGENT_DEFINITION_EXTENSION = ".md";

/**
 * The directories OpenCode auto-discovers agent definitions under, singular form first.
 *
 * Both spellings are live: `.opencode/agent/` and `.opencode/agents/` are separate discovery roots,
 * and the adapter generates into the plural one. That is the whole reason uniqueness has to be proved
 * rather than assumed - the generated file being intact says nothing about whether a *second* file
 * elsewhere resolves to the same agent id, and an id resolved from two places is exactly the case
 * where a repository chooses which definition the run gets.
 */
export const OPENCODE_AGENT_SOURCE_DIRECTORIES: readonly string[] = [
  ".opencode/agent",
  OPENCODE_AGENT_DIRECTORY,
];

/**
 * The project configuration files OpenCode would load from a repository, besides the generated one.
 *
 * The generated config is the root `opencode.json`. These are the other spellings and locations that
 * reach the same loader: the JSONC form beside it, and both forms inside the `.opencode/`
 * configuration directory. Which of them wins when more than one is present is OpenCode's own
 * precedence rule and is deliberately not guessed at here - if the answer could be "the repository's
 * file", then a repository that ships one of these is choosing the configuration the run uses, and
 * the only safe answer is to refuse. An empty or absent file is allowed, because an empty file
 * changes nothing, while a comment-only JSONC file is refused: being unable to prove it is inert is
 * not the same as proving it is.
 */
export const OPENCODE_ALTERNATE_PROJECT_CONFIG_PATHS: readonly string[] = [
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
];

/**
 * Root `opencode.json` fields the framework owns, and which therefore have to be absent.
 *
 * This is a short list on purpose. It is not a re-implementation of the OpenCode config schema, and
 * it is not an allowlist of everything the framework happens not to write: the generated config is
 * deliberately minimal, so an allowlist of it would refuse every legitimate project preference. The
 * list is the set of fields that can move the *permission or instruction boundary* a stage run
 * depends on, which is the same boundary the generated agent file states in its frontmatter and its
 * hard rules. Each entry is a field the published V2 config schema defines, and each is named with
 * what it would do to a run.
 *
 * Two fields are sensitive by value rather than by absence and are handled separately:
 * {@link OPENCODE_CONTROL_PLANE_DIRECTIVES} has to equal the generated `plugins` list in order, and
 * `share` has to stay disabled.
 *
 * Fields deliberately left project-owned: `model`, `small_model`, `provider`, `enabled_providers`,
 * and `disabled_providers`, which choose what talks to the model; `$schema`, `logLevel`, `layout`,
 * `username`, `snapshot`, `watcher`, `tool_output`, `compaction`, `attachment`, and `autoupdate`,
 * which are display and lifecycle settings. None of them can add an instruction, enable a tool, or
 * change what a profile is allowed to do.
 */
export const FRAMEWORK_SENSITIVE_CONFIG_FIELDS: Readonly<Record<string, string>> = {
  agent: "redefines a profile's prompt, permissions, mode, and tool list under its own id",
  agents: "is another spelling of the same agent override block",
  mode: "is the deprecated spelling of `agent`, which OpenCode still merges",
  default_agent: "chooses which agent a run starts as",
  permission: "overrides the permission rules the generated agent file carries",
  permissions: "is the other spelling of the same permission block",
  tools: "enables or disables tools globally",
  command: "declares a prompt template and an `agent` binding a run can invoke",
  instructions: "adds instruction files the generated agent never agreed to read",
  skills: "adds skill folders or URLs, which is a further instruction source",
  mcp: "starts MCP servers, which contribute tools to every agent",
  plugin: "is the plugin directive list OpenCode reads, so it can re-enable a repository plugin",
  references: "pulls configuration in from a git or local directory reference",
  reference: "is the deprecated spelling of `references`",
  experimental: "carries policy effects and `primary_tools`, which change tool availability",
  lsp: "starts language servers, which are processes a stage run does not authorize",
  autoshare: "publishes new sessions, the deprecated spelling of `share`",
};

const MAX_AGENT_SCAN_DEPTH = 8;

/**
 * The agent id OpenCode resolves from a definition file's path, or null when the path is not one.
 *
 * The id is the path relative to its agent directory with the `.md` extension removed, so
 * `.opencode/agents/verifier.md` is `verifier` and `.opencode/agent/team/reviewer.md` is
 * `team/reviewer`. That is why a check keyed on filenames is not enough: a repository that knows
 * the id only has to nest a file to reach it, and a nested id is a different string from a nested
 * filename.
 *
 * Returns null rather than a guessed id for anything that is not a plain `.md` file directly inside
 * one of the two source directories, so a path that cannot become an id can never satisfy the
 * uniqueness check.
 */
export function openCodeAgentIdForPath(relativePath: string): string | null {
  const normalized = relativePath.split("\\").join("/");

  for (const directory of OPENCODE_AGENT_SOURCE_DIRECTORIES) {
    if (!normalized.startsWith(`${directory}/`)) {
      continue;
    }

    const nested = normalized.slice(directory.length + 1);
    const segments = nested.split("/");
    const escapes = segments.some((segment) => segment === "" || segment === "." || segment === "..");

    if (escapes || !nested.endsWith(AGENT_DEFINITION_EXTENSION) || nested === AGENT_DEFINITION_EXTENSION) {
      return null;
    }

    return nested.slice(0, -AGENT_DEFINITION_EXTENSION.length);
  }

  return null;
}

interface AgentDefinitionScan {
  /** Repository-relative POSIX paths of the `.md` files found, in traversal order. */
  readonly files: readonly string[];
  /** True when a directory was too deep to descend, so the scan is known to be incomplete. */
  readonly incomplete: boolean;
}

/**
 * Every `.md` file OpenCode could load as an agent definition from one source directory.
 *
 * The walk refuses rather than tolerates the two ways a scan of a repository directory can lie about
 * what OpenCode will load. A symbolic link anywhere in the tree is refused, because a link is how a
 * definition arrives from outside the repository and the check cannot then say what the run reads. A
 * directory that cannot be listed is refused for the same reason a missing file is refused: an
 * unreadable directory is not the same as a directory with no definitions in it.
 *
 * Depth is bounded. A tree deeper than the bound is not silently truncated - the result is reported
 * as incomplete and the caller refuses, because an incomplete scan cannot prove uniqueness.
 */
async function scanAgentSourceDirectory(
  root: string,
  directory: string,
  profile: OpenCodeProfile,
  depth = 0,
): Promise<AgentDefinitionScan> {
  const absolute = join(root, directory);
  let stats;

  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Absent is normal for the singular spelling: the framework only generates the plural one.
      return { files: [], incomplete: false };
    }

    refuse(
      {
        path: directory,
        reason: "unreadable",
        detail: "The agent source directory could not be inspected, so the set of definitions OpenCode would load is unknown.",
      },
      profile,
    );
  }

  if (stats.isSymbolicLink()) {
    refuse(
      {
        path: directory,
        reason: "unsafe_path",
        detail: "The agent source directory is a symbolic link, so the definitions OpenCode would load are not the ones this check can account for.",
      },
      profile,
    );
  }

  if (!stats.isDirectory()) {
    refuse(
      {
        path: directory,
        reason: "unsafe_path",
        detail: "The agent source directory is not a directory.",
      },
      profile,
    );
  }

  let entries;

  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    refuse(
      {
        path: directory,
        reason: "unreadable",
        detail: "The agent source directory could not be listed, so the set of definitions OpenCode would load is unknown.",
      },
      profile,
    );
  }

  const files: string[] = [];
  let incomplete = false;

  for (const entry of entries) {
    const relativePath = `${directory}/${entry.name}`;

    if (entry.isSymbolicLink()) {
      refuse(
        {
          path: relativePath,
          reason: "unsafe_path",
          detail: "A symbolic link in an agent source directory can supply a definition from outside the repository, so which definition OpenCode resolves this id to is not decided by the repository's own files.",
        },
        profile,
      );
    }

    if (entry.isDirectory()) {
      if (depth >= MAX_AGENT_SCAN_DEPTH) {
        incomplete = true;
        continue;
      }

      const nested = await scanAgentSourceDirectory(
        root,
        relativePath,
        profile,
        depth + 1,
      );

      files.push(...nested.files);
      incomplete = incomplete || nested.incomplete;
      continue;
    }

    if (entry.name.endsWith(AGENT_DEFINITION_EXTENSION)) {
      files.push(relativePath);
    }
  }

  return { files, incomplete };
}

/**
 * Proves the generated file is the only definition of the profile's agent id.
 *
 * The CLI starts the run with `--agent <id>`, so `id` is what OpenCode resolves and every file that
 * maps to it is a candidate for the run. The generated file passing its own frontmatter check says
 * nothing about that set: a repository can define the same id in the other source directory, or nest
 * a file whose relative path is the same id. Both are found by walking every definition the loader
 * would see and comparing resolved ids, not filenames.
 *
 * Comparison is against a sorted list rather than a traversal order, so the refusal names the same
 * files every time regardless of the order the filesystem happened to return.
 */
async function assertUniqueAgentDefinition(root: string, profile: OpenCodeProfile): Promise<void> {
  const expectedPath = agentFilePathForProfile(profile);
  const expectedId = openCodeAgentIdForPath(expectedPath);

  if (expectedId === null) {
    throw new OpenCodeAdapterError(
      "opencode_configuration_tampered",
      `The generated agent file for the "${profile}" profile is "${expectedPath}", which resolves to no OpenCode agent id, so there is no id to prove unique.`,
    );
  }

  const files: string[] = [];
  let incomplete = false;

  for (const directory of OPENCODE_AGENT_SOURCE_DIRECTORIES) {
    const scan = await scanAgentSourceDirectory(root, directory, profile);

    files.push(...scan.files);
    incomplete = incomplete || scan.incomplete;
  }

  if (incomplete) {
    refuse(
      {
        path: expectedPath,
        reason: "duplicate_agent_definition",
        detail: `The agent source tree is nested deeper than ${String(MAX_AGENT_SCAN_DEPTH)} directories, so this check cannot prove that "${expectedId}" has exactly one definition.`,
      },
      profile,
    );
  }

  const definitions = files
    .filter((file) => openCodeAgentIdForPath(file) === expectedId)
    .sort((left, right) => left.localeCompare(right));

  if (definitions.length === 1 && definitions[0] === expectedPath) {
    return;
  }

  const found =
    definitions.length === 0
      ? "no definition at all"
      : `${String(definitions.length)} definitions: ${definitions.map((file) => `"${file}"`).join(", ")}`;

  refuse(
    {
      path: expectedPath,
      reason: "duplicate_agent_definition",
      detail: `The profile resolves to the OpenCode agent id "${expectedId}", and this repository defines that id as ${found}. Exactly one definition has to exist and it has to be the generated file, because which definition a duplicated id resolves to is OpenCode's own precedence rule and is not something the repository may decide.`,
    },
    profile,
  );
}

/**
 * Refuses a repository definition that would resolve to a framework profile's agent id.
 *
 * The profiles now live in the framework-owned runtime directory rather than in the repository, but
 * that changes where the framework's definition is, not what OpenCode resolves. A repository that
 * defines `agentflow-read` in `.opencode/agent/` still produces an agent with that id, and the
 * framework passes exactly that id to `--agent`. Which definition wins is OpenCode's own precedence
 * rule, and it is not one this framework may leave to a repository: a repository that won the id
 * would be deciding the permissions its own stage runs under.
 *
 * So the requirement is the same one {@link assertUniqueAgentDefinition} has always enforced -
 * exactly one definition of a framework profile's id, and it is the framework's - restated for a
 * definition that does not have to sit in the project. This is the check that keeps the move out of
 * the repository from becoming a loss of the guarantee the move was meant to keep.
 *
 * Unlike {@link assertOpenCodeConfigurationIntegrity} it requires nothing of the repository: a
 * project with no `.opencode/` directory at all passes, which is the normal case now.
 */
export async function assertNoProjectProfileShadow(root: string, profile: OpenCodeProfile): Promise<void> {
  const expectedId = profile;
  const files: string[] = [];
  let incomplete = false;

  for (const directory of OPENCODE_AGENT_SOURCE_DIRECTORIES) {
    const scan = await scanAgentSourceDirectory(resolve(root), directory, profile);

    files.push(...scan.files);
    incomplete = incomplete || scan.incomplete;
  }

  if (incomplete) {
    throw new OpenCodeAdapterError(
      "opencode_configuration_tampered",
      `Refusing to run the "${profile}" agent: the repository's agent source tree is nested deeper than ${String(MAX_AGENT_SCAN_DEPTH)} directories, so this check cannot prove that the OpenCode agent id "${expectedId}" is defined only by Agent Workflow Kit.`,
    );
  }

  const conflicts = files
    .filter((file) => openCodeAgentIdForPath(file) === expectedId)
    .sort((left, right) => left.localeCompare(right));

  if (conflicts.length === 0) {
    return;
  }

  // A repository that already carries this framework's generated profile - an installation from
  // before the configuration moved out of the repository - is not a shadow. Its bytes are the
  // framework's own, so it grants exactly the permissions the framework intends and cannot widen
  // anything. It is allowed, and it is allowed only because the contents are compared, so a file that
  // merely shares the name is still refused.
  const expected = renderAgentMarkdown(profile);
  const shadowing: string[] = [];

  for (const file of conflicts) {
    let contents: string;

    try {
      contents = await readFile(join(resolve(root), file), "utf8");
    } catch (error) {
      throw new OpenCodeAdapterError(
        "opencode_configuration_tampered",
        `Refusing to run the "${profile}" agent: this repository defines the OpenCode agent id "${expectedId}" in "${file}", but the file could not be read, so whether it matches Agent Workflow Kit's own definition cannot be proved.`,
        { cause: error },
      );
    }

    if (contents !== expected) {
      shadowing.push(file);
    }
  }

  if (shadowing.length === 0) {
    return;
  }

  throw new OpenCodeAdapterError(
    "opencode_configuration_tampered",
    `Refusing to run the "${profile}" agent: this repository defines the OpenCode agent id "${expectedId}" in ${shadowing.map((file) => `"${file}"`).join(", ")}, and those definitions differ from Agent Workflow Kit's own, which now lives in the framework runtime configuration. The run would be handed an id a repository also defines with different rules, and which definition OpenCode resolves it to is a precedence rule this framework does not leave to a repository. Remove the repository's definition of "${expectedId}", restore it to the framework-generated content, or rename it.`,
  );
}

/**
 * Refuses a repository configuration that could reach the stage run's permission or instruction
 * boundary, without requiring the repository to carry anything.
 *
 * Moving the framework's configuration out of the repository changed where the framework's own
 * settings live, not what a repository can still contribute. The target repository remains the
 * process working directory, so OpenCode still loads the repository's configuration on top of the
 * runtime configuration, and a repository can still set a global `permission`, `tools`, `plugin`,
 * `instructions`, or `command` there. Global permissions of exactly that kind are what would widen a
 * profile, so they are refused here - the same fields, and the same refusals, that
 * {@link assertOpenCodeConfigurationIsolation} refuses, minus the parts that only made sense while
 * the file was framework-generated.
 *
 * What is deliberately *not* required any more: the repository no longer has to carry an
 * `opencode.json`, the `plugins` list and `share` directive are not expected in it because the
 * framework states them in the runtime configuration, and a repository that keeps a legitimate
 * `model`, `provider`, or display preference still passes.
 *
 * So a repository with no `.opencode/` directory and no `opencode.json` passes, which is the normal
 * case now, and one that adds a global permission or a plugin is still refused.
 */
export async function assertNoRepositoryConfigBoundaryCrossing(
  root: string,
  profile: OpenCodeProfile,
): Promise<void> {
  // A second configuration file is still a repository choosing which configuration wins, and the
  // answer to that is OpenCode's precedence rule rather than a property of the file's contents.
  await assertNoAlternateProjectConfig(root, profile);

  const absolute = join(root, OPENCODE_PROJECT_CONFIG_PATH);
  let stats;

  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Absent is the normal case: the framework's own configuration is not written here any more.
      return;
    }

    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "unreadable",
        detail: "The project configuration could not be inspected, so what it contributes to the run is unknown.",
      },
      profile,
    );
  }

  if (stats.isSymbolicLink()) {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "unsafe_path",
        detail: "The project configuration is a symbolic link, so what it contributes to the run is not decided by the repository's own files.",
      },
      profile,
    );
  }

  const contents = await readFile(absolute, "utf8");

  if (contents.trim() === "") {
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "project_config_changed",
        detail: "The file is not valid JSON, so OpenCode would fall back to its own configuration and the repository's intent would be read as something other than what it wrote.",
      },
      profile,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "project_config_changed",
        detail: "The file is not a JSON object.",
      },
      profile,
    );
  }

  // The sensitive-field check is the whole point of this function: it is what stops a global
  // permission, tool, plugin, instruction source, or command from reaching a stage run. The
  // `plugins` list and `share` directives are not checked here, because they are the framework's to
  // state and it states them in the runtime configuration rather than asking the repository to.
  assertNoFrameworkSensitiveConfigFields(parsed as Record<string, unknown>, profile);
}

/**
 * Refuses the alternate project configuration files OpenCode would also load.
 *
 * Each path is absent or empty in a correctly generated repository, so refusing a non-empty one
 * costs a project nothing and closes the merge-precedence question without answering it.
 */
async function assertNoAlternateProjectConfig(root: string, profile: OpenCodeProfile): Promise<void> {
  for (const relativePath of OPENCODE_ALTERNATE_PROJECT_CONFIG_PATHS) {
    const absolute = join(root, relativePath);
    let stats;

    try {
      stats = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      refuse(
        {
          path: relativePath,
          reason: "alternate_project_config",
          detail: "The file could not be inspected, so whether it is one OpenCode would load is unknown.",
        },
        profile,
      );
    }

    if (stats.isSymbolicLink() || !stats.isFile()) {
      refuse(
        {
          path: relativePath,
          reason: "unsafe_path",
          detail: "The path is not a regular file, so what OpenCode would load from it is not what this check can account for.",
        },
        profile,
      );
    }

    let contents: string;

    try {
      contents = await readFile(absolute, "utf8");
    } catch {
      refuse(
        {
          path: relativePath,
          reason: "alternate_project_config",
          detail: "The file exists but could not be read, so whether it changes the configuration OpenCode loads is unknown.",
        },
        profile,
      );
    }

    if (contents.trim().length > 0) {
      refuse(
        {
          path: relativePath,
          reason: "alternate_project_config",
          detail: `The generated project configuration is "${OPENCODE_PROJECT_CONFIG_PATH}", and OpenCode also loads this file. Which one wins when both are present is OpenCode's own merge precedence, so a second project config in a repository means the repository is choosing the configuration a stage runs under. Delete or empty the file to run; everything a project needs belongs in "${OPENCODE_PROJECT_CONFIG_PATH}".`,
        },
        profile,
      );
    }
  }
}

/**
 * Refuses the root config fields that can move a stage run's permission or instruction boundary.
 *
 * Reading these out of the parsed config rather than comparing the file means a project keeps every
 * setting that cannot do that, which is most of them: model, provider, and display preferences stay
 * editable without a workflow noticing.
 */
function assertNoFrameworkSensitiveConfigFields(
  config: Record<string, unknown>,
  profile: OpenCodeProfile,
): void {
  const found = Object.keys(config)
    .filter((field) => Object.hasOwn(FRAMEWORK_SENSITIVE_CONFIG_FIELDS, field))
    .sort((left, right) => left.localeCompare(right));

  if (found.length === 0) {
    return;
  }

  const explained = found
    .map((field) => `"${field}" (${FRAMEWORK_SENSITIVE_CONFIG_FIELDS[field] ?? "framework-controlled"})`)
    .join(", ");

  refuse(
    {
      path: OPENCODE_PROJECT_CONFIG_PATH,
      reason: "project_config_changed",
      detail: `The framework-owned field(s) ${explained} must be absent, because each of them can redefine a profile, re-grant a tool, or add an instruction source behind the generated agent file. Every other field of this file, including the model and provider settings, stays the repository's to set.`,
    },
    profile,
  );
}

/**
 * Refuses the stage when the OpenCode configuration a run depends on is not the configuration this
 * framework generates.
 *
 * The check is per invocation and covers the profile about to run, which is the only moment its
 * agent file matters: every stage verifies its own file immediately before that stage starts, so a
 * file rewritten at any point is caught before the run that would read it starts.
 *
 * The order is deliberate. The generated file is read first, so a plain edit to it is reported as
 * what it is; the sources that could shadow or outrank it are checked next, so the id the CLI is
 * about to ask for is proved to be unambiguous before the project config is read; and the project
 * config is last, because it is the outermost source and its absence of overrides is what makes the
 * generated files the effective configuration.
 */
export async function assertOpenCodeConfigurationIntegrity(
  options: ConfigurationIntegrityOptions,
): Promise<void> {
  const root = options.workingDirectory;
  const profile = profileOf(options);
  const agentPath = agentFilePathForProfile(profile);
  await assertUniqueAgentDefinition(root, profile);
  const agentContents = await readControlledFile(root, agentPath, profile);
  const expectedFrontmatter = renderFrontmatterFor(profile);
  const actualFrontmatter = frontmatterOf(agentContents);

  if (actualFrontmatter === null) {
    refuse(
      {
        path: agentPath,
        reason: "frontmatter_changed",
        detail: "The installed file has no YAML frontmatter, so OpenCode would apply its own defaults instead of the generated permissions.",
      },
      profile,
    );
  }

  if (actualFrontmatter !== expectedFrontmatter) {
    refuse(
      {
        path: agentPath,
        reason: "frontmatter_changed",
        detail: `The \`permissions\` rule list or the agent \`mode\` differs from the generated one. The expected frontmatter is:\n${expectedFrontmatter}`,
      },
      profile,
    );
  }

  const rules = sectionOf(agentContents, HARD_RULES_HEADING);

  if (rules === null) {
    refuse(
      {
        path: agentPath,
        reason: "hard_rules_missing",
        detail: `The section "${HARD_RULES_HEADING}" is gone, so the file no longer states the framework rules the prompt also carries.`,
      },
      profile,
    );
  }

  const missing = FRAMEWORK_HARD_RULES.filter((rule) => !rules.includes(rule));

  if (missing.length > 0) {
    refuse(
      {
        path: agentPath,
        reason: "hard_rules_missing",
        detail: `${String(missing.length)} of the ${String(FRAMEWORK_HARD_RULES.length)} framework hard rules are no longer present verbatim, starting with "${missing[0] ?? ""}".`,
      },
      profile,
    );
  }

  await assertNoAlternateProjectConfig(root, profile);
  await assertProjectConfigIsolation(root, profile);
}

/**
 * The plugin-isolation and sharing directives in `opencode.json`.
 *
 * The generated file is intentionally minimal and leaves the model and temperature settings to the
 * repository, so a byte comparison would refuse a legitimate project preference. What is compared is
 * the part that decides what code runs: V2 applies `plugins` in order, so the two generated directives
 * have to be present, in that order, and with nothing after them that re-enables a plugin. `share` has
 * to stay disabled, because a session transcript is repository state that the framework did not agree
 * to publish.
 */
async function assertProjectConfigIsolation(root: string, profile: OpenCodeProfile): Promise<void> {
  const contents = await readControlledFile(root, OPENCODE_PROJECT_CONFIG_PATH, profile);

  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "project_config_changed",
        detail: "The file is not valid JSON, so OpenCode would fall back to its own configuration.",
      },
      profile,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "project_config_changed",
        detail: "The file is not a JSON object.",
      },
      profile,
    );
  }

  const config = parsed as Record<string, unknown>;
  const expected = JSON.parse(renderOpenCodeProjectConfig()) as Record<string, unknown>;
  const expectedPlugins = expected["plugins"];
  const plugins = config["plugins"];

  // Checked before the values it shares the file with, because a field that redefines the profile is a
  // different failure from a field that breaks the plugin directives, and naming the override is more
  // useful than naming the mismatch it happens to also cause.
  assertNoFrameworkSensitiveConfigFields(config, profile);

  if (!Array.isArray(expectedPlugins)) {
    throw new OpenCodeAdapterError(
      "opencode_configuration_tampered",
      "The generated OpenCode project configuration has no plugin directives, so there is nothing to verify the installed file against.",
    );
  }

  if (!Array.isArray(plugins) || plugins.length !== expectedPlugins.length) {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "project_config_changed",
        detail: `The "plugins" list must be exactly ${JSON.stringify(expectedPlugins)}. Anything else either leaves a repository plugin enabled or disables the OpenCode plugins a run cannot work without.`,
      },
      profile,
    );
  }

  for (const [index, directive] of expectedPlugins.entries()) {
    if (plugins[index] !== directive) {
      refuse(
        {
          path: OPENCODE_PROJECT_CONFIG_PATH,
          reason: "project_config_changed",
          detail: `The "plugins" list must be exactly ${JSON.stringify(expectedPlugins)}, because OpenCode applies the directives in order: entry ${String(index)} is ${JSON.stringify(plugins[index])} rather than ${JSON.stringify(directive)}.`,
        },
        profile,
      );
    }
  }

  if (config["share"] !== expected["share"]) {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "project_config_changed",
        detail: `"share" must remain ${JSON.stringify(expected["share"])}. The model, provider, and display fields of this file are the repository's to set; the framework-owned fields listed in the refusal above are not.`,
      },
      profile,
    );
  }
}

/** The two plugin directives, exported for the check's own tests and for documentation. */
export const OPENCODE_CONTROL_PLANE_DIRECTIVES: readonly string[] = [
  OPENCODE_PLUGIN_DISABLE_ALL,
  OPENCODE_PLUGIN_TRUSTED_NAMESPACE,
];
