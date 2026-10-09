import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE,
  createOpenCodeRuntimeConfig,
  removeOpenCodeRuntimeConfig,
} from "./runtime-config.js";
import { DEFAULT_OPENCODE_COMMAND } from "./cli-transport.js";
import {
  probeOpenCodeCapabilities,
  type OpenCodeCapabilities,
  type ProbeOpenCodeCapabilitiesOptions,
} from "./capabilities.js";
import {
  buildStageRunEnvironment,
  OPENCODE_SMOKE_TEST_FORCED_ENVIRONMENT,
} from "./environment.js";
import { effectFor, type OpenCodePermissionRuleset } from "./permissions.js";
import { runProcess } from "./process.js";
import { OPENCODE_PROFILES, agentForProfile, isWriteCapableProfile, type OpenCodeProfile } from "./roles.js";

/**
 * An optional, local, no-model check that the generated files are actually valid OpenCode V2
 * configuration.
 *
 * It writes the generated files into a temporary directory, asks the installed binary to report the
 * agents it discovered there with `opencode debug agents`, and checks that `agentflow-read` is denied
 * editing and shell access while `agentflow-write` is not. It never runs `opencode run`, so it
 * calls no model and needs no network.
 *
 * It checks the two profiles rather than the eleven roles, because the two profiles are the only
 * things OpenCode resolves. Every role is covered by the profile it runs under, and a distinct
 * permission decision per role is exactly what this change removed.
 *
 * The listing is polled until it accounts for every generated agent, because the first answer from a
 * freshly started background service does not. See {@link readAgentListing} for why that matters and
 * why waiting for it cannot turn a wrong configuration into a passing report.
 *
 * The evidence is the binary's own answer and nothing else. Every decision is replayed against the
 * ruleset the binary reported, so a passing report means OpenCode resolved the generated policy the
 * way the adapter intended, not that the adapter agrees with itself.
 *
 * It is a diagnostic, not a gate. A missing binary, a binary that cannot answer without a configured
 * provider, or a version whose listing has a different shape all produce `skipped` with a reason, so
 * an environment without OpenCode never fails a build.
 */
export interface OpenCodeSmokeTestAgentReport {
  /** The physical agent, which is also the profile that granted the capabilities under test. */
  readonly profile: OpenCodeProfile;
  readonly agent: string;
  readonly discovered: boolean;
  /** True when the binary's own output agreed with the generated decision for every check. */
  readonly verified: boolean | null;
  readonly failures: readonly string[];
}

export interface OpenCodeSmokeTestReport {
  readonly status: "passed" | "failed" | "skipped";
  /** Present when the check could not run, and when it ran and something was wrong. */
  readonly reason: string | null;
  readonly capabilities: OpenCodeCapabilities;
  readonly agents: readonly OpenCodeSmokeTestAgentReport[];
  readonly failures: readonly string[];
  /** The target directory the binary ran in, when it was kept for inspection. */
  readonly directory: string | null;
  /**
   * The framework-owned configuration directory the binary was pointed at, when it was kept.
   *
   * Reported separately from {@link directory} because the two are the point of the check: the target
   * is the process working directory and is expected to stay free of framework-written files, while
   * this is where the profiles were written.
   */
  readonly runtimeConfigDirectory: string | null;
}

export interface RunOpenCodeConfigSmokeTestOptions {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly inheritEnv?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Keep the temporary directory so a failure can be inspected. */
  readonly keepDirectory?: boolean;
  /**
   * How long to keep asking for a listing that accounts for every generated agent.
   *
   * Defaults to `DEFAULT_AGENT_LISTING_READY_TIMEOUT_MS`. A caller that wants a fast answer about a
   * machine it already knows is broken can shorten it; shortening it only ever makes the report
   * closer to the binary's first answer, and the first answer is the one the wait exists to distrust.
   */
  readonly readyTimeoutMs?: number;
}

export const DEFAULT_SMOKE_TEST_TIMEOUT_MS = 30_000;

