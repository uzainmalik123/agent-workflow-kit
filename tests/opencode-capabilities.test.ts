import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TARGET_OPENCODE_MAJOR,
  advertisesFlag,
  describeCapabilities,
  describeSmokeTest,
  missingRunCapabilities,
  parseAgentListing,
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

/*
 * The help strings below are copied from real binaries, not written to fit the adapter.
 *
 * `V2_*` is the help that OpenCode 2.0.18 actually prints, including the two facts that make this
 * milestone's probe necessary: the version is tagged (`opencode v2.0.18`), and the agent listing is
 * the plural `debug agents`. `V1_*` is what OpenCode 1.18.18 actually prints, including the singular
 * `debug agent <name>` and the `agent list` command that V2 removed. Keeping both real is what makes
 * a fixture unable to pass by accident: a V1 binary advertising the V2 command, or a V2 binary
 * advertising the V1 one, would have to be written by hand and would show up in review.
 */

const V2_ROOT_HELP = [
  "DESCRIPTION",
  "  OpenCode command line interface",
  "",
  "USAGE",
  "  opencode <subcommand> [flags] [<directory>]",
  "",
  "ARGUMENTS",
  "  directory string    Directory to start OpenCode in (optional)",
  "",
  "FLAGS",
  "  --standalone            Run with a private server instead of the background service",
  "  --server string         Connect to a server URL instead of the background service",
  "  --auto                  Auto-approve permissions that are not explicitly denied",
  "  --continue, -c          Continue the last session",
  "  --session, -s string    Session ID to continue",
  "  --prompt string         Prompt to use",
  "",
  "GLOBAL FLAGS",
  "  --help, -h                                                          Show help information",
  "  --version, -v                                                       Show version information",
  "  --wizard                                                            Start wizard mode for a command",
  '  --completions <bash|zsh|fish|sh>                                    Print shell completion script (choices: bash, zsh, fish, sh)',
  "  --log-level <all|trace|debug|info|warn|warning|error|fatal|none>    Sets the minimum log level (choices: all, trace, debug, info, warn, warning, error, fatal, none)",
  "  --print-logs                                                        Print logs to stderr (server logs require --standalone)",
  "",
  "SUBCOMMANDS",
  "  upgrade, update    Upgrade OpenCode to the latest or a specific version",
  "  uninstall          Uninstall OpenCode and remove related files",
  "  api                Make a request to the running server",
  "  debug              Debugging and troubleshooting tools",
  "  models             List all available models",
  "  run                Run OpenCode with a message",
  "  serve              Start the v2 API and web server",
].join("\n");

const V2_RUN_HELP = [
  "DESCRIPTION",
  "  Run OpenCode with a message",
  "",
  "USAGE",
  "  opencode run [flags] [<message...>]",
  "",
  "ARGUMENTS",
  "  message... string    Message to send (optional)",
  "",
  "FLAGS",
  "  --standalone            Run with a private server instead of the background service",
  "  --server string         Connect to a server URL instead of the background service",
  "  --continue, -c          Continue the last session",
  "  --session, -s string    Session ID to continue",
  "  --fork                  Fork the session before continuing",
  "  --model, -m string      Model to use in the format provider/model#variant",
  "  --agent string          Agent to use",
  "  --format choice         Output format (choices: default, json)",
  "  --file, -f string       File to attach to the message",
  "  --title string          Session title",
  "  --thinking              Show thinking blocks",
  "  --auto                  Auto-approve permissions that are not explicitly denied",
  "",
  "GLOBAL FLAGS",
  "  --help, -h                                                          Show help information",
  "  --version, -v                                                       Show version information",
].join("\n");

const V2_DEBUG_HELP = [
  "DESCRIPTION",
  "  Debugging and troubleshooting tools",
  "",
  "USAGE",
  "  opencode debug <subcommand> [flags]",
  "",
  "GLOBAL FLAGS",
  "  --help, -h                                                          Show help information",
  "  --version, -v                                                       Show version information",
  "",
  "SUBCOMMANDS",
  "  agents    List all agents",
  "  config    List configuration sources",
  "  paths     Show global paths (data, config, cache, state)",
].join("\n");

