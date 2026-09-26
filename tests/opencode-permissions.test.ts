import {
  OPENCODE_ROLES,
  PROTECTED_PATH_RULES,
  READ_ONLY_ROLES,
  READ_ONLY_PERMISSION,
  TOOLS_DENIED_FOR_READ_ONLY_ROLES,
  UNIVERSAL_DENIALS,
  WRITE_CAPABLE_PERMISSION,
  WRITE_CAPABLE_ROLES,
  effectFor,
  type OpenCodePermissionEffect,
  isReadOnlyRole,
  permissionForRole,
  readOnlyRoles,
  toolDenyListForRole,
  writeCapableRoles,
  type OpenCodePermissionMap,
} from "@agent-workflow-kit/opencode";
import { describe, expect, it } from "vitest";

const PROJECT_FILE = "src/app.ts";
const WORKFLOW_ARTIFACT = ".agentflow/F-001/plan.json";
const WORKFLOW_DOCUMENT = "docs/feature-plan.agentflow.md";
const GIT_PATH = ".git/config";
const NESTED_GIT_PATH = "packages/app/.git/HEAD";
const PROJECT_GITIGNORE = "packages/app.gitignore";

function editEffect(
  role: (typeof OPENCODE_ROLES)[number],
  path: string,
): OpenCodePermissionEffect {
  return effectFor(permissionForRole(role), "edit", path);
}

function readEffect(
  role: (typeof OPENCODE_ROLES)[number],
  path: string,
): OpenCodePermissionEffect {
  return effectFor(permissionForRole(role), "read", path);
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

describe("read-only role permissions", () => {
  it("denies every edit to every read-only role", () => {
    for (const role of READ_ONLY_ROLES) {
      expect(editEffect(role, PROJECT_FILE)).toBe("deny");
      expect(permissionForRole(role).edit).toEqual(READ_ONLY_PERMISSION.edit);
    }
  });

  it("denies every file modification tool for every read-only role", () => {
    for (const role of READ_ONLY_ROLES) {
      expect(toolDenyListForRole(role)).toEqual(TOOLS_DENIED_FOR_READ_ONLY_ROLES);
      expect(toolDenyListForRole(role)).toMatchObject({
        write: false,
        edit: false,
        patch: false,
      });
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
    }
  });

  it("denies editing Git state, whatever its location", () => {
    for (const role of WRITE_CAPABLE_ROLES) {
      expect(editEffect(role, GIT_PATH)).toBe("deny");
      expect(editEffect(role, NESTED_GIT_PATH)).toBe("deny");
      expect(editEffect(role, ".git/refs/heads/main")).toBe("deny");
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
});

describe("capability denials shared by every role", () => {
  it("denies command execution, delegation, and the network for every role", () => {
    for (const role of OPENCODE_ROLES) {
      const permission = permissionForRole(role);

      expect(permission).toMatchObject(UNIVERSAL_DENIALS);

      for (const [capability, effect] of Object.entries(UNIVERSAL_DENIALS)) {
        expect(effect).toBe("deny");
        expect(effectFor(permission, capability, "*")).toBe("deny");
      }
    }
  });

  it("denies external directory access for every role", () => {
    for (const role of OPENCODE_ROLES) {
      expect(effectFor(permissionForRole(role), "external_directory", "/etc")).toBe("deny");
    }
  });

  it("denies sub-agent delegation for every role", () => {
    for (const role of OPENCODE_ROLES) {
      expect(effectFor(permissionForRole(role), "task", "implementer")).toBe("deny");
    }
  });
});

describe("protected path rules", () => {
  it("protects workflow artifacts and Git in one place", () => {
    expect(PROTECTED_PATH_RULES).toEqual({
      ".agentflow/*": "deny",
      "*.agentflow/*": "deny",
      "*.agentflow.*": "deny",
      ".git/*": "deny",
      "*.git/*": "deny",
    });
  });

  it("is shared by the read-only and write-capable permission maps", () => {
    const protectedPaths = [
      ".agentflow/plan.json",
      "packages/app/.agentflow/plan.json",
      "docs/plan.agentflow.md",
      ".git/config",
      "packages/app/.git/HEAD",
    ];

    for (const permission of [READ_ONLY_PERMISSION, WRITE_CAPABLE_PERMISSION]) {
      for (const path of protectedPaths) {
        expect(effectFor(permission, "read", path)).toBe("deny");
        expect(effectFor(permission, "edit", path)).toBe("deny");
      }
    }
  });

  it("denies a read-only role every edit, protected path or not", () => {
    for (const path of [".agentflow/plan.json", ".git/config", "src/app.ts"]) {
      expect(effectFor(READ_ONLY_PERMISSION, "edit", path)).toBe("deny");
    }
  });
});

describe("permission effect resolution", () => {
  it("lets the last matching rule win, as OpenCode does", () => {
    const permission: OpenCodePermissionMap = {
      edit: { "*": "deny", "src/*": "allow", "src/generated/*": "deny" },
    };

    expect(effectFor(permission, "edit", "src/app.ts")).toBe("allow");
    expect(effectFor(permission, "edit", "src/generated/api.ts")).toBe("deny");
    expect(effectFor(permission, "edit", "docs/readme.md")).toBe("deny");
  });

  it("resolves a bare permission string", () => {
    expect(effectFor({ edit: "allow" }, "edit", "anything")).toBe("allow");
    expect(effectFor({ edit: "deny" }, "edit", "anything")).toBe("deny");
  });

  it("allows a path that matches no rule", () => {
    expect(effectFor({}, "edit", "src/app.ts")).toBe("allow");
  });

  it("matches a wildcard across path segments, so nested workflow state stays denied", () => {
    const permission: OpenCodePermissionMap = { edit: { ".agentflow/*": "deny" } };

    expect(effectFor(permission, "edit", ".agentflow/plan.json")).toBe("deny");
    expect(effectFor(permission, "edit", ".agentflow/events/run.jsonl")).toBe("deny");
    expect(effectFor(permission, "edit", "src/app.ts")).toBe("allow");
  });

  it("treats a question mark as a single character wildcard", () => {
    const permission: OpenCodePermissionMap = { edit: { "src/v?.ts": "deny" } };

    expect(effectFor(permission, "edit", "src/v1.ts")).toBe("deny");
    expect(effectFor(permission, "edit", "src/v12.ts")).toBe("allow");
  });
});
