import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_ROLES, type StageRole } from "@agent-workflow-kit/orchestration";
import { writeOpenCodeProjectFiles } from "./agents.js";
import { DEFAULT_OPENCODE_COMMAND } from "./cli-transport.js";
import {
  probeOpenCodeCapabilities,
  type OpenCodeCapabilities,
  type ProbeOpenCodeCapabilitiesOptions,
} from "./capabilities.js";
import { effectFor, type OpenCodePermissionRuleset } from "./permissions.js";
import { runProcess } from "./process.js";
import { agentForRole, isWriteCapableRole } from "./roles.js";

/**
 * An optional, local, no-model check that the generated files are actually valid OpenCode V2
 * configuration.
 *
 * It writes the generated files into a temporary directory, asks the installed binary to report the
 * agents it discovers there, and checks that a read-only agent is denied editing and shell access
 * while a write-capable agent is not. It runs only `agent list` and `debug agent`, never `run`, so it
 * calls no model and needs no network.
 *
 * It is a diagnostic, not a gate. A missing binary, a binary that cannot answer without a configured
 * provider, or a version whose debug output has a different shape all produce `skipped` with a
 * reason, so an environment without OpenCode never fails a build.
 */
export interface OpenCodeSmokeTestAgentReport {
  readonly role: StageRole;
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
  /** The temporary directory used, when it was kept for inspection. */
  readonly directory: string | null;
}

export interface RunOpenCodeConfigSmokeTestOptions {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly inheritEnv?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Keep the temporary directory so a failure can be inspected. */
  readonly keepDirectory?: boolean;
}

export const DEFAULT_SMOKE_TEST_TIMEOUT_MS = 30_000;

/**
 * Environment entries the smoke test forces on every child process.
 *
 * `OPENCODE_DISABLE_MODELS_FETCH` stops OpenCode fetching the model catalog from models.dev, and
 * `OPENCODE_DISABLE_AUTOUPDATE` stops it checking for a new release. Without them, a configuration
 * check that is supposed to be local and offline would quietly reach the network. They are applied
 * after the caller's own entries and cannot be switched off through this API, because "this check
 * never calls out" is a property of the check, not a preference.
 */
const FORCED_OFFLINE_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
};

