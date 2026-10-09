import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  createOpenCodeRuntimeConfig,
  createOpenCodeStageExecutor,
  effectFor,
  defaultRuntimeConfigDirectory,
  isInsideRepository,
  OPENCODE_PROFILES,
  OPENCODE_PROJECT_CONFIG_PATH,
  OPENCODE_RUNTIME_AGENT_DIRECTORY,
  OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE,
  OpenCodeAdapterError,
  isOpenCodeAdapterError,
  permissionRulesForProfile,
  removeOpenCodeRuntimeConfig,
  renderOpenCodeRuntimeConfigFiles,
  runtimeAgentFileForProfile,
  type OpenCodePermissionRule,
  type OpenCodeProfile,
} from "@agent-workflow-kit/opencode";
import { WorkflowState } from "@agent-workflow-kit/core";
import { STAGE_DEFINITIONS } from "@agent-workflow-kit/orchestration";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeOpenCodeTransport } from "../fixtures/opencode-transport.js";
import { testWorkspaceContext } from "../fixtures/workspace.js";

/**
 * The move this file covers: the framework's OpenCode configuration lives in a directory it owns,
 * outside the target repository, and the target repository is only the working directory.
 *
 * The proofs are deliberately behavioural. "The files are written somewhere else" is a statement
 * about this module; "a run resolves the profile the framework wrote, from a repository that defines
 * nothing, with the permissions the framework states" is a statement about the property that was
 * actually being bought, and only the second one can fail when a path is renamed.
 */

const roots: string[] = [];

async function makeRoot(prefix = "agent-workflow-kit-runtime-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("where the framework configuration lives", () => {
  it("writes the two profiles and the minimum config into a directory outside the repository", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    const config = await createOpenCodeRuntimeConfig(repository, { directory: runtime, fresh: true });

    // The assertion that matters is the negative one: nothing was written into the checkout. If this
    // ever fails, the run is configuring the target by writing to it again.
    expect(config.repositoryRoot).toBe(resolve(repository));
    expect(isInsideRepository(config.directory, repository)).toBe(false);

    for (const name of ["agentflow-read", "agentflow-write", OPENCODE_PROJECT_CONFIG_PATH]) {
      await expect(readFile(join(repository, name), "utf8")).rejects.toThrow();
    }

    const written = await Promise.all(
      OPENCODE_PROFILES.map((profile) =>
        readFile(join(runtime, runtimeAgentFileForProfile(profile)), "utf8"),
      ),
    );

    expect(written).toEqual(OPENCODE_PROFILES.map((profile) => renderAgentFileContents(profile)));
  });

  it("writes the profiles where a configuration directory discovers agents, not where a project does", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await createOpenCodeRuntimeConfig(repository, { directory: runtime, fresh: true });

    // The project-local installation uses `.opencode/agents/`; a configuration directory uses
    // `agent/` or `agents/` directly beneath it. Copying the project path here would have produced a
    // directory the loader never reads and profiles that silently did not exist, so the constant is
    // pinned to the spelling that actually resolves.
    expect(OPENCODE_RUNTIME_AGENT_DIRECTORY).toBe("agent");
    expect(runtimeAgentFileForProfile("agentflow-read")).toBe("agent/agentflow-read.md");
    expect(OPENCODE_RUNTIME_AGENT_DIRECTORY).not.toContain(".opencode");
  });

  it("renders only the two profiles and the config, with no per-role prose", () => {
    const files = renderOpenCodeRuntimeConfigFiles();

    expect(files.map((file) => file.path)).toEqual([
      "agent/agentflow-read.md",
      "agent/agentflow-write.md",
      OPENCODE_PROJECT_CONFIG_PATH,
    ]);
  });

  it("refuses a configuration directory inside the repository", async () => {
    const repository = await makeRoot();

    for (const directory of [
      join(repository, ".opencode"),
      join(repository, "nested", "deeper"),
      // The repository root itself, which the previous comparison did not count as inside.
      repository,
      // A `../` path that resolves back inside the checkout.
      join(repository, "a", "..", "b"),
    ]) {
      // Checked through the error's own code rather than `toThrow(isOpenCodeAdapterError)`, because
      // `toThrow` takes an error class, not a type guard, and would have accepted the wrong error type.
      const error = await refusal(createOpenCodeRuntimeConfig(repository, { directory }));

      expect(error.code).toBe("unsafe_output_path");
    }

    await expect(
      createOpenCodeRuntimeConfig(repository, { directory: join(repository, ".opencode") }),
    ).rejects.toThrow(/inside the target repository/);
  });

  it("treats a sibling directory with a shared prefix as outside", async () => {
    const repository = join(await makeRoot(), "repo");

    // `/tmp/x/repo-other` starts with `/tmp/x/repo` as a string but is not inside it, which is the
    // mistake a plain `startsWith` on the resolved path would make.
    expect(isInsideRepository(join(repository, "other"), repository)).toBe(true);
    expect(isInsideRepository(`${repository}-other`, repository)).toBe(false);
    expect(isInsideRepository(join(dirname(repository), "elsewhere"), repository)).toBe(false);
    expect(isInsideRepository(repository, repository)).toBe(true);
  });

  it("defaults to a stable per-repository directory under the temporary directory", async () => {
    const repository = await makeRoot();
    const first = defaultRuntimeConfigDirectory(repository);
    const second = defaultRuntimeConfigDirectory(repository);
    const other = defaultRuntimeConfigDirectory(await makeRoot());

    // Stable, so two runs of the same repository reuse one directory; distinct per repository, so
    // two repositories can never resolve each other's profiles.
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(relative(resolve(repository), resolve(first)).startsWith("..")).toBe(true);
  });

  it("rewrites the files each time, so a stale file cannot survive a run", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await createOpenCodeRuntimeConfig(repository, { directory: runtime });

    const target = join(runtime, runtimeAgentFileForProfile("agentflow-read"));

    await writeFile(target, "---\ndescription: edited\n---\n", "utf8");

    const config = await createOpenCodeRuntimeConfig(repository, { directory: runtime });

    expect(config.files).toContain("agent/agentflow-read.md");
    expect(await readFile(target, "utf8")).toBe(renderAgentFileContents("agentflow-read"));
  });

  it("removes a directory it created and tolerates one that is already gone", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    const config = await createOpenCodeRuntimeConfig(repository, { directory: runtime, fresh: true });

    await removeOpenCodeRuntimeConfig(config.directory);
    await removeOpenCodeRuntimeConfig(config.directory);
    await expect(readFile(join(runtime, OPENCODE_PROJECT_CONFIG_PATH), "utf8")).rejects.toThrow();
  });

  it("refuses to write through a symbolic link rather than redirecting the generated file", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();
    const outside = await makeRoot();

    // A link on the agent directory: writing "into" it would have put the profiles in `outside`
    // while the caller was told the directory was `runtime`.
    await mkdir(runtime, { recursive: true });
    await symlink(outside, join(runtime, OPENCODE_RUNTIME_AGENT_DIRECTORY));

    await expect(
      createOpenCodeRuntimeConfig(repository, { directory: runtime }),
    ).rejects.toThrow(/symbolic link/);
    await expect(readFile(join(outside, "agentflow-read.md"), "utf8")).rejects.toThrow();
  });
});