/**
 * The timeout for the single `opencode debug agents` call.
 *
 * It is larger than every other child timeout because it is the one command that does real work
 * rather than printing help. V2 answers it from a background service, so on a machine where no
 * service is running yet the CLI has to start one and wait for it to report healthy before it can
 * ask for the agent list. Cutting that off would report a permission problem that does not exist, so
 * the call is given room to start a service and still fails if it genuinely cannot answer.
 */
export const DEFAULT_AGENT_LISTING_TIMEOUT_MS = 120_000;

/**
 * How long the smoke test waits for a listing that accounts for every generated agent.
 *
 * It is a separate budget from the per-call timeout because the two answer different questions: the
 * per-call timeout allows one cold `debug agents` to start a background service, and this one allows
 * the service time to finish loading the directory before its answer is believed. A configuration
 * that is wrong never satisfies the condition being waited on, so a generous budget costs a slow
 * failure rather than a false one.
 */
export const DEFAULT_AGENT_LISTING_READY_TIMEOUT_MS = 30_000;

/** The gap between listing attempts while waiting for the service to finish loading. */
const DEFAULT_AGENT_LISTING_POLL_INTERVAL_MS = 500;

/**
 * The environment for one smoke-test child.
 *
 * It is the same scrub every stage run gets, for the same reason: the listing this check reads is the
 * listing the generated configuration produces, so an inherited `OPENCODE_CONFIG` would have the probe
 * validate somebody else's file. The forced offline entries are applied after the scrub, which is why
 * they live in `environment.ts` next to the rule they are exempt from rather than here.
 */
function childOptions(
  options: RunOpenCodeConfigSmokeTestOptions | ProbeOpenCodeCapabilitiesOptions,
  runtimeConfigDirectory?: string,
): { inheritEnv: false; env: Readonly<Record<string, string>>; signal?: AbortSignal } {
  return {
    inheritEnv: false,
    env: buildStageRunEnvironment({
      ...(options.inheritEnv === false ? { base: {} } : {}),
      ...(options.env === undefined ? {} : { overrides: options.env }),
      forced: {
        ...OPENCODE_SMOKE_TEST_FORCED_ENVIRONMENT,
        // After the scrub, for the same reason a stage run forces it: the probe has to read the
        // listing the framework's own runtime configuration produces, so it cannot be pointed at
        // somebody else's configuration directory.
        ...(runtimeConfigDirectory === undefined
          ? {}
          : { [OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE]: runtimeConfigDirectory }),
      },
    }).env,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/** One decision the binary's own answer is checked against. */
export interface OpenCodeSmokeTestCheck {
  readonly action: string;
  readonly resource: string;
  readonly expected: "allow" | "deny";
}

function checksForProfile(profile: OpenCodeProfile): readonly OpenCodeSmokeTestCheck[] {
  const base: readonly OpenCodeSmokeTestCheck[] = [
    // D-1, positive: the one command the allowlist names has to resolve to `allow` in the binary's
    // own ruleset, not only in the file. Everything below it stays denied, so the pair the file
    // writes (`deny shell *`, then `allow shell pwd`) is what the binary actually applies.
    { action: "shell", resource: "pwd", expected: "allow" },
    { action: "shell", resource: "git status", expected: "deny" },
    { action: "shell", resource: "git commit -m x", expected: "deny" },
    { action: "shell", resource: "git push origin main", expected: "deny" },
    { action: "subagent", resource: "agentflow-write", expected: "deny" },
    { action: "skill", resource: "anything", expected: "deny" },
    { action: "read", resource: "src/app.ts", expected: "allow" },
    { action: "read", resource: ".agentflow/session.json", expected: "deny" },
    { action: "read", resource: ".git/config", expected: "deny" },
  ];

  const edit: readonly OpenCodeSmokeTestCheck[] = isWriteCapableProfile(profile)
    ? [
        { action: "edit", resource: "src/app.ts", expected: "allow" },
        { action: "edit", resource: ".agentflow/session.json", expected: "deny" },
        { action: "edit", resource: ".git/config", expected: "deny" },
        { action: "edit", resource: ".gitignore", expected: "allow" },
      ]
    : [{ action: "edit", resource: "src/app.ts", expected: "deny" }];

  return [...base, ...edit];
}

/**
 * Replays the checks against a ruleset the binary reported, using the same last-match-wins
 * evaluation OpenCode uses. This verifies the binary agrees with the file we generated, rather than
 * only re-reading our own intent.
 */
export function verifyRuleset(
  rules: OpenCodePermissionRuleset,
  checks: readonly OpenCodeSmokeTestCheck[],
): readonly string[] {
  return checks
    .filter((check) => effectFor(rules, check.action, check.resource) !== check.expected)
    .map(
      (check) =>
        `${check.action} ${check.resource} resolved to ${effectFor(rules, check.action, check.resource)} instead of ${check.expected}`,
    );
}

function readRuleset(value: unknown): OpenCodePermissionRuleset | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const rules: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }

    const { action, resource, effect } = entry as Record<string, unknown>;

    if (
      typeof action !== "string" ||
      typeof resource !== "string" ||
      (effect !== "allow" && effect !== "deny" && effect !== "ask")
    ) {
      return null;
    }

    rules.push({ action, resource, effect });
  }

  return rules;
}

