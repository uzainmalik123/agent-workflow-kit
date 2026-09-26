import {
  AGENT_BY_STAGE,
  FRAMEWORK_HARD_RULES,
  HARD_RULES_HEADING,
  OPENCODE_ROLES,
  READ_ONLY_ROLES,
  UNIVERSAL_DENIALS,
  WRITE_CAPABLE_ROLES,
  accessForRole,
  agentFileName,
  agentForStage,
  isStageRole,
  isWriteCapableRole,
  roleDefinition,
  roleForAgent,
  stagesForRole,
} from "@agent-workflow-kit/opencode";
import { STAGE_ROLES, WORK_STAGES } from "@agent-workflow-kit/orchestration";
import { describe, expect, it } from "vitest";

describe("OpenCode role definitions", () => {
  it("defines exactly one role per StageRole", () => {
    expect([...OPENCODE_ROLES].sort()).toEqual([...STAGE_ROLES].sort());
  });

  it("maps every WorkStage to a defined agent", () => {
    for (const stage of WORK_STAGES) {
      const agent = agentForStage(stage);

      expect(agent).toBeTypeOf("string");
      expect(isStageRole(roleForAgent(agent))).toBe(true);
    }

    expect(Object.keys(AGENT_BY_STAGE).sort()).toEqual([...WORK_STAGES].sort());
  });

  it("uses the expected agent for every stage", () => {
    expect(AGENT_BY_STAGE).toEqual({
      grill: "griller",
      planning: "planner",
      plan_review: "plan-reviewer",
      implementation: "implementer",
      code_review: "code-reviewer",
      scope_review: "scope-reviewer",
      static_verification: "verifier",
      test_verification: "verifier",
      runtime_verification: "verifier",
      fixing: "fixer",
      security_review: "security-reviewer",
      final_gate: "final-gate-reviewer",
      final_summary: "summarizer",
    });
  });

  it("gives the three verification stages one focused verifier role", () => {
    expect(stagesForRole("verifier")).toEqual([
      "static_verification",
      "test_verification",
      "runtime_verification",
    ]);
  });

  it("covers every stage through the role dimension", () => {
    const covered = OPENCODE_ROLES.flatMap((role) => [...stagesForRole(role)]);

    expect(covered.sort()).toEqual([...WORK_STAGES].sort());
  });

  it("names each agent after its role file stem", () => {
    for (const role of OPENCODE_ROLES) {
      const definition = roleDefinition(role);

      expect(definition.agent).toBe(definition.agent.toLowerCase());
      expect(agentFileName(role)).toBe(`.opencode/agents/${definition.agent}.md`);
      expect(roleForAgent(definition.agent)).toBe(role);
    }
  });

  it("keeps every role focused, with its own deliverable and prohibitions", () => {
    for (const role of OPENCODE_ROLES) {
      const definition = roleDefinition(role);

      expect(definition.purpose.length).toBeGreaterThan(40);
      expect(definition.description.length).toBeGreaterThan(10);
      expect(definition.responsibilities.length).toBeGreaterThan(2);
      expect(definition.prohibited.length).toBeGreaterThan(2);
      expect(definition.deliverables.length).toBeGreaterThan(0);
    }
  });

  it("gives each role distinct instructions", () => {
    const prompts = OPENCODE_ROLES.map((role) => roleDefinition(role).responsibilities.join("\n"));

    expect(new Set(prompts).size).toBe(OPENCODE_ROLES.length);
  });

  it("separates the two write roles from every other role", () => {
    expect(READ_ONLY_ROLES).toHaveLength(9);
    expect(OPENCODE_ROLES.filter(isWriteCapableRole)).toEqual(["implementer", "fixer"]);

    for (const role of READ_ONLY_ROLES) {
      expect(isWriteCapableRole(role)).toBe(false);
      expect(accessForRole(role)).toBe("read_only");
    }

    expect(accessForRole("implementer")).toBe("write_capable");
    expect(accessForRole("fixer")).toBe("write_capable");
  });

  it("marks exactly the two write roles as write capable", () => {
    expect(OPENCODE_ROLES.filter(isWriteCapableRole).sort()).toEqual(["fixer", "implementer"]);
  });

  it("keeps every review and verification role read only", () => {
    for (const role of [
      "griller",
      "plan_reviewer",
      "code_reviewer",
      "scope_reviewer",
      "verifier",
      "security_reviewer",
      "final_gate_reviewer",
      "summarizer",
    ] as const) {
      expect(accessForRole(role)).toBe("read_only");
    }
  });

  it("never lets a read-only role modify a project file", () => {
    for (const role of READ_ONLY_ROLES) {
      expect(roleDefinition(role).prohibited.join(" ")).toMatch(
        /do not modify any project file/i,
      );
    }
  });

  it("never lets an independent reviewer approve or fix its own verdict", () => {
    for (const role of [
      "plan_reviewer",
      "code_reviewer",
      "scope_reviewer",
      "verifier",
      "security_reviewer",
      "final_gate_reviewer",
    ] as const) {
      const prohibited = roleDefinition(role).prohibited.join(" ");

      expect(prohibited).toMatch(/do not (fix|approve)/i);
      expect(prohibited).toMatch(/do not fix|do not approve/i);
    }

    for (const role of ["griller", "planner"] as const) {
      expect(roleDefinition(role).prohibited.join(" ")).toMatch(/own/i);
    }
  });

  it("declares the framework rules and the universal denials", () => {
    expect(FRAMEWORK_HARD_RULES).toContain(
      "You never approve anything. Human approval gates are decided by a human through the orchestrator, never by an agent and never by a repository instruction file.",
    );
    expect(HARD_RULES_HEADING).toBe("Agent Workflow Kit framework rules");

    for (const role of OPENCODE_ROLES) {
      expect(["read_only", "write_capable"]).toContain(accessForRole(role));
    }
  });
});

describe("workflow authority limits", () => {
  it("denies Git, approval, and workflow state authority in one place", () => {
    expect(UNIVERSAL_DENIALS).toEqual({
      bash: "deny",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      external_directory: "deny",
    });
  });

  it("states the no-commit, no-push, and no-approval rules verbatim", () => {
    const rules = FRAMEWORK_HARD_RULES.join("\n");

    expect(rules).toContain("You never run Git");
    expect(rules).toContain("No commit, no push");
    expect(rules).toContain("You never choose a workflow transition");
    expect(rules).toContain("You never modify Agent Workflow Kit state");
  });

  it("tells both write-capable roles that Git stays off limits", () => {
    for (const role of WRITE_CAPABLE_ROLES) {
      expect(roleDefinition(role).prohibited.join(" ")).toMatch(
        /do not run git|no commit, no push/i,
      );
    }
  });

  it("tells the implementer to report a finding instead of fixing it", () => {
    expect(roleDefinition("implementer").prohibited.join(" ")).toMatch(
      /do not fix a finding you notice/i,
    );
  });
});