describe("a repository cannot take over a profile's agent id", () => {
  it("refuses a repository that defines the profile's id with different rules", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await writeProjectAgent(repository, "agentflow-read", "---\ndescription: mine\n---\n");

    const error = await refusalFor(repository, runtime);

    // The refusal has to name the id and the file, because the id is what the run passes to
    // `--agent` and the file is what the operator has to rename or delete.
    expect(error.message).toContain("agentflow-read");
    expect(error.message).toContain(".opencode/agent/agentflow-read.md");
  });

  it("refuses a second definition even when the first one is the framework's own bytes", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    // A repository that already carries this framework's generated installation. The generated copy
    // is byte-identical, so on its own it grants nothing extra - but a second file resolving the same
    // id is a repository choosing between two definitions, and that is the same ambiguity.
    await writeProjectAgent(repository, "agentflow-write", renderAgentFileContents("agentflow-write"), ".opencode/agents");
    await writeProjectAgent(repository, "agentflow-write", "---\ndescription: mine\n---\n");

    const error = await refusalFor(repository, runtime, "agentflow-write");

    expect(error.message).toContain("agentflow-write");
  });

  it("allows the framework's own generated file to stay in a repository that has one", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    // A repository from before the move still has the generated profiles checked in. They are exactly
    // what the framework would write, so refusing them would break every existing installation for no
    // security gain - and they are allowed only because the bytes are compared, never because the
    // filename matches.
    await writeProjectAgent(repository, "agentflow-read", renderAgentFileContents("agentflow-read"), ".opencode/agents");

    const result = await runVerifier(repository, runtime);

    expect(result.error).toBeUndefined();
    expect(result.agent).toBe("agentflow-read");
  });

  it("allows an unrelated custom agent under its own id", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await writeProjectAgent(repository, "code-reviewer", "---\ndescription: theirs\n---\n");

    const result = await runVerifier(repository, runtime);

    expect(result.error).toBeUndefined();
  });

  it("still refuses a symlinked definition, which would decide the id from outside the repository", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();
    const outside = await makeRoot();

    await writeFile(join(outside, "agentflow-read.md"), "---\ndescription: elsewhere\n---\n", "utf8");
    await mkdir(join(repository, ".opencode", "agent"), { recursive: true });
    await symlink(
      join(outside, "agentflow-read.md"),
      join(repository, ".opencode", "agent", "agentflow-read.md"),
    );

    const error = await refusalFor(repository, runtime);

    expect(error.code).toBe("opencode_configuration_tampered");
    expect(error.message).toMatch(/symbolic link/);
  });
});

