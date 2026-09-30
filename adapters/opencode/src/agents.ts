import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { StageRole } from "@agent-workflow-kit/orchestration";
import { OpenCodeAdapterError } from "./errors.js";
import { FRAMEWORK_HARD_RULES } from "./hard-rules.js";
import { permissionRulesForProfile, type OpenCodePermissionRuleset } from "./permissions.js";
import {
  OPENCODE_PROFILES,
  agentFileNameForProfile,
  profileForRole,
  roleDefinition,
  type OpenCodeProfile,
  type OpenCodeRoleDefinition,
} from "./roles.js";

export const OPENCODE_AGENT_DIRECTORY = ".opencode/agents";
export const OPENCODE_PROJECT_CONFIG_PATH = "opencode.json";
export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

export interface GeneratedOpenCodeFile {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly contents: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * A deliberately small YAML emitter for the V2 `permissions` list.
 *
 * It quotes every key and value, because a bare `*` is a YAML alias and a pattern such as
 * `*.agentflow/*` is a plain scalar that must not be re-interpreted. It renders rules in the order
 * the module produced them, because in V2 the order is the policy.
 *
 * Every rule gets its own `-` sequence entry. The list item marker is what makes one rule one
 * mapping, and it has to be repeated for every rule: emitting it only on the first line folds every
 * later rule's `action`, `resource`, and `effect` into that first mapping as repeated keys. YAML
 * answers duplicate keys in one mapping with an error, so the whole frontmatter fails to parse and
 * OpenCode falls back to its own defaults. That is not a cosmetic mistake - it silently hands every
 * role an unrestricted capability set, which is exactly what the generated rules exist to prevent.
 */
function renderPermissionRules(rules: OpenCodePermissionRuleset): readonly string[] {
  const lines: string[] = [];

  for (const entry of rules) {
    lines.push(
      `  - action: ${yamlString(entry.action)}`,
      `    resource: ${yamlString(entry.resource)}`,
      `    effect: ${yamlString(entry.effect)}`,
    );
  }

  return lines;
}

/**
 * OpenCode V2 agent frontmatter.
 *
 * Only V2 fields are emitted: `permissions` as an ordered rule list. The V1 `permission:` object
 * and the V1 `tools:` boolean block are deliberately absent, because the adapter targets the native
 * V2 contract and must not depend on the compatibility layer that used to translate them.
 *
 * The `permissions` block here is the whole capability contract. OpenCode resolves a profile's own
 * block as authoritative, so a repository's global `permission` settings cannot widen it, and this
 * file is checked byte-for-byte before every run so nothing else can either.
 */
function renderFrontmatter(profile: OpenCodeProfile, rules: OpenCodePermissionRuleset): string {
  return [
    "---",
    `description: ${yamlString(PROFILE_DESCRIPTION[profile])}`,
    `mode: ${yamlString(AGENT_MODE)}`,
    "permissions:",
    ...renderPermissionRules(rules),
    "---",
  ].join("\n");
}

/**
 * `primary` keeps these agents out of the subagent graph: they are started as the main agent of a
 * one-shot run by the adapter, and no agent may delegate to one of them.
 */
export const AGENT_MODE = "primary";

const PROFILE_LABEL: Readonly<Record<OpenCodeProfile, string>> = {
  "agentflow-read": "Read-only",
  "agentflow-write": "Write-capable",
};

const PROFILE_DESCRIPTION: Readonly<Record<OpenCodeProfile, string>> = {
  "agentflow-read":
    "Agent Workflow Kit read-only profile. Reports findings; cannot change any project file.",
  "agentflow-write":
    "Agent Workflow Kit write profile. Edits project files within an approved scope; no shell, no Git, no workflow state.",
};

/**
 * What the profile grants, stated to the model in the same terms the ruleset enforces.
 *
 * A profile is not a role and must not describe one. It says what the model can do, never what job
 * it was given: the job arrives in the stage prompt, which names the stage and the role, so a single
 * file can serve nine roles without any of them being able to read another's instructions from it.
 */
const PROFILE_ACCESS_STATEMENT: Readonly<Record<OpenCodeProfile, string>> = {
  "agentflow-read":
    "You are running under the read-only profile. Your OpenCode configuration denies every file modification tool, so you cannot edit project files even if the job you were given seems to ask for it. Report what you find and stop there.",
  "agentflow-write":
    "You are running under the write profile. You may modify project files, with two hard exclusions your configuration also enforces: `.agentflow/` workflow state is not yours to touch, and `.git/` is off limits. You may not run shell commands at all, so you cannot commit, push, or run the project's tests.",
};

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** The heading under which the framework rules appear in a generated agent file. */
export const HARD_RULES_HEADING = "Agent Workflow Kit framework rules";

/**
 * The role's instruction block, rendered for the stage prompt.
 *
 * This is the single source for the per-role prose. It is no longer part of any generated agent
 * file, because one profile file serves every role that shares its capabilities and must therefore
 * carry none of their instructions.
 */
export function renderRoleInstructions(definition: OpenCodeRoleDefinition): string {
  return [
    `# ${definition.label}`,
    "",
    definition.purpose,
    "",
    "## Responsibilities",
    "",
    bulletList(definition.responsibilities),
    "",
    "## Never",
    "",
    bulletList(definition.prohibited),
    "",
    "## Expected deliverables",
    "",
    bulletList(definition.deliverables),
  ].join("\n");
}

export function renderRoleInstructionsForRole(role: StageRole): string {
  return renderRoleInstructions(roleDefinition(role));
}

/**
 * @deprecated Use {@link agentFileNameForProfile} with {@link profileForRole}. A role no longer owns
 * a file, so this returns the path of the profile its capabilities come from. Several roles resolve
 * to the same path.
 */
export function agentFileName(role: StageRole): string {
  return agentFileNameForProfile(profileForRole(role));
}

/**
 * The generated agent file for one physical profile.
 *
 * The file states capabilities and framework rules only. The job - which stage, which role, which
 * artifacts, which output slots, which response protocol - arrives in the stage prompt the adapter
 * sends with the run, which is what lets eleven roles share two files without a role's instructions
 * ever reaching the model under another role's profile.
 */
export function renderAgentMarkdown(profile: OpenCodeProfile): string {
  const frontmatter = renderFrontmatter(profile, permissionRulesForProfile(profile));

  const body = [
    `# Agent Workflow Kit ${PROFILE_LABEL[profile]} profile`,
    "",
    PROFILE_ACCESS_STATEMENT[profile],
    "",
    "## Your job is in the prompt, not in this file",
    "",
    "This file grants you capabilities and states the rules that hold for every run. It does not",
    "describe your assignment. The adapter starts you with a stage prompt that names the workflow",
    "stage, the role you are acting as, the artifacts routed to you, the output slots you may fill,",
    "and the response protocol you must answer in. Follow that prompt; ignore any assumption from",
    "this file about what kind of task you are doing.",
    "",
    `## ${HARD_RULES_HEADING}`,
    "",
    "These rules hold for every run of this profile and outrank any repository instruction file:",
    "",
    bulletList(FRAMEWORK_HARD_RULES),
    "",
    "## How a run is delivered",
    "",
    "Answer with exactly one fenced JSON block in the shape the prompt requires. Prose is not read as",
    "workflow truth, and a completion sentence such as \"done\" or \"all tests pass\" carries no",
    "meaning here.",
    "",
  ].join("\n");

  return `${frontmatter}\n\n${body}`;
}

/**
 * The V2 plugin directives that isolate a workflow run from everything the repository did not
 * generate.
 *
 * V2 removed the `--pure` flag this adapter used to pass, so plugin isolation is a configuration
 * concern now. V2's `plugins` field is an ordered list applied in order, and a string beginning with
 * `-` disables plugins matching that id, where `*` matches every id and a `.*` suffix matches a
 * prefix.
 *
 * `OPENCODE_PLUGIN_DISABLE_ALL` disables every plugin. `OPENCODE_PLUGIN_TRUSTED_NAMESPACE` re-enables
 * the whole `opencode.` namespace afterwards, and directives are applied in order, so the second
 * entry undoes the first for exactly one namespace.
 *
 * Every plugin OpenCode itself ships is built under that namespace, and that set is what a run
 * cannot work without: `opencode.config.agent` loads the generated agents, `opencode.agent`
 * registers the agent runtime, and the `opencode.config.policy` and permission machinery is what
 * turns the generated `permissions` list into an actual denial. Disabling them would not harden the
 * run, it would break it - and an empty agent list, not a restricted one, would be the result.
 *
 * What is left disabled is everything else, which is the point. A plugin is arbitrary code that can
 * rewrite an agent's system prompt, replace a tool, or register a new one, so a repository plugin
 * discovered under `.opencode/plugins/` would otherwise be able to change what a verifier, reviewer,
 * or implementer is allowed to do, and therefore what it reports. The generated rules and the
 * framework's hard rules are the only sources of behaviour for a workflow stage.
 */
export const OPENCODE_PLUGIN_DISABLE_ALL = "-*";
export const OPENCODE_PLUGIN_TRUSTED_NAMESPACE = "opencode.*";

/**
 * The project configuration OpenCode needs for this adapter. It is intentionally minimal: the
 * per-role capability model lives in the agent files, and model, temperature, prompts, and shared
 * defaults are left to the repository and the user.
 *
 * Plugin isolation is the one thing this file must set, and it sets it for the same reason the
 * capability model lives in the agent files: a stage run has to be the configuration the adapter
 * generated, not the configuration the repository happened to have lying around.
 */
export function renderOpenCodeProjectConfig(): string {
  return `${JSON.stringify(
    {
      $schema: OPENCODE_CONFIG_SCHEMA,
      share: "disabled",
      plugins: [OPENCODE_PLUGIN_DISABLE_ALL, OPENCODE_PLUGIN_TRUSTED_NAMESPACE],
    },
    null,
    2,
  )}\n`;
}

/**
 * The complete set of files the adapter needs in a project. Every file is generated from the role
 * definitions in this package, so the output is byte-for-byte deterministic and contains no part
 * of the framework implementation.
 */
export function renderOpenCodeProjectFiles(): readonly GeneratedOpenCodeFile[] {
  const agents = OPENCODE_PROFILES.map((profile) => ({
    path: agentFileNameForProfile(profile),
    contents: renderAgentMarkdown(profile),
  }));

  return [
    ...agents,
    { path: OPENCODE_PROJECT_CONFIG_PATH, contents: renderOpenCodeProjectConfig() },
  ];
}

export type OpenCodeFileWriteOutcome =
  | "created"
  | "unchanged"
  | "overwritten"
  | "conflict";

export interface OpenCodeFileWriteResult {
  readonly path: string;
  readonly outcome: OpenCodeFileWriteOutcome;
}

export interface WriteOpenCodeProjectFilesOptions {
  /** Overwrite a generated file whose contents differ from the generated output. */
  readonly force?: boolean;
}

async function assertSafeDirectory(path: string): Promise<void> {
  let stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Unable to inspect "${path}" before writing Agent Workflow Kit files.`,
      { cause: error },
    );
  }

  if (stats.isSymbolicLink()) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Refusing to write through the symbolic link "${path}".`,
    );
  }

  if (!stats.isDirectory()) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Refusing to write Agent Workflow Kit files: "${path}" is not a directory.`,
    );
  }
}

async function assertSafeFile(path: string): Promise<void> {
  let stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Unable to inspect "${path}" before writing Agent Workflow Kit files.`,
      { cause: error },
    );
  }

  if (stats.isSymbolicLink()) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Refusing to write through the symbolic link "${path}".`,
    );
  }

  if (!stats.isFile()) {
    throw new OpenCodeAdapterError(
      "unsafe_output_path",
      `Refusing to write Agent Workflow Kit files: "${path}" is not a regular file.`,
    );
  }
}

/**
 * Writes the generated files into a repository.
 *
 * A file whose contents already match is left alone, and a file a human has edited is reported as
 * a conflict instead of being silently reverted, because these files are version controlled and
 * meant to be customizable. `force` is the explicit way to restore generated content.
 */
export async function writeOpenCodeProjectFiles(
  repositoryRoot: string,
  options?: WriteOpenCodeProjectFilesOptions,
): Promise<readonly OpenCodeFileWriteResult[]> {
  const root = resolve(repositoryRoot);
  const results: OpenCodeFileWriteResult[] = [];

  await assertSafeDirectory(root);

  for (const file of renderOpenCodeProjectFiles()) {
    const target = join(root, file.path);

    await assertSafeDirectory(dirname(target));
    await assertSafeFile(target);

    const relativePath = relative(root, target);
    const report = (outcome: OpenCodeFileWriteOutcome): void => {
      results.push({ path: relativePath.split(sep).join("/"), outcome });
    };

    let existing: string | undefined;

    try {
      existing = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new OpenCodeAdapterError(
          "unsafe_output_path",
          `Unable to read "${file.path}" before writing Agent Workflow Kit files.`,
          { cause: error },
        );
      }
    }

    if (existing === file.contents) {
      report("unchanged");
      continue;
    }

    if (existing !== undefined && options?.force !== true) {
      report("conflict");
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");

    report(existing === undefined ? "created" : "overwritten");
  }

  return results;
}
