import { DEFAULT_OPENCODE_COMMAND } from "./cli-transport.js";
import { runProcess } from "./process.js";

/**
 * What the locally installed OpenCode binary can actually do.
 *
 * Every flag field is deliberately three-valued: `true` when the flag was seen in the CLI's own help
 * output, `false` when the help was read and the flag was absent, and `null` when the probe could
 * not read the help at all. `null` never becomes `false`, because "we could not check" and "the
 * flag is not there" lead to different decisions: the first is a reason to look again, the second
 * is a reason to change the invocation.
 */
export interface OpenCodeCapabilities {
  /** Whether an executable was found and started. */
  readonly executableFound: boolean;
  /** The executable that was probed. */
  readonly command: string;
  /** The reported version, when `opencode --version` succeeded. */
  readonly version: string | null;
  /** The major version parsed out of that string, or `null` when it could not be read. */
  readonly majorVersion: number | null;
  /**
   * Whether the binary is new enough to read the V2 configuration this adapter generates.
   *
   * This is not redundant with the flag fields, and the reason is specific. V1 advertises
   * `--agent`, `--format`, and `--auto` exactly as V2 does, and V1 does advertise a debug subcommand
   * for agents, so a flag probe alone cannot tell the two CLIs apart. What V1 does with a
   * `permissions:` list is silently ignore it, which leaves every role with the default capability
   * set. Reading the version is the only thing that catches that, and it is why this field is not
   * derived from the flag probe.
   */
  readonly versionSupportsV2: boolean | null;
  /** Whether `opencode run` is a command the binary advertises. */
  readonly runCommandAvailable: boolean | null;
  readonly agentFlagAvailable: boolean | null;
  readonly formatFlagAvailable: boolean | null;
  /** Whether `--format json` is advertised, which is what the event-stream transport needs. */
  readonly formatJsonAvailable: boolean | null;
  readonly modelFlagAvailable: boolean | null;
  readonly autoFlagAvailable: boolean | null;
  /**
   * Whether `--standalone` is advertised, which `buildOpenCodeInvocation` always passes.
   *
   * This is required, not optional. A stage run has to be isolated from any background service, so a
   * binary that cannot start a private one is a binary this adapter must refuse rather than run a
   * stage against a shared, already-loaded configuration.
   */
  readonly standaloneFlagAvailable: boolean | null;
  /**
   * Whether `opencode debug agents` exists, which the configuration smoke test needs.
   *
   * This is the plural, model-free listing V2 provides. V1 has no such command: it offers
   * `opencode agent list` and a singular `opencode debug agent <name>`, and V2 has neither. A probe
   * that only looked for the substring `agent` would accept the V1 command and then send V2 an
   * argument list it rejects, so the check is anchored on the exact subcommand name.
   */
  readonly debugAgentsAvailable: boolean | null;
  /** Human-readable reasons a field could not be determined. */
  readonly failures: readonly string[];
}

export interface ProbeOpenCodeCapabilitiesOptions {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly inheritEnv?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 10_000;

/** The OpenCode major version whose configuration this adapter generates. */
export const TARGET_OPENCODE_MAJOR = 2;

/** The one OpenCode command that reports resolved agent permissions without calling a model. */
export const DEBUG_AGENTS_COMMAND = "agents";

/**
 * The leading major version of an `opencode --version` string, or `null` if there is not one.
 *
 * The two supported CLIs do not print the same thing. V1 prints the bare number (`1.18.18`) while V2
 * prints a prefixed, explicitly tagged one (`opencode v2.0.18`). Matching only a leading digit would
 * read every V2 binary as having no version at all, which is the one answer that cannot be acted on:
 * it would report the dialect as unknown and skip the configuration check instead of reading it.
 * Leading non-numeric text is therefore skipped, and the first number after it is the major version.
 */
export function parseMajorVersion(version: string | null): number | null {
  const match = /^\D*(\d+)/u.exec(version?.trim() ?? "");

  if (match?.[1] === undefined) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);

  return Number.isNaN(major) ? null : major;
}

/**
 * The flags `buildOpenCodeInvocation` passes, in the order it passes them.
 *
 * This list and the transport's argument builder are the same contract written down once. `--dir`
 * and `--pure` are absent on purpose: V2 removed both, the working directory comes from the child
 * process's own `cwd`, and plugin isolation is the generated `plugins` configuration rather than a
 * flag. Every entry here is something the transport sends unconditionally, so a binary that lacks
 * one cannot be driven correctly and is reported as missing rather than being run anyway.
 */