describe("repository configuration still cannot widen a profile", () => {
  it("refuses a repository config that sets a global permission", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await writeFile(
      join(repository, OPENCODE_PROJECT_CONFIG_PATH),
      JSON.stringify({ permission: { edit: "allow", bash: "allow" } }, null, 2),
      "utf8",
    );

    const error = await refusalFor(repository, runtime);

    // The repository stays the working directory, so its config is still loaded. The framework's
    // profiles are still not widened by it - that is refused rather than assumed.
    expect(error.message).toContain('"permission"');
    expect(error.message).toContain("Agent Workflow Kit");
  });

  it("allows a legitimate project preference, which is the repository's to make", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await writeFile(
      join(repository, OPENCODE_PROJECT_CONFIG_PATH),
      JSON.stringify({ model: "anthropic/claude-sonnet-4", theme: "system" }, null, 2),
      "utf8",
    );

    const result = await runVerifier(repository, runtime);

    expect(result.error).toBeUndefined();
  });

  it("allows a repository with no .opencode directory and no opencode.json at all", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    const result = await runVerifier(repository, runtime);

    // The normal case now: nothing in the checkout, and the run still resolves the profile the
    // framework wrote somewhere else.
    expect(result.error).toBeUndefined();
    expect(result.agent).toBe("agentflow-read");
  });
});

