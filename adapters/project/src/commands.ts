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
 * shell line. `assertPackageManagerInvocation` allows exactly one package-manager command form, so
 * neither detection nor project configuration can smuggle an install, a registry query, or a
 * shorthand lifecycle call past it. And `implicitScriptHook` names the lifecycle hooks a package
 * manager would otherwise run around a script invocation.
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
 * The package-manager subcommands this framework is willing to run.
 *
 * A blacklist cannot answer the question that matters here, which is "what did we not think of". The
 * allowlist can: a package manager is invoked to run exactly the script a project declared, and every
 * other subcommand is refused because it is not that. `npm test` is the sharpest example, because it
 * is shorthand for `npm run test` and reads like a test command while being a lifecycle dispatch; it
 * also runs whatever `pretest` and `posttest` declare, which is why it is not merely redundant here
 * but wrong. `npm view`, `npm search`, and `npm publish` reach a registry, `npm install` mutates the
 * tree, and `pnpm exec` runs an arbitrary binary. None of them is verification, and none of them is
 * listed, so none of them runs.
 *
 * `run-script` is the documented long form of the same dispatch, so it is allowed, and the script
 * name it names is subject to the same lifecycle-hook and implicit-hook rules as `run`.
 */
export const ALLOWED_PACKAGE_MANAGER_SUBCOMMANDS: readonly string[] = ["run", "run-script"];

const PACKAGE_MANAGER_EXECUTABLES: ReadonlySet<string> = new Set(PACKAGE_MANAGERS);

/**
 * Executables whose purpose is to run a package rather than a script.
 *
 * `npx` does not belong under the subcommand allowlist, even though it is spelled like a package
 * manager. The allowlist works because every subcommand on it is a real subcommand of a real manager,
 * so a name that is not one of them is refused; `npx` takes a package name in the first position
 * instead, which means `npx run lint` names a package called `run`. Allowing that on the strength of
 * the first argument would permit a download and an execution of the operator's choosing, and it would
 * do it while claiming to have applied the script allowlist. So it is refused outright, with its own
 * message, in every form.
 */
const ARBITRARY_PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npx"]);

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
 * The install, registry, and arbitrary-code boundary.
 *
 * `pnpm run lint` is a script invocation and is the only package-manager form that runs. `pnpm install`,
 * `npm ci`, `npm test`, `npm view`, and `pnpm exec anything` are not, whatever their origin. This is
 * checked on the argument array, so a refused subcommand cannot be reached by quoting, spacing, or
 * nesting, and it is matched on the executable's base name so that an absolute path to the same binary
 * is the same command.
 *
 * The allowed form is exactly `"<manager>" "run" "<script>"`, with nothing but forwarded arguments
 * after the script. That last part is not pedantry: `npm run --if-present lint` and
 * `npm run --silent lint` both run `lint`, and both put a flag where the script name belongs. A flag
 * there is consumed by the manager rather than forwarded, so it can change which script runs, whether
 * it is an error, or whether the `pre`/`post` hooks fire at all. A rule that allowed flags in that
 * position would decide the hook question by accident, so the form is fixed instead. Arguments after a
 * `--` are forwarded to the script and are left alone.
 */