/** One agent entry as `opencode debug agents` reports it. */
export interface OpenCodeListedAgent {
  readonly id: string;
  /** The resolved ruleset, or `null` when the entry did not carry a readable one. */
  readonly rules: OpenCodePermissionRuleset | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one `opencode debug agents` payload.
 *
 * The command prints a JSON array of agent objects sorted by id, each carrying the id, the display
 * name, the mode, and the permissions OpenCode actually resolved for it. An entry is kept only when
 * it is an object with a non-empty string id, because the id is what discovery is matched on and an
 * entry without one says nothing about discovery. Everything else about the entry, including any
 * field this version of the adapter does not know yet, is ignored rather than rejected, so an
 * OpenCode release that adds a field does not turn into a parsing failure.
 *
 * `null` is returned for anything that is not an array, including valid JSON of the wrong shape. A
 * payload this function cannot recognise is never treated as an empty or partial listing, because
 * the two differ: an empty listing says every agent is missing, and an unreadable one says nothing.
 */
export function parseAgentListing(stdout: string): readonly OpenCodeListedAgent[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const agents: OpenCodeListedAgent[] = [];

  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"] === "") {
      return null;
    }

    agents.push({ id: entry["id"], rules: readRuleset(entry["permissions"]) });
  }

  return agents;
}

/**
 * Runs `opencode debug agents` once and parses it.
 *
 * `debug agents` is the one command the smoke test cannot ask to be standalone. A real 2.0.18
 * binary advertises `--standalone` on `run` and on the root command, but not on `debug agents`:
 * `opencode debug agents --standalone` prints its usage and exits 1. So unlike a stage run, this
 * listing is answered by the shared background service, and the start-up race below is the price of
 * that. It is the only reason this file polls.
 *
 * A failure is reported as a rejection rather than an empty list, so a binary that cannot answer is
 * never mistaken for a binary that discovered nothing.
 */