describe("the permissions the runtime configuration carries", () => {
  it("states the read profile as read-only, with the shell denied to every command but pwd", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await createOpenCodeRuntimeConfig(repository, { directory: runtime, fresh: true });

    const contents = await readFile(join(runtime, runtimeAgentFileForProfile("agentflow-read")), "utf8");

    // `edit` is the V2 action that covers reading and writing files, so denying it is what "read-only"
    // means here; there is no separate `write` action to check.
    expect(permissionRulesIn(contents)).toEqual(permissionRulesForProfile("agentflow-read"));
    expect(denied(permissionRulesIn(contents), "edit")).toBe(true);
    expect(denied(permissionRulesIn(contents), "shell")).toBe(true);
    expect(shellRulesOf(permissionRulesIn(contents))).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "pwd", effect: "allow" },
    ]);
  });

  it("states the write profile as able to edit and write, with the shell denied to every command but pwd", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await createOpenCodeRuntimeConfig(repository, { directory: runtime, fresh: true });

    const contents = await readFile(
      join(runtime, runtimeAgentFileForProfile("agentflow-write")),
      "utf8",
    );

    // Editing project files is what the write profile adds, and it adds nothing else: `shell` keeps
    // the same two rules the read profile has (deny `*`, allow `pwd`), so the profile that can
    // rewrite a file still cannot run a command that does anything.
    expect(permissionRulesIn(contents)).toEqual(permissionRulesForProfile("agentflow-write"));
    expect(allowed(permissionRulesIn(contents), "edit")).toBe(true);
    expect(denied(permissionRulesIn(contents), "shell")).toBe(true);
    expect(shellRulesOf(permissionRulesIn(contents))).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "pwd", effect: "allow" },
    ]);
  });

  it("is not widened by an allow a repository config contributes ahead of the profile's own rules", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    await createOpenCodeRuntimeConfig(repository, { directory: runtime, fresh: true });

    // This is what a real V2 run resolves when the working directory carries a config that grants
    // `edit` and `bash` globally: the repository's allows are merged in, before the profile's own
    // rules. It was measured against the binary, not assumed - OpenCode does merge them, so nothing
    // here may pretend the repository's config is invisible.
    //
    // What holds is the ordering. The profile's rules come after the injected allows, and V2 applies
    // the last match, so the profile still decides. Comparing the resolved set for equality would have
    // missed the point: the injected rules are supposed to be there, and they still lose.
    const injected: OpenCodePermissionRule[] = [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
    ];

    for (const profile of OPENCODE_PROFILES) {
      const merged: OpenCodePermissionRule[] = [
        { action: "*", resource: "*", effect: "deny" },
        ...injected,
        ...permissionRulesForProfile(profile),
      ];

      expect(effectFor(merged, "shell", "sh -c 'rm -rf /'"), `${profile} shell`).toBe("deny");
      expect(effectFor(merged, "shell", "git push"), `${profile} shell`).toBe("deny");
    }

    // The read profile is still read-only after the injection; the write profile still edits project
    // code and still refuses the protected paths.
    const readMerged: OpenCodePermissionRule[] = [
      { action: "*", resource: "*", effect: "deny" },
      ...injected,
      ...permissionRulesForProfile("agentflow-read"),
    ];
    const writeMerged: OpenCodePermissionRule[] = [
      { action: "*", resource: "*", effect: "deny" },
      ...injected,
      ...permissionRulesForProfile("agentflow-write"),
    ];

    for (const resource of ["src/app.ts", "README.md", ".git/config", ".agentflow/session.json"]) {
      expect(effectFor(readMerged, "edit", resource), `read edit ${resource}`).toBe("deny");
    }

    expect(effectFor(writeMerged, "edit", "src/app.ts")).toBe("allow");
    expect(effectFor(writeMerged, "edit", ".git/config")).toBe("deny");
    expect(effectFor(writeMerged, "edit", ".agentflow/session.json")).toBe("deny");
  });

  it("gives a stage the profile for the stage, never a role or a default agent", async () => {
    const repository = await makeRoot();
    const runtime = await makeRoot();

    // The read profile is the verifier's, and the id the transport receives is the id OpenCode
    // resolves. A role is not an agent any more, and a run must never fall back to a default agent.
    const read = await runVerifier(repository, runtime);

    expect(read.agent).toBe("agentflow-read");
  });
});

describe("the environment entry the transport is given", () => {
  it("points OpenCode at the framework directory through the variable V2 reads", () => {
    // `OPENCODE_CONFIG_DIR` is the supported mechanism rather than a flag, because V2 reads it as
    // `config.directory`; asserting the name here means a rename in this adapter and in the real run
    // cannot drift apart, because the transport builds its environment from this same constant.
    expect(OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE).toBe("OPENCODE_CONFIG_DIR");
  });
});

const READ_STAGE = {
  stage: "static_verification",
  role: "verifier",
  state: WorkflowState.StaticVerification,
  fixReturnState: null,
  fix: null,
} as const;

const WRITE_STAGE = {
  stage: "implementation",
  role: "implementer",
  state: WorkflowState.Implementing,
  fixReturnState: null,
  fix: null,
} as const;

function renderAgentFileContents(profile: OpenCodeProfile): string {
  const file = renderOpenCodeRuntimeConfigFiles().find(
    (candidate) => candidate.path === runtimeAgentFileForProfile(profile),
  );

  if (file === undefined) {
    throw new Error(`no rendered runtime file for ${profile}`);
  }

  return file.contents;
}

/**
 * The `permissions` YAML block, parsed back out of the generated file.
 *
 * The file is the artifact that ends up in front of OpenCode, so the permissions this asserts are
 * read back out of those bytes rather than taken from the function that produced them. Comparing the
 * parsed list to `permissionRulesForProfile` is what ties the two together: if the renderer ever wrote
 * a rule the permission module does not know about, this fails instead of the run.
 */
function permissionRulesIn(contents: string): ReadonlyArray<Record<string, string>> {
  const lines = contents.split("\n");
  const start = lines.findIndex((line) => line.trim() === "permissions:");

  if (start === -1) {
    throw new Error("the generated profile has no permissions list");
  }

  const rules: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;

  for (const line of lines.slice(start + 1)) {
    if (/^\s+-\s/.test(line)) {
      current = {};
      rules.push(current);
      const [, rest] = /^\s+-\s+\w+:\s*(.*)$/.exec(line) ?? [];

      if (rest === undefined) {
        throw new Error(`unreadable permission rule: ${line}`);
      }

      current["action"] = yamlValue(rest);
      continue;
    }

    const match = /^\s+(\w+):\s*(.*)$/.exec(line);

    if (match === null || current === null) {
      break;
    }

    current[match[1] ?? ""] = yamlValue(match[2] ?? "");
  }

  return rules;
}