export function assertPackageManagerInvocation(
  packageManager: string,
  args: readonly string[],
): void {
  const first = args[0];

  if (first === undefined) {
    // `<manager>` on its own prints help. It runs no project code, so there is nothing to allow or
    // refuse, and refusing it would only make the failure message worse.
    return;
  }

  if (!ALLOWED_PACKAGE_MANAGER_SUBCOMMANDS.includes(first)) {
    throw new ProjectAdapterError(
      "command_forbidden",
      `The package-manager subcommand "${first}" is refused. This framework invokes a package manager only as "${ALLOWED_PACKAGE_MANAGER_SUBCOMMANDS.map((entry) => `"${entry}"`).join(" or ")} <script>", because every other subcommand either installs or mutates the dependency tree, reaches a registry, publishes, or executes an arbitrary binary instead of running the check the project declared. State the tool directly.`,
    );
  }

  const script = args[1];

  if (script === undefined || script.startsWith("-")) {
    throw new ProjectAdapterError(
      "command_forbidden",
      `The "${first}" subcommand of "${packageManager}" needs a script name as its first argument, and a flag cannot be one. This framework accepts only "${packageManager} ${first} <script>" with nothing but forwarded arguments after the script, because a flag in the script's position is consumed by the manager instead of the script and can change which script runs, or whether the implicit pre and post hooks fire at all. State the tool directly.`,
    );
  }

  if (FORBIDDEN_PACKAGE_SCRIPTS.includes(script)) {
    throw new ProjectAdapterError(
      "command_forbidden",
      `The "${script}" script is a package lifecycle hook and is never executed by this framework.`,
    );
  }

  const forwarded = forwardedArguments(args);

  if (forwarded === null) {
    throw new ProjectAdapterError(
      "command_forbidden",
      `The arguments after "${packageManager} ${first} ${script}" include a flag that "${packageManager}" would consume itself rather than forward to "${script}". This framework accepts only arguments after a "--" separator, so that every argument the script receives is visible to the hook policy. State the tool directly.`,
    );
  }
}

/**
 * The arguments the script itself would receive, or `null` if the manager would take one of them first.
 *
 * Everything after a `--` is forwarded verbatim. Everything before it is the manager's own, and a
 * manager that reads `--ignore-scripts` or `--silent` or `--if-present` there changes the run in ways
 * the framework does not model, so it is refused rather than interpreted.
 */
function forwardedArguments(args: readonly string[]): readonly string[] | null {
  const separator = args.indexOf("--");

  const managerOwned = separator === -1 ? args.slice(2) : args.slice(2, separator);

  return managerOwned.some((argument) => argument.startsWith("-")) ? null : managerOwned;
}

/**
 * The script a package-manager invocation names, or `null` when the invocation names none.
 *
 * This is what makes a configured command answerable to the implicit-hook rule. A project that writes
 * `{ "executable": "npm", "args": ["run", "lint"] }` has asked for the same dispatch the detection
 * would have produced, and the `prelint` script it implies is the same implied script either way, so
 * the name is derived here and carried on the planned command rather than being assumed from the
 * command's `source`. A configured command that names the tool itself, such as `eslint .`, yields
 * `null` and involves no package manager at all.
 */
export function packageManagerScriptOf(
  executable: string,
  args: readonly string[],
): string | null {
  if (!PACKAGE_MANAGER_EXECUTABLES.has(commandBaseName(executable))) {
    return null;
  }

  const first = args[0];

  if (first === undefined || !ALLOWED_PACKAGE_MANAGER_SUBCOMMANDS.includes(first)) {
    return null;
  }

  const script = args[1];

  return script === undefined || script.startsWith("-") ? null : script;
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
  /**
   * The project script this runs. Detection states it, and a configured command's is derived from its
   * own argument array, so the implicit-hook policy sees the same fact in both cases.
   */
  readonly script: string | null;
  readonly source: "detected" | "configured";
}): PlannedVerificationCommand {
  assertExecutable(input.executable);
  assertArgs(input.args);
  assertNoCommandShell(input.executable, input.args);

  const baseName = commandBaseName(input.executable);

  if (ARBITRARY_PACKAGE_RUNNERS.has(baseName)) {
    throw new ProjectAdapterError(
      "command_forbidden",
      `The executable "${input.executable}" is refused. Every "npx" invocation names a package to download and run, so there is no form of it that is a check of this project; a subcommand allowlist does not apply to it, because the first argument is a package name rather than a subcommand. Name the tool itself, and its version is then whatever the project installed.`,
    );
  }

  if (PACKAGE_MANAGER_EXECUTABLES.has(baseName)) {
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
