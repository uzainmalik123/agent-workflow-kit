import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StageRole } from "@agent-workflow-kit/orchestration";
import {
  agentFileName,
  OPENCODE_PLUGIN_DISABLE_ALL,
  OPENCODE_PLUGIN_TRUSTED_NAMESPACE,
  OPENCODE_PROJECT_CONFIG_PATH,
  renderAgentMarkdown,
  renderOpenCodeProjectConfig,
  HARD_RULES_HEADING,
} from "./agents.js";
import { OpenCodeAdapterError } from "./errors.js";
import { FRAMEWORK_HARD_RULES } from "./hard-rules.js";

/**
 * The OpenCode control plane, checked immediately before a run.
 *
 * A verification command is repository-defined code and repository-defined code writes files. The
 * project implementation fingerprint cannot cover this, because `.opencode/` is not implementation: it
 * is excluded from the measured tree precisely so that a generated agent file is not a change to the
 * code under review. That exclusion is correct for judging the implementation and wrong for judging
 * the control plane, so this check is separate and is not derived from it.
 *
 * What it is protecting is a two-step escalation. A command rewrites the generated file for the role
 * that is about to run - granting a shell, widening a permission, dropping a framework rule - and
 * exits 0. Deterministic verification records a pass, because the command did pass. The next stage
 * then loads the rewritten agent and runs with it. Nothing in the verification path looks at
 * `.opencode/`, so the second stage would consume the first stage's edit without a trace.
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
 *   rule, which has to be present verbatim; and the plugin-isolation and sharing directives in
 *   `opencode.json`. A repository edit cannot change any of these without being refused.
 * - **Project-owned, not verified.** The prose under the role's instructions - its description of
 *   purpose, house style, and domain vocabulary - and every other field of `opencode.json` such as the
 *   model and temperature settings. These are customization surfaces and they are not part of the
 *   security contract, so editing them does not stop a workflow.
 */
export interface ConfigurationIntegrityOptions {
  /** The repository the agent runs in. The only project this check reads. */
  readonly workingDirectory: string;
  /** The role about to run. Its agent file is the one that has to be intact. */
  readonly role: StageRole;
}

/** Why a file is not the configuration the framework requires. */
export type ConfigurationIntegrityReason =
  | "missing"
  | "unreadable"
  | "unsafe_path"
  | "frontmatter_changed"
  | "hard_rules_missing"
  | "project_config_changed";

export interface ConfigurationIntegrityProblem {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly reason: ConfigurationIntegrityReason;
  readonly detail: string;
}

function refuse(problem: ConfigurationIntegrityProblem, role: StageRole): never {
  throw new OpenCodeAdapterError(
    "opencode_configuration_tampered",
    `Refusing to run the "${role}" agent: the framework-controlled OpenCode configuration at "${problem.path}" does not match what Agent Workflow Kit generates (${problem.reason}). ${problem.detail} Agent Workflow Kit never overwrites or regenerates this file on its own, so a repository edit to a permission, a framework rule, or the plugin-isolation configuration stops the workflow here rather than reaching the model. Inspect the difference, and restore the generated file with writeOpenCodeProjectFiles(root, { force: true }) if the edit was not yours.`,
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
  role: StageRole,
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
        role,
      );
    }

    refuse(
      {
        path: relativePath,
        reason: "unreadable",
        detail: "The file could not be inspected.",
      },
      role,
    );
  }

  if (stats.isSymbolicLink()) {
    refuse(
      {
        path: relativePath,
        reason: "unsafe_path",
        detail: "The path is a symbolic link, so the contents are not the file this framework generated.",
      },
      role,
    );
  }

  if (!stats.isFile()) {
    refuse(
      {
        path: relativePath,
        reason: "unsafe_path",
        detail: "The path is not a regular file.",
      },
      role,
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
      role,
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

function renderFrontmatterFor(role: StageRole): string {
  const generated = renderAgentMarkdown(role);
  const frontmatter = frontmatterOf(generated);

  if (frontmatter === null) {
    throw new OpenCodeAdapterError(
      "opencode_configuration_tampered",
      `The generated agent file for the "${role}" role has no frontmatter, so there is nothing to verify the installed file against.`,
    );
  }

  return frontmatter;
}

/**
 * The generated file for a role, as a repository-relative path.
 *
 * Detection builds the name through the same function the writer uses, so a role whose filename were
 * ever renamed could not leave the check reading a path nothing generates.
 */
export function agentFilePathForRole(role: StageRole): string {
  return agentFileName(role);
}

/**
 * Refuses the stage when the OpenCode configuration a run depends on is not the configuration this
 * framework generates.
 *
 * The check is per invocation and covers the role about to run, which is the only moment its agent
 * file matters: every stage verifies its own file immediately before that stage starts, so a file
 * rewritten at any point is caught before the role that would read it runs.
 */
export async function assertOpenCodeConfigurationIntegrity(
  options: ConfigurationIntegrityOptions,
): Promise<void> {
  const { workingDirectory: root, role } = options;
  const agentPath = agentFilePathForRole(role);
  const agentContents = await readControlledFile(root, agentPath, role);
  const expectedFrontmatter = renderFrontmatterFor(role);
  const actualFrontmatter = frontmatterOf(agentContents);

  if (actualFrontmatter === null) {
    refuse(
      {
        path: agentPath,
        reason: "frontmatter_changed",
        detail: "The installed file has no YAML frontmatter, so OpenCode would apply its own defaults instead of the generated permissions.",
      },
      role,
    );
  }

  if (actualFrontmatter !== expectedFrontmatter) {
    refuse(
      {
        path: agentPath,
        reason: "frontmatter_changed",
        detail: `The \`permissions\` rule list or the agent \`mode\` differs from the generated one. The expected frontmatter is:\n${expectedFrontmatter}`,
      },
      role,
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
      role,
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
      role,
    );
  }

  await assertProjectConfigIsolation(root, role);
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
async function assertProjectConfigIsolation(root: string, role: StageRole): Promise<void> {
  const contents = await readControlledFile(root, OPENCODE_PROJECT_CONFIG_PATH, role);

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
      role,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "project_config_changed",
        detail: "The file is not a JSON object.",
      },
      role,
    );
  }

  const config = parsed as Record<string, unknown>;
  const expected = JSON.parse(renderOpenCodeProjectConfig()) as Record<string, unknown>;
  const expectedPlugins = expected["plugins"];
  const plugins = config["plugins"];

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
      role,
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
        role,
      );
    }
  }

  if (config["share"] !== expected["share"]) {
    refuse(
      {
        path: OPENCODE_PROJECT_CONFIG_PATH,
        reason: "project_config_changed",
        detail: `"share" must remain ${JSON.stringify(expected["share"])}. Every other field of this file is the repository's to set, including the model and temperature, and none of them decides what code runs.`,
      },
      role,
    );
  }
}

/** The two plugin directives, exported for the check's own tests and for documentation. */
export const OPENCODE_CONTROL_PLANE_DIRECTIVES: readonly string[] = [
  OPENCODE_PLUGIN_DISABLE_ALL,
  OPENCODE_PLUGIN_TRUSTED_NAMESPACE,
];
