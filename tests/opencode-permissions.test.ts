import {
  DENY_ALL_RULE,
  OPENCODE_PROFILES,
  OPENCODE_ROLES,
  PROTECTED_PATH_PATTERNS,
  READ_ONLY_PERMISSION_RULES,
  SECRET_PATH_PATTERNS,
  SHELL_ALLOWLIST,
  UNIVERSAL_ALLOWED_ACTIONS,
  UNIVERSAL_DENIAL_ACTIONS,
  WRITE_CAPABLE_PERMISSION_RULES,
  effectFor,
  isReadOnlyProfile,
  isReadOnlyRole,
  isWriteCapableProfile,
  matchesResourcePattern,
  operationEffect,
  permissionRulesForProfile,
  permissionRulesForRole,
  profileForRole,
  readOnlyRoles,
  writeCapableRoles,
  type OpenCodePermissionEffect,
  type OpenCodePermissionRuleset,
  type OpenCodeProfile,
} from "@agent-workflow-kit/opencode";
import { ALLOWED_SHELL_COMMAND, SHELL_COMMANDS_THAT_MUST_BE_DENIED } from "../fixtures/shell-commands.js";
import { describe, expect, it } from "vitest";

const PROJECT_FILE = "src/app.ts";
const WORKFLOW_ARTIFACT = ".agentflow/F-001/plan.json";
const WORKFLOW_DOCUMENT = "docs/feature-plan.agentflow.md";
const GIT_PATH = ".git/config";
const NESTED_GIT_PATH = "packages/app/.git/HEAD";
const PROJECT_GITIGNORE = "packages/app.gitignore";
const SECRET_FILE = ".env";

function editEffect(profile: OpenCodeProfile, path: string): OpenCodePermissionEffect {
  return effectFor(permissionRulesForProfile(profile), "edit", path);
}

function readEffect(profile: OpenCodeProfile, path: string): OpenCodePermissionEffect {
  return effectFor(permissionRulesForProfile(profile), "read", path);
}

function ruleIndex(rules: readonly { action: string; resource: string }[], action: string, resource: string): number {
  return rules.findIndex((entry) => entry.action === action && entry.resource === resource);
}

describe("least-privilege access levels", () => {
  it("defines exactly two profiles, and they are the only rulesets that exist", () => {
    expect(OPENCODE_PROFILES).toEqual(["agentflow-read", "agentflow-write"]);
    expect(permissionRulesForProfile("agentflow-read")).toEqual(READ_ONLY_PERMISSION_RULES);
    expect(permissionRulesForProfile("agentflow-write")).toEqual(WRITE_CAPABLE_PERMISSION_RULES);
  });

  it("classifies every profile as read-only or write-capable", () => {
    expect(isReadOnlyProfile("agentflow-read")).toBe(true);
    expect(isReadOnlyProfile("agentflow-write")).toBe(false);
    expect(isWriteCapableProfile("agentflow-read")).toBe(false);
    expect(isWriteCapableProfile("agentflow-write")).toBe(true);
  });

  it("routes all eleven roles to one of the two profiles, and no role has rules of its own", () => {
    const rulesets = new Set<OpenCodePermissionRuleset>();

    for (const role of OPENCODE_ROLES) {
      rulesets.add(permissionRulesForProfile(profileForRole(role)));
    }

    expect(rulesets.size).toBe(2);
    expect(OPENCODE_ROLES).toHaveLength(11);
  });

  /* eslint-disable @typescript-eslint/no-deprecated -- this block exists to prove the deprecated aliases still resolve to the profile API */
  it("resolves every deprecated role-keyed permission alias to the same rules as its replacement", () => {
    for (const role of OPENCODE_ROLES) {
      const profile = profileForRole(role);

      expect(permissionRulesForRole(role)).toEqual(permissionRulesForProfile(profile));
      expect(isReadOnlyRole(role)).toBe(isReadOnlyProfile(profile));
    }

    expect([...readOnlyRoles()].sort()).toEqual([...OPENCODE_ROLES].filter((role) => isReadOnlyProfile(profileForRole(role))).sort());
    expect([...writeCapableRoles()].sort()).toEqual([...OPENCODE_ROLES].filter((role) => !isReadOnlyProfile(profileForRole(role))).sort());
  });
  /* eslint-enable @typescript-eslint/no-deprecated */
});

