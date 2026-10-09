import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENCODE_PROFILES,
  OpenCodeAdapterError,
  assertOpenCodeRuntimeConfigIntegrity,
  createOpenCodeRuntimeConfig,
  isOpenCodeAdapterError,
  permissionRulesForProfile,
  runtimeAgentFileForProfile,
  type OpenCodeProfile,
} from "@agent-workflow-kit/opencode";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Decision D-1 condition 2: the generated agent files are re-read and parsed after they are
 * written, and a file that does not carry exactly the intended rules refuses the stage.
 *
 * Task E showed the failure this closes: a hand-written agent config with broken YAML was read by
 * OpenCode as *no* frontmatter at all, which left the base allow-everything policy in force. So
 * "the bytes are what we wrote" is not the property under test - the property is "those bytes still
 * parse into the rules we intend, in the order we intend them", which is what the adapter now
 * re-derives from disk before every run.
 */

const roots: string[] = [];

async function makeRoot(prefix = "agent-workflow-kit-integrity-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function writtenConfig(): Promise<{ repository: string; runtime: string }> {
  const repository = await makeRoot();
  const runtime = await makeRoot();

  await createOpenCodeRuntimeConfig(repository, { directory: runtime, fresh: true });

  return { repository, runtime };
}

function agentFile(runtime: string, profile: OpenCodeProfile): string {
  return join(runtime, runtimeAgentFileForProfile(profile));
}

/** Applies a textual edit to one generated agent file and writes it back. */
async function breakAgentFile(
  runtime: string,
  profile: OpenCodeProfile,
  edit: (contents: string) => string,
): Promise<string> {
  const path = agentFile(runtime, profile);
  const contents = await readFile(path, "utf8");
  const broken = edit(contents);

  expect(broken, "the edit helper must actually change the file").not.toBe(contents);
  await writeFile(path, broken, "utf8");

  return path;
}

async function refusal(pending: Promise<unknown>): Promise<OpenCodeAdapterError> {
  try {
    await pending;
  } catch (error) {
    expect(isOpenCodeAdapterError(error)).toBe(true);

    return error as OpenCodeAdapterError;
  }

  throw new Error("the call resolved, so there was no refusal to assert on");
}

describe("the runtime configuration is re-read and checked before a run", () => {
  it("accepts the files exactly as the framework writes them, for both profiles", async () => {
    const { runtime } = await writtenConfig();

    await expect(assertOpenCodeRuntimeConfigIntegrity(runtime)).resolves.toBeUndefined();
  });

  it("refuses when the generated agent file is missing", async () => {
    const { runtime } = await writtenConfig();
    const path = agentFile(runtime, "agentflow-read");

    await rm(path);

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.code).toBe("opencode_configuration_tampered");
    expect(error.message).toContain("agentflow-read");
  });

  it("refuses malformed YAML instead of letting OpenCode fall back to its own defaults", async () => {
    const { runtime } = await writtenConfig();

    // The exact hazard from Task E: the sequence marker is dropped, so the rule is no longer a rule
    // and the block is not valid for the shape this framework writes. OpenCode reads a frontmatter
    // it cannot parse as absent, which is an unrestricted agent.
    const path = await breakAgentFile(runtime, "agentflow-read", (contents) =>
      contents.replace(`  - action: "*"`, `  action: "*"`),
    );

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.code).toBe("opencode_configuration_tampered");
    expect(error.message).toContain(path);
    expect(error.message).toMatch(/parse/i);
  });

  it("refuses a rule whose keys are not the quoted scalars the emitter writes", async () => {
    const { runtime } = await writtenConfig();

    await breakAgentFile(runtime, "agentflow-write", (contents) =>
      contents.replace(`    effect: "deny"`, `    effect: deny`),
    );

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.message).toMatch(/quoted scalar/i);
  });

  it("refuses duplicate keys inside one rule", async () => {
    const { runtime } = await writtenConfig();

    await breakAgentFile(runtime, "agentflow-read", (contents) =>
      contents.replace(
        `  - action: "shell"\n    resource: "*"\n    effect: "deny"`,
        `  - action: "shell"\n    resource: "*"\n    effect: "deny"\n    effect: "allow"`,
      ),
    );

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.message).toMatch(/duplicate/i);
  });

  it("refuses a duplicated permissions block", async () => {
    const { runtime } = await writtenConfig();

    await breakAgentFile(runtime, "agentflow-read", (contents) =>
      contents.replace("permissions:", "permissions:\npermissions:"),
    );

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.message).toMatch(/duplicate/i);
  });

  it("refuses a missing rule: the shell allow for pwd", async () => {
    const { runtime } = await writtenConfig();

    await breakAgentFile(runtime, "agentflow-write", (contents) =>
      contents.replace(
        `  - action: "shell"\n    resource: "pwd"\n    effect: "allow"\n`,
        "",
      ),
    );

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.message).toMatch(/rule/i);
    expect(error.message).toMatch(/shell/);
    expect(error.message).toMatch(/pwd/);
  });

  it("refuses a different rule order, even when every rule is still present", async () => {
    const { runtime } = await writtenConfig();

    await breakAgentFile(runtime, "agentflow-read", (contents) => {
      const deny = `  - action: "shell"\n    resource: "*"\n    effect: "deny"\n`;
      const allow = `  - action: "shell"\n    resource: "pwd"\n    effect: "allow"\n`;

      // The two shell rules are separated by the rest of the universal denials, so the swap moves
      // the deny block from where it is to immediately after the allow. Same rules, same count,
      // and under last-match-wins this grants every shell command instead of only `pwd`.
      expect(contents).toContain(deny);
      expect(contents).toContain(allow);

      return contents.replace(deny, "").replace(allow, `${allow}${deny}`);
    });

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.message).toMatch(/order/i);
  });

  it("refuses a widened rule: the deny narrowed to something narrower than everything", async () => {
    const { runtime } = await writtenConfig();

    await breakAgentFile(runtime, "agentflow-read", (contents) =>
      contents.replace(
        `  - action: "shell"\n    resource: "*"\n    effect: "deny"`,
        `  - action: "shell"\n    resource: "git *"\n    effect: "deny"`,
      ),
    );

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.message).toMatch(/rule/i);
    expect(error.message).toContain("git *");
  });

  it("names the profile and the file in every refusal, so the operator can act on it", async () => {
    const { runtime } = await writtenConfig();

    await breakAgentFile(runtime, "agentflow-write", (contents) => contents.replace("---\n", ""));

    const error = await refusal(assertOpenCodeRuntimeConfigIntegrity(runtime));

    expect(error.message).toContain("agentflow-write");
    expect(error.message).toContain(runtimeAgentFileForProfile("agentflow-write"));
  });

  it("does not mistake an untouched file for a broken one for either profile", async () => {
    const { runtime } = await writtenConfig();

    for (const profile of OPENCODE_PROFILES) {
      const contents = await readFile(agentFile(runtime, profile), "utf8");

      expect(contents).toContain(`- action: "shell"`);
      await expect(assertOpenCodeRuntimeConfigIntegrity(runtime)).resolves.toBeUndefined();
      expect(permissionRulesForProfile(profile).some((rule) => rule.action === "shell")).toBe(true);
    }
  });
});
