import {
  DENY_ALL_RULE,
  OPENCODE_ROLES,
  PROTECTED_PATH_PATTERNS,
  READ_ONLY_PERMISSION_RULES,
  READ_ONLY_ROLES,
  SECRET_PATH_PATTERNS,
  UNIVERSAL_ALLOWED_ACTIONS,
  UNIVERSAL_DENIAL_ACTIONS,
  WRITE_CAPABLE_PERMISSION_RULES,
  WRITE_CAPABLE_ROLES,
  effectFor,
  isReadOnlyRole,
  matchesResourcePattern,
  operationEffect,
  permissionRulesForRole,
  readOnlyRoles,
  writeCapableRoles,
  type OpenCodePermissionEffect,
} from "@agent-workflow-kit/opencode";
import { describe, expect, it } from "vitest";

const PROJECT_FILE = "src/app.ts";
const WORKFLOW_ARTIFACT = ".agentflow/F-001/plan.json";
const WORKFLOW_DOCUMENT = "docs/feature-plan.agentflow.md";
const GIT_PATH = ".git/config";
const NESTED_GIT_PATH = "packages/app/.git/HEAD";
const PROJECT_GITIGNORE = "packages/app.gitignore";
const SECRET_FILE = ".env";

function editEffect(role: (typeof OPENCODE_ROLES)[number], path: string): OpenCodePermissionEffect {
  return effectFor(permissionRulesForRole(role), "edit", path);
}

function readEffect(role: (typeof OPENCODE_ROLES)[number], path: string): OpenCodePermissionEffect {
  return effectFor(permissionRulesForRole(role), "read", path);
}

function ruleIndex(rules: readonly { action: string; resource: string }[], action: string, resource: string): number {
  return rules.findIndex((entry) => entry.action === action && entry.resource === resource);
}

describe("least-privilege access levels", () => {
  it("splits the roles into nine read-only and two write-capable", () => {
    expect(readOnlyRoles()).toEqual([...READ_ONLY_ROLES]);
    expect(readOnlyRoles()).toHaveLength(9);
    expect(writeCapableRoles()).toEqual([...WRITE_CAPABLE_ROLES]);
    expect(writeCapableRoles()).toEqual(["implementer", "fixer"]);
  });

  it("classifies every role as read-only or write-capable", () => {
    for (const role of OPENCODE_ROLES) {
      expect(isReadOnlyRole(role)).toBe(!WRITE_CAPABLE_ROLES.includes(role));
    }
  });
});