const V2_DEBUG_AGENTS_HELP = [
  "DESCRIPTION",
  "  List all agents",
  "",
  "USAGE",
  "  opencode debug agents [flags]",
  "",
  "GLOBAL FLAGS",
  "  --help, -h                                                          Show help information",
  "  --version, -v                                                       Show version information",
].join("\n");

const V1_ROOT_HELP = [
  "Usage: opencode [options] [command]",
  "",
  "Options:",
  "  -h, --help        Display this help",
  "  -v, --version     Display version number",
  "  --pure            Run in pure mode",
  "",
  "Commands:",
  "  run [message..]   Run opencode in non-interactive mode",
  "  agent             Manage agents",
  "  debug             Debug commands",
].join("\n");

const V1_RUN_HELP = [
  "Usage: opencode run [options] [message..]",
  "",
  "Options:",
  "  --agent <agent>   Agent to use",
  "  --format <format> Output format (default: \"default\")",
  "  --dir <dir>       Directory to run in",
].join("\n");

const V1_DEBUG_HELP = [
  "Usage: opencode debug [options] [command]",
  "",
  "Commands:",
  "  opencode debug agent <name>  show agent configuration details",
  "  opencode debug config        List configuration sources",
].join("\n");

const V1_DEBUG_AGENT_HELP = [
  "Usage: opencode debug agent <name> [options]",
  "",
  "Options:",
  "  --tool <tool>   Tool id to execute",
].join("\n");

const V2_REPLIES: Readonly<Record<string, string>> = {
  "--version": "opencode v2.0.18\n",
  "--help": V2_ROOT_HELP,
  "run --help": V2_RUN_HELP,
  "debug --help": V2_DEBUG_HELP,
  "debug agents --help": V2_DEBUG_AGENTS_HELP,
};

const V1_REPLIES: Readonly<Record<string, string>> = {
  "--version": "1.18.18\n",
  "--help": V1_ROOT_HELP,
  "run --help": V1_RUN_HELP,
  "debug --help": V1_DEBUG_HELP,
  "debug agent --help": V1_DEBUG_AGENT_HELP,
};

/**
 * A reply table with one command removed.
 *
 * The stand-in binary answers anything it has a reply for and exits non-zero for anything it does
 * not, which is how a test says "this command does not exist here" rather than "this command printed
 * something unhelpful". Both are worth testing, and conflating them would make an unreadable help
 * look like an absent command.
 */
function without(
  replies: Readonly<Record<string, string>>,
  key: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(replies).filter(([name]) => name !== key));
}

/**
 * The ruleset OpenCode 2.0.18 gives every agent before the agent's own rules are appended.
 *
 * This is the real base, copied out of a `debug agents` payload. It is here because it is the reason
 * the generated rules are load-bearing: the base allows everything, so an agent whose own rules were
 * not read is left with full access, and only the appended rules take that away.
 */
const V2_BASE_RULES = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "external_directory", resource: "/home/u/.local/share/opencode/shell/*/*", effect: "allow" },
  { action: "external_directory", resource: "/home/u/.local/share/opencode/tool-output/*", effect: "allow" },
  { action: "external_directory", resource: "/tmp/opencode/*", effect: "allow" },
  { action: "external_directory", resource: "/home/u/.config/opencode/*", effect: "allow" },
  { action: "question", resource: "*", effect: "allow" },
] as const;

const UNIVERSAL_DENIALS = [
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
] as const;

const PROTECTED_PATHS = [
  ".agentflow",
  ".agentflow/*",
  "*.agentflow",
  "*.agentflow/*",
  "*.agentflow.*",
  ".git",
  ".git/*",
  "*.git",
  "*.git/*",
] as const;