export const REQUIRED_RUN_FLAGS = ["--standalone", "--agent", "--format"] as const;

interface HelpProbe {
  readonly available: boolean | null;
  readonly text: string;
}

async function readHelp(
  command: string,
  args: readonly string[],
  label: string,
  options: Required<Pick<ProbeOpenCodeCapabilitiesOptions, "timeoutMs">> &
    Pick<ProbeOpenCodeCapabilitiesOptions, "inheritEnv" | "env" | "signal">,
): Promise<HelpProbe> {
  try {
    const result = await runProcess(command, args, {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 1_000_000,
      ...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      label,
    });

    return { available: true, text: `${result.stdout}\n${result.stderr}` };
  } catch {
    return { available: null, text: "" };
  }
}

/**
 * A flag counts as advertised only when the help text shows it as a flag of the probed command.
 * Matching `--agent` against `--agentfoo` or against prose would report a capability that does not
 * exist, so the check is anchored on a flag boundary.
 */
export function advertisesFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[\\s|'\`"])${escaped}([\\s|,'"\`:]|$)`, "mu").test(help);
}

function unadvertised(help: HelpProbe, flag: string): boolean | null {
  return help.available === true ? advertisesFlag(help.text, flag) : null;
}

/**
 * `--format json` needs both halves: the flag, and `json` offered as one of its values. Reporting the
 * flag alone would claim an event-stream transport the binary cannot serve.
 */
function advertisesJsonFormat(help: HelpProbe): boolean | null {
  if (help.available !== true) {
    return null;
  }

  if (!advertisesFlag(help.text, "--format")) {
    return false;
  }

  return /json/iu.test(help.text);
}

/**
 * Inspects a locally installed OpenCode binary.
 *
 * It runs only safe, local, provider-free commands: `opencode --version`, `opencode --help`,
 * `opencode run --help`, `opencode debug --help`, and `opencode debug agents --help`. It never
 * contacts a model, never contacts the network, and never writes anything. In particular the
 * `debug agents` probe is given `--help`, which prints the subcommand's usage and returns without
 * starting the background service that the real listing needs. A missing or broken binary is a
 * normal result, reported as `executableFound: false` with every other field left unknown.
 */
