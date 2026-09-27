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
   * This is not redundant with the flag fields. A V1 CLI advertises `--agent`, `--format`,
   * `--pure`, and `debug agent` just as V2 does, so a missing flag never reveals the version. What a
   * V1 CLI does is silently ignore a `permissions:` list, which leaves every role with the default
   * capability set. Reading the version is the only thing that catches that, and it is why this
   * field is not derived from the flag probe.
   */
  readonly versionSupportsV2: boolean | null;
  /** Whether `opencode run` is a command the binary advertises. */
  readonly runCommandAvailable: boolean | null;
  readonly agentFlagAvailable: boolean | null;
  readonly formatFlagAvailable: boolean | null;
  /** Whether `--format json` is advertised, which is what the event-stream transport needs. */
  readonly formatJsonAvailable: boolean | null;
  readonly dirFlagAvailable: boolean | null;
  readonly modelFlagAvailable: boolean | null;
  readonly autoFlagAvailable: boolean | null;
  /** `--pure` is a global flag, so it is read from the root help rather than the run help. */
  readonly pureFlagAvailable: boolean | null;
  /** Whether `opencode debug agent` exists, which the configuration smoke test needs. */
  readonly debugAgentAvailable: boolean | null;
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

/** The leading major version of an `opencode --version` string, or `null` if there is not one. */
export function parseMajorVersion(version: string | null): number | null {
  const match = /^(\d+)/u.exec(version?.trim() ?? "");

  if (match?.[1] === undefined) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);

  return Number.isNaN(major) ? null : major;
}

/** A run is only safe if the binary advertises every flag the invocation depends on. */
export const REQUIRED_RUN_FLAGS = ["--agent", "--format", "--dir"] as const;

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

function advertisesCommand(help: string, name: string): boolean {
  return new RegExp(`(^|[\\s|'\`"])${name}([\\s|,'"\`:]|$)`, "mu").test(help);
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
 * `opencode run --help`, and `opencode debug agent --help`. It never contacts a model, never
 * contacts the network, and never writes anything. A missing or broken binary is a normal result,
 * reported as `executableFound: false` with every other field left unknown.
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
      dirFlagAvailable: null,
      modelFlagAvailable: null,
      autoFlagAvailable: null,
      pureFlagAvailable: null,
      debugAgentAvailable: null,
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

  const debugHelp = await readHelp(
    command,
    ["debug", "agent", "--help"],
    "The OpenCode debug agent help probe",
    runOptions,
  );

  if (debugHelp.available !== true) {
    failures.push(`${command} debug agent --help did not succeed, so debug agent support is unknown.`);
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
    dirFlagAvailable: unadvertised(runHelp, "--dir"),
    modelFlagAvailable: unadvertised(runHelp, "--model"),
    autoFlagAvailable: unadvertised(runHelp, "--auto"),
    pureFlagAvailable: rootHelp.available === true ? advertisesFlag(rootHelp.text, "--pure") : null,
    debugAgentAvailable:
      debugHelp.available === true ? advertisesCommand(debugHelp.text, "agent") : null,
    failures,
  };
}

/**
 * The run flags a real stage run depends on, mapped to the field that reports each one, so a new
 * required flag has to be named in exactly one place.
 */
const RUN_FLAG_FIELDS: Readonly<Record<(typeof REQUIRED_RUN_FLAGS)[number], keyof OpenCodeCapabilities>> = {
  "--agent": "agentFlagAvailable",
  "--format": "formatFlagAvailable",
  "--dir": "dirFlagAvailable",
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
    `--dir: ${known(capabilities.dirFlagAvailable)},`,
    `--pure: ${known(capabilities.pureFlagAvailable)},`,
    `debug agent: ${known(capabilities.debugAgentAvailable)}.`,
  ].join(" ");
}