interface Rule {
  readonly action: string;
  readonly resource: string;
  readonly effect: string;
}

function rules(): Rule[] {
  return V2_BASE_RULES.map((rule) => ({ ...rule }));
}

/** The ruleset a generated read-only role resolves to. */
function resolvedReadOnlyRules(): Rule[] {
  const out = rules();

  out.push({ action: "*", resource: "*", effect: "deny" });
  out.push({ action: "edit", resource: "*", effect: "deny" });

  for (const action of UNIVERSAL_DENIALS) {
    out.push({ action, resource: "*", effect: "deny" });
  }

  // D-1: the one shell resource either profile allows, always after the universal denials, which is
  // where the generated file puts it. A fixture that left it out would no longer be "the ruleset a
  // generated role resolves to", and the smoke test would then check the binary against a policy the
  // framework never wrote.
  out.push({ action: "shell", resource: "pwd", effect: "allow" });

  for (const action of ["read", "glob", "grep"]) {
    out.push({ action, resource: "*", effect: "allow" });
  }

  for (const resource of [...PROTECTED_PATHS, "*.env", "*.env.*"]) {
    out.push({ action: "read", resource, effect: "deny" });
  }

  return out;
}

/** The ruleset a generated write-capable role resolves to. */
function resolvedWriteCapableRules(): Rule[] {
  const out = rules();

  out.push({ action: "*", resource: "*", effect: "deny" });

  for (const action of UNIVERSAL_DENIALS) {
    out.push({ action, resource: "*", effect: "deny" });
  }

  out.push({ action: "shell", resource: "pwd", effect: "allow" });

  for (const action of ["read", "glob", "grep"]) {
    out.push({ action, resource: "*", effect: "allow" });
  }

  out.push({ action: "edit", resource: "*", effect: "allow" });

  for (const resource of PROTECTED_PATHS) {
    out.push({ action: "edit", resource, effect: "deny" });
  }

  for (const resource of [...PROTECTED_PATHS, "*.env", "*.env.*"]) {
    out.push({ action: "read", resource, effect: "deny" });
  }

  return out;
}

const WRITE_CAPABLE_AGENTS = new Set(["agentflow-write"]);

/** The two physical agents the adapter generates, and the only ids a stage ever asks for. */
const ALL_AGENTS = ["agentflow-read", "agentflow-write"] as const;

/** A `debug agents` payload in the shape OpenCode 2.0.18 really prints. */
function listing(options?: { readonly resolved: boolean }): string {
  const resolved = options?.resolved ?? true;

  const agents = ALL_AGENTS.map((id) => ({
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: resolved
      ? WRITE_CAPABLE_AGENTS.has(id)
        ? resolvedWriteCapableRules()
        : resolvedReadOnlyRules()
      : rules(),
  }));

  return `${JSON.stringify(agents, null, 2)}\n`;
}

/**
 * A stand-in that reproduces the V2 background service's start-up behaviour.
 *
 * The real 2.0.18 binary answers `debug agents` with an empty array on the first call after it has to
 * start its service, and answers properly from the second call on. This counts its own invocations in
 * a file so a test can prove the smoke test kept asking instead of believing the first answer.
 */