describe("the V2 rule shape", () => {
  it("uses ordered action/resource/effect rules and nothing else", () => {
    for (const profile of OPENCODE_PROFILES) {
      for (const entry of permissionRulesForProfile(profile)) {
        expect(Object.keys(entry).sort()).toEqual(["action", "effect", "resource"]);
        expect(typeof entry.action).toBe("string");
        expect(typeof entry.resource).toBe("string");
        expect(["allow", "deny", "ask"]).toContain(entry.effect);
      }
    }
  });

  it("opens every ruleset with deny-all so nothing is allowed by accident", () => {
    for (const profile of OPENCODE_PROFILES) {
      expect(permissionRulesForProfile(profile)[0]).toEqual(DENY_ALL_RULE);
      expect(DENY_ALL_RULE).toEqual({ action: "*", resource: "*", effect: "deny" });
    }
  });

  it("places broad rules before the exceptions that narrow them", () => {
    for (const rules of [READ_ONLY_PERMISSION_RULES, WRITE_CAPABLE_PERMISSION_RULES]) {
      // The broad allow must come before every narrower denial of the same action.
      for (const pattern of [...PROTECTED_PATH_PATTERNS, ...SECRET_PATH_PATTERNS]) {
        expect(ruleIndex(rules, "read", "*")).toBeLessThan(ruleIndex(rules, "read", pattern));
      }

      for (const pattern of PROTECTED_PATH_PATTERNS) {
        const broadEdit = ruleIndex(rules, "edit", "*");
        const narrowEdit = ruleIndex(rules, "edit", pattern);

        if (broadEdit === -1 || narrowEdit === -1) {
          continue;
        }

        expect(broadEdit).toBeLessThan(narrowEdit);
      }
    }
  });

  it("never lets an action fall through to an ask, which a non-interactive run would reject", () => {
    const actions = [
      ...UNIVERSAL_DENIAL_ACTIONS,
      ...UNIVERSAL_ALLOWED_ACTIONS,
      "todowrite",
      "list",
      "mcp_github_create_issue",
      "some_plugin_invented_action",
    ];
    const resources = ["*", PROJECT_FILE, WORKFLOW_ARTIFACT, GIT_PATH, "git push origin main"];

    for (const profile of OPENCODE_PROFILES) {
      const rules = permissionRulesForProfile(profile);

      for (const action of actions) {
        for (const resource of resources) {
          expect(effectFor(rules, action, resource)).not.toBe("ask");
        }
      }
    }
  });

  it("denies a plugin action it has never heard of", () => {
    for (const profile of OPENCODE_PROFILES) {
      expect(effectFor(permissionRulesForProfile(profile), "some_plugin_invented_action", "*")).toBe(
        "deny",
      );
    }
  });
});

describe("the agentflow-read profile", () => {
  it("denies every edit, for all nine roles that run under it", () => {
    expect(editEffect("agentflow-read", PROJECT_FILE)).toBe("deny");
    expect(editEffect("agentflow-read", "README.md")).toBe("deny");

    for (const role of OPENCODE_ROLES.filter((entry) => profileForRole(entry) === "agentflow-read")) {
      expect(permissionRulesForProfile(profileForRole(role))).toEqual(READ_ONLY_PERMISSION_RULES);
    }
  });

  it("allows reading project files", () => {
    expect(readEffect("agentflow-read", PROJECT_FILE)).toBe("allow");
    expect(readEffect("agentflow-read", "package.json")).toBe("allow");
  });

  it("denies reading workflow state and Git", () => {
    expect(readEffect("agentflow-read", WORKFLOW_ARTIFACT)).toBe("deny");
    expect(readEffect("agentflow-read", GIT_PATH)).toBe("deny");
  });
});

