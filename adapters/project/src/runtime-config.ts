import {
  buildVerificationCommand,
  packageManagerScriptOf,
  type PlannedVerificationCommand,
} from "./commands.js";
import { ProjectAdapterError } from "./errors.js";
import { isRecord, resolveInsideRoot } from "./fs-safe.js";
import { resolveHttpTarget } from "./http-check.js";
import {
  DEFAULT_RUNTIME_TIMEOUT_MS,
  RUNTIME_CHECK_KINDS,
  RUNTIME_HTTP_METHODS,
  type RuntimeCheckConfiguration,
  type RuntimeHttpCheckConfiguration,
  type RuntimeHttpMethod,
  type RuntimeProcessStartCheckConfiguration,
  type RuntimeReadinessConfiguration,
  type RuntimeVerificationConfiguration,
} from "@agent-workflow-kit/orchestration";

/**
 * The `runtime` section of `agent-workflow.config.json`.
 *
 * Runtime verification is the one verification stage whose command is never discovered, and that is a
 * decision rather than a gap. A lint command is a fact about a manifest: if a project declares one,
 * running it is the obvious thing to do. A runtime command is not a fact about anything. Which
 * executable boots the feature, which port it binds, and what a correct response looks like are all
 * specific to a project, and any of the three could be guessed wrongly in a way that produces a
 * confident, green, meaningless result. So nothing is inferred: no port scan, no manifest probe, no
 * route enumeration, no framework convention. A project that wants runtime verification states the
 * command, the readiness condition, and the acceptance criteria, and a project that states nothing
 * gets `inconclusive`.
 *
 * The static and test sections are arrays of commands because those stages run a fixed set of
 * capabilities and each one is a command. Runtime is a different shape of thing — a process with a
 * lifetime, a gate in front of it, and several assertions behind it — so it is an object, and the
 * difference in shape is the difference in what the stage has to do.
 *
 * The command inside it is not a new kind of command. It goes through `buildVerificationCommand`, so
 * it gets the whole existing policy: an executable plus an argument array, no shell, no
 * command-string flag aimed at a known shell, no `npx`, the package-manager subcommand allowlist, and
 * the implicit `pre`/`post` hook rule. A runtime command is a command, and a command that is unsafe
 * for `lint` is unsafe for `dev`.
 */
const RUNTIME_FIELDS: ReadonlySet<string> = new Set(["command", "readiness", "checks", "timeoutMs"]);

const RUNTIME_COMMAND_FIELDS: ReadonlySet<string> = new Set(["executable", "args", "cwd"]);

const CHECK_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "method",
  "path",
  "expectedStatus",
  "expectedBodyFragment",
  "timeoutMs",
  "stableMs",
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 3_600_000;

function refuse(message: string): never {
  throw new ProjectAdapterError("config_invalid", message);
}

function positiveTimeout(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    refuse(`The runtime ${label} must be a whole number of milliseconds between ${String(MIN_TIMEOUT_MS)} and ${String(MAX_TIMEOUT_MS)}.`);
  }

  return value;
}

function optionalTimeout(value: unknown, label: string): number | null {
  return value === undefined ? null : positiveTimeout(value, label);
}

/**
 * The declared command, as a planned command, so the runtime stage plans a command exactly the way
 * the static and test stages plan theirs.
 */
function parseRuntimeCommand(root: string, raw: unknown): PlannedVerificationCommand {
  if (!isRecord(raw)) {
    refuse('The runtime "command" must be an object with an "executable" and an "args" array.');
  }

  for (const field of Object.keys(raw)) {
    if (!RUNTIME_COMMAND_FIELDS.has(field)) {
      refuse(
        `The runtime "command" contains the unknown field "${field}". Only executable, args, and an optional cwd are accepted, so a runtime command is an executable and an argument array and never a command line.`,
      );
    }
  }

  const executable = raw["executable"];

  if (typeof executable !== "string" || executable.length === 0) {
    refuse('The runtime "command" must name an executable, such as "pnpm", "npm", or "node".');
  }

  const args = raw["args"];

  if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
    refuse('The runtime "command" must list its arguments as an array of strings, such as ["dev"].');
  }

  const cwd = raw["cwd"];

  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    refuse('The runtime "command" declares a cwd that is not a non-empty string.');
  }

  return buildVerificationCommand({
    // The id is fixed rather than declared: a runtime command is not a check, it is the process the
    // checks run against, so there is nothing for a project to name it after and nothing to confuse it
    // with. The evidence ids belong to the acceptance criteria, which are chosen below.
    id: "runtime-application",
    capability: "runtime",
    stage: "runtime",
    label: "Application",
    executable,
    args,
    cwd: cwd === undefined ? root : resolveInsideRoot(root, cwd),
    // Derived rather than assumed, so the implicit-hook policy reads the script this command names
    // exactly as it would read a configured `pnpm run lint`.
    script: packageManagerScriptOf(executable, args),
    source: "configured",
  });
}

