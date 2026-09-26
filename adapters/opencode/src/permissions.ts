import type { StageRole } from "@agent-workflow-kit/orchestration";
import { STAGE_ROLES } from "@agent-workflow-kit/orchestration";
import { accessForRole } from "./roles.js";

export type OpenCodePermissionEffect = "allow" | "ask" | "deny";

/** OpenCode accepts either a single effect or a resource-pattern to effect map per permission. */
export type OpenCodePermissionRule = string | Readonly<Record<string, OpenCodePermissionEffect>>;

export type OpenCodePermissionMap = Readonly<Record<string, OpenCodePermissionRule>>;

/**
 * Paths an agent may never reach, in either direction. `.agentflow/` holds the authoritative
 * session, artifacts, event log, approval checkpoint, and fix history; `.git/` holds version
 * control. Neither belongs to an agent.
 *
 * OpenCode matches permission patterns with `*` for any run of characters, `/` included, and it
 * resolves the last matching rule. `*.agentflow/*` therefore also covers `packages/app/.agentflow/x`,
 * and it is listed after the `*` allow rule on purpose. `*.agentflow.*` covers an exported
 * workflow document such as `docs/plan.agentflow.md`, which is workflow state even though it is
 * not inside a `.agentflow/` directory.
 *
 * A project's own `.gitignore` is deliberately not protected: `*.git/*` needs a directory segment,
 * so `packages/app.gitignore` stays editable and only real version-control state is denied.
 */
export const PROTECTED_PATH_RULES: Readonly<Record<string, OpenCodePermissionEffect>> = {
  ".agentflow/*": "deny",
  "*.agentflow/*": "deny",
  "*.agentflow.*": "deny",
  ".git/*": "deny",
  "*.git/*": "deny",
};

function readRules(): Readonly<Record<string, OpenCodePermissionEffect>> {
  return { "*": "allow", ...PROTECTED_PATH_RULES };
}

/**
 * Denied for every role, without exception.
 *
 * `bash: deny` is what makes "no agent receives Git commit or push authority" structural: with no
 * shell there is no `git commit`, no `git push`, and no project command execution either, which is
 * consistent with command execution being deferred in this milestone. `task: deny` is what keeps
 * roles separate: a reviewer cannot delegate to an implementer, and no role can collapse the
 * workflow into one generalist agent.
 */
export const UNIVERSAL_DENIALS: Readonly<Record<string, OpenCodePermissionEffect>> = {
  bash: "deny",
  webfetch: "deny",
  websearch: "deny",
  task: "deny",
  external_directory: "deny",
};

export const READ_ONLY_PERMISSION: OpenCodePermissionMap = {
  ...UNIVERSAL_DENIALS,
  edit: { "*": "deny" },
  read: readRules(),
};

export const WRITE_CAPABLE_PERMISSION: OpenCodePermissionMap = {
  ...UNIVERSAL_DENIALS,
  edit: { "*": "allow", ...PROTECTED_PATH_RULES },
  read: readRules(),
};

export const TOOLS_DENIED_FOR_READ_ONLY_ROLES: Readonly<Record<string, boolean>> = {
  write: false,
  edit: false,
  patch: false,
  bash: false,
  webfetch: false,
  task: false,
};

export function permissionForRole(role: StageRole): OpenCodePermissionMap {
  return accessForRole(role) === "read_only" ? READ_ONLY_PERMISSION : WRITE_CAPABLE_PERMISSION;
}

export function toolDenyListForRole(role: StageRole): Readonly<Record<string, boolean>> {
  return accessForRole(role) === "read_only" ? TOOLS_DENIED_FOR_READ_ONLY_ROLES : {};
}

/**
 * A structural read of a permission map, used by the tests and by anyone auditing a generated
 * agent file. It answers "what happens to this resource for this role" using OpenCode's own
 * last-match-wins evaluation, so it never has to guess which of two rules applies.
 */
export function effectFor(
  permission: OpenCodePermissionMap,
  action: string,
  resource: string,
): OpenCodePermissionEffect {
  const rule = permission[action];

  if (rule === undefined) {
    return "allow";
  }

  if (typeof rule === "string") {
    return rule as OpenCodePermissionEffect;
  }

  let effect: OpenCodePermissionEffect = "allow";

  for (const [pattern, candidate] of Object.entries(rule)) {
    if (matchesResourcePattern(pattern, resource)) {
      effect = candidate;
    }
  }

  return effect;
}

function matchesResourcePattern(pattern: string, resource: string): boolean {
  const expression = pattern
    .split("*")
    .map((segment) => segment.split("?").map(escapeRegExp).join("[^/]"))
    .join(".*");

  return new RegExp(`^${expression}$`, "u").test(resource);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function isReadOnlyRole(role: StageRole): boolean {
  return accessForRole(role) === "read_only";
}

export function readOnlyRoles(): readonly StageRole[] {
  return STAGE_ROLES.filter((role) => accessForRole(role) === "read_only");
}

export function writeCapableRoles(): readonly StageRole[] {
  return STAGE_ROLES.filter((role) => accessForRole(role) === "write_capable");
}
