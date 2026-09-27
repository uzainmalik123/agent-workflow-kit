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
  type OpenCodePermissionEffect,
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

  it("opens a YAML list item for every single rule", () => {
    // The regression this guards is the emitter writing `- ` only before the first rule, which folds
    // every later rule's keys into one mapping as repeats. That is not a formatting nit: YAML
    // answers duplicate keys in a mapping with an error, OpenCode rejects the whole frontmatter, and
    // every role falls back to an unrestricted default capability set.
    for (const role of OPENCODE_ROLES) {
      const expected = permissionRulesForRole(role);
      const listItems = frontmatterOf(role)
        .split("\n")
        .filter((line) => /^ {2}- action: /u.test(line));

      expect(listItems).toHaveLength(expected.length);
      expect(permissionRulesOf(role)).toHaveLength(expected.length);
    }
  });

  it("keeps every rule in its own mapping, with each key appearing once", () => {
    for (const role of OPENCODE_ROLES) {
      const block = frontmatterOf(role).split("\n");
      const start = block.findIndex((line) => line === "permissions:") + 1;
      const lines = block.slice(start).filter((line) => line !== "");

      // One rule is exactly three lines, and the keys come in policy order. Anything else means a
      // key was written into the previous rule's mapping.
      expect(lines.length % 3).toBe(0);

      for (let index = 0; index < lines.length; index += 3) {
        const [first, second, third] = lines.slice(index, index + 3) as [string, string, string];

        expect(first).toMatch(/^ {2}- action: ".*"$/u);
        expect(second).toMatch(/^ {4}resource: ".*"$/u);
        expect(third).toMatch(/^ {4}effect: ".*"$/u);
      }

      expect(lines).toHaveLength(permissionRulesForRole(role).length * 3);
    }
  });

  it("emits a list, not a mapping, so nothing is folded into one item", () => {
    for (const role of OPENCODE_ROLES) {
      const permissions = frontmatterOf(role)
        .split("\n")
        .slice(
          frontmatterOf(role).split("\n").findIndex((line) => line === "permissions:") + 1,
        )
        .filter((line) => /^ {2}\S/u.test(line));

      // Every line at the item indent opens a new mapping. If the emitter ever stops doing that,
      // these become `resource`/`effect` continuations and the count collapses to one.
      expect(permissions).toHaveLength(permissionRulesForRole(role).length);
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
 * Reads the generated `permissions:` list back out of the frontmatter, the way YAML reads it.
 *
 * The adapter emits YAML by hand, so the only way to know the file says what the policy says is to
 * parse what was actually written. This walks the block sequence structurally: a `- ` at the item
 * indent opens a new mapping, the keys indented under it belong to that mapping, and a second
 * occurrence of the same key inside one mapping is an error rather than an overwrite.
 *
 * That strictness is the whole point. An earlier version of this reader made the `- ` marker
 * optional and started a fresh rule at every `action:` line, which reconstructed the intended rule
 * list perfectly from frontmatter that was not valid YAML at all. OpenCode parses that file by
 * rejecting it, so every role silently fell back to its default capabilities and the real smoke test
 * reported all eleven roles as unrestricted. A reader that recovers the intent from broken output
 * cannot see the defect, so a repeated key inside one list item fails here for exactly the reason it
 * fails there.
 */
function permissionRulesOf(role: (typeof OPENCODE_ROLES)[number]): OpenCodePermissionRule[] {
  const lines = frontmatterOf(role).split("\n");
  const start = lines.findIndex((line) => line === "permissions:");

  if (start === -1) {
    throw new Error(`Agent ${role} has no permissions list.`);
  }

  type RuleKey = keyof OpenCodePermissionRule;
  // Mutable while the mapping is still being read; `OpenCodePermissionRule` is readonly because the
  // renderer has finished by the time anything holds one.
  type PartialRule = { -readonly [K in RuleKey]?: OpenCodePermissionRule[K] };

  const EFFECTS: readonly OpenCodePermissionEffect[] = ["allow", "deny", "ask"];
  const rules: OpenCodePermissionRule[] = [];
  let item: PartialRule | undefined;

  // Assigns through the key rather than returning a value, so each field keeps its own type: an
  // `effect` that is not one of the three real effects is rejected here, not silently accepted as
  // any string and compared away in a test assertion.
  const setValue = (target: PartialRule, line: string, key: RuleKey, quoted: string): void => {
    const value: unknown = JSON.parse(quoted);

    if (typeof value !== "string") {
      throw new Error(`Agent ${role} has a non-string ${key}: ${JSON.stringify(line)}`);
    }

    if (key === "effect") {
      if (!EFFECTS.includes(value as OpenCodePermissionEffect)) {
        throw new Error(`Agent ${role} has an effect that is not an effect: ${JSON.stringify(line)}`);
      }

      target.effect = value as OpenCodePermissionEffect;
      return;
    }

    if (key === "action") {
      target.action = value;
      return;
    }

    target.resource = value;
  };

  const flush = (): void => {
    if (item === undefined) {
      return;
    }

    if (
      Object.keys(item).length !== 3 ||
      item.action === undefined ||
      item.resource === undefined ||
      item.effect === undefined
    ) {
      throw new Error(
        `Agent ${role} has a permission list item that is not a complete rule: ${JSON.stringify(item)}`,
      );
    }

    rules.push({ action: item.action, resource: item.resource, effect: item.effect });
    item = undefined;
  };

  for (const line of lines.slice(start + 1)) {
    // A blank line ends the block: everything after it is the markdown body.
    if (line === "") {
      break;
    }

    const opened = /^ {2}- (action|resource|effect): ("(?:[^"\\]|\\.)*")$/u.exec(line);

    if (opened?.[1] !== undefined && opened[2] !== undefined) {
      flush();
      item = {};
      setValue(item, line, opened[1] as RuleKey, opened[2]);
      continue;
    }

    const continued = /^ {4}(action|resource|effect): ("(?:[^"\\]|\\.)*")$/u.exec(line);

    if (continued?.[1] === undefined || continued[2] === undefined) {
      throw new Error(`Agent ${role} has an unparseable permission line: ${JSON.stringify(line)}`);
    }

    if (item === undefined) {
      throw new Error(
        `Agent ${role} has a permission key before any list item opened: ${JSON.stringify(line)}`,
      );
    }

    const key = continued[1] as RuleKey;

    if (item[key] !== undefined) {
      throw new Error(
        `Agent ${role} repeats "${key}" inside one permission list item, so the frontmatter is not valid YAML and OpenCode ignores all of it: ${JSON.stringify(line)}`,
      );
    }

    setValue(item, line, key, continued[2]);
  }

  flush();

  return rules;
}

describe("generated project configuration", () => {
  it("is valid JSON and points at the OpenCode schema", () => {
    const config = renderOpenCodeProjectConfig();

    expect(JSON.parse(config)).toEqual({
      $schema: OPENCODE_CONFIG_SCHEMA,
      share: "disabled",
      plugins: ["-*", "opencode.*"],
    });
    expect(config.endsWith("\n")).toBe(true);
  });

  it("disables every non-OpenCode plugin and keeps the OpenCode namespace", () => {
    const config = JSON.parse(renderOpenCodeProjectConfig()) as { plugins: string[] };

    // V2 removed `--pure`, so plugin isolation is configuration. `-*` disables every plugin, and a
    // later entry re-enables one namespace, so a repository plugin under `.opencode/plugins/`
    // cannot load. Everything OpenCode ships lives under `opencode.`, including the agent loader
    // and the permission machinery the generated rules depend on.
    expect(config.plugins[0]).toBe("-*");
    expect(config.plugins).toContain("opencode.*");
    expect(config.plugins.indexOf("-*")).toBeLessThan(config.plugins.indexOf("opencode.*"));
  });

  it("configures no model, no permissions, and no defaults", () => {
    const config = JSON.parse(renderOpenCodeProjectConfig()) as Record<string, unknown>;

    expect(Object.keys(config).sort()).toEqual(["$schema", "plugins", "share"]);
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