describe("the agentflow-write profile", () => {
  it("allows editing project files, for both roles that run under it", () => {
    expect(editEffect("agentflow-write", PROJECT_FILE)).toBe("allow");
    expect(editEffect("agentflow-write", "packages/app/src/new-file.ts")).toBe("allow");
    expect(
      OPENCODE_ROLES.filter((role) => profileForRole(role) === "agentflow-write"),
    ).toEqual(["implementer", "fixer"]);
  });

  it("denies editing workflow artifacts, whatever their location", () => {
    expect(editEffect("agentflow-write", WORKFLOW_ARTIFACT)).toBe("deny");
    expect(editEffect("agentflow-write", ".agentflow/events/2026-01-01.jsonl")).toBe("deny");
    expect(editEffect("agentflow-write", "packages/app/.agentflow/plan.json")).toBe("deny");
    expect(editEffect("agentflow-write", WORKFLOW_DOCUMENT)).toBe("deny");
    expect(editEffect("agentflow-write", ".agentflow")).toBe("deny");
  });

  it("denies editing Git state, whatever its location", () => {
    expect(editEffect("agentflow-write", GIT_PATH)).toBe("deny");
    expect(editEffect("agentflow-write", NESTED_GIT_PATH)).toBe("deny");
    expect(editEffect("agentflow-write", ".git/refs/heads/main")).toBe("deny");
    expect(editEffect("agentflow-write", ".git")).toBe("deny");
  });

  it("still allows a project .gitignore, which is not version-control state", () => {
    expect(editEffect("agentflow-write", PROJECT_GITIGNORE)).toBe("allow");
    expect(editEffect("agentflow-write", ".gitignore")).toBe("allow");
  });

  it("denies reading workflow artifacts so a run cannot rewrite the record of its own stage", () => {
    expect(readEffect("agentflow-write", WORKFLOW_ARTIFACT)).toBe("deny");
    expect(readEffect("agentflow-write", GIT_PATH)).toBe("deny");
  });

  it("does not deny the write profile the ability to read its own changes", () => {
    expect(editEffect("agentflow-write", "src/app.ts")).toBe("allow");
    expect(readEffect("agentflow-write", "src/app.ts")).toBe("allow");
  });

  it("denies a patch that spans a project file and workflow state", () => {
    const rules = permissionRulesForProfile("agentflow-write");

    expect(operationEffect(rules, "edit", [PROJECT_FILE, WORKFLOW_ARTIFACT])).toBe("deny");
    expect(operationEffect(rules, "edit", [PROJECT_FILE, "src/other.ts"])).toBe("allow");
  });
});

describe("capability denials shared by every profile", () => {
  it("denies command execution, delegation, skills, and the network for every profile", () => {
    for (const profile of OPENCODE_PROFILES) {
      const rules = permissionRulesForProfile(profile);

      for (const action of UNIVERSAL_DENIAL_ACTIONS) {
        expect(effectFor(rules, action, "*")).toBe("deny");
      }
    }
  });

  // "Every command that does something" rather than "the shell outright": since D-1 the `shell`
  // action is declared with a `deny` for `*` followed by an `allow` for `pwd`, so the universal
  // denial below is still what covers Git and every other command, and the single no-op that is
  // allowed is asserted separately.
  it("denies the shell for every command that does anything, so nothing can commit or push", () => {
    for (const profile of OPENCODE_PROFILES) {
      const rules = permissionRulesForProfile(profile);

      for (const command of ["git status", "git commit -m x", "git push origin main", "npm test", "ls"]) {
        expect(effectFor(rules, "shell", command)).toBe("deny");
      }
    }
  });

  /*
   * Decision D-1: the shell tool stays declared in both profiles, denied for every resource, and
   * then re-allowed for exactly one no-op command. The gate that made this necessary (OpenCode
   * Zen's free tier rejects an agent whose config removes `bash` or `read`) is a provider quirk;
   * the security claim is the ruleset below, which is what is asserted.
   */
  it("declares the shell tool with exactly two rules, deny then allow, in both profiles", () => {
    expect(SHELL_ALLOWLIST).toEqual([ALLOWED_SHELL_COMMAND]);

    for (const profile of OPENCODE_PROFILES) {
      const shellRules = permissionRulesForProfile(profile).filter((entry) => entry.action === "shell");

      expect(shellRules, profile).toEqual([
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: ALLOWED_SHELL_COMMAND, effect: "allow" },
      ]);
    }
  });

  it("allows exactly `pwd` and denies every compound, argument, and prefix form", () => {
    for (const profile of OPENCODE_PROFILES) {
      const rules = permissionRulesForProfile(profile);

      expect(effectFor(rules, "shell", ALLOWED_SHELL_COMMAND), profile).toBe("allow");

      for (const command of SHELL_COMMANDS_THAT_MUST_BE_DENIED) {
        expect(effectFor(rules, "shell", command), `${profile}: ${command}`).toBe("deny");
      }
    }
  });

  it("denies subagent delegation for every profile, under the V2 action name", () => {
    for (const profile of OPENCODE_PROFILES) {
      expect(effectFor(permissionRulesForProfile(profile), "subagent", "agentflow-write")).toBe("deny");
    }
  });

  it("never uses the V1 action names", () => {
    for (const profile of OPENCODE_PROFILES) {
      const actions = permissionRulesForProfile(profile).map((entry) => entry.action);

      expect(actions).not.toContain("bash");
      expect(actions).not.toContain("task");
      expect(actions).not.toContain("lsp");
      expect(actions).not.toContain("doom_loop");
    }
  });

  it("denies skill loading for every profile until skill integration exists", () => {
    for (const profile of OPENCODE_PROFILES) {
      const rules = permissionRulesForProfile(profile);

      expect(effectFor(rules, "skill", "*")).toBe("deny");
      expect(effectFor(rules, "skill", "anything")).toBe("deny");
    }
  });

  it("denies external directory access for every profile", () => {
    for (const profile of OPENCODE_PROFILES) {
      expect(effectFor(permissionRulesForProfile(profile), "external_directory", "/etc")).toBe("deny");
    }
  });

  it("denies the actions a non-interactive run cannot satisfy", () => {
    for (const profile of OPENCODE_PROFILES) {
      const rules = permissionRulesForProfile(profile);

      for (const action of ["question", "plan_enter", "plan_exit", "execute"]) {
        expect(effectFor(rules, action, "*")).toBe("deny");
      }
    }
  });
});

