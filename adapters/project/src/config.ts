import { resolve } from "node:path";
import type { VerificationStage } from "@agent-workflow-kit/orchestration";
import { buildVerificationCommand, type PlannedVerificationCommand } from "./commands.js";
import { ProjectAdapterError } from "./errors.js";
import { isFile, isRecord, parseJsonFile, readProjectFile, resolveInsideRoot } from "./fs-safe.js";

/**
 * Explicit project configuration for verification commands.
 *
 * This is the only way to state a command the deterministic detection did not find, and it is the
 * whole reason detection can stay small: a project that uses a tool the adapter has never heard of
 * declares the command itself, and the framework still executes it as an executable plus an argument
 * array, still refuses lifecycle and install invocations, and still records the exit status.
 *
 * Two things are structurally impossible here. A shell line cannot be written: the only accepted
 * shape is `{ id, capability, executable, args }`, any other field is refused, and a `command` or
 * `shell` string has nowhere to go. And the file is project configuration, not agent output: the
 * OpenCode adapter denies writing it to every role, and this adapter never writes it.
 */
export const PROJECT_CONFIG_FILENAME = "agent-workflow.config.json";

export const PROJECT_CONFIG_SCHEMA_VERSION = 1 as const;

const CONFIG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const CONFIG_FIELDS: ReadonlySet<string> = new Set(["schemaVersion", "verification"]);

const COMMAND_FIELDS: ReadonlySet<string> = new Set(["id", "capability", "executable", "args", "cwd"]);

const SECTIONS: readonly { readonly key: "static" | "test" | "runtime"; readonly stage: VerificationStage }[] = [
  { key: "static", stage: "static" },
  { key: "test", stage: "test" },
  { key: "runtime", stage: "runtime" },
];

export interface ProjectVerificationConfig {
  readonly static: readonly PlannedVerificationCommand[];
  readonly test: readonly PlannedVerificationCommand[];
  readonly runtime: readonly PlannedVerificationCommand[];
  /** The absolute path of the file, or `null` when the project declares nothing. */
  readonly path: string | null;
}

function emptyConfig(path: string | null): ProjectVerificationConfig {
  return { static: [], test: [], runtime: [], path };
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
    capability !== "build" &&
    capability !== "runtime"
  ) {
    refuse(`The configured command "${id}" must name a capability: lint, typecheck, test, build, or runtime.`);
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
    script: null,
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
    if (!SECTIONS.some((section) => section.key === field)) {
      refuse(
        `The project verification configuration contains the unknown section "${field}". Only static, test, and runtime are read.`,
      );
    }
  }

  const commands: Record<"static" | "test" | "runtime", PlannedVerificationCommand[]> = {
    static: [],
    test: [],
    runtime: [],
  };

  for (const section of SECTIONS) {
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

  return { ...commands, path };
}
