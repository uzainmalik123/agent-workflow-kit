import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STAGE_DEFINITIONS, type StageExecutionRequest } from "@agent-workflow-kit/orchestration";
import {
  DEFAULT_TRANSIENT_RETRIES,
  INVOCATION_MANIFEST_FILENAME,
  OpenCodeAdapterError,
  TRANSIENT_RETRY_BACKOFF_MS,
  TRANSIENT_PROVIDER_PATTERNS,
  classifyProviderFailure,
  createOpenCodeCliTransport,
  createOpenCodeStageExecutor,
  isOpenCodeAdapterError,
  renderOpenCodeProjectFiles,
  type StageProgressEvent,
} from "@agent-workflow-kit/opencode";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeOpenCodeTransport } from "../fixtures/opencode-transport.js";
import { testWorkspaceContext } from "../fixtures/workspace.js";

/**
 * The bounded retry for transient provider failures (Task Y, P-33).
 *
 * A dropped provider connection used to kill the whole stage: OpenCode exited 1 with
 * `ECONNRESET` on its stderr and the run stopped with `executor_error` after hundreds of seconds
 * of work. These tests prove the new behaviour at the adapter, with no model and no network: the
 * transport is a fake or a `node -e` stand-in for the CLI.
 *
 * The rule (D-24): a non-zero exit or transport failure whose message names a transient network or
 * provider failure is retried up to `DEFAULT_TRANSIENT_RETRIES` times with a 15s then 45s backoff,
 * bounded by a per-stage wall-clock budget. Anything else — credit, billing, `FreeTierError`,
 * authentication, any 4xx but 429, a stage timeout, a format failure — is never retried, and an
 * unknown error is never retried.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const created = "2026-04-05T06:07:08.000Z";

/** The failure F-002 actually hit: a provider connection reset on the child's stderr. */
const CONNECTION_RESET_STDERR = "\u001b[91m\u001b[1mERROR  Provider error: ECONNRESET\u001b[0m";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-transient-retry-"));
  roots.push(root);

  for (const file of renderOpenCodeProjectFiles()) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }

  return root;
}

function requestFor(stage: StageExecutionRequest["stage"], root: string): StageExecutionRequest {
  const definition = STAGE_DEFINITIONS[stage];

  return {
    feature: {
      featureId: "F-001",
      title: "Transient retry",
      slug: "transient-retry",
      state: definition.state,
      createdAt: created,
      updatedAt: created,
    },
    stage,
    role: definition.role,
    state: definition.state,
    context: [],
    outputs: definition.outputs,
    fixReturnState: null,
    fix: null,
    workspace: testWorkspaceContext({ repositoryRoot: root, workingDirectory: root }),
  };
}

