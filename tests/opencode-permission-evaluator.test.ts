import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStageRunEnvironment,
  createOpenCodeRuntimeConfig,
  OPENCODE_PROFILES,
  OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE,
  OPENCODE_SMOKE_TEST_FORCED_ENVIRONMENT,
  probeOpenCodeCapabilities,
  type OpenCodeProfile,
} from "@agent-workflow-kit/opencode";
import {
  ALLOWED_SHELL_COMMAND,
  SHELL_COMMANDS_THAT_MUST_BE_DENIED,
} from "../fixtures/shell-commands.js";
import { afterEach, describe, it } from "vitest";

/**
 * Decision D-1 against the real evaluator, opt-in.
 *
 * ```text
 * AGENTFLOW_OPENCODE_EVALUATOR=1 pnpm vitest run tests/opencode-permission-evaluator.test.ts
 * ```
 *
 * The whole file is skipped unless that variable is set, and the test inside it is skipped again
 * when no OpenCode V2 is installed. Two gates, for two different reasons: this starts a server and
 * binds a port, which a CI job should not do by surprise, and it depends on a binary whose answers
 * are not this repository's to control, so a machine without V2 has nothing to assert rather than
 * something to guess at.
 *
 * What it does not do is call a model. `POST /api/session/{id}/permission` is the same endpoint
 * OpenCode's own permission prompts go through, and it answers from the resolved ruleset alone:
 * start `opencode serve` against the framework's generated runtime configuration, open a session
 * for a profile, and ask it what it would decide. The decisions are the binary's, computed by the
 * binary's own last-match-wins evaluator over the rules the binary read from the file this
 * framework wrote.
 *
 * Two properties of the endpoint have to be handled or the test measures the wrong thing. The first
 * call in a session (and sometimes the first call after start-up) can answer `deny` spuriously,
 * which is why every session is warmed up until it gives the answer the file requires for the
 * allowlisted command. The second is that a single answer is not evidence on its own, so every
 * decision is asked for twice and the pair has to agree with the expected effect; a disagreement is
 * retried, and a result that never settles is reported with every answer it gave.
 *
 * A failure here means the generated configuration and the binary disagree, which is exactly the
 * condition D-1 exists to catch - the file says one thing and the agent that runs says another.
 */

const OPT_IN_ENVIRONMENT_VARIABLE = "AGENTFLOW_OPENCODE_EVALUATOR";

const OPTED_IN = process.env[OPT_IN_ENVIRONMENT_VARIABLE] === "1";

/** Probed once, and only when the test is asked for: the probe starts the real binary. */
const capabilities = OPTED_IN ? await probeOpenCodeCapabilities() : null;

const V2_AVAILABLE = capabilities?.executableFound === true && capabilities.versionSupportsV2 === true;

const STARTUP_TIMEOUT_MS = 60_000;
const WARM_UP_TIMEOUT_MS = 30_000;
const SETTLE_ATTEMPTS = 6;
const SETTLE_DELAY_MS = 300;

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-evaluator-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface RunningServer {
  readonly baseUrl: string;
  readonly password: string;
  stop(): Promise<void>;
}

/**
 * Starts `opencode serve` with the framework's generated configuration as its configuration
 * directory.
 *
 * The environment is the stage-run environment, not the inherited one, for the reason the transport
 * uses it: the listing and the rules the server reads have to be the ones this framework wrote, so
 * the config-injection variables are scrubbed and the runtime directory is then forced after the
 * scrub. The two offline entries are forced the same way the configuration smoke test forces them,
 * because a test that only needs the permission evaluator has no reason to reach the network.
 *
 * The URL and the password are read from the child's own start-up lines rather than assumed: the
 * port is whatever was free, and the password is regenerated per start, so both are per-run data.
 */
async function startServer(
  command: string,
  cwd: string,
  runtimeConfigDirectory: string,
): Promise<RunningServer> {
  const environment = buildStageRunEnvironment({
    forced: {
      ...OPENCODE_SMOKE_TEST_FORCED_ENVIRONMENT,
      [OPENCODE_RUNTIME_CONFIG_ENVIRONMENT_VARIABLE]: runtimeConfigDirectory,
    },
  }).env;

  const child = spawn(command, ["serve"], {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let baseUrl: string | null = null;
  let password: string | null = null;

  while (baseUrl === null || password === null) {
    baseUrl = /server listening on (http:\/\/\S+)/u.exec(output)?.[1] ?? null;
    password = /server password (\S+)/u.exec(output)?.[1] ?? null;

    if (baseUrl !== null && password !== null) {
      break;
    }

    if (child.exitCode !== null) {
      throw new Error(
        `opencode serve exited with code ${String(child.exitCode)} before it reported an address. Output:\n${output}`,
      );
    }

    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`opencode serve did not report an address within ${String(STARTUP_TIMEOUT_MS)}ms. Output:\n${output}`);
    }

    await sleep(250);
  }

  return {
    baseUrl,
    password,
    async stop(): Promise<void> {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      await Promise.race([exited, sleep(5_000)]);

      // Unconditional on purpose: `kill` on a child that already exited is a no-op, and reading
      // `exitCode` again here would be a narrowing question rather than a fact about the process.
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(5_000)]);
    },
  };
}