describe("the V2 rule shape", () => {
  it("uses ordered action/resource/effect rules and nothing else", () => {
    for (const role of OPENCODE_ROLES) {
      for (const entry of permissionRulesForRole(role)) {
        expect(Object.keys(entry).sort()).toEqual(["action", "effect", "resource"]);
        expect(typeof entry.action).toBe("string");
        expect(typeof entry.resource).toBe("string");
        expect(["allow", "deny", "ask"]).toContain(entry.effect);
      }
    }
  });

  it("opens every ruleset with deny-all so nothing is allowed by accident", () => {
    for (const role of OPENCODE_ROLES) {
      expect(permissionRulesForRole(role)[0]).toEqual(DENY_ALL_RULE);
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

    for (const role of OPENCODE_ROLES) {
      const rules = permissionRulesForRole(role);

      for (const action of actions) {
        for (const resource of resources) {
          expect(effectFor(rules, action, resource)).not.toBe("ask");
        }
      }
    }
  });

  it("denies a plugin action it has never heard of", () => {
    for (const role of OPENCODE_ROLES) {
      expect(effectFor(permissionRulesForRole(role), "some_plugin_invented_action", "*")).toBe("deny");
    }
  });
});

describe("read-only role permissions", () => {
  it("denies every edit to every read-only role", () => {
    for (const role of READ_ONLY_ROLES) {
      expect(editEffect(role, PROJECT_FILE)).toBe("deny");
      expect(editEffect(role, "README.md")).toBe("deny");
      expect(permissionRulesForRole(role)).toEqual(READ_ONLY_PERMISSION_RULES);
    }
  });

  it("allows reading project files", () => {
    for (const role of READ_ONLY_ROLES) {
      expect(readEffect(role, PROJECT_FILE)).toBe("allow");
      expect(readEffect(role, "package.json")).toBe("allow");
    }
  });

  it("denies reading workflow state and Git even for a read-only role", () => {
    for (const role of READ_ONLY_ROLES) {
      expect(readEffect(role, WORKFLOW_ARTIFACT)).toBe("deny");
      expect(readEffect(role, GIT_PATH)).toBe("deny");
    }
  });
});

describe("write-capable role permissions", () => {
  it("allows editing project files", () => {
    for (const role of WRITE_CAPABLE_ROLES) {
      expect(editEffect(role, PROJECT_FILE)).toBe("allow");
      expect(editEffect(role, "packages/app/src/new-file.ts")).toBe("allow");
    }
  });

  it("denies editing workflow artifacts, whatever their location", () => {
    for (const role of WRITE_CAPABLE_ROLES) {
      expect(editEffect(role, WORKFLOW_ARTIFACT)).toBe("deny");
      expect(editEffect(role, ".agentflow/events/2026-01-01.jsonl")).toBe("deny");
      expect(editEffect(role, "packages/app/.agentflow/plan.json")).toBe("deny");
      expect(editEffect(role, WORKFLOW_DOCUMENT)).toBe("deny");
      expect(editEffect(role, ".agentflow")).toBe("deny");
    }
  });

  it("denies editing Git state, whatever its location", () => {
    for (const role of WRITE_CAPABLE_ROLES) {
      expect(editEffect(role, GIT_PATH)).toBe("deny");
      expect(editEffect(role, NESTED_GIT_PATH)).toBe("deny");
      expect(editEffect(role, ".git/refs/heads/main")).toBe("deny");
      expect(editEffect(role, ".git")).toBe("deny");
    }
  });

  it("still allows a project .gitignore, which is not version-control state", () => {
    for (const role of WRITE_CAPABLE_ROLES) {
      expect(editEffect(role, PROJECT_GITIGNORE)).toBe("allow");
      expect(editEffect(role, ".gitignore")).toBe("allow");
    }
  });

  it("denies reading workflow artifacts so a role cannot rewrite the record of its own run", () => {
    for (const role of WRITE_CAPABLE_ROLES) {
      expect(readEffect(role, WORKFLOW_ARTIFACT)).toBe("deny");
      expect(readEffect(role, GIT_PATH)).toBe("deny");
    }
  });

  it("does not deny a write-capable role the ability to read its own changes", () => {
    expect(editEffect("implementer", "src/app.ts")).toBe("allow");
    expect(readEffect("implementer", "src/app.ts")).toBe("allow");
  });

  it("denies a patch that spans a project file and workflow state", () => {
    for (const role of WRITE_CAPABLE_ROLES) {
      expect(operationEffect(permissionRulesForRole(role), "edit", [PROJECT_FILE, WORKFLOW_ARTIFACT])).toBe(
        "deny",
      );
      expect(operationEffect(permissionRulesForRole(role), "edit", [PROJECT_FILE, "src/other.ts"])).toBe(
        "allow",
      );
    }
  });
});

describe("capability denials shared by every role", () => {
  it("denies command execution, delegation, skills, and the network for every role", () => {
    for (const role of OPENCODE_ROLES) {
      const rules = permissionRulesForRole(role);

      for (const action of UNIVERSAL_DENIAL_ACTIONS) {
        expect(effectFor(rules, action, "*")).toBe("deny");
      }
    }
  });

  it("denies the shell outright, so no role can commit or push", () => {
    for (const role of OPENCODE_ROLES) {
      const rules = permissionRulesForRole(role);

      for (const command of ["git status", "git commit -m x", "git push origin main", "npm test", "ls"]) {
        expect(effectFor(rules, "shell", command)).toBe("deny");
      }
    }
  });

  it("denies subagent delegation for every role, under the V2 action name", () => {
    for (const role of OPENCODE_ROLES) {
      expect(effectFor(permissionRulesForRole(role), "subagent", "implementer")).toBe("deny");
    }
  });

  it("never uses the V1 action names", () => {
    for (const role of OPENCODE_ROLES) {
      const actions = permissionRulesForRole(role).map((entry) => entry.action);

      expect(actions).not.toContain("bash");
      expect(actions).not.toContain("task");
      expect(actions).not.toContain("lsp");
      expect(actions).not.toContain("doom_loop");
    }
  });

  it("denies skill loading for every role until skill integration exists", () => {
    for (const role of OPENCODE_ROLES) {
      const rules = permissionRulesForRole(role);

      expect(effectFor(rules, "skill", "*")).toBe("deny");
      expect(effectFor(rules, "skill", "anything")).toBe("deny");
    }
  });

  it("denies external directory access for every role", () => {
    for (const role of OPENCODE_ROLES) {
      expect(effectFor(permissionRulesForRole(role), "external_directory", "/etc")).toBe("deny");
    }
  });

  it("denies the actions a non-interactive run cannot satisfy", () => {
    for (const role of OPENCODE_ROLES) {
      const rules = permissionRulesForRole(role);

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

    for (const role of OPENCODE_ROLES) {
      expect(readEffect(role, SECRET_FILE)).toBe("deny");
      expect(readEffect(role, "packages/app/.env.local")).toBe("deny");
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