describe("transient failure detection patterns", () => {
  it("is one exported constant with the network, HTTP 5xx, and provider-load patterns", () => {
    const transient = TRANSIENT_PROVIDER_PATTERNS.transientSubstrings.map((pattern) =>
      pattern.toLowerCase(),
    );

    for (const expected of [
      "econnreset",
      "etimedout",
      "eai_again",
      "socket hang up",
      "connection lost",
      "overloaded",
    ]) {
      expect(
        transient.some((pattern) => pattern.includes(expected)),
        `transient patterns lack ${expected}`,
      ).toBe(true);
    }

    for (const status of ["http 502", "http 503", "http 504"]) {
      expect(
        transient.includes(status) || TRANSIENT_PROVIDER_PATTERNS.transientHttpStatus.test(status),
        `transient patterns lack ${status}`,
      ).toBe(true);
    }
  });

  it("classifies the real transient failures", () => {
    expect(classifyProviderFailure("Provider error: ECONNRESET")).toBe("transient");
    expect(classifyProviderFailure("connect ETIMEDOUT 1.2.3.4:443")).toBe("transient");
    expect(classifyProviderFailure("getaddrinfo EAI_AGAIN api.example.com")).toBe("transient");
    expect(classifyProviderFailure("Error: socket hang up")).toBe("transient");
    expect(classifyProviderFailure("fetch failed: connection lost")).toBe("transient");
    expect(classifyProviderFailure("HTTP 502 Bad Gateway")).toBe("transient");
    expect(classifyProviderFailure("HTTP 503 Service Unavailable")).toBe("transient");
    expect(classifyProviderFailure("HTTP 504 Gateway Timeout")).toBe("transient");
    expect(classifyProviderFailure("provider is overloaded, try again")).toBe("transient");
  });

  it("classifies 429 as retry once", () => {
    expect(classifyProviderFailure("HTTP 429 Too Many Requests")).toBe("retry_once");
    expect(classifyProviderFailure("status 429")).toBe("retry_once");
  });

  it("never classifies credit, billing, free-tier, authentication, or other 4xx errors as transient", () => {
    expect(classifyProviderFailure("HTTP 402: insufficient credits")).toBe("never");
    expect(classifyProviderFailure("billing error: card declined")).toBe("never");
    expect(classifyProviderFailure("FreeTierError: daily limit reached")).toBe("never");
    expect(classifyProviderFailure("HTTP 401 Unauthorized")).toBe("never");
    expect(classifyProviderFailure("authentication failed: invalid api key")).toBe("never");
    expect(classifyProviderFailure("HTTP 400 Bad Request")).toBe("never");
    expect(classifyProviderFailure("HTTP 422 Unprocessable Entity")).toBe("never");
  });

  it("never classifies a stage timeout or an unknown error as transient", () => {
    expect(
      classifyProviderFailure('The OpenCode run for agent "agentflow-read" exceeded its 900000ms budget after 900123ms.'),
    ).toBe("unknown");
    expect(classifyProviderFailure("spawn opencode ENOENT")).toBe("unknown");
    expect(classifyProviderFailure("The OpenCode run was cancelled.")).toBe("unknown");
  });

  it("keeps the whole failure message below the budget pattern check: a bare 5xx number inside a duration is not an HTTP status", () => {
    // "after 5043ms" must not read as HTTP 504.
    expect(classifyProviderFailure("the run ended after 5043ms")).toBe("unknown");
  });
});

