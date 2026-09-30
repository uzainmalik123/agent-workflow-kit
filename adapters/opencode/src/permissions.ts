import { PROJECT_CONFIG_FILENAME } from "@agent-workflow-kit/project";
import type { StageRole } from "@agent-workflow-kit/orchestration";
import { isWriteCapableProfile, profileForRole, rolesForProfile, type OpenCodeProfile } from "./roles.js";

/**
 * OpenCode V2 permissions.
 *
 * There are exactly two rulesets, one per physical agent: `agentflow-read` and `agentflow-write`.
 * A logical role does not have its own ruleset, because a profile's `permission:` block is
 * authoritative in OpenCode and cannot be widened by anything the repository declares. The role
 * chooses which of the two it runs as; it never adds to it.
 *
 * V2 configuration uses `permissions`: an ordered array of `{ action, resource, effect }` rules.
 * The V1 object syntax is not used anywhere in this adapter. In particular `permission:`, the
 * `bash` and `task` action names, and the `tools:` boolean block are all V1-only and are gone.
 *
 * Two V2 evaluation rules make the ordering below load-bearing:
 *
 * - the last matching rule wins, so a broad rule must come before the exception it is excepted by;
 * - an action that matches no rule at all resolves to `ask`, and a non-interactive `opencode run`
 *   auto-rejects a `permission.asked` request, which would break the stage run.
 *
 * Every rule set below therefore opens with a deny-everything rule and then re-allows only the exact
 * actions a role needs. That makes an `ask` outcome unreachable, and it also denies any action a
 * plugin might introduce, because nothing is allowed that was not asked for by name.
 */
export type OpenCodePermissionEffect = "allow" | "deny" | "ask";

export interface OpenCodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: OpenCodePermissionEffect;
}

/** An ordered V2 ruleset. Order is the policy. */
export type OpenCodePermissionRuleset = readonly OpenCodePermissionRule[];

function rule(action: string, resource: string, effect: OpenCodePermissionEffect): OpenCodePermissionRule {
  return { action, resource, effect };
}

/**
 * The first rule of every generated agent.
 *
 * V2 gives every agent a base policy of `{"*", "*", "allow"}` and then appends global and agent
 * rules, so this rule does not have to win against the base allow - it only has to come before this
 * agent's own allows. Its real job is the tail of the ruleset: anything not named below stays
 * denied, including MCP tools, Code Mode's `execute` dispatcher, and any action a future plugin
 * adds.
 */
export const DENY_ALL_RULE: OpenCodePermissionRule = rule("*", "*", "deny");

/**
 * Actions denied for every role, without exception.
 *
 * `shell: deny` is what makes "no agent receives Git commit or push authority" structural: with no
 * shell there is no `git commit` and no `git push`, and no project command execution either. Project
 * commands are not deferred, they are simply not the agent's to run: a deterministic framework process
 * executes them outside the session and hands the recorded result to the verifier. `subagent: deny` keeps roles
 * separate - a reviewer cannot delegate to an implementer, and no role can collapse the workflow
 * into one generalist agent or bypass the orchestrator. `skill: deny` holds the line until skill
 * integration is implemented, so no role can pull in instructions from outside the repository.
 *
 * `question`, `plan_enter`, `plan_exit`, and `execute` are denied for a mechanical reason: a stage
 * run has no human attached and no plan mode, so allowing them would only produce a request that
 * the non-interactive runner has to reject. The CLI denies the first three itself for non-interactive
 * runs; repeating them here keeps the agent file honest on its own.
 */
export const UNIVERSAL_DENIAL_ACTIONS: readonly string[] = [
  "shell",
  "subagent",
  "skill",
  "webfetch",
  "websearch",
  "external_directory",
  "question",
  "plan_enter",
  "plan_exit",
  "execute",
];

/** Actions every role may use, and the only ones. */
export const UNIVERSAL_ALLOWED_ACTIONS: readonly string[] = ["read", "glob", "grep"];