function childOptions(
  options: RunOpenCodeConfigSmokeTestOptions | ProbeOpenCodeCapabilitiesOptions,
): { inheritEnv?: boolean; env: Readonly<Record<string, string>>; signal?: AbortSignal } {
  return {
    ...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
    env: { ...FORCED_OFFLINE_ENV, ...options.env },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/** One decision the binary's own answer is checked against. */
export interface OpenCodeSmokeTestCheck {
  readonly action: string;
  readonly resource: string;
  readonly expected: "allow" | "deny";
}

function checksForRole(role: StageRole): readonly OpenCodeSmokeTestCheck[] {
  const base: readonly OpenCodeSmokeTestCheck[] = [
    { action: "shell", resource: "git status", expected: "deny" },
    { action: "shell", resource: "git commit -m x", expected: "deny" },
    { action: "shell", resource: "git push origin main", expected: "deny" },
    { action: "subagent", resource: "implementer", expected: "deny" },
    { action: "skill", resource: "anything", expected: "deny" },
    { action: "read", resource: "src/app.ts", expected: "allow" },
    { action: "read", resource: ".agentflow/session.json", expected: "deny" },
    { action: "read", resource: ".git/config", expected: "deny" },
  ];

  const edit: readonly OpenCodeSmokeTestCheck[] = isWriteCapableRole(role)
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

/** The tool names the binary reports as unavailable, when it reports them at all. */
function readDeniedTools(value: unknown): ReadonlySet<string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const denied = new Set<string>();

  for (const [name, available] of Object.entries(value as Record<string, unknown>)) {
    if (available === false) {
      denied.add(name);
    }
  }

  return denied;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readAgentList(
  command: string,
  directory: string,
  options: RunOpenCodeConfigSmokeTestOptions,
): Promise<readonly string[] | null> {
  try {
    const result = await runProcess(command, ["agent", "list"], {
      cwd: directory,
      timeoutMs: options.timeoutMs ?? DEFAULT_SMOKE_TEST_TIMEOUT_MS,
      maxOutputBytes: 2_000_000,
      ...childOptions(options),
      label: "The OpenCode agent list probe",
    });

    const names = new Set<string>();

    for (const line of result.stdout.split("\n")) {
      const match = /^([A-Za-z0-9_.\-/]+)\s+\((?:primary|subagent|all)\)\s*$/u.exec(line);

      if (match?.[1] !== undefined) {
        names.add(match[1]);
      }
    }

    return names.size === 0 ? null : [...names];
  } catch {
    return null;
  }
}

async function readAgentDetail(
  command: string,
  directory: string,
  agent: string,
  options: RunOpenCodeConfigSmokeTestOptions,
): Promise<unknown> {
  const result = await runProcess(command, ["debug", "agent", agent], {
    cwd: directory,
    timeoutMs: options.timeoutMs ?? DEFAULT_SMOKE_TEST_TIMEOUT_MS,
    maxOutputBytes: 2_000_000,
    ...childOptions(options),
    label: `The OpenCode debug agent probe for "${agent}"`,
  });

  return JSON.parse(result.stdout) as unknown;
}

/**
 * The checks the smoke test makes against whatever the binary reported for one agent. A V2 binary
 * reports the resolved `permissions` array; the returned map of denied tools is used as a
 * cross-check when present, because it is the runtime's own answer rather than a re-read of config.
 */
function verifyAgent(
  detail: unknown,
  checks: readonly OpenCodeSmokeTestCheck[],
): { verified: boolean | null; failures: readonly string[] } {
  if (!isRecord(detail)) {
    return { verified: null, failures: ["the debug output was not a JSON object"] };
  }

  const rules = readRuleset(detail["permissions"]);
  const deniedTools = readDeniedTools(detail["tools"]);
  const failures: string[] = [];

  if (rules === null) {
    if (deniedTools === null) {
      return {
        verified: null,
        failures: ["the debug output carried neither a V2 permissions array nor a tool availability map"],
      };
    }
  } else {
    failures.push(...verifyRuleset(rules, checks));
  }

  if (deniedTools !== null) {
    // Only the two capabilities OpenCode gates whole tools on can be cross-checked this way, and each
    // tool is checked once against the decision the checks already agree on.
    const expected = new Map<string, "allow" | "deny">();

    for (const check of checks) {
      if (check.action === "edit" || check.action === "shell") {
        expected.set(check.action === "edit" ? "edit" : "bash", check.expected);
      }
    }

    for (const [tool, decision] of expected) {
      const unavailable = deniedTools.has(tool);

      if (decision === "deny" && !unavailable) {
        failures.push(`the binary still reports the ${tool} tool as available`);
      }

      if (decision === "allow" && unavailable) {
        failures.push(`the binary reports the ${tool} tool as unavailable, which this role needs`);
      }
    }
  }

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

  const cleanup = async (): Promise<string | null> => {
    if (options?.keepDirectory === true) {
      return directory;
    }

    await rm(directory, { recursive: true, force: true });

    return null;
  };

  try {
    await writeOpenCodeProjectFiles(directory);

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
      };
    }

    if (capabilities.debugAgentAvailable !== true) {
      const kept = await cleanup();

      return {
        status: "skipped",
        reason:
          capabilities.debugAgentAvailable === false
            ? "The installed OpenCode does not advertise `debug agent`, so generated permissions cannot be inspected without calling a model."
            : "The `debug agent` help for the installed OpenCode could not be read, so generated permissions were left unverified.",
        capabilities,
        agents: [],
        failures: [],
        directory: kept,
      };
    }

    const listed = await readAgentList(command, directory, options ?? {});
    const agents: OpenCodeSmokeTestAgentReport[] = [];
    const failures: string[] = [];

    if (listed === null) {
      failures.push("the binary could not list the agents it discovered, so discovery was not checked");
    }

    for (const role of STAGE_ROLES) {
      const agent = agentForRole(role);
      const checks = checksForRole(role);
      const agentFailures: string[] = [];
      const discovered = listed !== null && listed.includes(agent);

      if (listed !== null && !discovered) {
        agentFailures.push(`the binary did not list the agent "${agent}"`);
      }

      let verified: boolean | null = null;

      {
        try {
          const detail = await readAgentDetail(command, directory, agent, options ?? {});
          const outcome = verifyAgent(detail, checks);

          verified = outcome.verified;
          agentFailures.push(...outcome.failures);

          if (outcome.verified === null) {
            agentFailures.push(
              "the debug output could not be interpreted, so this agent's permissions were not verified",
            );
          }
        } catch (error) {
          agentFailures.push(
            `the binary could not report on "${agent}": ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }

      failures.push(...agentFailures.map((failure) => `${agent}: ${failure}`));
      agents.push({ role, agent, discovered, verified, failures: agentFailures });
    }

    const kept = await cleanup();

    const unverified = agents.filter((agent) => agent.verified !== true);

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
    };
  } catch (error) {
    const kept = await cleanup();

    return {
      status: "skipped",
      reason: `The configuration smoke test could not run: ${error instanceof Error ? error.message : "unknown error"}`,
      capabilities: await probeOpenCodeCapabilities({ command }),
      agents: [],
      failures: [],
      directory: kept,
    };
  }
}

/** A log-safe one-line summary of a smoke-test report. */
export function describeSmokeTest(report: OpenCodeSmokeTestReport): string {
  if (report.status === "skipped") {
    return `OpenCode configuration smoke test skipped: ${report.reason ?? "no reason recorded"}`;
  }

  const verified = report.agents.filter((agent) => agent.verified === true).length;

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