describe("bounded retry for transient provider failures", () => {
  /** A sleep that records the delays it was asked for instead of waiting. */
  function fakeSleep(delays: number[]): (ms: number) => Promise<void> {
    return (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
  }

  it("retries a non-zero exit whose stderr shows a connection reset, then succeeds", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configureSequence("grill", [
      { exitCode: 1, stderr: CONNECTION_RESET_STDERR },
      {},
    ]);
    const delays: number[] = [];

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      sleep: fakeSleep(delays),
    });
    const result = await executor.execute(requestFor("grill", root));

    expect(result.outcome).toBe("success");
    expect(transport.callCount).toBe(2);
    expect(delays).toEqual([15_000]);
  });

  it("retries a transport failure that names a socket hang up", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configureSequence("grill", [
      {
        error: new OpenCodeAdapterError(
          "transport_failed",
          'The OpenCode run for agent "agentflow-read" failed. stderr: Error: socket hang up',
        ),
      },
      {},
    ]);
    const delays: number[] = [];

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      sleep: fakeSleep(delays),
    });
    const result = await executor.execute(requestFor("grill", root));

    expect(result.outcome).toBe("success");
    expect(transport.callCount).toBe(2);
    expect(delays).toEqual([15_000]);
  });

  it("backs off 15s then 45s, emits one progress event per retry, and fails after the budget of attempts", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { exitCode: 1, stderr: CONNECTION_RESET_STDERR });
    const delays: number[] = [];
    const events: StageProgressEvent[] = [];

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      onProgress: (event) => {
        events.push(event);
      },
      sleep: fakeSleep(delays),
    });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect((failure as OpenCodeAdapterError).code).toBe("non_zero_exit");
    // 1 original attempt + DEFAULT_TRANSIENT_RETRIES retries.
    expect(DEFAULT_TRANSIENT_RETRIES).toBe(2);
    expect(transport.callCount).toBe(1 + DEFAULT_TRANSIENT_RETRIES);
    expect(delays).toEqual([15_000, 45_000]);
    expect(TRANSIENT_RETRY_BACKOFF_MS).toEqual([15_000, 45_000]);

    const retries = events.filter(
      (event): event is Extract<StageProgressEvent, { type: "transient_retry" }> =>
        event.type === "transient_retry",
    );
    expect(retries).toEqual([
      { type: "transient_retry", stage: "grill", retry: 1, maxRetries: 2, delayMs: 15_000 },
      { type: "transient_retry", stage: "grill", retry: 2, maxRetries: 2, delayMs: 45_000 },
    ]);
  });

  it("emits the ordinary stage events exactly once around the retries", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configureSequence("grill", [
      { exitCode: 1, stderr: CONNECTION_RESET_STDERR },
      {},
    ]);
    const events: StageProgressEvent[] = [];

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      onProgress: (event) => {
        events.push(event);
      },
      sleep: fakeSleep([]),
    });
    await executor.execute(requestFor("grill", root));

    expect(events.map((event) => event.type)).toEqual(["stage_started", "transient_retry", "stage_finished"]);
  });

  it("retries a 429 only once, with the first backoff", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { exitCode: 1, stderr: "HTTP 429 Too Many Requests" });
    const delays: number[] = [];

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      sleep: fakeSleep(delays),
    });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect(transport.callCount).toBe(2);
    expect(delays).toEqual([15_000]);
  });

  it("never retries a credit or billing error", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", {
      exitCode: 1,
      stderr: "HTTP 402: you have insufficient credits, check your billing",
    });

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      sleep: fakeSleep([]),
    });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(transport.callCount).toBe(1);
    expect((failure as OpenCodeAdapterError).code).toBe("non_zero_exit");
  });

  it("never retries a FreeTierError or an authentication error", async () => {
    const root = await makeRoot();

    for (const stderr of [
      "FreeTierError: you have exceeded your free-tier quota",
      "HTTP 401 Unauthorized: invalid api key",
    ]) {
      const transport = createFakeOpenCodeTransport();
      transport.configure("grill", { exitCode: 1, stderr });

      const executor = createOpenCodeStageExecutor({
        transport,
        projectRoot: root,
        sleep: fakeSleep([]),
      });
      await executor.execute(requestFor("grill", root)).catch(() => undefined);

      expect(transport.callCount, stderr).toBe(1);
    }
  });

  it("never retries other 4xx statuses", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { exitCode: 1, stderr: "HTTP 400 Bad Request: bad prompt" });

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      sleep: fakeSleep([]),
    });
    await executor.execute(requestFor("grill", root)).catch(() => undefined);

    expect(transport.callCount).toBe(1);
  });

  it("never retries a stage timeout", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", {
      error: new OpenCodeAdapterError(
        "transport_timeout",
        'The OpenCode run for agent "agentflow-read" exceeded its 900000ms budget after 900123ms.',
      ),
    });

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      sleep: fakeSleep([]),
    });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_timeout");
    expect(transport.callCount).toBe(1);
  });

  it("never retries a format failure: the reply retry owns those (Task M)", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { text: "prose with no fence" });

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      sleep: fakeSleep([]),
    });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("malformed_response");
    // 1 original attempt + the 2 format retries, and nothing beyond that.
    expect(transport.callCount).toBe(3);
  });

  it("does not retry an unknown non-zero exit", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { exitCode: 1, stderr: "something entirely unfamiliar went wrong" });

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      sleep: fakeSleep([]),
    });
    await executor.execute(requestFor("grill", root)).catch(() => undefined);

    expect(transport.callCount).toBe(1);
  });

  it("honours a configured retry count, and 0 disables the retry entirely", async () => {
    const root = await makeRoot();

    const one = createFakeOpenCodeTransport();
    one.configure("grill", { exitCode: 1, stderr: CONNECTION_RESET_STDERR });
    const oneExecutor = createOpenCodeStageExecutor({
      transport: one,
      projectRoot: root,
      transientRetries: 1,
      sleep: fakeSleep([]),
    });
    await oneExecutor.execute(requestFor("grill", root)).catch(() => undefined);
    expect(one.callCount).toBe(2);

    const zero = createFakeOpenCodeTransport();
    zero.configure("grill", { exitCode: 1, stderr: CONNECTION_RESET_STDERR });
    const zeroExecutor = createOpenCodeStageExecutor({
      transport: zero,
      projectRoot: root,
      transientRetries: 0,
      sleep: fakeSleep([]),
    });
    await zeroExecutor.execute(requestFor("grill", root)).catch(() => undefined);
    expect(zero.callCount).toBe(1);
  });

  it("bounds the retries with a wall-clock budget of twice the stage timeout, spent through the backoffs", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { exitCode: 1, stderr: CONNECTION_RESET_STDERR });
    const delays: number[] = [];

    // The clock advances only through the backoff sleeps, so the budget is spent by them.
    let clock = 0;
    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      // budget = 2 x 5000ms = 10000ms; the first 15s backoff spends it.
      timeoutMs: 5_000,
      now: () => clock,
      sleep: (ms: number): Promise<void> => {
        clock += ms;
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect(transport.callCount).toBe(2);
    expect(delays).toEqual([15_000]);
  });
});