function parseReadiness(raw: unknown): RuntimeReadinessConfiguration | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (!isRecord(raw)) {
    refuse('The runtime "readiness" must be an object with a "url".');
  }

  for (const field of Object.keys(raw)) {
    if (field !== "url" && field !== "timeoutMs") {
      refuse(
        `The runtime "readiness" contains the unknown field "${field}". Only url and an optional timeoutMs are accepted: this milestone recognises exactly one readiness condition, a URL that answers.`,
      );
    }
  }

  const url = raw["url"];

  if (typeof url !== "string" || url.length === 0) {
    refuse('The runtime "readiness" must name a "url" the application answers on while it is starting up.');
  }

  return { url, timeoutMs: optionalTimeout(raw["timeoutMs"], 'readiness "timeoutMs"') };
}

/**
 * The method, or `GET` when the check declared none.
 *
 * The default is `GET` and the reasoning is narrow: a check that omits the method is describing a page
 * a browser or a client would fetch, and a project that means otherwise says so. A method that is
 * declared and unrecognised is refused, because a check that cannot name how it asks is not a
 * criterion a reader could evaluate.
 */
function parseHttpMethod(raw: unknown, id: string): RuntimeHttpMethod {
  if (raw === undefined) {
    return "GET";
  }

  if (typeof raw !== "string" || !(RUNTIME_HTTP_METHODS as readonly string[]).includes(raw)) {
    refuse(
      `The runtime check "${id}" names the method ${JSON.stringify(raw)}, which is not one of ${RUNTIME_HTTP_METHODS.join(", ")}.`,
    );
  }

  return raw as RuntimeHttpMethod;
}

function parseCheck(raw: unknown, index: number): DeclaredCheck {
  if (!isRecord(raw)) {
    refuse(`The runtime check at position ${String(index)} must be an object.`);
  }

  for (const field of Object.keys(raw)) {
    if (!CHECK_FIELDS.has(field)) {
      refuse(
        `The runtime check at position ${String(index)} contains the unknown field "${field}". A check is a method, a path, an expected status, and optionally an expected body fragment, or it is a process-startup assertion. Nothing else is accepted, so a check cannot become a script.`,
      );
    }
  }

  const id = raw["id"];

  if (id !== undefined && (typeof id !== "string" || !ID_PATTERN.test(id))) {
    refuse(`A runtime check id must match ${ID_PATTERN.source}.`);
  }

  // The name a message uses when the check declared no id. It is worked out once, because inside an
  // `id ?? ...` fallback the id is already narrowed to `undefined` — which is exactly the case the
  // fallback exists for, and exactly the case that must still produce a usable name.
  const label = id ?? String(index);

  // The kind is stated rather than inferred from which fields are present. Inferring it would mean a
  // check that forgot its method silently became a different check, and a silently different check is
  // the one thing an acceptance criterion must never be.
  const declaredType = raw["type"];
  const type = declaredType === undefined ? "http" : declaredType;

  if (typeof type !== "string" || !(RUNTIME_CHECK_KINDS as readonly string[]).includes(type)) {
    refuse(
      `The runtime check at position ${String(index)} declares the type ${JSON.stringify(declaredType)}, which is not one of ${RUNTIME_CHECK_KINDS.join(", ")}.`,
    );
  }

  if (type === "process_start") {
    for (const field of ["method", "path", "expectedStatus", "expectedBodyFragment"]) {
      if (raw[field] !== undefined) {
        refuse(
          `The runtime check at position ${String(index)} is a "process_start" check and also declares "${field}", which only an HTTP check has.`,
        );
      }
    }

    return {
      kind: "process_start",
      id: id ?? `runtime-process-start-${String(index + 1)}`,
      // The stability window is required rather than defaulted, because "the process started" is not
      // a criterion: a process that starts and immediately exits has started. How long it has to stay
      // up is the project's statement, not this framework's guess.
      stableMs: positiveTimeout(raw["stableMs"], `check "${label}" stableMs`),
    };
  }

  const path = raw["path"];

  if (typeof path !== "string" || !path.startsWith("/")) {
    refuse(
      `The runtime check "${label}" must declare a "path" beginning with "/". The host comes from the readiness URL, so a check is a path and never a whole URL, and one check cannot reach a different server than the one the project declared.`,
    );
  }

  const expectedStatus = raw["expectedStatus"];

  if (
    typeof expectedStatus !== "number" ||
    !Number.isInteger(expectedStatus) ||
    expectedStatus < 100 ||
    expectedStatus > 599
  ) {
    refuse(
      `The runtime check "${label}" must declare an "expectedStatus" that is a whole HTTP status code between 100 and 599. A check with no expected status could not fail, and a check that cannot fail is not a criterion.`,
    );
  }

  const declaredFragment = raw["expectedBodyFragment"];

  if (declaredFragment !== undefined && typeof declaredFragment !== "string") {
    refuse(
      `The runtime check "${label}" declares an "expectedBodyFragment" that is not a string. It is a literal fragment, not a pattern: a regular expression here would make a failing check's message depend on the reader's ability to guess the intended expression.`,
    );
  }

  return {
    kind: "http",
    id: id ?? `runtime-${parseHttpMethod(raw["method"], label).toLowerCase()}-${String(index + 1)}`,
    method: parseHttpMethod(raw["method"], label),
    path,
    expectedStatus,
    // `null` means the check looks only at the status, and it is derived rather than defaulted: a
    // check that named no fragment asked for no fragment, which is not the same as asking for "".
    expectedBodyFragment: typeof declaredFragment === "string" ? declaredFragment : null,
    timeoutMs: optionalTimeout(raw["timeoutMs"], `check "${label}" timeoutMs`),
  };
}