/**
 * Paths an agent may never reach, in either direction.
 *
 * `.agentflow/` holds the authoritative session, artifacts, event log, approval checkpoint, and fix
 * history; `.git/` holds version control. Neither belongs to an agent.
 *
 * V2 matches a resource with whole-value wildcards where `*` stands for any run of characters, `/`
 * included, so `*.agentflow/*` also covers `packages/app/.agentflow/x`. The bare `*.agentflow` and
 * `.agentflow` entries deny the directory path itself, and `*.agentflow.*` covers an exported
 * workflow document such as `docs/plan.agentflow.md`, which is workflow state even though it is not
 * inside a `.agentflow/` directory.
 *
 * A project's own `.gitignore` is deliberately not protected: `*.git/*` needs a directory segment
 * and `*.git` needs the name to end in `.git`, so `packages/app.gitignore` stays editable and only
 * real version-control state is denied.
 */
export const PROTECTED_PATH_PATTERNS: readonly string[] = [
  ".agentflow",
  ".agentflow/*",
  "*.agentflow",
  "*.agentflow/*",
  "*.agentflow.*",
  ".git",
  ".git/*",
  "*.git",
  "*.git/*",
];

/**
 * Paths an agent may read but never write, because they decide how the framework verifies the project.
 *
 * The project verification configuration is the only file a project uses to state a command the
 * deterministic detection did not find, and a command the framework will execute is exactly the thing an agent must
 * not get to choose. An implementer that could add an entry there could redefine what "verified" means
 * for the rest of the run, so the write is denied structurally rather than by instruction. The file is
 * still readable: a fixer repairing a failing check has a legitimate reason to know which command
 * produced it.
 *
 * The second pattern carries the `/` in the name for the same reason as the `.agentflow` entries: `*`
 * spans directory separators in V2, so this covers `packages/app/agent-workflow.config.json` while the
 * bare pattern still matches the file at the repository root.
 */
export const FRAMEWORK_OWNED_EDIT_PATTERNS: readonly string[] = [
  PROJECT_CONFIG_FILENAME,
  `*${PROJECT_CONFIG_FILENAME}`,
];

/**
 * Secret-bearing files are denied a read outright rather than left to OpenCode's base policy, which
 * asks about `.env`. A stage run has nobody to answer that question, and a denied read is a
 * deterministic, reportable outcome instead of a tool call the runner silently rejects.
 */
export const SECRET_PATH_PATTERNS: readonly string[] = ["*.env", "*.env.*"];

function denialRules(): readonly OpenCodePermissionRule[] {
  return UNIVERSAL_DENIAL_ACTIONS.map((action) => rule(action, "*", "deny"));
}

function allowedRules(): readonly OpenCodePermissionRule[] {
  return UNIVERSAL_ALLOWED_ACTIONS.map((action) => rule(action, "*", "allow"));
}

function protectedReadDenials(): readonly OpenCodePermissionRule[] {
  return [
    ...PROTECTED_PATH_PATTERNS.map((resource) => rule("read", resource, "deny")),
    ...SECRET_PATH_PATTERNS.map((resource) => rule("read", resource, "deny")),
  ];
}

function protectedEditDenials(): readonly OpenCodePermissionRule[] {
  return [...PROTECTED_PATH_PATTERNS, ...FRAMEWORK_OWNED_EDIT_PATTERNS].map((resource) =>
    rule("edit", resource, "deny"),
  );
}

/**
 * The `agentflow-read` ruleset: deny everything, then allow the three discovery actions and nothing
 * else.
 *
 * `edit` is named explicitly even though the leading deny already covers it. The explicit rule is
 * what an auditor reads first, and it is what OpenCode's own `debug` output shows as the deciding
 * rule for the edit, write, and patch tools.
 */
export const READ_ONLY_PERMISSION_RULES: OpenCodePermissionRuleset = [
  DENY_ALL_RULE,
  rule("edit", "*", "deny"),
  ...denialRules(),
  ...allowedRules(),
  ...protectedReadDenials(),
];