export async function probeOpenCodeCapabilities(
  options?: ProbeOpenCodeCapabilitiesOptions,
): Promise<OpenCodeCapabilities> {
  const command = options?.command ?? DEFAULT_OPENCODE_COMMAND;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS;
  const runOptions = {
    timeoutMs,
    ...(options?.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
    ...(options?.env === undefined ? {} : { env: options.env }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  };
  const failures: string[] = [];

  let version: string | null = null;
  let versionRead = false;

  try {
    const result = await runProcess(command, ["--version"], {
      ...runOptions,
      label: "The OpenCode version probe",
    });

    version = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    versionRead = true;

    if (version === "") {
      version = null;
    }
  } catch {
    failures.push(`${command} --version did not succeed, so no version was read.`);
  }

  const majorVersion = parseMajorVersion(version);
  const versionSupportsV2 = majorVersion === null ? null : majorVersion >= TARGET_OPENCODE_MAJOR;

  if (majorVersion !== null && !versionSupportsV2) {
    failures.push(
      `The installed OpenCode is version ${String(majorVersion)}, which predates the V2 configuration this adapter generates.`,
    );
  }

  if (!versionRead) {
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
      failures,
    };
  }

  const rootHelp = await readHelp(command, ["--help"], "The OpenCode help probe", runOptions);

  if (rootHelp.available !== true) {
    failures.push(`${command} --help did not succeed, so global flags are unknown.`);
  }

  const runHelp = await readHelp(command, ["run", "--help"], "The OpenCode run help probe", runOptions);

  if (runHelp.available !== true) {
    failures.push(`${command} run --help did not succeed, so run flags are unknown.`);
  }

  const debugHelp = await readHelp(command, ["debug", "--help"], "The OpenCode debug help probe", runOptions);

  if (debugHelp.available !== true) {
    failures.push(`${command} debug --help did not succeed, so debug subcommands are unknown.`);
  }

  // The listing's own help is asked for with `--help` so the probe stays a pure help read. Running
  // `debug agents` for real would be a different kind of command: V2 answers it from a background
  // service, so it is the smoke test's call to make, not the capability probe's.
  const debugAgentsHelp = await readHelp(
    command,
    ["debug", DEBUG_AGENTS_COMMAND, "--help"],
    `The OpenCode debug ${DEBUG_AGENTS_COMMAND} help probe`,
    runOptions,
  );

  if (debugAgentsHelp.available !== true) {
    failures.push(
      `${command} debug ${DEBUG_AGENTS_COMMAND} --help did not succeed, so debug ${DEBUG_AGENTS_COMMAND} support is unknown.`,
    );
  }

  return {
    executableFound: true,
    command,
    version,
    majorVersion,
    versionSupportsV2,
    runCommandAvailable: runHelp.available,
    agentFlagAvailable: unadvertised(runHelp, "--agent"),
    formatFlagAvailable: unadvertised(runHelp, "--format"),
    formatJsonAvailable: advertisesJsonFormat(runHelp),
    modelFlagAvailable: unadvertised(runHelp, "--model"),
    autoFlagAvailable: unadvertised(runHelp, "--auto"),
    // `--standalone` is a global flag, so it is read from the root help rather than the run help.
    standaloneFlagAvailable: rootHelp.available === true ? advertisesFlag(rootHelp.text, "--standalone") : null,
    debugAgentsAvailable: advertiseDebugAgents(debugHelp, debugAgentsHelp),
    failures,
  };
}

/**
 * `debug agents` is available when its own help is readable, and is definitively unavailable when it
 * is not and the debug help was readable too.
 *
 * The command's own help is the evidence that counts, because it is the only one that answers
 * "does this command work here". The debug help is the corroborating list, and it settles the case
 * where the command's help could not be read at all: a readable list that does not include the
 * subcommand, or a command that will not start, is a real `false` rather than a reason to look again.
 * `null` is reserved for the one case with no evidence either way, which is when neither help could
 * be read.
 */
function advertiseDebugAgents(debugHelp: HelpProbe, debugAgentsHelp: HelpProbe): boolean | null {
  if (debugAgentsHelp.available === true) {
    return true;
  }

  return debugHelp.available === true ? false : null;
}

/**
 * The run flags a real stage run depends on, mapped to the field that reports each one, so a new
 * required flag has to be named in exactly one place.
 */
const RUN_FLAG_FIELDS: Readonly<Record<(typeof REQUIRED_RUN_FLAGS)[number], keyof OpenCodeCapabilities>> = {
  "--standalone": "standaloneFlagAvailable",
  "--agent": "agentFlagAvailable",
  "--format": "formatFlagAvailable",
};

/**
 * The required flags this binary is known not to have.
 *
 * Only `false` is reported. A `null` means the probe could not read the help, and reporting that as
 * a missing flag would turn "look again" into a decision the caller did not make.
 */
export function missingRunCapabilities(capabilities: OpenCodeCapabilities): readonly string[] {
  return REQUIRED_RUN_FLAGS.filter((flag) => capabilities[RUN_FLAG_FIELDS[flag]] === false);
}

/** A one-line, log-safe summary of a probe result. */
export function describeCapabilities(capabilities: OpenCodeCapabilities): string {
  if (!capabilities.executableFound) {
    return `OpenCode was not found at "${capabilities.command}". Install the current OpenCode V2 CLI with \`npm install -g @opencode/cli\`.`;
  }

  const known = (value: boolean | null): string => (value === null ? "unknown" : value ? "yes" : "no");

  const supported =
    capabilities.versionSupportsV2 === true
      ? ""
      : capabilities.versionSupportsV2 === false
        ? " (predates the V2 configuration this adapter generates)"
        : " (version unknown)";

  return [
    `OpenCode ${capabilities.version ?? "of unknown version"} at "${capabilities.command}"${supported}.`,
    `run: ${known(capabilities.runCommandAvailable)},`,
    `--agent: ${known(capabilities.agentFlagAvailable)},`,
    `--format json: ${known(capabilities.formatJsonAvailable)},`,
    `--standalone: ${known(capabilities.standaloneFlagAvailable)},`,
    `debug agents: ${known(capabilities.debugAgentsAvailable)}.`,
  ].join(" ");
}
