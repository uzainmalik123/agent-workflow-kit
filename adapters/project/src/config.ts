import { resolve } from "node:path";
import type { RuntimeVerificationConfiguration, VerificationStage } from "@agent-workflow-kit/orchestration";
import {
  buildVerificationCommand,
  CAPABILITIES_BY_STAGE,
  capabilityBelongsToStage,
  packageManagerScriptOf,
  type PlannedVerificationCommand,
} from "./commands.js";
import { ProjectAdapterError } from "./errors.js";
import { isFile, isRecord, parseJsonFile, readProjectFile, resolveInsideRoot } from "./fs-safe.js";
import { parseRuntimeVerificationConfiguration } from "./runtime-config.js";

/**
 * Explicit project configuration for verification commands.
 *
 * This is the only way to state a command the deterministic detection did not find, and it is the
 * whole reason detection can stay small: a project that uses a tool the adapter has never heard of
 * declares the command itself, and the framework still executes it as an executable plus an argument
 * array, still refuses lifecycle and install invocations, and still records the exit status.
 *
 * Four things are structurally impossible here. A shell line cannot be written: the only accepted
 * shape is `{ id, capability, executable, args }` plus an optional `cwd`, any other field is refused,
 * and a `command` or `shell` string has nowhere to go. A shell wrapper cannot do the same thing one
 * level down, because `{ "executable": "/bin/sh", "args": ["-c", ...] }` is refused by name. A
 * command cannot claim a capability its section does not cover, so a test command cannot answer the
 * static stage. And a package manager can only be asked to `run` a script, because every other
 * subcommand either installs, mutates, publishes, or reaches a registry.
 *
 * Being explicit does not exempt a command from the implicit-hook policy either. `{ "executable":
 * "npm", "args": ["run", "lint"] }` is the same dispatch as the detected form, so a `prelint` script
 * blocks it; declaring the tool itself, as `eslint .`, is the way to run a check whose script has
 * neighbouring hooks. The file is also project configuration rather than agent output: the OpenCode
 * adapter denies writing it to every role, and this adapter never writes it.
 *
 * The `runtime` section is the one place the file is not an array of commands, and the difference is
 * the difference in what the stage does. Lint and tests are commands that exit; runtime verification is
 * a process with a lifetime, a readiness gate, and assertions made against it while it runs, so it is
 * an object. Its command is still a command and goes through the same policy in
 * `runtime-config.ts`, and its absence is reported as absent rather than discovered.
 */
export const PROJECT_CONFIG_FILENAME = "agent-workflow.config.json";

export const PROJECT_CONFIG_SCHEMA_VERSION = 1 as const;

const CONFIG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const CONFIG_FIELDS: ReadonlySet<string> = new Set(["schemaVersion", "verification"]);

const COMMAND_FIELDS: ReadonlySet<string> = new Set(["id", "capability", "executable", "args", "cwd"]);

/** The two sections that are lists of commands. `runtime` is an object and is parsed elsewhere. */
const COMMAND_SECTIONS: readonly { readonly key: "static" | "test"; readonly stage: VerificationStage }[] = [
  { key: "static", stage: "static" },
  { key: "test", stage: "test" },
];

const SECTION_KEYS: readonly string[] = [...COMMAND_SECTIONS.map((section) => section.key), "runtime"];

export interface ProjectVerificationConfig {
  readonly static: readonly PlannedVerificationCommand[];
  readonly test: readonly PlannedVerificationCommand[];
  /**
   * The project's declared runtime verification, or `null` when it declared none.
   *
   * `null` is the normal case for most repositories and never an error: a project that has not said
   * what to run has not asked to be checked at runtime, and the stage reports that as deferred rather
   * than discovering an application or passing on the verifier's word.
   */
  readonly runtime: RuntimeVerificationConfiguration | null;
  /** The absolute path of the file, or `null` when the project declares nothing. */
  readonly path: string | null;
}

function emptyConfig(path: string | null): ProjectVerificationConfig {
  return { static: [], test: [], runtime: null, path };
}

function refuse(message: string): never {
  throw new ProjectAdapterError("config_invalid", message);
}

