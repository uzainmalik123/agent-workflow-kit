import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_RUN_FLAGS,
  TARGET_OPENCODE_MAJOR,
  advertisesFlag,
  describeCapabilities,
  describeSmokeTest,
  missingRunCapabilities,
  parseMajorVersion,
  probeOpenCodeCapabilities,
  runOpenCodeConfigSmokeTest,
  type OpenCodeCapabilities,
} from "@agent-workflow-kit/opencode";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-probe-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Writes a stand-in for the OpenCode CLI.
 *
 * The script is a plain Node program that answers the probe commands from a lookup table, so a test
 * can describe a hypothetical V1 or V2 binary exactly. It appends one JSON line per invocation to
 * `FAKE_OPENCODE_TRACE` when that variable is set, which is how a test proves which commands ran and
 * with which environment. Nothing here starts a server, reads a credential, or reaches the network.
 */
async function fakeBinary(replies: Readonly<Record<string, string>>): Promise<string> {
  const root = await makeRoot();
  const path = join(root, "fake-opencode.mjs");
  const script = [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    `const replies = ${JSON.stringify(replies)};`,
    'const key = process.argv.slice(2).join(" ");',
    "if (process.env.FAKE_OPENCODE_TRACE) {",
    "  appendFileSync(",
    "    process.env.FAKE_OPENCODE_TRACE,",
    "    JSON.stringify({",
    "      args: process.argv.slice(2),",
    "      modelsFetch: process.env.OPENCODE_DISABLE_MODELS_FETCH ?? null,",
    "      autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null,",
    "    }) + \"\\n\",",
    "  );",
    "}",
    "const reply = replies[key] ?? replies['*'];",
    "if (reply === undefined) { process.stderr.write('unknown command: ' + key); process.exit(1); }",
    "process.stdout.write(reply);",
  ].join("\n");

  await writeFile(path, `${script}\n`, { encoding: "utf8", mode: 0o755 });
  await chmod(path, 0o755);

  return path;
}

const V2_ROOT_HELP = [
  "Usage: opencode [options] [command]",
  "",
  "Options:",
  "  --pure            Run in pure mode",
  "  -h, --help        Display this help",
  "",
  "Commands:",
  "  run [message..]   Run opencode in non-interactive mode",
  "  debug             Debug commands",
].join("\n");

const V2_RUN_HELP = [
  "Usage: opencode run [options] [message..]",
  "",
  "Options:",
  "  --agent <agent>          Agent to use",
  "  --model <model>          Model to use in the format of provider/model",
  "  --format <format>        Output format (default: \"default\", options: \"text\", \"json\")",
  "  --dir <directory>        Directory to run in",
  "  --auto                   Automatically approve permissions",
].join("\n");

const V2_DEBUG_AGENT_HELP = [
  "Usage: opencode debug agent [options] [command]",
  "",
  "Commands:",
  "  list   List all configured agents",
].join("\n");

const V1_RUN_HELP = [
  "Usage: opencode run [options] [message..]",
  "",
  "Options:",
  "  --model <model>   Model to use",
  "  --dir <dir>       Directory to run in",
].join("\n");

const V2_REPLIES: Readonly<Record<string, string>> = {
  "--version": "2.0.6\n",
  "--help": V2_ROOT_HELP,
  "run --help": V2_RUN_HELP,
  "debug agent --help": V2_DEBUG_AGENT_HELP,
};

interface TracedCall {
  readonly args: readonly string[];
  readonly modelsFetch: string | null;
  readonly autoupdate: string | null;
}

async function readTrace(path: string): Promise<readonly TracedCall[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as TracedCall);
}

function unknownCapabilities(command: string): OpenCodeCapabilities {
  return {
    executableFound: false,
    command,
    version: null,
    majorVersion: null,
    versionSupportsV2: null,
    runCommandAvailable: null,
    agentFlagAvailable: null,
    formatFlagAvailable: null,
    formatJsonAvailable: null,
    dirFlagAvailable: null,
    modelFlagAvailable: null,
    autoFlagAvailable: null,
    pureFlagAvailable: null,
    debugAgentAvailable: null,
    failures: [],
  };
}

describe("reading flags out of help text", () => {
  it("matches a flag on a boundary, not a longer flag or a word", () => {
    expect(advertisesFlag(V2_RUN_HELP, "--agent")).toBe(true);
    expect(advertisesFlag(V2_RUN_HELP, "--agentfoo")).toBe(false);
    expect(advertisesFlag("use --agentfoo to change agents", "--agent")).toBe(false);
    expect(advertisesFlag("the --agent flag selects an agent", "--agent")).toBe(true);
  });

  it("does not match a flag that is not there", () => {
    expect(advertisesFlag(V1_RUN_HELP, "--agent")).toBe(false);
    expect(advertisesFlag(V1_RUN_HELP, "--format")).toBe(false);
  });
});

