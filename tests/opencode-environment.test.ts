import {
  buildStageRunEnvironment,
  isScrubbedEnvironmentName,
  OPENCODE_CONFIG_INJECTION_VARIABLES,
  OPENCODE_CONFIG_SUPPRESSING_VARIABLES,
  OPENCODE_SCRUBBED_PREFIXES,
  OPENCODE_SCRUBBED_VARIABLES,
  OPENCODE_SMOKE_TEST_FORCED_ENVIRONMENT,
  createOpenCodeCliTransport,
  type OpenCodeTransportRequest,
} from "@agent-workflow-kit/opencode";
import { describe, expect, it } from "vitest";

/**
 * A stage run inherits the operator's shell environment because a credential is required, and it
 * removes the variables that could hand the CLI a different configuration or a different permission
 * policy. These tests pin the exact list, the two exemptions, and the guarantee that a caller cannot
 * reintroduce a scrubbed name through the transport.
 */
describe("the OpenCode stage environment", () => {
  it("names every scrubbed variable and prefix", () => {
    for (const name of [
      ...OPENCODE_CONFIG_INJECTION_VARIABLES,
      ...OPENCODE_CONFIG_SUPPRESSING_VARIABLES,
    ]) {
      expect(isScrubbedEnvironmentName(name)).toBe(true);
      expect(OPENCODE_SCRUBBED_VARIABLES).toContain(name);
    }

    for (const prefix of OPENCODE_SCRUBBED_PREFIXES) {
      expect(isScrubbedEnvironmentName(`${prefix}SOMETHING_NEW`)).toBe(true);
    }

    expect(OPENCODE_SCRUBBED_VARIABLES).toContain("OPENCODE_DISABLE_*");
    expect(OPENCODE_SCRUBBED_VARIABLES).toContain("OPENCODE_EXPERIMENTAL_*");
  });

  it("removes configuration injection, suppressing flags, and experimental gates", () => {
    const { env, scrubbed } = buildStageRunEnvironment({
      base: {
        OPENCODE_CONFIG: "/tmp/foreign.json",
        OPENCODE_CONFIG_DIR: "/tmp/foreign",
        OPENCODE_CONFIG_CONTENT: '{"permission":{}}',
        OPENCODE_TUI_CONFIG: "/tmp/tui.json",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_AUTO_SHARE: "true",
        OPENCODE_EXPERIMENTAL_LSP_TY: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        PATH: "/usr/bin",
      },
    });

    expect(Object.keys(env).filter((name) => name.startsWith("OPENCODE_"))).toEqual([]);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(scrubbed).toEqual([
      "OPENCODE_AUTO_SHARE",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "OPENCODE_DISABLE_LSP_DOWNLOAD",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_EXPERIMENTAL_LSP_TY",
      "OPENCODE_PURE",
      "OPENCODE_TUI_CONFIG",
    ]);
  });

  it("keeps credentials, the toolchain environment, and the project's own variables", () => {
    const { env, scrubbed } = buildStageRunEnvironment({
      base: {
        ANTHROPIC_API_KEY: "sk-ant-secret",
        OPENAI_API_KEY: "sk-secret",
        OPENCODE_API_KEY: "sk-opencode-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        HOME: "/home/dev",
        XDG_DATA_HOME: "/home/dev/.local/share",
        PATH: "/usr/bin",
        CI: "true",
        NODE_ENV: "development",
      },
    });

    expect(scrubbed).toEqual([]);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-secret",
      OPENCODE_API_KEY: "sk-opencode-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      HOME: "/home/dev",
      XDG_DATA_HOME: "/home/dev/.local/share",
      PATH: "/usr/bin",
      CI: "true",
      NODE_ENV: "development",
    });
  });

  it("never treats a credential-shaped name as scrubbable", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENCODE_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "MY_SECRET",
      "DISABLE_SOMETHING",
      "EXPERIMENTAL_thing",
    ]) {
      expect(isScrubbedEnvironmentName(name)).toBe(false);
    }
  });

  it("does not let a transport override reintroduce a scrubbed name", () => {
    const { env } = buildStageRunEnvironment({
      base: { PATH: "/usr/bin" },
      overrides: { OPENCODE_CONFIG: "/tmp/foreign.json", AGENT_WORKFLOW_KIT_TEST: "1" },
    });

    expect(env["OPENCODE_CONFIG"]).toBeUndefined();
    expect(env["AGENT_WORKFLOW_KIT_TEST"]).toBe("1");
  });

  it("applies framework-forced entries after the scrub, so an exempt name survives", () => {
    const { env, scrubbed } = buildStageRunEnvironment({
      base: { OPENCODE_DISABLE_MODELS_FETCH: "0", PATH: "/usr/bin" },
      forced: OPENCODE_SMOKE_TEST_FORCED_ENVIRONMENT,
    });

    expect(scrubbed).toEqual(["OPENCODE_DISABLE_MODELS_FETCH"]);
    expect(env["OPENCODE_DISABLE_MODELS_FETCH"]).toBe("1");
    expect(env["OPENCODE_DISABLE_AUTOUPDATE"]).toBe("1");
  });

  it("drops an undefined entry rather than passing it to spawn", () => {
    const { env } = buildStageRunEnvironment({ base: { PATH: "/usr/bin", EMPTY: undefined } });

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("reaches the child process without the injected configuration", async () => {
    const previous = process.env["OPENCODE_CONFIG"];

    process.env["OPENCODE_CONFIG"] = "/tmp/foreign.json";

    try {
      const transport = createOpenCodeCliTransport({
        command: process.execPath,
        extraArgs: ["-e", 'process.stdout.write(process.env.OPENCODE_CONFIG ?? "unset");'],
      });

      const result = await transport.run({
        agent: "plan",
        prompt: "plan",
        runtimeConfigDirectory: null,
        model: null,
        featureId: "feature-1",
        stage: "planning",
        role: "planner",
        fixReturnState: null,
        signal: null,
        workingDirectory: process.cwd(),
        timeoutMs: 20_000,
      } satisfies OpenCodeTransportRequest);

      expect(result.text).toBe("unset");
    } finally {
      if (previous === undefined) {
        delete process.env["OPENCODE_CONFIG"];
      } else {
        process.env["OPENCODE_CONFIG"] = previous;
      }
    }
  });
});