function parseCommand(
  root: string,
  raw: unknown,
  stage: VerificationStage,
): PlannedVerificationCommand {
  if (!isRecord(raw)) {
    refuse(`A configured verification command in the "${stage}" section must be an object.`);
  }

  for (const field of Object.keys(raw)) {
    if (!COMMAND_FIELDS.has(field)) {
      refuse(
        `A configured verification command in the "${stage}" section contains the unknown field "${field}". Only id, capability, executable, args, and an optional cwd are accepted, so a command can only be an executable and an argument array.`,
      );
    }
  }

  const id = raw["id"];

  if (typeof id !== "string" || !CONFIG_ID_PATTERN.test(id)) {
    refuse(`A configured verification command id must match ${CONFIG_ID_PATTERN.source}.`);
  }

  const capability = raw["capability"];

  if (
    capability !== "lint" &&
    capability !== "typecheck" &&
    capability !== "test" &&
    capability !== "build"
  ) {
    refuse(
      `The configured command "${id}" must name a capability: lint, typecheck, test, or build. Runtime verification is not declared as a command, because it is a process with acceptance criteria rather than a command that exits; the "runtime" section states a command, a readiness condition, and checks instead.`,
    );
  }

  if (!capabilityBelongsToStage(stage, capability)) {
    const allowed = CAPABILITIES_BY_STAGE[stage]
      .map((entry) => `"${entry}"`)
      .join(", ");

    refuse(
      `The configured command "${id}" claims capability "${capability}" in the "${stage}" section, which may only cover ${allowed}. A stage runs the capabilities it is defined by, so a command claiming another one would be recorded as evidence about the wrong stage.`,
    );
  }

  const executable = raw["executable"];

  if (typeof executable !== "string") {
    refuse(`The configured command "${id}" must name an executable.`);
  }

  const args = raw["args"];

  if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
    refuse(`The configured command "${id}" must list its arguments as an array of strings.`);
  }

  const cwd = raw["cwd"];

  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    refuse(`The configured command "${id}" declares a cwd that is not a non-empty string.`);
  }

  return buildVerificationCommand({
    id,
    capability,
    stage,
    label: id,
    executable,
    args,
    cwd: cwd === undefined ? root : resolveInsideRoot(root, cwd),
    // A configured command that goes through a package manager is the same dispatch detection would
    // have produced, so the script it names is derived here. Being explicit about the command does not
    // make the manifest's `pre` and `post` scripts stop applying, and the hook policy reads the script
    // name rather than the command's source, so `npm run lint` is blocked by a `prelint` script
    // exactly as `pnpm run lint` is. A configured command that names the tool itself derives `null`
    // and involves no package manager, which is the documented way out.
    script: packageManagerScriptOf(executable, args),
    source: "configured",
  });
}

/**
 * Reads and validates the project configuration, if there is one.
 *
 * A file that exists and does not validate is a refusal, not a fallback to detection: silently
 * ignoring a misconfigured command would report a project as verified when its own configuration
 * says otherwise.
 */
export async function loadProjectVerificationConfig(root: string): Promise<ProjectVerificationConfig> {
  const path = resolve(root, PROJECT_CONFIG_FILENAME);

  if (!(await isFile(path))) {
    return emptyConfig(null);
  }

  const parsed = parseJsonFile(
    await readProjectFile(path, "The project verification configuration"),
    path,
    "The project verification configuration",
  );

  if (!isRecord(parsed)) {
    refuse(`The project verification configuration at "${path}" is not an object.`);
  }

  for (const field of Object.keys(parsed)) {
    if (!CONFIG_FIELDS.has(field)) {
      refuse(`The project verification configuration contains the unknown field "${field}".`);
    }
  }

  if (parsed["schemaVersion"] !== PROJECT_CONFIG_SCHEMA_VERSION) {
    refuse(
      `The project verification configuration declares schema version ${String(parsed["schemaVersion"])}; this framework reads version ${String(PROJECT_CONFIG_SCHEMA_VERSION)}.`,
    );
  }

  const verification = parsed["verification"];

  if (!isRecord(verification)) {
    refuse('The project verification configuration must contain a "verification" object.');
  }

  for (const field of Object.keys(verification)) {
    if (!SECTION_KEYS.includes(field)) {
      refuse(
        `The project verification configuration contains the unknown section "${field}". Only static, test, and runtime are read.`,
      );
    }
  }

  const commands: Record<"static" | "test", PlannedVerificationCommand[]> = {
    static: [],
    test: [],
  };

  for (const section of COMMAND_SECTIONS) {
    const entries = verification[section.key];

    if (entries === undefined) {
      continue;
    }

    if (!Array.isArray(entries)) {
      refuse(`The "${section.key}" verification section must be an array of commands.`);
    }

    const seen = new Set<string>();
    const built = entries.map((entry) => parseCommand(root, entry, section.stage));

    for (const command of built) {
      if (seen.has(command.id)) {
        refuse(`The "${section.key}" verification section repeats the command id "${command.id}".`);
      }

      seen.add(command.id);
    }

    commands[section.key] = built;
  }

  return { ...commands, runtime: parseRuntimeVerificationConfiguration(root, verification["runtime"]), path };
}
