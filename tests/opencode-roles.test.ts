import {
  FRAMEWORK_HARD_RULES,
  HARD_RULES_HEADING,
  OPENCODE_PROFILES,
  OPENCODE_ROLES,
  PROFILE_BY_STAGE,
  READ_ONLY_ROLES,
  UNIVERSAL_DENIAL_ACTIONS,
  WRITE_CAPABLE_ROLES,
  accessForRole,
  agentFileNameForProfile,
  AGENT_BY_STAGE,
  agentForRole,
  agentForStage,
  isOpenCodeProfile,
  isStageRole,
  isWriteCapableRole,
  profileForAgent,
  profileForRole,
  profileForStage,
  roleDefinition,
  roleForStage,
  rolesForProfile,
  stagesForRole,
} from "@agent-workflow-kit/opencode";
import { STAGE_ROLES, WORK_STAGES } from "@agent-workflow-kit/orchestration";
import { describe, expect, it } from "vitest";

describe("OpenCode role definitions", () => {
  it("defines exactly one role per StageRole", () => {
    expect([...OPENCODE_ROLES].sort()).toEqual([...STAGE_ROLES].sort());
  });

  it("maps every WorkStage to one of the two physical profiles", () => {
    for (const stage of WORK_STAGES) {
      expect(isOpenCodeProfile(profileForStage(stage))).toBe(true);
    }

    expect(Object.keys(PROFILE_BY_STAGE).sort()).toEqual([...WORK_STAGES].sort());
  });

  it("uses the expected profile for every stage", () => {
    expect(PROFILE_BY_STAGE).toEqual({
      grill: "agentflow-read",
      planning: "agentflow-read",
      plan_review: "agentflow-read",
      implementation: "agentflow-write",
      code_review: "agentflow-read",
      scope_review: "agentflow-read",
      static_verification: "agentflow-read",
      test_verification: "agentflow-read",
      runtime_verification: "agentflow-read",
      fixing: "agentflow-write",
      security_review: "agentflow-read",
      final_gate: "agentflow-read",
      final_summary: "agentflow-read",
    });
  });

  it("defines exactly two physical profiles, and every stage agrees with its role", () => {
    expect(OPENCODE_PROFILES).toEqual(["agentflow-read", "agentflow-write"]);

    for (const stage of WORK_STAGES) {
      expect(profileForStage(stage)).toBe(profileForRole(roleForStage(stage)));
    }
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

  it("covers all eleven roles with two profiles, nine and two", () => {
    expect(rolesForProfile("agentflow-read")).toEqual([
      "griller",
      "planner",
      "plan_reviewer",
      "code_reviewer",
      "scope_reviewer",
      "verifier",
      "security_reviewer",
      "final_gate_reviewer",
      "summarizer",
    ]);
    expect(rolesForProfile("agentflow-write")).toEqual(["implementer", "fixer"]);

    const covered = [
      ...rolesForProfile("agentflow-read"),
      ...rolesForProfile("agentflow-write"),
    ];

    expect(covered.sort()).toEqual([...OPENCODE_ROLES].sort());
  });

  it("names each generated file after its profile, not after a role", () => {
    for (const profile of OPENCODE_PROFILES) {
      expect(agentFileNameForProfile(profile)).toBe(`.opencode/agents/${profile}.md`);
      expect(profileForAgent(profile)).toBe(profile);
    }

    // A role no longer has a file of its own, so no role name can resolve to a generated agent id.
    for (const role of OPENCODE_ROLES) {
      expect(profileForAgent(role)).toBeUndefined();
    }
  });

  /* eslint-disable @typescript-eslint/no-deprecated -- this block exists to prove the deprecated aliases still resolve to the profile API */
  it("resolves every deprecated role-keyed alias to the same profile as its replacement", () => {
    for (const stage of WORK_STAGES) {
      expect(AGENT_BY_STAGE[stage]).toBe(PROFILE_BY_STAGE[stage]);
      expect(agentForStage(stage)).toBe(profileForStage(stage));
    }

    for (const role of OPENCODE_ROLES) {
      expect(agentForRole(role)).toBe(profileForRole(role));
    }
  });
  /* eslint-enable @typescript-eslint/no-deprecated */

  it("keeps the role's own file stem out of the role definition", () => {
    for (const role of OPENCODE_ROLES) {
      const definition = roleDefinition(role);

      expect(isStageRole(role)).toBe(true);
      expect(Object.hasOwn(definition, "agent")).toBe(false);
      expect(Object.hasOwn(definition, "filename")).toBe(false);
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
  it("denies Git, delegation, skills, and network authority in one place", () => {
    expect(UNIVERSAL_DENIAL_ACTIONS).toEqual([
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
    ]);
  });

  it("denies Git by denying the shell itself, which is the only way to run it", () => {
    expect(UNIVERSAL_DENIAL_ACTIONS).toContain("shell");
    expect(UNIVERSAL_DENIAL_ACTIONS).not.toContain("bash");
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

  // P-12: the implementer wrote `implementation.json` because the prompt renders artifacts with
  // filenames while its role never said the response comes back in the reply. The sentence is one
  // string in both write roles, so a test can hold the wording still rather than a paraphrase.
  it("tells every write-capable role that the structured response is returned, never written to a file", () => {
    expect(WRITE_CAPABLE_ROLES).toEqual(["implementer", "fixer"]);

    const sentence =
      "The structured response is returned in your reply and is NEVER written to a file: do not create or edit `implementation.json` or any other artifact filename in the repository.";

    for (const role of WRITE_CAPABLE_ROLES) {
      expect(roleDefinition(role).prohibited.join("\n")).toContain(sentence);
    }
  });

  it("tells the implementer to report a finding instead of fixing it", () => {
    expect(roleDefinition("implementer").prohibited.join(" ")).toMatch(
      /do not fix a finding you notice/i,
    );
  });
});