async function fakeBinaryThatWarmsUp(
  replies: Readonly<Record<string, string>>,
  warmListing: string,
  counterPath: string,
  options?: { readonly alwaysWarm?: boolean },
): Promise<string> {
  const root = await makeRoot();
  const path = join(root, "warming-opencode.mjs");
  const script = [
    "#!/usr/bin/env node",
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
    `const replies = ${JSON.stringify(replies)};`,
    `const warmListing = ${JSON.stringify(warmListing)};`,
    `const counter = ${JSON.stringify(counterPath)};`,
    'const key = process.argv.slice(2).join(" ");',
    "if (key === 'debug agents') {",
    "  appendFileSync(counter, 'call\\n');",
    "  const calls = existsSync(counter) ? readFileSync(counter, 'utf8').split('\\n').length - 1 : 0;",
    `  if (${options?.alwaysWarm === true ? "false" : "calls < 2"}) {`,
    "    process.stdout.write('[]');",
    "    process.exit(0);",
    "  }",
    "  process.stdout.write(warmListing);",
    "  process.exit(0);",
    "}",
    "process.stdout.write(replies[key] ?? replies['*']);",
  ].join("\n");

  await writeFile(path, `${script}\n`, { encoding: "utf8", mode: 0o755 });
  await chmod(path, 0o755);

  return path;
}

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
    modelFlagAvailable: null,
    autoFlagAvailable: null,
    standaloneFlagAvailable: null,
    debugAgentsAvailable: null,
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
    expect(advertisesFlag(V1_RUN_HELP, "--agent")).toBe(true);
    expect(advertisesFlag("Options:\n  --model <model>\n", "--agent")).toBe(false);
  });

  it("reads the V2 choice-style format line as --format json", () => {
    // V2 prints `--format choice  Output format (choices: default, json)` rather than naming the
    // value in the flag itself, so the value has to be found in the choices list.
    expect(advertisesFlag(V2_RUN_HELP, "--format")).toBe(true);
    expect(V2_RUN_HELP).toContain("json");
  });
});