describe("protected path rules", () => {
  it("protects workflow artifacts and Git in one place", () => {
    expect(PROTECTED_PATH_PATTERNS).toEqual([
      ".agentflow",
      ".agentflow/*",
      "*.agentflow",
      "*.agentflow/*",
      "*.agentflow.*",
      ".git",
      ".git/*",
      "*.git",
      "*.git/*",
    ]);
  });

  it("denies a secret file outright instead of leaving it to an ask", () => {
    expect(SECRET_PATH_PATTERNS).toEqual(["*.env", "*.env.*"]);

    for (const profile of OPENCODE_PROFILES) {
      expect(readEffect(profile, SECRET_FILE)).toBe("deny");
      expect(readEffect(profile, "packages/app/.env.local")).toBe("deny");
    }
  });

  it("is shared by the read-only and write-capable rulesets", () => {
    const protectedPaths = [
      ".agentflow/plan.json",
      "packages/app/.agentflow/plan.json",
      "docs/plan.agentflow.md",
      ".git/config",
      "packages/app/.git/HEAD",
    ];

    for (const rules of [READ_ONLY_PERMISSION_RULES, WRITE_CAPABLE_PERMISSION_RULES]) {
      for (const path of protectedPaths) {
        expect(effectFor(rules, "read", path)).toBe("deny");
      }
    }
  });
});

describe("V2 wildcard matching", () => {
  it("lets the last matching rule win, as OpenCode does", () => {
    const rules = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "edit", resource: "*", effect: "allow" as const },
      { action: "edit", resource: "src/generated/*", effect: "deny" as const },
    ];

    expect(effectFor(rules, "edit", "src/app.ts")).toBe("allow");
    expect(effectFor(rules, "edit", "src/generated/api.ts")).toBe("deny");
    expect(effectFor(rules, "edit", "docs/readme.md")).toBe("allow");
  });

  it("resolves an unmatched action to ask, which is OpenCode's own default", () => {
    expect(effectFor([], "edit", "src/app.ts")).toBe("ask");
  });

  it("matches a wildcard across path segments, so nested workflow state stays denied", () => {
    expect(matchesResourcePattern(".agentflow/*", ".agentflow/events/run.jsonl")).toBe(true);
    expect(matchesResourcePattern(".agentflow/*", "src/app.ts")).toBe(false);
  });

  it("treats a question mark as exactly one character", () => {
    expect(matchesResourcePattern("src/v?.ts", "src/v1.ts")).toBe(true);
    expect(matchesResourcePattern("src/v?.ts", "src/v12.ts")).toBe(false);
    expect(matchesResourcePattern("src/v?.ts", "src/v/.ts")).toBe(true);
  });

  it("lets a pattern ending in a space and a star also match the bare value", () => {
    expect(matchesResourcePattern("git status *", "git status")).toBe(true);
    expect(matchesResourcePattern("git status *", "git status --short")).toBe(true);
    expect(matchesResourcePattern("git status *", "git statusx")).toBe(false);
  });

  it("normalizes backslashes the way OpenCode does", () => {
    expect(matchesResourcePattern("src/*", "src\\app.ts")).toBe(true);
  });

  it("anchors a pattern to the whole value", () => {
    expect(matchesResourcePattern("*.agentflow.*", "docs/plan.agentflow.md")).toBe(true);
    expect(matchesResourcePattern("*.agentflow", "docs/plan.agentflow.md")).toBe(false);
    expect(matchesResourcePattern("*.git", "packages/app.gitignore")).toBe(false);
  });
});
