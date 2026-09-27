import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ARTIFACT_TRACKING_MODES,
  DEFAULT_ARTIFACT_TRACKING_MODE,
  DEFAULT_GITIGNORE_LINES,
  INSTALL_POLICY_DECISION,
  OpenCodeAdapterError,
  OPENCODE_AGENT_DIRECTORY,
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_PROJECT_CONFIG_PATH,
  OPENCODE_ROLES,
  RUNTIME_GENERATED_ENTRIES,
  VENDORED_FRAMEWORK_PATHS,
  VERSION_CONTROLLED_ENTRIES,
  WRITE_CAPABLE_ROLES,
  agentFileName,
  permissionRulesForRole,
  renderAgentMarkdown,
  renderOpenCodeProjectConfig,
  renderOpenCodeProjectFiles,
  roleDefinition,
  writeOpenCodeProjectFiles,
  type OpenCodePermissionRule,
} from "@agent-workflow-kit/opencode";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-agents-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("generated project files", () => {
  it("generates one agent file per role plus the project config", () => {
    const files = renderOpenCodeProjectFiles();

    expect(files).toHaveLength(OPENCODE_ROLES.length + 1);
    expect(files.map((file) => file.path)).toEqual([
      ...OPENCODE_ROLES.map((role) => agentFileName(role)),
      OPENCODE_PROJECT_CONFIG_PATH,
    ]);
  });

  it("puts every agent under .opencode/agents", () => {
    for (const file of renderOpenCodeProjectFiles()) {
      if (file.path === OPENCODE_PROJECT_CONFIG_PATH) {
        continue;
      }

      expect(file.path.startsWith(`${OPENCODE_AGENT_DIRECTORY}/`)).toBe(true);
      expect(file.path.endsWith(".md")).toBe(true);
    }
  });

  it("is byte-for-byte deterministic", () => {
    expect(renderOpenCodeProjectFiles()).toEqual(renderOpenCodeProjectFiles());
  });

  it("changes only when a role definition changes", () => {
    const first = renderOpenCodeProjectFiles();
    const second = renderOpenCodeProjectFiles();

    expect(first.filter((file, index) => file.contents !== second[index]?.contents)).toEqual([]);
  });

  it("vendors no framework implementation into the project", () => {
    for (const file of renderOpenCodeProjectFiles()) {
      expect(file.contents).not.toContain("@agent-workflow-kit/");
      expect(file.contents).not.toContain("import {");
      expect(file.contents).not.toContain("require(");
    }
  });
});