describe("every transient attempt is recorded", () => {
  it("writes one recording per attempt, each with the run's own exit and stderr", async () => {
    const root = await makeRoot();
    // A real spawn, a fake CLI: the script exits 1 with a connection reset on stderr while the
    // answer file is absent, and answers with the workflow payload once the backoff "sleep"
    // writes it. No model and no network are involved.
    const answerPath = join(root, "answer.json.txt");
    const script = [
      "const fs = require('fs');",
      `const answer = ${JSON.stringify(answerPath)};`,
      "if (fs.existsSync(answer)) { process.stdout.write(fs.readFileSync(answer, 'utf8')); }",
      "else { process.stderr.write('ECONNRESET'); process.exit(1); }",
    ].join(" ");

    const executor = createOpenCodeStageExecutor({
      transport: createOpenCodeCliTransport({
        command: process.execPath,
        extraArgs: ["-e", script],
      }),
      projectRoot: root,
      sleep: async () => {
        const { defaultPayload, renderFencedJson } = await import("../fixtures/opencode-transport.js");
        const { STAGE_DEFINITIONS } = await import("@agent-workflow-kit/orchestration");
        await writeFile(
          answerPath,
          renderFencedJson(
            defaultPayload({
              featureId: "F-001",
              stage: "grill",
              role: STAGE_DEFINITIONS["grill"].role,
              fixReturnState: null,
            }),
          ),
          "utf8",
        );
      },
    });

    const result = await executor.execute(requestFor("grill", root));
    expect(result.outcome).toBe("success");

    const folder = join(root, ".agentflow", "recordings", "F-001", "grill");
    const invocations = await readdir(folder);
    expect(invocations).toHaveLength(2);

    const manifests = await Promise.all(
      invocations.map(async (entry) =>
        JSON.parse(
          await readFile(join(folder, entry, INVOCATION_MANIFEST_FILENAME), "utf8"),
        ) as Record<string, unknown>,
      ),
    );

    const exits = manifests.map((manifest) => manifest["exitCode"]).sort();
    expect(exits).toEqual([0, 1]);
    for (const manifest of manifests) {
      if (manifest["exitCode"] === 1) {
        expect(JSON.stringify(manifest["error"])).toContain("non_zero_exit");
        expect(JSON.stringify(manifest)).toContain("ECONNRESET");
      }
    }
  });
});