describe("probing a local binary", () => {
  it("reports a missing executable without guessing anything else", async () => {
    const root = await makeRoot();
    const capabilities = await probeOpenCodeCapabilities({
      command: join(root, "no-such-opencode"),
    });

    expect(capabilities.executableFound).toBe(false);
    expect(capabilities.version).toBeNull();
    expect(capabilities.formatJsonAvailable).toBeNull();
    expect(capabilities.failures.length).toBeGreaterThan(0);
    expect(missingRunCapabilities(capabilities)).toEqual([]);
  });

  it("reports every V2 run flag as present when the binary advertises them", async () => {
    const command = await fakeBinary(V2_REPLIES);
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.executableFound).toBe(true);
    expect(capabilities.version).toBe("2.0.6");
    expect(capabilities.runCommandAvailable).toBe(true);
    expect(capabilities.pureFlagAvailable).toBe(true);
    expect(capabilities.debugAgentAvailable).toBe(true);
    expect(capabilities.failures).toEqual([]);

    for (const flag of REQUIRED_RUN_FLAGS) {
      expect(missingRunCapabilities(capabilities)).not.toContain(flag);
    }

    expect(capabilities.formatJsonAvailable).toBe(true);
    expect(missingRunCapabilities(capabilities)).toEqual([]);
  });

  it("asks only version and help commands, and never runs a model", async () => {
    const root = await makeRoot();
    const trace = join(root, "trace.log");
    const command = await fakeBinary(V2_REPLIES);

    await probeOpenCodeCapabilities({ command, timeoutMs: 20_000, env: { FAKE_OPENCODE_TRACE: trace } });

    const seen = (await readTrace(trace)).map((call) => call.args.join(" "));

    expect(seen).toEqual(["--version", "--help", "run --help", "debug agent --help"]);
  });

  it("does not claim --format json when the binary only offers a plain format", async () => {
    const command = await fakeBinary({
      ...V2_REPLIES,
      "run --help": V2_RUN_HELP.replace(
        'Output format (default: "default", options: "text", "json")',
        'Output format (default: "default")',
      ),
    });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.formatFlagAvailable).toBe(true);
    expect(capabilities.formatJsonAvailable).toBe(false);
  });

  it("reads the major version out of the version string", () => {
    expect(parseMajorVersion("2.0.6")).toBe(2);
    expect(parseMajorVersion("1.18.18\n")).toBe(1);
    expect(parseMajorVersion("v2.1.0")).toBeNull();
    expect(parseMajorVersion("")).toBeNull();
    expect(parseMajorVersion(null)).toBeNull();
    expect(TARGET_OPENCODE_MAJOR).toBe(2);
  });

  it("cannot tell V1 from V2 by flags alone, and says so through the version", async () => {
    // A real V1.18.18 binary advertises every flag the adapter uses. The only thing that reveals it
    // is the version, which is why the version is probed separately.
    const command = await fakeBinary({
      "--version": "1.18.18\n",
      "--help": V2_ROOT_HELP,
      "run --help": V2_RUN_HELP,
      "debug agent --help": V2_DEBUG_AGENT_HELP,
    });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.executableFound).toBe(true);
    expect(capabilities.version).toBe("1.18.18");
    expect(capabilities.majorVersion).toBe(1);
    expect(capabilities.versionSupportsV2).toBe(false);
    expect(missingRunCapabilities(capabilities)).toEqual([]);
    expect(capabilities.failures.join(" ")).toContain("predates the V2 configuration");
  });

  it("accepts a newer major version as unread but unverified rather than compatible", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "--version": "3.0.0\n" });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.majorVersion).toBe(3);
    expect(capabilities.versionSupportsV2).toBe(true);
  });

  it("leaves version support unknown when the version string has no leading number", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "--version": "build 20260901\n" });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.majorVersion).toBeNull();
    expect(capabilities.versionSupportsV2).toBeNull();
  });

  it("reports the V1 run help as missing only the flags V1 really lacks", async () => {
    const command = await fakeBinary({
      ...V2_REPLIES,
      "--version": "1.18.18\n",
      "run --help": V1_RUN_HELP,
    });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.agentFlagAvailable).toBe(false);
    expect(capabilities.formatFlagAvailable).toBe(false);
    expect(capabilities.dirFlagAvailable).toBe(true);
    expect(missingRunCapabilities(capabilities)).toEqual(["--agent", "--format"]);
  });

  it("leaves a flag unknown when the help could not be read", async () => {
    const command = await fakeBinary({ "--version": "2.0.6\n", "--help": "no commands here" });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.formatFlagAvailable).toBeNull();
    expect(capabilities.formatJsonAvailable).toBeNull();
    expect(capabilities.failures).toContain(
      `${command} run --help did not succeed, so run flags are unknown.`,
    );
    expect(missingRunCapabilities(capabilities)).toEqual([]);
  });

  it("never turns an unreadable help into a missing flag", async () => {
    const command = await fakeBinary({ "--version": "2.0.6\n" });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.agentFlagAvailable).toBeNull();
    expect(missingRunCapabilities(capabilities)).toEqual([]);
  });

  it("describes a result in one log-safe line", async () => {
    const command = await fakeBinary(V2_REPLIES);
    const description = describeCapabilities(
      await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 }),
    );

    expect(description).toContain("OpenCode 2.0.6");
    expect(description).toContain("--agent: yes");
    expect(description.split("\n")).toHaveLength(1);
  });

  it("tells a missing binary how to install it without installing anything", async () => {
    const root = await makeRoot();
    const description = describeCapabilities(
      unknownCapabilities(join(root, "no-such-opencode")),
    );

    expect(description).toContain("@opencode/cli");
    expect(description).toContain("was not found");
  });
});

