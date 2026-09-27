import type { VerificationCapability, VerificationStage } from "@agent-workflow-kit/orchestration";
import { ProjectAdapterError } from "./errors.js";

/**
 * The command policy.
 *
 * A verification command is an executable plus an argument array, always. There is no function in
 * this adapter that takes a string and runs it, and no code path that concatenates one: a script
 * name containing `;`, `&&`, `|`, backticks, or `$(...)` is one argv entry, and it will be looked up
 * as one file name.
 *
 * The policy has three parts. `assertExecutable` and `assertArgs` refuse anything that smells like a
 * shell line. `assertPackageManagerInvocation` refuses the package-manager subcommands that install
 * dependencies, run lifecycle hooks, reach the network, or execute arbitrary code, so neither
 * detection nor project configuration can smuggle an install past it. And `FORBIDDEN_PACKAGE_SCRIPTS`
 * names the lifecycle hooks a package manager would otherwise run for a script invocation.
 */
export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;

export type NodePackageManager = (typeof PACKAGE_MANAGERS)[number];

export function isNodePackageManager(value: unknown): value is NodePackageManager {
  return typeof value === "string" && (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/** Lifecycle script names a package manager runs around install, publish, and pack. */
export const FORBIDDEN_PACKAGE_SCRIPTS: readonly string[] = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "preversion",
  "postversion",
];

/**
 * Package-manager subcommands that install, mutate the dependency tree, reach a registry, publish, or
 * run an arbitrary binary. Refused for every package manager, whether the command came from
 * detection or from project configuration.
 */
export const FORBIDDEN_PACKAGE_MANAGER_COMMANDS: readonly string[] = [
  "add",
  "audit",
  "ci",
  "create",
  "dedupe",
  "dlx",
  "exec",
  "fund",
  "i",
  "install",
  "install-test",
  "link",
  "pack",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "uninstall",
  "unlink",
  "update",
  "up",
  "upgrade",
  "x",
];

/** Shell metacharacters and quoting characters. None of them can appear in an executable name. */
const SHELL_METACHARACTERS = /[\s;&|<>$`'"\\()[\]{}*?!#~\n\r\0]/u;

const MAX_EXECUTABLE_LENGTH = 255;

/** A base name or a path, never a command line. */
export function assertExecutable(executable: string): void {
  if (executable.length === 0) {
    throw new ProjectAdapterError("command_invalid", "A verification command needs an executable.");
  }

  if (executable.length > MAX_EXECUTABLE_LENGTH) {
    throw new ProjectAdapterError(
      "command_invalid",
      `The executable name is longer than ${String(MAX_EXECUTABLE_LENGTH)} characters.`,
    );
  }

  if (executable.startsWith("-")) {
    throw new ProjectAdapterError(
      "command_invalid",
      `The executable "${executable}" may not start with a dash, which would make it an option.`,
    );
  }

  if (SHELL_METACHARACTERS.test(executable)) {
    throw new ProjectAdapterError(
      "command_invalid",
      `The executable "${executable}" contains a character that only has meaning to a shell. Commands are executed as an executable and an argument array, never through a shell.`,
    );
  }
}

/**
 * Argument arrays are not shell lines, so whitespace and quotes are legitimate content: a test runner
 * pattern, a filter, or a script path may contain any of them. A NUL byte is not, because it cannot
 * survive the exec boundary and would truncate the call.
 */
export function assertArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new ProjectAdapterError(
        "command_invalid",
        "A verification command argument contains a NUL byte.",
      );
    }
  }
}

/**
 * The capabilities each verification stage is allowed to cover, and the only pairing a configured
 * command may use.
 *
 * The sections of `agent-workflow.config.json` are the workflow's stages, and a command in a section
 * is a claim about what that stage checks. Letting `verification.static` declare `"capability":
 * "test"` would let a project answer the static stage with its test command, and the resulting
 * evidence would carry `capability: "test"` inside `static` evidence and be recorded as a static pass.
 * The refusal is a refusal rather than a silent move between sections, because quietly reclassifying
 * a command would hide the only sign that the configuration and the project disagree.
 */
export const CAPABILITIES_BY_STAGE: Readonly<Record<VerificationStage, readonly VerificationCapability[]>> = {
  static: ["lint", "typecheck", "build"],
  test: ["test"],
  runtime: ["runtime"],
};

export function capabilitiesForStage(stage: VerificationStage): readonly VerificationCapability[] {
  return CAPABILITIES_BY_STAGE[stage];
}

/** Whether `capability` is a capability the given verification stage may cover. */
export function capabilityBelongsToStage(
  stage: VerificationStage,
  capability: VerificationCapability,
): boolean {
  return CAPABILITIES_BY_STAGE[stage].includes(capability);
}

/**
 * Command shells, and the flags that make one of them execute a string instead of a file.
 *
 * The list is deliberately about *command-string mode* rather than about shells in general. `sh
 * ./verify.sh` and `python -m pytest` are legitimate ways to state a verification command and are
 * project configuration written by a human, so they stay allowed. What is refused is the shape that
 * turns the structured promise back into the thing it replaced: an executable plus a single argument
 * that a shell will parse as a command line.
 *
 * Only the shells that are on a supported platform's default `PATH` under a predictable name are
 * listed. A general-purpose interpreter such as `node -e` or `python -c` is deliberately not
 * included: it can evaluate a string too, but it is a project tool as often as a shell wrapper, and
 * a rule that tried to catch every evaluator would be a compatibility matrix rather than a boundary.
 */
const COMMAND_SHELLS: Readonly<Record<string, readonly string[]>> = {
  // POSIX and Unix shells. `busybox sh -c` and the `exec shell -c` form a shell reaches for.
  sh: ["-c"],
  bash: ["-c"],
  dash: ["-c"],
  zsh: ["-c"],
  ksh: ["-c"],
  ash: ["-c"],
  csh: ["-c"],
  tcsh: ["-c"],
  fish: ["-c"],
  busybox: ["sh", "-c"],
  // Windows. `cmd /c` and the PowerShell command-string parameters are the same idea.
  cmd: ["/c", "/k"],
  command: ["/c", "/k"],
  "command.com": ["/c", "/k"],
  "powershell": ["-command", "-encodedcommand", "-ec", "-e"],
  "powershell.exe": ["-command", "-encodedcommand", "-ec", "-e"],
  "pwsh": ["-command", "-encodedcommand", "-ec", "-e"],
  "pwsh.exe": ["-command", "-encodedcommand", "-ec", "-e"],
};

/** The final component of a path, in either separator style, without a Windows executable suffix. */
function commandBaseName(executable: string): string {
  const lastSlash = Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\"));
  const base = lastSlash === -1 ? executable : executable.slice(lastSlash + 1);

  return base.toLowerCase().endsWith(".exe") ? base.slice(0, -4).toLowerCase() : base.toLowerCase();
}

/**
 * The install and arbitrary-code boundary.
 *
 * `pnpm run lint` is a script invocation and is fine. `pnpm install`, `npm ci`, `bun x anything`, and
 * `pnpm run postinstall` are not, whatever their origin. This is checked on the argument array, so a
 * forbidden name cannot be reached by quoting, spacing, or nesting.
 */
export function assertPackageManagerInvocation(
  packageManager: NodePackageManager,
  args: readonly string[],
): void {
  const first = args[0];

  if (first === undefined) {
    return;
  }

  if (first === "run" || first === "run-script") {
    const script = args[1];

    if (script !== undefined && FORBIDDEN_PACKAGE_SCRIPTS.includes(script)) {
      throw new ProjectAdapterError(
        "command_forbidden",
        `The "${script}" script is a package lifecycle hook and is never executed by this framework.`,
      );
    }

    return;
  }

  if (FORBIDDEN_PACKAGE_MANAGER_COMMANDS.includes(first)) {
    throw new ProjectAdapterError(
      "command_forbidden",
      `The package-manager subcommand "${first}" is refused: this framework never installs dependencies, runs lifecycle hooks, publishes, or executes arbitrary code.`,
    );
  }
}

/**
 * The implicit-hook boundary.
 *
 * `npm run lint` does not only run `lint`. Every package manager that supports the convention will
 * look for `prelint` and `postlint` first, which makes the selected command a function of two
 * neighbouring script names the framework never chose and never read. That is an extra script
 * executing for a reason the operator cannot see, and it is exactly what the no-shell, no-implicit-code
 * guarantee is about.
 *
 * The policy is to block rather than to find a flag that suppresses the hook, and it is the same
 * block for all four managers. Suppressing hooks is version- and manager-specific, so a per-manager
 * flag table would be a compatibility claim this framework has no way to keep honest; a project that
 * needs one can state the command directly, in which case no package manager is involved and no hook
 * is implied.
 *
 * Returns the name of the hook that blocks the command, or `null` when the command is safe.
 */
export function implicitScriptHook(
  script: string | null,
  availableScripts: ReadonlySet<string> | readonly string[],
): string | null {
  if (script === null) {
    return null;
  }

  const declared = availableScripts instanceof Set ? availableScripts : new Set(availableScripts);

  for (const hook of [`pre${script}`, `post${script}`]) {
    if (declared.has(hook)) {
      return hook;
    }
  }

  return null;
}

/**
 * The shell-wrapper boundary.
 *
 * The adapter's structural promise is that a command is an executable and an argument array and never
 * a string a shell parses. `{ "executable": "/bin/sh", "args": ["-c", "..."] }` satisfies every
 * structural rule and throws the promise away, because the second argument is a command line and
 * `sh` will read it as one. So the interpreter is recognised by name and the command-string flag is
 * recognised by position, and the combination is refused with the flag that caused it.
 *
 * The base name is matched case-insensitively and with either separator style, so `C:\Windows\
 * System32\cmd.exe` is the same executable as `cmd` and is refused the same way.
 */
export function assertNoCommandShell(executable: string, args: readonly string[]): void {
  const commandStringFlags = COMMAND_SHELLS[commandBaseName(executable)];

  if (commandStringFlags === undefined) {
    return;
  }

  const lowered = args.map((arg) => arg.toLowerCase());
  const used = lowered.find((arg) => commandStringFlags.includes(arg));

  if (used === undefined) {
    return;
  }

  throw new ProjectAdapterError(
    "command_forbidden",
    `The command shell "${executable}" was given "${used}", which makes it execute a command string. A verification command is an executable and an argument array, and this framework refuses the shell that would turn the two back into a command line. State the tool directly, or use a flag this shell does not treat as a command.`,
  );
}

export interface PlannedVerificationCommand {
  /** Stable identity of the check, used as the evidence id. */
  readonly id: string;
  readonly capability: VerificationCapability;
  readonly stage: VerificationStage;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The project script this runs, when it came from detection or from a `run` invocation. */
  readonly script: string | null;
  readonly source: "detected" | "configured";
}

/**
 * Builds one command, applying the whole policy to it before it can exist.
 *
 * Every command in this adapter is created here, so there is exactly one place where the structural
 * form is decided and exactly one place where a forbidden invocation is refused.
 */
export function buildVerificationCommand(input: {
  readonly id: string;
  readonly capability: VerificationCapability;
  readonly stage: VerificationStage;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly script: string | null;
  readonly source: "detected" | "configured";
}): PlannedVerificationCommand {
  assertExecutable(input.executable);
  assertArgs(input.args);
  assertNoCommandShell(input.executable, input.args);

  if (isNodePackageManager(input.executable)) {
    assertPackageManagerInvocation(input.executable, input.args);
  }

  if (input.id.length === 0) {
    throw new ProjectAdapterError("command_invalid", "A verification command needs an id.");
  }

  return {
    id: input.id,
    capability: input.capability,
    stage: input.stage,
    label: input.label,
    executable: input.executable,
    args: [...input.args],
    cwd: input.cwd,
    script: input.script,
    source: input.source,
  };
}