/** One YAML scalar, which this renderer always writes quoted. */
function yamlValue(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];

  if ((first === '"' || first === "'") && trimmed.endsWith(first) && trimmed.length > 1) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function denied(rules: readonly Record<string, string>[], action: string): boolean {
  // A rule on the action itself, wide open and explicitly denied, so a repository's global default
  // cannot stand in for one. The last match wins in V2, so the position of the rule matters as much as
  // its presence; these are the narrow "this action, everywhere" rules rather than a protected path.
  return rules.some(
    (rule) => rule["action"] === action && rule["effect"] === "deny" && rule["resource"] === "*",
  );
}

function allowed(rules: readonly Record<string, string>[], action: string): boolean {
  return rules.some(
    (rule) => rule["action"] === action && rule["effect"] === "allow" && rule["resource"] === "*",
  );
}

/**
 * Every `shell` rule, in the order the file declares them.
 *
 * Order is the policy under last-match-wins, so a set or a "some rule exists" check would both miss
 * what D-1 asserts: the deny has to be first and the single allow after it.
 */
function shellRulesOf(rules: readonly Record<string, string>[]): Record<string, string>[] {
  return rules.filter((rule) => rule["action"] === "shell");
}

/** The adapter's own refusal, or a failure if the call resolved instead. */
async function refusal(pending: Promise<unknown>): Promise<OpenCodeAdapterError> {
  try {
    await pending;
  } catch (error) {
    expect(isOpenCodeAdapterError(error)).toBe(true);

    return error as OpenCodeAdapterError;
  }

  throw new Error("the call resolved, so there was no refusal to assert on");
}

async function writeProjectAgent(
  repository: string,
  agent: string,
  contents: string,
  directory = ".opencode/agent",
): Promise<void> {
  await mkdir(join(repository, directory), { recursive: true });
  await writeFile(join(repository, directory, `${agent}.md`), contents, "utf8");
}

/** Runs the read profile to refusal, and returns the refusal when there is one. */
async function refusalFor(
  repository: string,
  runtime: string,
  profile: OpenCodeProfile = "agentflow-read",
): Promise<{ readonly code: string; readonly message: string }> {
  const result = await runVerifier(repository, runtime, profile);

  expect(isOpenCodeAdapterError(result.error)).toBe(true);

  return result.error as OpenCodeAdapterError;
}

/**
 * Runs one stage against a repository, with the framework configuration in `runtime`.
 *
 * The transport is a fake that answers the response protocol, so nothing here calls a model: the
 * properties under test are all decided before the transport is reached, which is exactly why a
 * refusal has to arrive without a request being sent.
 */
async function runVerifier(
  repository: string,
  runtime: string,
  profile: OpenCodeProfile = "agentflow-read",
): Promise<{ readonly error: unknown; readonly agent: string | null }> {
  // The stage is chosen by profile, because a refusal has to be attributed to the profile about to
  // run: the read profile is what the verifier needs, and the write profile is what an implementation
  // stage would need.
  const target = profile === "agentflow-read" ? READ_STAGE : WRITE_STAGE;
  const transport = createFakeOpenCodeTransport();
  const executor = createOpenCodeStageExecutor({
    transport,
    projectRoot: repository,
    runtimeConfigDirectory: runtime,
  });

  try {
    await executor.execute({
      feature: {
        featureId: "F-001",
        title: "Google OAuth / API",
        slug: "google-oauth-api",
        state: target.state,
        createdAt: "2026-04-05T06:07:08.000Z",
        updatedAt: "2026-04-05T06:07:08.000Z",
      },
      stage: target.stage,
      role: target.role,
      state: target.state,
      context: [],
      outputs: STAGE_DEFINITIONS[target.stage].outputs,
      fixReturnState: target.fixReturnState,
      fix: target.fix,
      workspace: testWorkspaceContext({ repositoryRoot: repository, workingDirectory: repository }),
    });

    return { error: undefined, agent: transport.lastRequest()?.agent ?? null };
  } catch (error) {
    return { error, agent: transport.lastRequest()?.agent ?? null };
  }
}
