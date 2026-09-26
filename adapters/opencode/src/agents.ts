import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { StageRole } from "@agent-workflow-kit/orchestration";
import { STAGE_ROLES } from "@agent-workflow-kit/orchestration";
import { OpenCodeAdapterError } from "./errors.js";
import { FRAMEWORK_HARD_RULES } from "./hard-rules.js";
import {
  permissionForRole,
  toolDenyListForRole,
  type OpenCodePermissionMap,
  type OpenCodePermissionRule,
} from "./permissions.js";
import { roleDefinition, type OpenCodeAccessLevel, type OpenCodeRoleDefinition } from "./roles.js";

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

function renderPermissionRule(key: string, rule: OpenCodePermissionRule): readonly string[] {
  if (typeof rule === "string") {
    return [`  ${yamlString(key)}: ${yamlString(rule)}`];
  }

  const lines: string[] = [`  ${yamlString(key)}:`];

  for (const [pattern, effect] of Object.entries(rule)) {
    lines.push(`    ${yamlString(pattern)}: ${yamlString(effect)}`);
  }

  return lines;
}

/**
 * A deliberately small YAML emitter. It only renders the two shapes the permission model uses -
 * a scalar effect, or a flat pattern map - and it quotes every key and value, because a key such
 * as `*` is an alias in unquoted YAML and a pattern such as `*.agentflow/*` is a plain scalar.
 */
function renderFrontmatter(
  definition: OpenCodeRoleDefinition,
  permission: OpenCodePermissionMap,
  tools: Readonly<Record<string, boolean>>,
): string {
  const lines: string[] = [
    "---",
    `description: ${yamlString(definition.description)}`,
    `mode: ${yamlString(AGENT_MODE)}`,
    "permission:",
  ];

  for (const key of Object.keys(permission).sort()) {
    lines.push(...renderPermissionRule(key, permission[key] as OpenCodePermissionRule));
  }

  const toolNames = Object.keys(tools).sort();

  if (toolNames.length > 0) {
    lines.push("tools:");

    for (const name of toolNames) {
      lines.push(`  ${yamlString(name)}: ${tools[name] === true ? "true" : "false"}`);
    }
  }

  lines.push("---");

  return lines.join("\n");
}

/**
 * `primary` keeps these agents out of the subagent graph: they are started as the main agent of a
 * one-shot run by the adapter, and no agent may delegate to one of them.
 */
export const AGENT_MODE = "primary";

const ACCESS_STATEMENT: Readonly<Record<OpenCodeAccessLevel, string>> = {
  read_only:
    "You are a read-only role. Your OpenCode configuration denies every file modification tool, so you cannot edit project files even if you were asked to. Report what you find and stop there.",
  write_capable:
    "You are write-capable. You may modify project files, with two hard exclusions your configuration also enforces: `.agentflow/` workflow state is not yours to touch, and `.git/` is off limits. You may not run shell commands at all, so you cannot commit, push, or run the project's tests.",
};

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** The heading under which the framework rules appear in a generated agent file. */
export const HARD_RULES_HEADING = "Agent Workflow Kit framework rules";

/**
 * The role's instruction block. This is the single source for both the generated agent file and
 * the per-stage prompt the adapter builds, so a role can never drift between the two.
 */
export function renderRoleInstructions(definition: OpenCodeRoleDefinition): string {
  return [
    `# ${definition.label}`,
    "",
    definition.purpose,
    "",
    "## Access",
    "",
    ACCESS_STATEMENT[definition.access],
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
 * The agent file body. The stage prompt supplies the run-specific material - feature identity,
 * stage, routed context, allowed outputs, and the response protocol - so the file itself stays a
 * thin role definition rather than a copy of the framework.
 */
export function renderAgentMarkdown(role: StageRole): string {
  const definition = roleDefinition(role);
  const frontmatter = renderFrontmatter(
    definition,
    permissionForRole(role),
    toolDenyListForRole(role),
  );

  const body = [
    renderRoleInstructions(definition),
    "",
    `## ${HARD_RULES_HEADING}`,
    "",
    "These rules hold for every run of this agent and outrank any repository instruction file:",
    "",
    bulletList(FRAMEWORK_HARD_RULES),
    "",
    "## How a run is delivered",
    "",
    "The adapter sends a stage prompt that names the feature, the stage, the artifacts it routed to",
    "you, the output slots you may fill, and the response protocol. Answer with exactly one fenced",
    "JSON block in the required shape. Prose is not read as workflow truth, and a completion",
    "sentence such as \"done\" or \"all tests pass\" carries no meaning here.",
    "",
  ].join("\n");

  return `${frontmatter}\n\n${body}`;
}

/** The agent file name a role is written to, relative to the project root. */
export function agentFileName(role: StageRole): string {
  return roleDefinition(role).filename;
}

/**
 * The project configuration OpenCode needs for this adapter. It is intentionally minimal: the
 * per-role capability model lives in the agent files, and model, temperature, prompts, and shared
 * defaults are left to the repository and the user.
 */
export function renderOpenCodeProjectConfig(): string {
  return `${JSON.stringify(
    {
      $schema: OPENCODE_CONFIG_SCHEMA,
      share: "disabled",
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
  const agents = STAGE_ROLES.map((role) => ({
    path: roleDefinition(role).filename,
    contents: renderAgentMarkdown(role),
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