/**
 * A check exactly as the project wrote it, before its HTTP target is resolved.
 *
 * This is what a project states: a path, a status, and a fragment. The URL those add up to is worked out
 * once, for the whole section, because the host every check shares is a property of the section rather
 * than of a single check — and that is exactly why it is resolved in one place.
 */
type DeclaredCheck =
  | Omit<RuntimeHttpCheckConfiguration, "url">
  | RuntimeProcessStartCheckConfiguration;

/**
 * Reads the `runtime` section, or reports that the project declared none.
 *
 * `null` is a normal answer and not an error. A project that has not declared runtime verification
 * gets a deferred stage and an `inconclusive` result, which is the honest description of a check that
 * was never asked, and it is emphatically not a pass: absence is reported as absence so that it can
 * never be read as a feature that works.
 */
export function parseRuntimeVerificationConfiguration(
  root: string,
  raw: unknown,
): RuntimeVerificationConfiguration | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (!isRecord(raw)) {
    refuse(
      'The runtime verification section must be an object with a "command" and at least one entry in "checks", rather than an array of commands like the static and test sections. A runtime check is a request and a response, not a command that exits.',
    );
  }

  for (const field of Object.keys(raw)) {
    if (!RUNTIME_FIELDS.has(field)) {
      refuse(
        `The runtime verification section contains the unknown field "${field}". Only command, readiness, checks, and timeoutMs are accepted.`,
      );
    }
  }

  if (raw["command"] === undefined) {
    refuse(
      'The runtime verification section must declare a "command". Nothing is discovered or launched on a project\'s behalf, so a section with checks and no command has nothing to check them against.',
    );
  }

  const command = parseRuntimeCommand(root, raw["command"]);
  const readiness = parseReadiness(raw["readiness"]);
  const rawChecks = raw["checks"];

  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    refuse(
      'The runtime verification section must declare at least one entry in "checks". A runtime section with a command and no criteria cannot fail, and a stage that cannot fail is not a verification.',
    );
  }

  const checks = rawChecks.map(parseCheck);
  const seen = new Set<string>();

  for (const check of checks) {
    if (seen.has(check.id)) {
      refuse(`The runtime verification section repeats the check id "${check.id}".`);
    }

    seen.add(check.id);
  }

  return {
    command: {
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      script: command.script,
    },
    readiness,
    checks: resolveCheckUrls(checks, readiness),
    timeoutMs: optionalTimeout(raw["timeoutMs"], 'verification "timeoutMs"') ?? DEFAULT_RUNTIME_TIMEOUT_MS,
  };
}

/**
 * Resolves each HTTP check's path against the one declared URL.
 *
 * Two refusals happen here, both about the host. A check that declares no readiness URL has nowhere to
 * be sent, and refusing it is better than defaulting to `localhost`, because a default would be a
 * guess that silently produces a green result about a server the project never mentioned. A
 * protocol-relative path — one that starts with `//` — is a different host wearing a path's clothes,
 * so it is refused rather than resolved.
 */
function resolveCheckUrls(
  checks: readonly DeclaredCheck[],
  readiness: RuntimeReadinessConfiguration | null,
): readonly RuntimeCheckConfiguration[] {
  if (readiness === null) {
    return checks.map((check) => {
      if (check.kind !== "process_start") {
        refuse(
          'A runtime check with a "path" needs a "readiness" url to be resolved against. This framework probes exactly the server the project named, so it will not fall back to localhost or invent a host.',
        );
      }

      return check;
    });
  }

  const base = parseReadinessUrl(readiness.url);

  return checks.map((check) => {
    if (check.kind !== "http") {
      return check;
    }

    if (check.path.startsWith("//")) {
      refuse(
        `The runtime check "${check.id}" declares the path "${check.path}", which is a protocol-relative URL and therefore a different host than the one the readiness url names. A check addresses a path on the server the project started, nothing else.`,
      );
    }

    const target = new URL(check.path, base);

    if (target.host !== new URL(base).host) {
      refuse(
        `The runtime check "${check.id}" resolves to "${target.href}", which is not on the host named by the readiness url. A check cannot reach a server the application does not serve.`,
      );
    }

    return { ...check, url: target.toString() };
  });
}

/**
 * Validates a readiness URL as an `http:` URL.
 *
 * The check is here, where the configuration is read, rather than where a socket is opened: a `https:`
 * URL should be refused as an unsupported scheme at configuration time, and not as a connection error
 * seconds later after a process has been started.
 */
function parseReadinessUrl(url: string): string {
  try {
    resolveHttpTarget(url);
  } catch (error) {
    refuse(error instanceof Error ? error.message : `The runtime readiness url "${url}" is not usable.`);
  }

  return url;
}

export { DEFAULT_RUNTIME_TIMEOUT_MS };