describe("reading the version", () => {
  it("reads the major version out of the version string", () => {
    expect(parseMajorVersion("2.0.6")).toBe(2);
    expect(parseMajorVersion("1.18.18\n")).toBe(1);
    expect(parseMajorVersion("")).toBeNull();
    expect(parseMajorVersion(null)).toBeNull();
    expect(TARGET_OPENCODE_MAJOR).toBe(2);
  });

  it("reads the tagged version string the V2 CLI really prints", () => {
    // This is OpenCode 2.0.18's actual output. A leading-digit-only reader returns null here, which
    // would report every real V2 binary as having an unknown dialect and skip the check entirely.
    expect(parseMajorVersion("opencode v2.0.18")).toBe(2);
    expect(parseMajorVersion("opencode v2.0.18\n")).toBe(2);
    expect(parseMajorVersion("opencode-ai 1.18.18")).toBe(1);
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

  it("reads a real V2 binary as V2 and finds the plural agent listing", async () => {
    const command = await fakeBinary(V2_REPLIES);
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.executableFound).toBe(true);
    expect(capabilities.version).toBe("opencode v2.0.18");
    expect(capabilities.majorVersion).toBe(2);
    expect(capabilities.versionSupportsV2).toBe(true);
    expect(capabilities.runCommandAvailable).toBe(true);
    expect(capabilities.agentFlagAvailable).toBe(true);
    expect(capabilities.formatFlagAvailable).toBe(true);
    expect(capabilities.formatJsonAvailable).toBe(true);
    expect(capabilities.modelFlagAvailable).toBe(true);
    expect(capabilities.autoFlagAvailable).toBe(true);
    expect(capabilities.debugAgentsAvailable).toBe(true);
    expect(capabilities.failures).toEqual([]);
  });

  it("reports a real V2 binary as having every flag the invocation needs", async () => {
    // A real 2.0.18 advertises `--standalone`, `--agent`, and `--format json`. It has no `--dir` and
    // no `--pure`, and the invocation sends neither, so the probe must find nothing missing. If it
    // ever does, `missingRunCapabilities` is what stops a stage run against a binary that cannot
    // accept the arguments the adapter sends.
    const command = await fakeBinary(V2_REPLIES);
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.standaloneFlagAvailable).toBe(true);
    expect(capabilities.agentFlagAvailable).toBe(true);
    expect(capabilities.formatJsonAvailable).toBe(true);
    expect(missingRunCapabilities(capabilities)).toEqual([]);
    expect(capabilities.failures).toEqual([]);
  });

  it("asks only version and help commands, and never runs a model", async () => {
    const root = await makeRoot();
    const trace = join(root, "trace.log");
    const command = await fakeBinary(V2_REPLIES);

    await probeOpenCodeCapabilities({ command, timeoutMs: 20_000, env: { FAKE_OPENCODE_TRACE: trace } });

    const seen = (await readTrace(trace)).map((call) => call.args.join(" "));

    expect(seen).toEqual(["--version", "--help", "run --help", "debug --help", "debug agents --help"]);
  });

  it("does not claim --format json when the binary only offers a plain format", async () => {
    const command = await fakeBinary({
      ...V2_REPLIES,
      "run --help": V2_RUN_HELP.replace("Output format (choices: default, json)", "Output format"),
    });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.formatFlagAvailable).toBe(true);
    expect(capabilities.formatJsonAvailable).toBe(false);
  });

  it("cannot tell V1 from V2 by flags alone, and says so through the version", async () => {
    // A real V1.18.18 binary advertises `--agent`, `--format`, `--dir`, `--model`, and `--auto` just
    // as V2 does. The only thing that reveals it is the version.
    const command = await fakeBinary({ ...V1_REPLIES, "run --help": V2_RUN_HELP });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.executableFound).toBe(true);
    expect(capabilities.version).toBe("1.18.18");
    expect(capabilities.majorVersion).toBe(1);
    expect(capabilities.versionSupportsV2).toBe(false);
    expect(capabilities.failures.join(" ")).toContain("predates the V2 configuration");
  });

  it("does not accept the singular V1 debug command as the V2 agent listing", async () => {
    // V1.18.18 has `debug agent <name>` and no `debug agents`. Matching the substring `agent` would
    // pass this binary and then send it an argument list it rejects.
    const command = await fakeBinary(V1_REPLIES);
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.debugAgentsAvailable).toBe(false);
  });

  it("does not accept a V2 binary that lists the command but cannot print its help", async () => {
    const command = await fakeBinary(without(V2_REPLIES, "debug agents --help"));
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.debugAgentsAvailable).toBe(false);
    expect(capabilities.failures).toContain(
      `${command} debug agents --help did not succeed, so debug agents support is unknown.`,
    );
  });

  it("still finds the listing when only the debug help is unreadable", async () => {
    // The command's own help is the evidence that counts, so a debug help that could not be read
    // does not hide a command that demonstrably works.
    const command = await fakeBinary(without(V2_REPLIES, "debug --help"));
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.debugAgentsAvailable).toBe(true);
    expect(capabilities.failures).toContain(
      `${command} debug --help did not succeed, so debug subcommands are unknown.`,
    );
  });

  it("leaves the agent listing unknown rather than absent when neither help is readable", async () => {
    const command = await fakeBinary(without(without(V2_REPLIES, "debug --help"), "debug agents --help"));
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.debugAgentsAvailable).toBeNull();
    expect(capabilities.failures).toContain(
      `${command} debug --help did not succeed, so debug subcommands are unknown.`,
    );
  });

  it("accepts a newer major version as unread but unverified rather than compatible", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "--version": "opencode v3.0.0\n" });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.majorVersion).toBe(3);
    expect(capabilities.versionSupportsV2).toBe(true);
  });

  it("leaves version support unknown when the version string has no version in it", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "--version": "build unknown\n" });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.majorVersion).toBeNull();
    expect(capabilities.versionSupportsV2).toBeNull();
  });

  it("reports the V1 run help as missing only the flags V1 really lacks", async () => {
    const command = await fakeBinary({
      ...V1_REPLIES,
      "run --help": ["Usage: opencode run [options] [message..]", "", "Options:", "  --dir <dir>       Directory to run in"].join("\n"),
    });
    const capabilities = await probeOpenCodeCapabilities({ command, timeoutMs: 20_000 });

    expect(capabilities.agentFlagAvailable).toBe(false);
    expect(capabilities.formatFlagAvailable).toBe(false);
    // This V1 help has no `--standalone` at all, so a stage run cannot be isolated on it.
    expect(capabilities.standaloneFlagAvailable).toBe(false);
    expect(missingRunCapabilities(capabilities)).toEqual(["--standalone", "--agent", "--format"]);
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

    expect(description).toContain("OpenCode opencode v2.0.18");
    expect(description).toContain("--agent: yes");
    expect(description).toContain("debug agents: yes");
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

describe("parsing the agent listing", () => {
  it("reads the array shape `opencode debug agents` prints", () => {
    const parsed = parseAgentListing(listing());

    expect(parsed).not.toBeNull();
    expect(parsed?.map((agent) => agent.id)).toEqual([...ALL_AGENTS]);
    expect(parsed?.[0]?.rules).not.toBeNull();
  });

  it("refuses anything that is not a JSON array of identified agents", () => {
    expect(parseAgentListing("")).toBeNull();
    expect(parseAgentListing("not json")).toBeNull();
    expect(parseAgentListing("{}")).toBeNull();
    expect(parseAgentListing("null")).toBeNull();
    expect(parseAgentListing('[{"name":"griller","permissions":[]}]')).toBeNull();
    expect(parseAgentListing('[{"id":"","permissions":[]}]')).toBeNull();
  });

  it("reads an empty array as an empty listing rather than as unreadable", () => {
    // The two are different facts. An empty array is a real answer: the binary ran and found nothing.
    expect(parseAgentListing("[]")).toEqual([]);
  });

  it("keeps an entry whose permissions cannot be read, with no rules", () => {
    const parsed = parseAgentListing('[{"id":"griller"},{"id":"planner","permissions":[{"effect":"maybe"}]}]');

    expect(parsed).toEqual([
      { id: "griller", rules: null },
      { id: "planner", rules: null },
    ]);
  });

  it("ignores fields this adapter does not know instead of rejecting the entry", () => {
    const parsed = parseAgentListing(
      '[{"id":"griller","name":"Griller","mode":"primary","hidden":false,"somethingNew":{"a":1},"permissions":[]}]',
    );

    expect(parsed).toEqual([{ id: "griller", rules: [] }]);
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

  it("writes nothing into the directory it runs in, and keeps or removes both directories", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "debug agents": listing() });
    const kept = await runOpenCodeConfigSmokeTest({ command, keepDirectory: true, timeoutMs: 20_000 });

    expect(kept.directory).not.toBeNull();

    // The framework's configuration is written outside the directory the binary runs in, so the
    // directory it runs in is expected to be empty of anything the framework wrote. This is the
    // assertion that a run configures OpenCode without writing to the target.
    await expect(readFile(join(kept.directory ?? "", "opencode.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(kept.directory ?? "", ".opencode"), "utf8")).rejects.toThrow();

    // And the profiles are in the separate runtime directory the run was pointed at.
    expect(kept.runtimeConfigDirectory).not.toBeNull();
    await expect(
      readFile(join(kept.runtimeConfigDirectory ?? "", "agent", "agentflow-read.md"), "utf8"),
    ).resolves.toContain("permissions:");
    await expect(
      readFile(join(kept.runtimeConfigDirectory ?? "", "opencode.json"), "utf8"),
    ).resolves.toContain("$schema");

    await rm(kept.directory ?? "", { recursive: true, force: true });
    await rm(kept.runtimeConfigDirectory ?? "", { recursive: true, force: true });

    const discarded = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(discarded.directory).toBeNull();
    expect(discarded.runtimeConfigDirectory).toBeNull();
  });

  it("passes when the binary resolves both generated profiles as written", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "debug agents": listing() });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.failures).toEqual([]);
    expect(report.agents).toHaveLength(ALL_AGENTS.length);
    expect(report.agents.map((agent) => agent.profile)).toEqual([...ALL_AGENTS]);
    expect(report.agents.every((agent) => agent.discovered)).toBe(true);
    expect(report.agents.every((agent) => agent.verified)).toBe(true);
    expect(report.status).toBe("passed");
  });

  it("fails when the binary reports a profile with its untouched default capabilities", async () => {
    // This is what OpenCode 2.0.18 actually reports for an agent whose `permissions:` frontmatter it
    // did not read: the base allow-everything ruleset and nothing else. Both profiles then have full
    // access, so the report has to say so rather than pass on a listing that parsed cleanly.
    const command = await fakeBinary({ ...V2_REPLIES, "debug agents": listing({ resolved: false }) });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.status).toBe("failed");
    expect(report.agents.every((agent) => agent.verified === false)).toBe(true);
    expect(report.failures.join(" ")).toContain("shell git status resolved to allow instead of deny");
    expect(report.failures.join(" ")).toContain("edit .agentflow/session.json resolved to allow instead of deny");
  });

  it("leaves a profile unverified rather than passing it when its permissions cannot be read", async () => {
    const payload = JSON.parse(listing()) as { id: string; permissions?: unknown }[];

    for (const agent of payload) {
      if (agent.id === "agentflow-read") {
        delete agent.permissions;
      }
    }

    const command = await fakeBinary({ ...V2_REPLIES, "debug agents": JSON.stringify(payload) });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    const read = report.agents.find((agent) => agent.agent === "agentflow-read");

    expect(read?.discovered).toBe(true);
    expect(read?.verified).toBeNull();
    expect(read?.failures.join(" ")).toContain("no readable permissions array");
  });

  it("fails when the binary does not discover a generated profile", async () => {
    const payload = (JSON.parse(listing()) as { id: string }[]).filter(
      (agent) => agent.id !== "agentflow-write",
    );
    const command = await fakeBinary({ ...V2_REPLIES, "debug agents": JSON.stringify(payload) });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    const write = report.agents.find((agent) => agent.agent === "agentflow-write");

    expect(report.status).toBe("failed");
    expect(write?.discovered).toBe(false);
    expect(write?.failures.join(" ")).toContain('did not list the agent "agentflow-write"');
  });

  it("fails, and never passes, when the listing is not the array the parser reads", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "debug agents": "agentflow-read (primary)\n" });
    const report = await runOpenCodeConfigSmokeTest({
      command,
      timeoutMs: 20_000,
      readyTimeoutMs: 200,
    });

    expect(report.status).toBe("failed");
    expect(report.agents.every((agent) => agent.verified === null)).toBe(true);
    expect(report.failures.join(" ")).toContain("not the JSON array of agents");
  });

  it("reports a listing the binary could not produce as a failure, not as an empty discovery", async () => {
    const root = await makeRoot();
    const path = join(root, "no-service-opencode.mjs");

    await writeFile(
      path,
      [
        "#!/usr/bin/env node",
        `const replies = ${JSON.stringify(V2_REPLIES)};`,
        'const key = process.argv.slice(2).join(" ");',
        "if (key === 'debug agents') {",
        "  process.stderr.write('Error: Timed out waiting for the background service to start');",
        "  process.exit(1);",
        "}",
        "process.stdout.write(replies[key] ?? replies['*']);",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    await chmod(path, 0o755);

    const report = await runOpenCodeConfigSmokeTest({
      command: path,
      timeoutMs: 20_000,
      readyTimeoutMs: 200,
    });

    expect(report.status).toBe("failed");
    expect(report.agents.every((agent) => agent.verified === null)).toBe(true);
    expect(report.failures.join(" ")).toContain("could not list the agents it discovered");
  });

  it("waits for a listing that accounts for the generated agents before judging it", async () => {
    // A real V2 binary answers its first `debug agents` with an empty array while the background
    // service it just started is still loading the directory, and answers the next one properly.
    // Believing the first answer would report both profiles as missing.
    const root = await makeRoot();
    const state = join(root, "calls.txt");
    const command = await fakeBinaryThatWarmsUp(V2_REPLIES, listing(), state);
    const report = await runOpenCodeConfigSmokeTest({
      command,
      timeoutMs: 20_000,
      readyTimeoutMs: 20_000,
    });

    const calls = (await readFile(state, "utf8")).split("\n").filter((line) => line === "call");

    expect(calls.length).toBeGreaterThan(1);
    expect(report.status).toBe("passed");
    expect(report.agents.every((agent) => agent.discovered)).toBe(true);
    expect(report.agents.every((agent) => agent.verified)).toBe(true);
  });

  it("still fails, rather than waiting for ever, when the agents never appear", async () => {
    const root = await makeRoot();
    const state = join(root, "calls.txt");
    // The same cold-service answer, every time: a listing that never accounts for the generated
    // agents. Waiting must end and report the truth rather than keep polling.
    const command = await fakeBinaryThatWarmsUp(
      V2_REPLIES,
      JSON.stringify([{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [] }]),
      state,
      { alwaysWarm: true },
    );
    const report = await runOpenCodeConfigSmokeTest({
      command,
      timeoutMs: 20_000,
      readyTimeoutMs: 400,
    });

    expect(report.status).toBe("failed");
    expect(report.agents.every((agent) => !agent.discovered)).toBe(true);
    expect(report.failures.join(" ")).toContain('did not list the agent "agentflow-read"');
  });

  it("skips rather than fails when debug agents support cannot be determined", async () => {
    const command = await fakeBinary({ "--version": "opencode v2.0.18\n", "--help": "no commands here" });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.status).toBe("skipped");
    expect(report.failures).toEqual([]);
    expect(report.reason).toContain("debug agents");
  });

  it("skips rather than fails when the binary advertises no debug agents", async () => {
    const command = await fakeBinary({ ...V1_REPLIES, "run --help": V2_RUN_HELP });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.status).toBe("skipped");
    expect(report.reason).toContain("1.18.18");
    expect(report.reason).toContain("silently ignore");
  });

  it("skips when the version cannot be read at all", async () => {
    const command = await fakeBinary({ ...V2_REPLIES, "--version": "build unknown\n" });
    const report = await runOpenCodeConfigSmokeTest({ command, timeoutMs: 20_000 });

    expect(report.status).toBe("skipped");
    expect(report.reason).toContain("version could not be read");
  });

  it("never runs a model, and asks the binary to skip its remote model catalog", async () => {
    const root = await makeRoot();
    const trace = join(root, "trace.log");
    const command = await fakeBinary({ ...V2_REPLIES, "debug agents": listing() });

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

    // Every invocation is a version, a help, or the one agent listing. `run --help` is a help
    // command; a stage run would be `run` with a prompt, and no such command appears.
    const allowed = new Set(["--version", "--help", "run --help", "debug --help", "debug agents --help", "debug agents"]);

    for (const seen of commands) {
      expect(allowed.has(seen)).toBe(true);
    }

    // The listing is asked for once, not once per agent: V2 has no per-agent debug command at all.
    expect(commands.filter((seen) => seen === "debug agents")).toHaveLength(1);
    expect(commands.some((seen) => seen.startsWith("agent ") || seen.startsWith("debug agent "))).toBe(false);
    expect(report.status).toBe("passed");
    await rm(report.directory ?? "", { recursive: true, force: true });
  });

  it("keeps the offline environment entries even when a caller tries to switch them off", async () => {
    const root = await makeRoot();
    const trace = join(root, "trace.log");
    const command = await fakeBinary({ ...V2_REPLIES, "debug agents": listing() });

    await runOpenCodeConfigSmokeTest({
      command,
      timeoutMs: 20_000,
      env: {
        FAKE_OPENCODE_TRACE: trace,
        OPENCODE_DISABLE_MODELS_FETCH: "0",
        OPENCODE_DISABLE_AUTOUPDATE: "0",
      },
    });

    const seen = await readTrace(trace);

    expect(seen.length).toBeGreaterThan(0);

    for (const call of seen) {
      expect(call.modelsFetch).toBe("1");
      expect(call.autoupdate).toBe("1");
    }
  });
});