/**
 * The `agentflow-write` ruleset: the same surface, plus an `edit` allowance that is immediately
 * narrowed to deny the workflow and Git paths. The `edit *` allow comes after the universal denials
 * and before the protected-path denials, which is the order the last-match-wins rule requires.
 */
export const WRITE_CAPABLE_PERMISSION_RULES: OpenCodePermissionRuleset = [
  DENY_ALL_RULE,
  ...denialRules(),
  ...allowedRules(),
  rule("edit", "*", "allow"),
  ...protectedEditDenials(),
  ...protectedReadDenials(),
];

/** The ruleset a physical agent carries. There are two, and a profile names one of them. */
export function permissionRulesForProfile(profile: OpenCodeProfile): OpenCodePermissionRuleset {
  return isWriteCapableProfile(profile) ? WRITE_CAPABLE_PERMISSION_RULES : READ_ONLY_PERMISSION_RULES;
}

/**
 * A faithful port of OpenCode's `Wildcard.match`, so a decision made here is the decision the CLI
 * makes there.
 *
 * The input is normalized to forward slashes, `*` becomes any run of characters and `?` becomes
 * exactly one character, and a pattern that ends in a space and a star also matches the bare value
 * without the arguments - which is how `git status *` covers both `git status` and
 * `git status --short`. Matching is anchored to the whole value and case-insensitive only on
 * Windows, as in the CLI.
 */
export function matchesResourcePattern(pattern: string, resource: string): boolean {
  const normalized = resource.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*")
    .replace(/\?/gu, ".");

  if (escaped.endsWith(" .*")) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}

/**
 * The structural read of a ruleset: "what happens to this resource for this action" under V2
 * last-match-wins evaluation. It never guesses which of two rules applies, and it returns `ask` only
 * when genuinely nothing matched, exactly as OpenCode does.
 */
export function effectFor(
  rules: OpenCodePermissionRuleset,
  action: string,
  resource: string,
): OpenCodePermissionEffect {
  let effect: OpenCodePermissionEffect | undefined;

  for (const candidate of rules) {
    if (matchesResourcePattern(candidate.action, action) && matchesResourcePattern(candidate.resource, resource)) {
      effect = candidate.effect;
    }
  }

  return effect ?? "ask";
}

/** True when a multi-resource operation such as a patch spanning two paths is blocked. */
export function operationEffect(
  rules: OpenCodePermissionRuleset,
  action: string,
  resources: readonly string[],
): OpenCodePermissionEffect {
  const effects = resources.map((resource) => effectFor(rules, action, resource));

  if (effects.includes("deny")) {
    return "deny";
  }

  return effects.includes("ask") ? "ask" : "allow";
}

export function isReadOnlyProfile(profile: OpenCodeProfile): boolean {
  return !isWriteCapableProfile(profile);
}

/**
 * @deprecated Use {@link permissionRulesForProfile} with {@link profileForRole}. A role no longer
 * owns a ruleset, so this resolves the role's shared profile and returns that profile's rules.
 */
export function permissionRulesForRole(role: StageRole): OpenCodePermissionRuleset {
  return permissionRulesForProfile(profileForRole(role));
}

/**
 * @deprecated Use {@link isReadOnlyProfile} with {@link profileForRole}. Several roles now share
 * one read-only profile, so this reports the access of the role's profile.
 */
export function isReadOnlyRole(role: StageRole): boolean {
  return isReadOnlyProfile(profileForRole(role));
}

/**
 * @deprecated Use {@link rolesForProfile} with `OPENCODE_PROFILES`. This lists the roles behind the
 * read-only profile, in the orchestrator's own role order.
 */
export function readOnlyRoles(): readonly StageRole[] {
  return rolesForProfile("agentflow-read");
}

/**
 * @deprecated Use {@link rolesForProfile} with `OPENCODE_PROFILES`. This lists the roles behind the
 * write profile, in the orchestrator's own role order.
 */
export function writeCapableRoles(): readonly StageRole[] {
  return rolesForProfile("agentflow-write");
}