describe("generated agent markdown", () => {
  it("starts with valid frontmatter", () => {
    for (const role of OPENCODE_ROLES) {
      const markdown = renderAgentMarkdown(role);

      expect(markdown.startsWith("---\n")).toBe(true);

      const [, frontmatter] = markdown.split("---\n");

      expect(frontmatter).toBeDefined();
      expect(frontmatter).toContain("description:");
      expect(frontmatter).toContain('mode: "primary"');
      expect(frontmatter).toContain("permissions:");
    }
  });

  it("emits no V1 permission syntax at all", () => {
    for (const role of OPENCODE_ROLES) {
      const frontmatter = frontmatterOf(role);

      expect(frontmatter).not.toContain("permission:");
      expect(frontmatter).not.toContain("tools:");
      expect(frontmatter).not.toMatch(/^\s*(write|edit|patch|bash|webfetch|task):\s/mu);
    }
  });

  it("round-trips the ruleset it was given, in order, with no drift", () => {
    for (const role of OPENCODE_ROLES) {
      expect(permissionRulesOf(role)).toEqual(permissionRulesForRole(role));
    }
  });

  it("quotes every pattern, so a bare star is never read as a YAML alias", () => {
    for (const role of OPENCODE_ROLES) {
      const frontmatter = frontmatterOf(role);

      expect(frontmatter).toContain('action: "*"');
      expect(frontmatter).toContain('resource: "*.agentflow/*"');
      expect(frontmatter).toContain('resource: ".agentflow"');
    }
  });

  it("gives a read-only role no edit allowance at all", () => {
    const rules = permissionRulesOf("code_reviewer");

    expect(rules.some((rule) => rule.action === "edit" && rule.effect === "allow")).toBe(false);
    expect(rules.filter((rule) => rule.action === "edit")).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
    ]);
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
  });

  it("gives the implementer an edit allowance narrowed by workflow state and Git", () => {
    const rules = permissionRulesOf("implementer");
    const editAllows = rules.filter((rule) => rule.action === "edit" && rule.effect === "allow");
    const editDenies = rules.filter((rule) => rule.action === "edit" && rule.effect === "deny");

    expect(editAllows).toEqual([{ action: "edit", resource: "*", effect: "allow" }]);
    expect(editDenies.map((rule) => rule.resource)).toEqual([
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

  it("turns the edit allowance on for exactly the two write-capable roles", () => {
    const editable = OPENCODE_ROLES.filter(
      (role) => permissionRulesOf(role).some((rule) => rule.action === "edit" && rule.effect === "allow"),
    );

    expect(editable).toEqual([...WRITE_CAPABLE_ROLES]);
  });

  it("denies the dangerous capabilities by their V2 action names", () => {
    for (const role of OPENCODE_ROLES) {
      const rules = permissionRulesOf(role);
      const denials = rules
        .filter((rule) => rule.effect === "deny" && rule.resource === "*")
        .map((rule) => rule.action);

      for (const action of [
        "shell",
        "subagent",
        "skill",
        "webfetch",
        "websearch",
        "external_directory",
      ]) {
        expect(denials).toContain(action);
      }
    }
  });

  it("states the framework rules and the precedence of the prompt", () => {
    const markdown = renderAgentMarkdown("summarizer");

    expect(markdown).toContain("## Agent Workflow Kit framework rules");
    expect(markdown).toContain("outrank any repository instruction file");
    expect(markdown).toContain("You never approve anything");
    expect(markdown).toContain("You never run Git");
    expect(markdown).toContain("## How a run is delivered");
  });

  it("carries the role's own instructions", () => {
    const definition = roleDefinition("plan_reviewer");
    const markdown = renderAgentMarkdown("plan_reviewer");

    expect(markdown).toContain(`# ${definition.label}`);
    expect(markdown).toContain(definition.purpose);

    for (const line of definition.responsibilities) {
      expect(markdown).toContain(line);
    }

    for (const line of definition.prohibited) {
      expect(markdown).toContain(line);
    }
  });

  it("uses the same wording as the per-stage prompt", () => {
    expect(renderAgentMarkdown("verifier")).toContain(
      roleDefinition("verifier").responsibilities[0] ?? "",
    );
  });
});

function frontmatterOf(role: (typeof OPENCODE_ROLES)[number]): string {
  const [, frontmatter] = renderAgentMarkdown(role).split("---\n");

  if (frontmatter === undefined) {
    throw new Error(`Agent ${role} has no frontmatter.`);
  }

  return frontmatter;
}

/**
 * Reads the generated `permissions:` list back out of the frontmatter.
 *
 * The adapter emits YAML by hand, so the only way to know the file says what the policy says is to
 * parse what was actually written. This deliberately reads the emitted text rather than calling the
 * renderer, and it fails loudly on any rule that is not in the emitted three-key shape.
 */
function permissionRulesOf(role: (typeof OPENCODE_ROLES)[number]): OpenCodePermissionRule[] {
  const lines = frontmatterOf(role).split("\n");
  const start = lines.findIndex((line) => line === "permissions:");

  if (start === -1) {
    throw new Error(`Agent ${role} has no permissions list.`);
  }

  const rules: OpenCodePermissionRule[] = [];
  let pending: Partial<OpenCodePermissionRule> | undefined;

  const flush = (): void => {
    if (pending === undefined) {
      return;
    }

    if (pending.action === undefined || pending.resource === undefined || pending.effect === undefined) {
      throw new Error(`Agent ${role} has an incomplete permission rule: ${JSON.stringify(pending)}`);
    }

    rules.push({
      action: pending.action,
      resource: pending.resource,
      effect: pending.effect,
    });
    pending = undefined;
  };

  for (const line of lines.slice(start + 1)) {
    if (line === "") {
      break;
    }

    const match = /^\s+(?:-\s*)?(action|resource|effect):\s(".*")$/u.exec(line);
    const key = match?.[1];
    const quoted = match?.[2];

    if (key === undefined || quoted === undefined) {
      throw new Error(`Agent ${role} has an unparseable permission line: ${line}`);
    }

    if (key === "action") {
      flush();
    }

    pending = { ...pending, [key]: JSON.parse(quoted) as string };
  }

  flush();

  return rules;
}

describe("generated project configuration", () => {
  it("is minimal, valid JSON, and points at the OpenCode schema", () => {
    const config = renderOpenCodeProjectConfig();

    expect(JSON.parse(config)).toEqual({
      $schema: OPENCODE_CONFIG_SCHEMA,
      share: "disabled",
    });
    expect(config.endsWith("\n")).toBe(true);
  });

  it("configures no model, no permissions, and no defaults", () => {
    const config = JSON.parse(renderOpenCodeProjectConfig()) as Record<string, unknown>;

    expect(Object.keys(config).sort()).toEqual(["$schema", "share"]);
  });
});

describe("writing the generated files", () => {
  it("creates every file and reports what it wrote", async () => {
    const root = await makeRoot();
    const report = await writeOpenCodeProjectFiles(root);

    expect(report).toHaveLength(OPENCODE_ROLES.length + 1);
    expect(report.every((result) => result.outcome === "created")).toBe(true);
    expect(report.map((result) => result.path)).toEqual([
      ...OPENCODE_ROLES.map((role) => agentFileName(role)),
      OPENCODE_PROJECT_CONFIG_PATH,
    ]);

    for (const role of OPENCODE_ROLES) {
      const markdown = await readFile(join(root, agentFileName(role)), "utf8");

      expect(markdown).toBe(renderAgentMarkdown(role));
    }

    expect(await readFile(join(root, OPENCODE_PROJECT_CONFIG_PATH), "utf8")).toBe(
      renderOpenCodeProjectConfig(),
    );
  });

  it("reports unchanged files on a second run", async () => {
    const root = await makeRoot();

    await writeOpenCodeProjectFiles(root);
    const second = await writeOpenCodeProjectFiles(root);

    expect(second.every((result) => result.outcome === "unchanged")).toBe(true);
    expect(second).toHaveLength(OPENCODE_ROLES.length + 1);
  });

  it("reports a human edit as a conflict instead of reverting it", async () => {
    const root = await makeRoot();
    const target = join(root, OPENCODE_PROJECT_CONFIG_PATH);

    await writeOpenCodeProjectFiles(root);
    await writeFile(target, "{}\n", "utf8");

    const skipped = await writeOpenCodeProjectFiles(root);

    expect(skipped.find((result) => result.path === OPENCODE_PROJECT_CONFIG_PATH)?.outcome).toBe(
      "conflict",
    );
    expect(await readFile(target, "utf8")).toBe("{}\n");

    const forced = await writeOpenCodeProjectFiles(root, { force: true });

    expect(forced.find((result) => result.path === OPENCODE_PROJECT_CONFIG_PATH)?.outcome).toBe(
      "overwritten",
    );
    expect(await readFile(target, "utf8")).toBe(renderOpenCodeProjectConfig());
  });

  it("writes nothing when the project root is a symbolic link", async () => {
    const root = await makeRoot();
    const elsewhere = await makeRoot();
    const link = join(root, "linked-project");

    await symlink(elsewhere, link);

    await expect(writeOpenCodeProjectFiles(link)).rejects.toThrow(OpenCodeAdapterError);
    await expect(lstat(join(elsewhere, OPENCODE_PROJECT_CONFIG_PATH))).rejects.toThrow();
  });

  it("refuses to follow a symbolic link already sitting where a file goes", async () => {
    const root = await makeRoot();
    const elsewhere = await makeRoot();

    await writeFile(join(root, OPENCODE_PROJECT_CONFIG_PATH), "original\n", "utf8");
    await rm(join(root, OPENCODE_PROJECT_CONFIG_PATH));
    await symlink(join(elsewhere, "target.txt"), join(root, OPENCODE_PROJECT_CONFIG_PATH));

    await expect(writeOpenCodeProjectFiles(root, { force: true })).rejects.toThrow(
      OpenCodeAdapterError,
    );
  });

  it("creates the agent directory when the project has none", async () => {
    const root = await makeRoot();

    await writeOpenCodeProjectFiles(root);

    expect((await lstat(join(root, OPENCODE_AGENT_DIRECTORY))).isDirectory()).toBe(true);
    expect((await lstat(dirname(join(root, agentFileName("griller"))))).isDirectory()).toBe(true);
  });
});

describe("recorded install policy", () => {
  it("records a decision, not an implementation", () => {
    expect(INSTALL_POLICY_DECISION).toMatch(/must not vendor the framework/i);
    expect(INSTALL_POLICY_DECISION).toMatch(/only the configuration is version controlled/i);
  });

  it("records the tracking modes without implementing them", () => {
    expect(ARTIFACT_TRACKING_MODES).toEqual(["local", "summary", "all"]);
    expect(DEFAULT_ARTIFACT_TRACKING_MODE).toBe("local");
  });

  it("keeps the generated agents version controlled", () => {
    const controlled = VERSION_CONTROLLED_ENTRIES.map((entry) => entry.path);

    expect(controlled.some((path) => path.includes(".opencode/agents/*.md"))).toBe(true);
    expect(controlled.some((path) => path.includes(OPENCODE_PROJECT_CONFIG_PATH))).toBe(true);

    for (const entry of VERSION_CONTROLLED_ENTRIES) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("ignores run state rather than committing it", () => {
    const gitignore = DEFAULT_GITIGNORE_LINES.join("\n");

    expect(gitignore).toContain(".agentflow/features/");

    for (const entry of RUNTIME_GENERATED_ENTRIES) {
      expect(entry.path.startsWith(".agentflow/")).toBe(true);
      expect(gitignore).toContain(entry.path);
    }

    expect(gitignore).not.toContain(".opencode/agents");
  });

  it("never versions a run artifact", () => {
    for (const entry of VERSION_CONTROLLED_ENTRIES) {
      expect(entry.path.startsWith(".agentflow/features/")).toBe(false);
    }
  });

  it("names what must never be vendored into a project", () => {
    expect(VENDORED_FRAMEWORK_PATHS).toContain("core/");
    expect(VENDORED_FRAMEWORK_PATHS).toContain("orchestration/");
    expect(VENDORED_FRAMEWORK_PATHS).toContain("adapters/");
    expect(VENDORED_FRAMEWORK_PATHS).not.toContain(".opencode/");
  });
});