describe("the configuration smoke test", () => {
  const missing = (root: string): string => join(root, "no-such-opencode");

  it("skips itself when no OpenCode binary is present, and says why", async () => {
    const root = await makeRoot();
    const report = await runOpenCodeConfigSmokeTest({ command: missing(root), timeoutMs: 5_000 });

    expect(report.status).toBe("skipped");
    expect(report.reason).toContain(missing(root));
    expect(report.reason).toContain("was not validated");
    expect(report.agents).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(describeSmokeTest(report)).toContain("skipped");
  });

  it("leaves no directory behind after a skipped run", async () => {
    const root = await makeRoot();
    const report = await runOpenCodeConfigSmokeTest({ command: missing(root), timeoutMs: 5_000 });

    expect(report.directory).toBeNull();
  });

  it("keeps its temporary project when asked, and removes it otherwise", async () => {
    const command = await fakeBinary(V2_REPLIES);
    const kept = await runOpenCodeConfigSmokeTest({ command, keepDirectory: true, timeoutMs: 20_000 });

    expect(kept.directory).not.toBeNull();
    await expect(readFile(join(kept.directory ?? "", "opencode.json"), "utf8")).resolves.toContain("$schema");
    await rm(kept.directory ?? "", { recursive: true, force: true });

    const discarded = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(discarded.directory).toBeNull();
  });

  it("skips rather than fails when debug agent support cannot be determined", async () => {
    const command = await fakeBinary({ "--version": "2.0.6\n", "--help": "no commands here" });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.status).toBe("skipped");
    expect(report.failures).toEqual([]);
    expect(report.reason).toContain("debug agent");
  });

  it("skips a V1 binary rather than reporting its ignore of the generated rules as a failure", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "--version": "1.18.18\n", "*": "{}" });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.status).toBe("skipped");
    expect(report.failures).toEqual([]);
    expect(report.reason).toContain("1.18.18");
    expect(report.reason).toContain("silently ignore");
  });

  it("skips when the version cannot be read at all", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "--version": "build unknown\n" });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.status).toBe("skipped");
    expect(report.reason).toContain("version could not be read");
  });

  it("skips rather than fails when the binary advertises no debug agent", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "debug agent --help": "no such command" });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.status).toBe("skipped");
    expect(report.reason).toContain("does not advertise");
  });

  it("never runs a model, and asks the binary to skip its remote model catalog", async () => {
    const root = await makeRoot();
    const trace = join(root, "trace.log");
    const command = await fakeBinary({
      ...V2_REPLIES,
      "agent list": "planner (primary)\n",
      "*": "{}",
    });

    const report = await runOpenCodeConfigSmokeTest({
      command,
      timeoutMs: 20_000,
      keepDirectory: true,
      env: { FAKE_OPENCODE_TRACE: trace },
    });

    const seen = await readTrace(trace);
    const commands = seen.map((call) => call.args.join(" "));

    for (const call of seen) {
      expect(call.modelsFetch).toBe("1");
      expect(call.autoupdate).toBe("1");
    }

    // Every invocation is a version, help, or inspection command. `run --help` is a help command;
    // a stage run would be `run` with a prompt, and no such command appears.
    const allowed = ["--version", "--help", "run --help", "debug agent --help", "agent list"];

    for (const command of commands) {
      expect(allowed.includes(command) || command.startsWith("debug agent ")).toBe(true);
    }

    expect(commands).toContain("agent list");
    expect(commands.some((command) => command.startsWith("debug agent "))).toBe(true);
    expect(report.status).not.toBe("skipped");
    await rm(report.directory ?? "", { recursive: true, force: true });
  });
});