async function readAgentListingOnce(
  command: string,
  directory: string,
  options: RunOpenCodeConfigSmokeTestOptions,
  runtimeConfigDirectory: string,
): Promise<readonly OpenCodeListedAgent[]> {
  let stdout: string;

  try {
    const result = await runProcess(command, ["debug", "agents"], {
      cwd: directory,
      timeoutMs: options.timeoutMs ?? DEFAULT_AGENT_LISTING_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
      ...childOptions(options, runtimeConfigDirectory),
      label: "The OpenCode debug agents probe",
    });

    stdout = result.stdout;
  } catch (error) {
    throw new Error(
      `the binary could not list the agents it discovered: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }

  const listed = parseAgentListing(stdout);

  if (listed === null) {
    throw new Error("the agent listing was not the JSON array of agents the smoke test reads");
  }

  return listed;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

/**
 * Asks for the listing until it accounts for every generated agent, or the wait runs out.
 *
 * The first answer is not authoritative. V2 serves this command from a background service, and when
 * no service is running yet the CLI reports the service healthy and asks it for the agent list before
 * that service has loaded the directory's configuration. On a real 2.0.18 binary the first call
 * returns an empty array, and an immediate second call returns only the built-in agents; the
 * generated ones appear a moment later. Reading the first answer would report both profiles as
 * missing, which is a statement about the service's start-up rather than about the generated
 * configuration.
 *
 * So the listing is polled until every generated agent is present, which is a condition a correctly
 * generated project satisfies. A configuration that is genuinely wrong never satisfies it, so the
 * wait cannot hide a defect: the loop simply runs out of time and the last real answer is reported
 * as the failure it is. Nothing here treats a listing as a pass on its own; the checks decide that.
 */
async function readAgentListing(
  command: string,
  directory: string,
  expected: readonly string[],
  options: RunOpenCodeConfigSmokeTestOptions,
  runtimeConfigDirectory: string,
): Promise<readonly OpenCodeListedAgent[]> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_AGENT_LISTING_READY_TIMEOUT_MS);
  const seen = new Set(expected);
  let last: readonly OpenCodeListedAgent[] | null = null;
  let lastFailure: string | null = null;

  for (;;) {
    try {
      const listed = await readAgentListingOnce(command, directory, options, runtimeConfigDirectory);

      last = listed;

      if (listed.some((agent) => seen.has(agent.id))) {
        return listed;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : "the agent listing could not be read";
    }

    if (Date.now() >= deadline) {
      break;
    }

    await sleep(DEFAULT_AGENT_LISTING_POLL_INTERVAL_MS, options.signal);
  }

  if (last !== null) {
    return last;
  }

  throw new Error(
    lastFailure ??
      "the binary never produced an agent listing this adapter could read",
  );
}

/**
 * The checks the smoke test makes against whatever the binary reported for one agent.
 *
 * A V2 listing carries the resolved `permissions` array and nothing else, so the ruleset is the whole
 * of the evidence. An entry with no readable ruleset is unverified rather than wrong: the binary said
 * something about the agent but not something this adapter can check.
 */
function verifyAgent(
  listed: OpenCodeListedAgent | undefined,
  checks: readonly OpenCodeSmokeTestCheck[],
): { verified: boolean | null; failures: readonly string[] } {
  if (listed === undefined) {
    return { verified: null, failures: ["the agent was not in the listing"] };
  }

  if (listed.rules === null) {
    return {
      verified: null,
      failures: ["the listing carried no readable permissions array for this agent"],
    };
  }

  const failures = verifyRuleset(listed.rules, checks);

  return { verified: failures.length === 0 ? true : false, failures };
}

/**
 * Generates the project files in a temporary directory and asks the installed binary to validate
 * them. See {@link OpenCodeSmokeTestReport} for what each status means.
 */
export async function runOpenCodeConfigSmokeTest(
  options?: RunOpenCodeConfigSmokeTestOptions,
): Promise<OpenCodeSmokeTestReport> {
  const command = options?.command ?? DEFAULT_OPENCODE_COMMAND;
  const directory = await mkdtemp(join(tmpdir(), "agentflow-opencode-smoke-"));

  // The runtime configuration is a second directory outside the one the binary runs in, so it is
  // cleaned up separately. `keepDirectory` reports the target directory, which is the one a report
  // reader would want to inspect; the runtime directory is named in the report as well so it can be
  // kept deliberately.
  let runtimeConfigDirectory: string | null = null;

  // The kept counterpart of `directory`, so a report can name where the profiles actually went.
  let keptRuntime: string | null = null;

  const cleanup = async (): Promise<string | null> => {
    if (options?.keepDirectory === true) {
      keptRuntime = runtimeConfigDirectory;

      return directory;
    }

    await rm(directory, { recursive: true, force: true });

    if (runtimeConfigDirectory !== null) {
      await removeOpenCodeRuntimeConfig(runtimeConfigDirectory);
    }

    return null;
  };

  try {
    // The framework's configuration is written outside the directory the binary runs in, and the
    // binary runs in the target directory. That is the arrangement a stage run has, so this is the
    // arrangement worth validating: if the two were ever the same directory again, this probe would
    // no longer be proving what a stage run depends on.
    const runtimeConfig = await createOpenCodeRuntimeConfig(directory, { fresh: true });

    runtimeConfigDirectory = runtimeConfig.directory;

    const capabilities = await probeOpenCodeCapabilities({
      command,
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...childOptions(options ?? {}),
    });

    if (!capabilities.executableFound) {
      const kept = await cleanup();

      return {
        status: "skipped",
        reason: `No usable OpenCode binary at "${command}"; the configuration was not validated.`,
        capabilities,
        agents: [],
        failures: [],
        directory: kept,
        runtimeConfigDirectory: keptRuntime,
      };
    }

    if (capabilities.versionSupportsV2 !== true) {
      const kept = await cleanup();

      return {
        status: "skipped",
        reason:
          capabilities.versionSupportsV2 === false
            ? `The installed OpenCode is ${capabilities.version ?? "of an older major version"}, which reads V1 configuration and would silently ignore the generated \`permissions\` list, so the generated files cannot be validated against it.`
            : "The installed OpenCode version could not be read, so its configuration dialect is unknown and the generated files were left unverified.",
        capabilities,
        agents: [],
        failures: [],
        directory: kept,
        runtimeConfigDirectory: keptRuntime,
      };
    }

    if (capabilities.debugAgentsAvailable !== true) {
      const kept = await cleanup();

      return {
        status: "skipped",
        reason:
          capabilities.debugAgentsAvailable === false
            ? "The installed OpenCode does not advertise `debug agents`, so generated permissions cannot be inspected without calling a model."
            : "The `debug agents` help for the installed OpenCode could not be read, so generated permissions were left unverified.",
        capabilities,
        agents: [],
        failures: [],
        directory: kept,
        runtimeConfigDirectory: keptRuntime,
      };
    }

    const agents: OpenCodeSmokeTestAgentReport[] = [];
    const failures: string[] = [];
    let listed: readonly OpenCodeListedAgent[] | null = null;

    try {
      listed = await readAgentListing(
        command,
        directory,
        OPENCODE_PROFILES.map((profile) => agentForProfile(profile)),
        options ?? {},
        runtimeConfig.directory,
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "the agent listing could not be read");
    }

    for (const profile of OPENCODE_PROFILES) {
      const agent = agentForProfile(profile);
      const checks = checksForProfile(profile);
      const agentFailures: string[] = [];
      const entry = listed?.find((candidate) => candidate.id === agent);
      const discovered = entry !== undefined;

      if (listed !== null && !discovered) {
        agentFailures.push(`the binary did not list the agent "${agent}"`);
      }

      const outcome = verifyAgent(entry, checks);
      const { verified } = outcome;

      agentFailures.push(...outcome.failures);

      if (outcome.verified === null) {
        agentFailures.push(
          "the listing could not be interpreted, so this agent's permissions were not verified",
        );
      }

      failures.push(...agentFailures.map((failure) => `${agent}: ${failure}`));
      agents.push({ profile, agent, discovered, verified, failures: agentFailures });
    }

    const kept = await cleanup();

    const unverified = agents.filter((entry) => entry.verified !== true);

    return {
      status: failures.length === 0 ? "passed" : "failed",
      reason:
        failures.length === 0
          ? unverified.length === 0
            ? null
            : "The agents were listed, but their permissions could not be fully verified."
          : failures.join("; "),
      capabilities,
      agents,
      failures,
      directory: kept,
      runtimeConfigDirectory: keptRuntime,
    };
  } catch (error) {
    const kept = await cleanup();

    return {
      status: "skipped",
      reason: `The configuration smoke test could not run: ${error instanceof Error ? error.message : "unknown error"}`,
      capabilities: await probeOpenCodeCapabilities({ command, ...childOptions(options ?? {}) }),
      agents: [],
      failures: [],
      directory: kept,
      runtimeConfigDirectory: keptRuntime,
    };
  }
}

/** A log-safe one-line summary of a smoke-test report. */
export function describeSmokeTest(report: OpenCodeSmokeTestReport): string {
  if (report.status === "skipped") {
    return `OpenCode configuration smoke test skipped: ${report.reason ?? "no reason recorded"}`;
  }

  const verified = report.agents.filter((entry) => entry.verified === true).length;

  return [
    `OpenCode configuration smoke test ${report.status}:`,
    `${String(report.agents.length)} agents,`,
    `${String(verified)} verified,`,
    `${String(report.failures.length)} failures.`,
    report.reason ?? "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}