/** `opencode:<password>` as the server's own Basic scheme requires; an empty username is rejected. */
function authorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

interface PermissionAnswer {
  readonly effect: string;
}

/** One POST, with the refusal the server gave if it did not answer 2xx. */
async function post<T>(server: RunningServer, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: authorizationHeader(server.password),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload: unknown = await response.json();

  if (!response.ok) {
    throw new Error(
      `${path} answered ${String(response.status)}: ${JSON.stringify(payload)}`,
    );
  }

  const data = (payload as { data?: T }).data;

  if (data === undefined) {
    throw new Error(`${path} answered 200 without a data field: ${JSON.stringify(payload)}`);
  }

  return data;
}

/** What one profile decides about one shell command, asked for through the evaluator. */
type Evaluate = (command: string) => Promise<string>;

async function openSession(server: RunningServer, profile: OpenCodeProfile): Promise<string> {
  const session = await post<{ id: string }>(server, "/api/session", { agent: profile });

  return session.id;
}

function evaluatorFor(server: RunningServer, profile: OpenCodeProfile, session: string): Evaluate {
  return async (command: string): Promise<string> => {
    const answer: PermissionAnswer = await post<PermissionAnswer>(
      server,
      `/api/session/${session}/permission`,
      { action: "shell", resources: [command], agent: profile },
    );

    return answer.effect;
  };
}

/**
 * Repeats the positive decision until the evaluator settles on it.
 *
 * Settled means the answer the generated file requires: `allow` for the one allowlisted command.
 * Anything else within the window is reported with every answer that was seen, because a deny that
 * never turns into an allow is a real decision and not a warm-up artifact, and a test that could not
 * tell those apart would have no business asserting the negatives either.
 */
async function warmUp(evaluate: Evaluate): Promise<number> {
  const deadline = Date.now() + WARM_UP_TIMEOUT_MS;
  const observed: string[] = [];
  let attempts = 0;

  for (;;) {
    observed.push(await evaluate(ALLOWED_SHELL_COMMAND));
    attempts += 1;

    if (observed[attempts - 1] === "allow") {
      return attempts;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `the evaluator never settled: ${ALLOWED_SHELL_COMMAND} answered ${JSON.stringify(observed)} over ${String(WARM_UP_TIMEOUT_MS)}ms, so none of its answers can be read as a decision`,
      );
    }

    await sleep(400);
  }
}

/**
 * Asks twice and requires both answers to be the expected one, retrying while they disagree.
 *
 * Double-checking is what makes a `deny` readable: a spurious deny right after start-up would
 * otherwise look exactly like the deny D-1 requires, and the positive case would never be able to
 * tell "the file allows it" from "the endpoint has not caught up". When the pair never agrees, the
 * error carries every answer so a failure shows the flake rather than only its last sample.
 */
async function expectDecision(evaluate: Evaluate, command: string, expected: "allow" | "deny"): Promise<void> {
  const observed: string[] = [];

  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    const first = await evaluate(command);
    const second = await evaluate(command);

    observed.push(first, second);

    if (first === expected && second === expected) {
      return;
    }

    await sleep(SETTLE_DELAY_MS);
  }

  throw new Error(
    `"${command}" answered ${JSON.stringify(observed)} across ${String(SETTLE_ATTEMPTS)} double-checked attempts, but D-1 requires "${expected}"`,
  );
}

describe.skipIf(!OPTED_IN)("the real OpenCode permission evaluator, against the generated shell rules", () => {
  it.runIf(
    V2_AVAILABLE,
  )(
    "allows only the allowlisted command and denies every compound, argument, and prefix form for both profiles",
    async () => {
      const repository = await makeRoot();
      const runtime = await makeRoot();

      // The same write a stage run performs, integrity check included, so the bytes the server reads
      // are the bytes this framework generated and verified.
      await createOpenCodeRuntimeConfig(repository, { directory: runtime, fresh: true });

      const server = await startServer(
        capabilities?.command ?? "opencode",
        repository,
        runtime,
      );

      try {
        for (const profile of OPENCODE_PROFILES) {
          const session = await openSession(server, profile);
          const evaluate = evaluatorFor(server, profile, session);

          await warmUp(evaluate);

          await expectDecision(evaluate, ALLOWED_SHELL_COMMAND, "allow");

          for (const command of SHELL_COMMANDS_THAT_MUST_BE_DENIED) {
            await expectDecision(evaluate, command, "deny");
          }

          // The positive again after all of it: a session that started permitting and then stopped
          // would still have passed every assertion above in isolation.
          await expectDecision(evaluate, ALLOWED_SHELL_COMMAND, "allow");
        }
      } finally {
        await server.stop();
      }
    },
    180_000,
  );
});
