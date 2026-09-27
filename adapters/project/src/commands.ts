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
