import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowState } from "@agent-workflow-kit/core";
import type {
  RuntimeCheckConfiguration,
  RuntimeVerificationConfiguration,
  RuntimeVerificationRequest,
  VerificationCommandEvidence,
  VerificationEvidenceBundle,
  VerificationRequest,
} from "@agent-workflow-kit/orchestration";
import {
  applyDeterministicEvidence,
  bindVerificationEvidenceToRequest,
  createWorkflowOrchestrator,
  type OrchestrationResult,
} from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore, type FeatureSessionStore } from "@agent-workflow-kit/persistence";
import {
  loadProjectVerificationConfig,
  PROJECT_CONFIG_FILENAME,
  ProjectRuntimeVerificationProvider,
  ProjectVerificationProvider,
  type ChildProcessOutcome,
  type HttpCheckOutcome,
  type ProcessFailureReason,
  type ProcessStreamCapture,
  type ProcessTermination,
  type SupervisedChildProcess,
} from "@agent-workflow-kit/project";
import { FakeStageExecutor } from "../fixtures/stage-executor.js";
import { createFakeWorkspaceProvider, type FakeWorkspaceProvider } from "../fixtures/workspace-provider.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSecurityProvider } from "../fixtures/security-provider.js";

/**
 * Runtime acceptance verification, from configuration to workflow outcome.
 *
 * The suite is organised around the promises the feature makes rather than around its functions, so
 * each `it` names a claim a user could otherwise be surprised by: nothing is discovered, only the
 * declared server is probed, the process is always stopped, and a stage that measured nothing is never
 * reported as a success.
 *
 * Two kinds of test live here on purpose. Most use an injected process and an injected HTTP client, so
 * a lifecycle assertion costs milliseconds and cannot be made flaky by a slow machine. The lifecycle
 * claims themselves — the process really stops, a whole process group really goes, no shell really
 * interprets anything — are tested against real `node` and real sockets, because those are exactly the
 * claims a stub cannot make honestly.
 */

/** The committed fixture application, verified against its own declared configuration. */
const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "runtime-app");

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeProject(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-runtime-"));
  roots.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);

    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }

  return root;
}

const nodeProjectFiles = {
  "package.json": JSON.stringify({ name: "fixture", private: true, version: "1.0.0" }),
  "pnpm-lock.yaml": "lockfileVersion: 9.0\n",
};

function writeRuntimeConfig(root: string, runtime: unknown): Promise<void> {
  return writeFile(
    join(root, PROJECT_CONFIG_FILENAME),
    JSON.stringify({ schemaVersion: 1, verification: { runtime } }, null, 2),
    "utf8",
  );
}

interface Refusal {
  readonly code: string;
  readonly message: string;
}

async function loadRuntime(root: string): Promise<RuntimeVerificationConfiguration | null> {
  const config = await loadProjectVerificationConfig(root);

  return config.runtime;
}

/** The refusal a load produced, as a value rather than a thrown error. */
async function refusalFrom(load: Promise<unknown>): Promise<Refusal> {
  try {
    await load;
  } catch (error) {
    return error as Refusal;
  }

  throw new Error("The configuration was accepted when it should have been refused.");
}

describe("a declared runtime section", () => {
  it("resolves every check path against the one URL the project named", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, {
      command: { executable: "node", args: ["server.mjs"] },
      readiness: { url: "http://127.0.0.1:5173/health" },
      checks: [
        { id: "home", path: "/", expectedStatus: 200, expectedBodyFragment: "Dashboard" },
        { path: "/health", expectedStatus: 204 },
      ],
    });

    const runtime = await loadRuntime(root);

    expect(runtime?.checks).toEqual([
      {
        kind: "http",
        id: "home",
        method: "GET",
        path: "/",
        url: "http://127.0.0.1:5173/",
        expectedStatus: 200,
        expectedBodyFragment: "Dashboard",
        timeoutMs: null,
      },
      {
        kind: "http",
        // The id is derived from what the check does, so a project that names two paths without
        // naming them still gets two distinct evidence records instead of one overwriting the other.
        id: "runtime-get-2",
        method: "GET",
        path: "/health",
        url: "http://127.0.0.1:5173/health",
        expectedStatus: 204,
        expectedBodyFragment: null,
        timeoutMs: null,
      },
    ]);
  });

  it("defaults the method to GET, because a check that omits it is describing a page", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, {
      command: { executable: "node", args: ["server.mjs"] },
      readiness: { url: "http://127.0.0.1:5173/" },
      checks: [{ path: "/", expectedStatus: 200 }],
    });

    expect((await loadRuntime(root))?.checks[0]).toMatchObject({ method: "GET" });
  });

  it("refuses a section shaped like the static and test sections", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, [{ id: "smoke", capability: "runtime", executable: "node", args: [] }]);

    const refusal = await refusalFrom(loadRuntime(root));

    expect(refusal.code).toBe("config_invalid");
    expect(refusal.message).toContain("an array of commands");
  });

  it("refuses a check with no host to be sent to, rather than guessing localhost", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, {
      command: { executable: "node", args: ["server.mjs"] },
      checks: [{ path: "/", expectedStatus: 200 }],
    });

    const refusal = await refusalFrom(loadRuntime(root));

    expect(refusal.message).toContain("needs a \"readiness\" url");
  });

  it("refuses a path that names another host in disguise", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, {
      command: { executable: "node", args: ["server.mjs"] },
      readiness: { url: "http://127.0.0.1:5173/health" },
      checks: [{ path: "//elsewhere.example/status", expectedStatus: 200 }],
    });

    const refusal = await refusalFrom(loadRuntime(root));

    expect(refusal.message).toContain("protocol-relative URL");
  });

  it("refuses a scheme the client cannot speak, before a process is started", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, {
      command: { executable: "node", args: ["server.mjs"] },
      readiness: { url: "https://127.0.0.1:5173/health" },
      checks: [{ path: "/", expectedStatus: 200 }],
    });

    expect((await refusalFrom(loadRuntime(root))).message).toContain('only speaks "http:"');
  });

  it("refuses a section whose criteria could not fail", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, {
      command: { executable: "node", args: ["server.mjs"] },
      readiness: { url: "http://127.0.0.1:5173/" },
      checks: [],
    });

    expect((await refusalFrom(loadRuntime(root))).message).toContain("at least one entry in \"checks\"");
  });

  it("refuses a check with no expected status, because a check that cannot fail is not a criterion", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, {
      command: { executable: "node", args: ["server.mjs"] },
      readiness: { url: "http://127.0.0.1:5173/" },
      checks: [{ path: "/" }],
    });

    expect((await refusalFrom(loadRuntime(root))).message).toContain("expectedStatus");
  });

  it("refuses a command that runs a shell, because it would put the arguments back into a line", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeRuntimeConfig(root, {
      command: { executable: "sh", args: ["-c", "node server.mjs && echo up"] },
      readiness: { url: "http://127.0.0.1:5173/" },
      checks: [{ path: "/", expectedStatus: 200 }],
    });

    const refusal = await refusalFrom(loadRuntime(root));

    expect(refusal.code).toBe("command_forbidden");
    expect(refusal.message).toContain("execute a command string");
  });
});

/** A capture that never grew, for a fake process that produced no output. */
const EMPTY_CAPTURE: ProcessStreamCapture = { text: "", truncated: false, bytes: 0, omittedBytes: 0 };

/**
 * A process the test controls.
 *
 * It stays open until it is stopped or told to die, which is the situation a runtime verification is
 * written for: a process that is still there while it is probed. `died()` is the other situation, the
 * application that exited during the wait, and it is offered separately because a fake that was closed
 * from the start would make every wait look like a crash.
 */
class FakeChild implements SupervisedChildProcess {
  readonly startedAt = "2026-04-05T06:07:08.000Z";
  readonly #outcome: ChildProcessOutcome;
  readonly #closed: Promise<ChildProcessOutcome>;
  #resolveClosed!: (outcome: ChildProcessOutcome) => void;
  #terminations: { termination: string; reason: string }[] = [];

  constructor(outcome: Partial<ChildProcessOutcome> = {}) {
    this.#outcome = {
      termination: "signalled",
      exitCode: null,
      signal: "SIGTERM",
      startedAt: this.startedAt,
      durationMs: 1200,
      stdout: EMPTY_CAPTURE,
      stderr: EMPTY_CAPTURE,
      reason: "terminated_by_signal",
      ...outcome,
    };
    this.#closed = new Promise<ChildProcessOutcome>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  /** The termination the framework asked for, in the order it asked for it. */
  get terminations(): readonly { termination: string; reason: string }[] {
    return this.#terminations;
  }

  get finished(): Promise<ChildProcessOutcome> {
    return this.#closed;
  }

  peekOutcome(): ChildProcessOutcome | null {
    return this.#terminated ? this.#outcome : null;
  }

  #terminated = false;

  stdoutCapture(): ProcessStreamCapture {
    return EMPTY_CAPTURE;
  }

  stderrCapture(): ProcessStreamCapture {
    return EMPTY_CAPTURE;
  }

  /** The application exited on its own, with this outcome. */
  died(outcome: Partial<ChildProcessOutcome>): void {
    Object.assign(this.#outcome, outcome);
    this.#terminated = true;
    this.#resolveClosed(this.#outcome);
  }

  terminate(
    termination: ProcessTermination = "signalled",
    reason: ProcessFailureReason = "terminated_by_signal",
  ): void {
    this.#terminations.push({ termination, reason });
    this.died({ termination, reason });
  }
}

interface HttpProbe {
  readonly url: string;
  readonly method: string;
  readonly timeoutMs: number;
}

interface StubOptions {
  /** Answers each request. Every URL must be answered, or the check records a failed request. */
  readonly respond: (probe: HttpProbe) => Omit<HttpCheckOutcome, "durationMs">;
  readonly child?: FakeChild;
  /** Sleep is immediate by default, so a readiness timeout costs milliseconds rather than seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal | null;
}

const responded = (
  status: number,
  body = "",
): Omit<HttpCheckOutcome, "durationMs"> => ({
  responded: true,
  status,
  bodyBytes: body.length,
  bodyExcerpt: body,
  truncated: false,
  failure: null,
});

const refused = (): Omit<HttpCheckOutcome, "durationMs"> => ({
  responded: false,
  status: null,
  bodyBytes: 0,
  bodyExcerpt: "",
  truncated: false,
  failure: "connection_refused",
});

function stubbedProvider(options: StubOptions): {
  readonly provider: ProjectRuntimeVerificationProvider;
  readonly child: FakeChild;
  readonly probes: HttpProbe[];
} {
  const child = options.child ?? new FakeChild();
  const probes: HttpProbe[] = [];

  const provider = new ProjectRuntimeVerificationProvider({
    start: (): SupervisedChildProcess => child,
    httpCheck: (request: {
      url: string;
      method: string;
      timeoutMs: number;
      signal?: AbortSignal | null;
    }): Promise<HttpCheckOutcome> => {
      probes.push({ url: request.url, method: request.method, timeoutMs: request.timeoutMs });

      return Promise.resolve({ ...options.respond({ ...request }), durationMs: 3 });
    },
    sleep: options.sleep ?? ((): Promise<void> => Promise.resolve()),
    readinessPollMs: 1,
  });

  return { provider, child, probes };
}

function configurationFor(
  overrides: Partial<RuntimeVerificationConfiguration> & {
    readonly checks: readonly RuntimeCheckConfiguration[];
  },
): RuntimeVerificationConfiguration {
  return {
    command: { executable: "node", args: ["server.mjs"], cwd: "/project", script: null },
    readiness: { url: "http://127.0.0.1:5173/health", timeoutMs: null },
    timeoutMs: 5_000,
    ...overrides,
  };
}

function requestFor(
  configuration: RuntimeVerificationConfiguration | null,
  overrides: Partial<RuntimeVerificationRequest> = {},
): RuntimeVerificationRequest {
  return {
    featureId: "F-001",
    projectRoot: "/project",
    revision: 4,
    configuration,
    timeoutMs: 10_000,
    ...overrides,
  };
}

const httpCheck = (path: string, expectedStatus = 200, fragment: string | null = null): RuntimeCheckConfiguration => ({
  kind: "http",
  id: `check-${path}`,
  method: "GET",
  path,
  url: `http://127.0.0.1:5173${path}`,
  expectedStatus,
  expectedBodyFragment: fragment,
  timeoutMs: null,
});

describe("the runtime provider", () => {
  it("passes only when every declared criterion is met", async () => {
    const { provider, child, probes } = stubbedProvider({
      respond: (probe) => (probe.url.endsWith("/health") ? responded(200, "ok") : responded(200, "Dashboard")),
    });

    const result = await provider.verify(
      requestFor(
        configurationFor({
          checks: [httpCheck("/health"), httpCheck("/", 200, "Dashboard")],
        }),
      ),
    );

    expect(result.status).toBe("passed");
    expect(result.evidence.map((check) => [check.id, check.status])).toEqual([
      ["check-/health", "passed"],
      ["check-/", "passed"],
    ]);
    expect(result.evidence[1]).toMatchObject({ expectedStatus: 200, actualStatus: 200, bodyMatched: true });
    // Three requests for two checks: the readiness gate was asked first, which is the whole reason it
    // exists. A readiness URL that is also a check path is asked twice, once to wait and once to judge.
    expect(probes.map((probe) => probe.url)).toEqual([
      "http://127.0.0.1:5173/health",
      "http://127.0.0.1:5173/health",
      "http://127.0.0.1:5173/",
    ]);
    // The process it started is stopped, and the stop is recorded as the framework's own doing.
    expect(child.terminations).toEqual([{ termination: "signalled", reason: "terminated_by_signal" }]);
    expect(result.diagnostics.process).toMatchObject({ terminatedByVerification: true });
  });

  it("fails on the status the server returned, and names both statuses", async () => {
    const { provider } = stubbedProvider({ respond: () => responded(503, "unavailable") });

    const result = await provider.verify(
      requestFor(configurationFor({ checks: [httpCheck("/health", 200)] })),
    );

    expect(result.status).toBe("failed");
    expect(result.evidence[0]).toMatchObject({
      status: "failed",
      reason: "status_mismatch",
      expectedStatus: 200,
      actualStatus: 503,
    });
    expect(result.evidence[0]?.detail).toContain("the configured criterion is status 200");
  });

  it("fails a check whose body lacks the declared fragment", async () => {
    const { provider } = stubbedProvider({ respond: () => responded(200, "<html>Sign in</html>") });

    const result = await provider.verify(
      requestFor(configurationFor({ checks: [httpCheck("/", 200, "Dashboard")] })),
    );

    expect(result.evidence[0]).toMatchObject({
      status: "failed",
      reason: "body_absent",
      // The status matched, so the status is not the finding and is not reported as one.
      expectedStatus: 200,
      actualStatus: 200,
      bodyMatched: false,
    });
    expect(result.evidence[0]?.responseExcerpt).toContain("Sign in");
  });

  it("reports a request that got no response as a failure of the check, not as a pass", async () => {
    const { provider } = stubbedProvider({ respond: () => refused() });

    const result = await provider.verify(
      requestFor(configurationFor({ readiness: null, checks: [httpCheck("/health", 200)] })),
    );

    expect(result.evidence[0]).toMatchObject({ status: "failed", reason: "request_failed" });
  });

  it("never issues a check against an application that never became ready", async () => {
    const { provider, child, probes } = stubbedProvider({ respond: () => refused() });

    const result = await provider.verify(
      requestFor(
        configurationFor({
          readiness: { url: "http://127.0.0.1:5173/health", timeoutMs: 25 },
          checks: [httpCheck("/")],
        }),
      ),
    );

    // Only the readiness URL was ever requested. A check issued against an application that was not up
    // yet measures the boot, and a boot that times out is a finding about the boot.
    expect(probes.every((probe) => probe.url === "http://127.0.0.1:5173/health")).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.evidence[0]).toMatchObject({ status: "timed_out", reason: "readiness_timeout" });
    expect(result.diagnostics.readiness).toMatchObject({ reached: false });
    expect(child.terminations).toHaveLength(1);
  });

  it("fails in a second when the application dies during the wait, and reports its exit code", async () => {
    const child = new FakeChild();
    const { provider } = stubbedProvider({ child, respond: () => refused() });

    // The application dies before the readiness condition answers.
    child.died({ termination: "exited", exitCode: 3, signal: null, reason: null });

    const result = await provider.verify(
      requestFor(
        configurationFor({
          readiness: { url: "http://127.0.0.1:5173/health", timeoutMs: 5_000 },
          checks: [httpCheck("/")],
        }),
      ),
    );

    expect(result.evidence[0]).toMatchObject({ status: "failed", reason: "process_exited" });
    expect(result.evidence[0]?.detail).toContain("exit code 3");
    // The process was already gone, so the framework did not claim it stopped something.
    expect(result.diagnostics.process).toMatchObject({ exitCode: 3, terminatedByVerification: false });
    expect(child.terminations).toHaveLength(0);
  });

  it("holds a process_start check open for the window the project declared", async () => {
    const { provider, probes } = stubbedProvider({ respond: () => refused() });

    const result = await provider.verify(
      requestFor(
        configurationFor({
          readiness: null,
          checks: [{ kind: "process_start", id: "stable", stableMs: 60 }],
        }),
      ),
    );

    expect(result.status).toBe("passed");
    expect(result.evidence[0]).toMatchObject({ status: "passed", reason: null, id: "stable" });
    expect(result.evidence[0]?.durationMs).toBeGreaterThanOrEqual(60);
    expect(probes).toHaveLength(0);
  });

  it("fails a process_start check when the process dies inside the window", async () => {
    const child = new FakeChild();
    const { provider } = stubbedProvider({ child, respond: () => refused() });

    child.died({ termination: "exited", exitCode: 1, signal: null, reason: null });

    const result = await provider.verify(
      requestFor(
        configurationFor({
          readiness: null,
          checks: [{ kind: "process_start", id: "stable", stableMs: 5_000 }],
        }),
      ),
    );

    // The check did not sit out its window: a process that has already exited is a known fact, and the
    // interesting part of it is that it exited.
    expect(result.evidence[0]).toMatchObject({ status: "failed", reason: "process_exited" });
  });

  it("records a cancelled run as cancelled, so it is not mistaken for a defect", async () => {
    const controller = new AbortController();
    const { provider } = stubbedProvider({
      respond: () => refused(),
      signal: controller.signal,
    });

    controller.abort();

    const result = await provider.verify(
      requestFor(
        configurationFor({
          readiness: { url: "http://127.0.0.1:5173/health", timeoutMs: 5_000 },
          checks: [httpCheck("/")],
        }),
        { signal: controller.signal },
      ),
    );

    expect(result.evidence[0]?.status).toBe("cancelled");
  });

  it("stops checking once the whole-run budget is spent", async () => {
    // A clock the test owns, so the budget is spent at a known moment rather than by racing a timer.
    let now = 0;
    const clock = (): number => now;
    const probes: HttpProbe[] = [];
    const budgeted = new ProjectRuntimeVerificationProvider({
      clock,
      start: (): SupervisedChildProcess => new FakeChild(),
      httpCheck: (request: {
        url: string;
        method: string;
        timeoutMs: number;
      }): Promise<HttpCheckOutcome> => {
        probes.push({ url: request.url, method: request.method, timeoutMs: request.timeoutMs });

        // This check takes longer than the whole run is allowed to take.
        const slow = request.url.includes("/slow");

        if (slow) {
          now += 10_000;
        }

        return Promise.resolve({ ...(slow ? refused() : responded(200, "ok")), durationMs: 3 });
      },
      sleep: (): Promise<void> => Promise.resolve(),
      readinessPollMs: 1,
    });

    const result = await budgeted.verify(
      requestFor(
        configurationFor({
          timeoutMs: 20,
          checks: [httpCheck("/slow"), httpCheck("/")],
        }),
      ),
    );

    expect(result.evidence[0]).toMatchObject({ reason: "request_failed" });
    // The second check was never issued: issuing it would measure a framework that had already stopped.
    expect(result.evidence[1]).toMatchObject({ reason: "deadline_exceeded" });
    expect(probes.some((probe) => probe.url === "http://127.0.0.1:5173/")).toBe(false);
  });

  it("answers a project that declared nothing with an inconclusive result and no invented work", async () => {
    const child = new FakeChild();
    const { provider, probes } = stubbedProvider({ child, respond: () => responded(200) });
    const request = requestFor(null);

    const result = await provider.verify(request);

    expect(result.status).toBe("inconclusive");
    expect(result.evidence[0]).toMatchObject({ status: "skipped", reason: "runtime_not_configured" });
    expect(result.diagnostics.command).toBeNull();
    expect(result.diagnostics.process.termination).toBe("not_started");
    // Nothing was discovered and nothing was launched: there is no port scan behind this.
    expect(probes).toHaveLength(0);
    expect(child.terminations).toHaveLength(0);
  });

  it("keeps a failed run's own reason rather than blaming the exit code", async () => {
    const { provider } = stubbedProvider({ respond: () => responded(200, "ok") });

    const result = await provider.verify(
      requestFor(
        configurationFor({
          readiness: null,
          checks: [httpCheck("/", 201)],
        }),
      ),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics.process.termination).toBe("signalled");
  });
});

/** A port that was free a moment ago, which is the best a test can do without asking the OS to hold one. */
async function freePort(): Promise<number> {
  const probe = createServer();

  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });

  const address = probe.address();

  if (address === null || typeof address === "string") {
    throw new Error("The probe server did not report a port.");
  }

  const { port } = address;

  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });

  return port;
}

const SERVER = `import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  response.writeHead(200, { "content-type": "text/html" }).end("<h1>Dashboard</h1>");
});

server.listen(Number(process.argv[2]), "127.0.0.1");
`;

/** A server that answers nothing, for a readiness that must time out. */
const SILENT_SERVER = `import { createServer } from "node:http";

createServer(() => {}).listen(Number(process.argv[2]), "127.0.0.1");
`;

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();

    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

async function waitForPort(port: number, attempt: () => Promise<boolean>): Promise<boolean> {
  for (let step = 0; step < 40; step += 1) {
    if (await attempt()) {
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  return false;
}

describe("a real application", () => {
  it("verifies the committed fixture, from its declared configuration to a bundle", async () => {
    // The whole path a project takes: a configuration on disk, a provider that reads it, a process
    // that really starts, criteria that really fail, and a bundle the workflow can act on.
    const root = fixtureRoot;
    const provider = new ProjectVerificationProvider({ projectRoot: root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "runtime_verification",
      verification: "runtime",
      revision: 7,
      projectRoot: root,
      workspaceId: null,
    });

    expect(bundle.outcome).toBe("passed");
    expect(bundle.checks.map((check) => [check.id, check.status])).toEqual([
      ["health", "passed"],
      ["dashboard", "passed"],
    ]);
    expect(bundle.checks.every((check) => check.executable === "node" && check.exitCode === null)).toBe(true);
    expect(bundle.checks[1]?.stdoutExcerpt).toContain("Dashboard");
    // The application the framework started was stopped by the framework, on the way to a pass.
    expect(bundle.checks[0]?.detail).toContain("returned the expected status 200");

    const port = 4599;

    expect(await waitForPort(port, async () => await portIsFree(port))).toBe(true);
  });

  it("fails the same fixture when a criterion the project wrote is not met", async () => {
    // The configuration is copied to a temporary project with one criterion that this server cannot
    // satisfy, which is the negative half of the same fixture: a check that cannot fail proves nothing,
    // so the counterpart has to be shown failing for the pass to mean anything.
    const root = await makeProject({
      "package.json": await readFile(join(fixtureRoot, "package.json"), "utf8"),
      "server.mjs": await readFile(join(fixtureRoot, "server.mjs"), "utf8"),
      [PROJECT_CONFIG_FILENAME]: JSON.stringify({
        schemaVersion: 1,
        verification: {
          runtime: {
            command: { executable: "node", args: ["server.mjs", "4600"] },
            readiness: { url: "http://127.0.0.1:4600/health", timeoutMs: 10000 },
            checks: [{ id: "dashboard", path: "/", expectedStatus: 200, expectedBodyFragment: "Reports" }],
          },
        },
      }),
    });

    const bundle = await new ProjectVerificationProvider({ projectRoot: root }).collect({
      featureId: "F-002",
      stage: "runtime_verification",
      verification: "runtime",
      revision: 1,
      projectRoot: root,
      workspaceId: null,
    });

    expect(bundle.outcome).toBe("failed");
    expect(bundle.checks[0]).toMatchObject({ id: "dashboard", status: "failed", reason: "body_absent" });
    // The shared record carries the finding as a sentence, because that is what the artifact and the
    // prompt show. The expected and actual statuses are stated, not left for a reader to infer.
    expect(bundle.checks[0]?.detail).toContain("returned the expected status 200");
    expect(bundle.checks[0]?.detail).toContain("does not contain the expected fragment");
    // And the response that was examined is kept, bounded, so the failure can be read rather than
    // re-derived.
    expect(bundle.checks[0]?.stdoutExcerpt).toContain("Dashboard");
    // A failed criterion still leaves nothing running, or the next attempt would hit a bound port.
    expect(await waitForPort(4600, async () => await portIsFree(4600))).toBe(true);
  });

  it("is started, probed, and left stopped with its port free", async () => {
    const root = await makeProject(nodeProjectFiles);
    const port = await freePort();
    await writeFile(join(root, "server.mjs"), SERVER, "utf8");

    const provider = new ProjectRuntimeVerificationProvider();
    const result = await provider.verify(
      requestFor({
        command: {
          executable: "node",
          args: ["server.mjs", String(port)],
          cwd: root,
          script: null,
        },
        readiness: { url: `http://127.0.0.1:${String(port)}/health`, timeoutMs: 10_000 },
        checks: [
          {
            kind: "http",
            id: "dashboard",
            method: "GET",
            path: "/",
            url: `http://127.0.0.1:${String(port)}/`,
            expectedStatus: 200,
            expectedBodyFragment: "Dashboard",
            timeoutMs: null,
          },
        ],
        timeoutMs: 20_000,
      }),
    );

    expect(result.status).toBe("passed");
    expect(result.diagnostics.readiness).toMatchObject({ reached: true, status: 200 });
    expect(result.evidence[0]).toMatchObject({ actualStatus: 200, bodyMatched: true });
    expect(result.diagnostics.process).toMatchObject({ terminatedByVerification: true, signal: "SIGTERM" });

    // The port the application held is free again, which is the promise that makes it safe to run a
    // second verification in the same session.
    expect(await waitForPort(port, async () => await portIsFree(port))).toBe(true);
  });

  it("is stopped even when it never became ready", async () => {
    const root = await makeProject(nodeProjectFiles);
    const port = await freePort();
    await writeFile(join(root, "silent.mjs"), SILENT_SERVER, "utf8");

    const provider = new ProjectRuntimeVerificationProvider();
    const result = await provider.verify(
      requestFor({
        command: { executable: "node", args: ["silent.mjs", String(port)], cwd: root, script: null },
        // Nothing is listening here, so this can never be reached: the point is that a run which waits
        // for a condition that cannot arrive still has to clean up after itself.
        readiness: { url: `http://127.0.0.1:${String(port)}/health`, timeoutMs: 400 },
        checks: [
          {
            kind: "http",
            id: "health",
            method: "GET",
            path: "/health",
            url: `http://127.0.0.1:${String(port)}/health`,
            expectedStatus: 200,
            expectedBodyFragment: null,
            timeoutMs: null,
          },
        ],
        timeoutMs: 20_000,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.evidence[0]).toMatchObject({ status: "timed_out", reason: "readiness_timeout" });
    expect(result.diagnostics.process.terminatedByVerification).toBe(true);
    expect(await waitForPort(port, async () => await portIsFree(port))).toBe(true);
  });

  it("is reported as dead when it exits during the wait, with its own exit code", async () => {
    const root = await makeProject(nodeProjectFiles);

    await writeFile(join(root, "crash.mjs"), 'process.stderr.write("boom\\n");\nprocess.exit(3);\n', "utf8");

    const provider = new ProjectRuntimeVerificationProvider();
    const result = await provider.verify(
      requestFor({
        command: { executable: "node", args: ["crash.mjs"], cwd: root, script: null },
        readiness: { url: "http://127.0.0.1:5173/health", timeoutMs: 10_000 },
        checks: [
          {
            kind: "http",
            id: "health",
            method: "GET",
            path: "/health",
            url: "http://127.0.0.1:5173/health",
            expectedStatus: 200,
            expectedBodyFragment: null,
            timeoutMs: null,
          },
        ],
        timeoutMs: 20_000,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.evidence[0]).toMatchObject({ reason: "process_exited" });
    expect(result.diagnostics.process).toMatchObject({ exitCode: 3, termination: "exited" });
    expect(result.diagnostics.process.stderrExcerpt).toContain("boom");
    expect(result.observations.join(" ")).toContain("exit code 3");
  });

  it("is started without the operator's environment, and says what it can see", async () => {
    // Runtime verification gets the same environment boundary a static command does, and this is the
    // half that could regress independently: a supervised process has a different entry point and a
    // different lifetime, so "the policy lives in the one launch" is a claim that has to be paid for.
    const root = await makeProject(nodeProjectFiles);
    const port = await freePort();
    await writeFile(
      join(root, "server.mjs"),
      `process.stdout.write(JSON.stringify({ fake: process.env.AGENT_WORKFLOW_KIT_FAKE_CREDENTIAL ?? null, home: process.env.HOME ?? null }) + "\\n");\n${SERVER}`,
      "utf8",
    );

    const previous = process.env["AGENT_WORKFLOW_KIT_FAKE_CREDENTIAL"];
    process.env["AGENT_WORKFLOW_KIT_FAKE_CREDENTIAL"] = "not-a-real-secret-3f9c1ad2";

    let result: Awaited<ReturnType<ProjectRuntimeVerificationProvider["verify"]>>;

    try {
      result = await new ProjectRuntimeVerificationProvider().verify(
        requestFor({
          command: { executable: "node", args: ["server.mjs", String(port)], cwd: root, script: null },
          readiness: { url: `http://127.0.0.1:${String(port)}/health`, timeoutMs: 10_000 },
          checks: [
            {
              kind: "http",
              id: "health",
              method: "GET",
              path: "/health",
              url: `http://127.0.0.1:${String(port)}/health`,
              expectedStatus: 200,
              expectedBodyFragment: null,
              timeoutMs: null,
            },
          ],
          timeoutMs: 20_000,
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env["AGENT_WORKFLOW_KIT_FAKE_CREDENTIAL"];
      } else {
        process.env["AGENT_WORKFLOW_KIT_FAKE_CREDENTIAL"] = previous;
      }
    }

    // The application started, answered, and was stopped: the credential is absent from a run that
    // genuinely happened rather than from a run that never got as far as executing anything.
    expect(result.status).toBe("passed");
    expect(result.diagnostics.readiness).toMatchObject({ reached: true, status: 200 });
    expect(result.diagnostics.process.stdoutExcerpt).not.toContain("not-a-real-secret-3f9c1ad2");

    const reported = JSON.parse(result.diagnostics.process.stdoutExcerpt) as {
      readonly fake: string | null;
      readonly home: string | null;
    };

    expect(reported.fake).toBeNull();
    expect(reported.home).toBeNull();
    expect(await waitForPort(port, async () => await portIsFree(port))).toBe(true);
  });

  it("is killed as a whole group, so a wrapper cannot leave the port bound", async () => {
    const root = await makeProject(nodeProjectFiles);
    const port = await freePort();
    await writeFile(join(root, "server.mjs"), SERVER, "utf8");

    // The shape almost every real command has: a package manager, or a shell script, that runs the
    // actual program as a child. Signalling only the wrapper would record a clean shutdown while the
    // server kept running and kept the port.
    await writeFile(join(root, "dev.sh"), `#!/bin/sh\nexec node server.mjs "$1"\n`, "utf8");
    await chmod(join(root, "dev.sh"), 0o755);

    const provider = new ProjectRuntimeVerificationProvider();
    const result = await provider.verify(
      requestFor({
        command: { executable: "sh", args: ["dev.sh", String(port)], cwd: root, script: null },
        readiness: { url: `http://127.0.0.1:${String(port)}/health`, timeoutMs: 10_000 },
        checks: [
          {
            kind: "http",
            id: "health",
            method: "GET",
            path: "/health",
            url: `http://127.0.0.1:${String(port)}/health`,
            expectedStatus: 200,
            expectedBodyFragment: null,
            timeoutMs: null,
          },
        ],
        timeoutMs: 20_000,
      }),
    );

    expect(result.status).toBe("passed");
    expect(await waitForPort(port, async () => await portIsFree(port))).toBe(true);
  });

  it("runs its command with no shell, so an argument is never a line", async () => {
    const root = await makeProject(nodeProjectFiles);

    // The child outlives `stableMs` on purpose. The criterion under test is whether the arguments were
    // passed through uninterpreted, but a `process_start` check asserts that the process stayed *running*,
    // and a child that writes and exits immediately satisfies that only when the machine is busy enough to
    // delay its exit past the deadline. Making the lifetime longer than the criterion removes the race
    // without weakening either assertion.
    await writeFile(
      join(root, "echo.mjs"),
      [
        "process.stdout.write(`${process.argv.length - 2} arguments\\n`);",
        "setTimeout(() => { process.exit(0); }, 1_000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const provider = new ProjectRuntimeVerificationProvider();
    const result = await provider.verify(
      requestFor({
        command: { executable: "node", args: ["echo.mjs", "a && b", "; echo c"], cwd: root, script: null },
        readiness: null,
        checks: [{ kind: "process_start", id: "stable", stableMs: 100 }],
        timeoutMs: 20_000,
      }),
    );

    expect(result.status).toBe("passed");
    // Two arguments, not a command, a background job, and a second command: nothing was interpreted.
    expect(result.diagnostics.process.stdoutExcerpt).toContain("2 arguments");
    expect(result.diagnostics.process.stdoutExcerpt).not.toContain("c\n");
  });
});

describe("runtime evidence in the workflow", () => {
  const FINGERPRINT = "a".repeat(64);
  const fixedTimestamp = "2026-04-05T06:07:08.000Z";

  interface Harness {
    readonly store: FeatureSessionStore;
    readonly executor: FakeStageExecutor;
    readonly workspace: FakeWorkspaceProvider;
    readonly orchestrator: ReturnType<typeof createWorkflowOrchestrator>;
  }

  function makeHarness(root: string, answer: (request: VerificationRequest) => VerificationEvidenceBundle): Harness {
    const store = createFeatureSessionStore(root, { clock: (): string => fixedTimestamp });
    const executor = new FakeStageExecutor();
    const workspace = createFakeWorkspaceProvider({ workingDirectory: join(root, "workspace") });
    const orchestrator = createWorkflowOrchestrator({
      store,
      executor,
      workspace,
      verification: { collect: (request: VerificationRequest) => Promise.resolve(answer(request)) },
      security: createFakeSecurityProvider(),
      projectRoot: root,
    });

    return { store, executor, workspace, orchestrator };
  }

  const profileSummary = (): VerificationEvidenceBundle["project"] => ({
    ecosystem: "node",
    language: "typescript",
    packageManager: "pnpm",
    declaredPackageManager: "pnpm",
    dependenciesInstalled: true,
    frameworks: [],
    capabilities: [],
  });

  function bundleFor(request: VerificationRequest, overrides: Partial<VerificationEvidenceBundle> = {}): VerificationEvidenceBundle {
    return {
      verification: request.verification,
      outcome: "passed",
      revision: request.revision,
      implementationFingerprint: FINGERPRINT,
      workspace: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
      controlPlane: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
      collectedAt: fixedTimestamp,
      projectRoot: request.projectRoot,
      workspaceId: request.workspaceId,
      project: profileSummary(),
      checks: [],
      ...overrides,
    };
  }

  function runtimeCheckFor(request: VerificationRequest, overrides: Partial<VerificationCommandEvidence> = {}): VerificationCommandEvidence {
    return {
      id: "dashboard",
      kind: "runtime",
      capability: "runtime",
      capabilityStatus: "applicable",
      label: 'Runtime http check "dashboard"',
      executable: "node",
      args: ["server.mjs"],
      cwd: request.projectRoot,
      script: null,
      startedAt: fixedTimestamp,
      durationMs: 340,
      // A runtime check is a request and a response, so there is no exit code to report.
      exitCode: null,
      signal: null,
      status: "failed",
      reason: "status_mismatch",
      detail: "node server.mjs returned 500 for GET /, expected 200.",
      stdoutExcerpt: "<h1>Error</h1>",
      stderrExcerpt: "",
      truncated: false,
      revision: request.revision,
      implementationFingerprint: FINGERPRINT,
      ...overrides,
    };
  }

  async function driveToRuntimeVerification(harness: Harness): Promise<void> {
    await harness.orchestrator.createFeature({
      featureId: "F-001",
      title: "Dashboard",
      request: "# Request\n\nServe the dashboard.\n",
    });

    for (let step = 0; step < 6; step += 1) {
      await harness.orchestrator.runNext("F-001");
    }

    await harness.orchestrator.approvePlan("F-001");
  }

  async function runUntilRuntime(harness: Harness): Promise<OrchestrationResult | undefined> {
    for (let step = 0; step < 8; step += 1) {
      const result = await harness.orchestrator.runNext("F-001");

      if (result.stage === "runtime_verification") {
        return result;
      }
    }

    return undefined;
  }

  it("sends a failed runtime stage back to the fixer, with the check that failed", async () => {
    const root = await makeProject();
    const harness = makeHarness(root, (request) =>
      request.verification === "runtime"
        ? bundleFor(request, { outcome: "failed", checks: [runtimeCheckFor(request)] })
        : bundleFor(request),
    );

    await driveToRuntimeVerification(harness);
    const result = await runUntilRuntime(harness);

    expect(result).toMatchObject({ status: "fix_requested", state: WorkflowState.Fixing });
    // The finding names the criterion, and it says what was asked for rather than quoting an exit code
    // that never happened.
    const messages = (result?.findings ?? []).map((finding) => finding.message).join(" ");
    expect(messages).toContain('runtime check "dashboard"');
    expect(messages).toContain("ran to no exit code");
  });

  it("verifies again after a fix, on the revision the fix produced", async () => {
    const root = await makeProject();
    const seen: number[] = [];
    let attempt = 0;
    const harness = makeHarness(root, (request) => {
      if (request.verification !== "runtime") {
        return bundleFor(request);
      }

      seen.push(request.revision);
      attempt += 1;

      return attempt === 1
        ? bundleFor(request, { outcome: "failed", checks: [runtimeCheckFor(request)] })
        : bundleFor(request, { checks: [runtimeCheckFor(request, { status: "passed", reason: null })] });
    });

    await driveToRuntimeVerification(harness);

    expect(await runUntilRuntime(harness)).toMatchObject({ status: "fix_requested" });

    // The fixer runs, the machine returns to runtime verification, and the stage is measured again from
    // the start: a fresh process, a fresh request, and a fresh revision.
    expect(await harness.orchestrator.runNext("F-001")).toMatchObject({
      stage: "fixing",
      event: "complete_fix",
      state: WorkflowState.RuntimeVerification,
    });

    const afterFix = await runUntilRuntime(harness);

    expect(afterFix).toMatchObject({ status: "stage_completed", state: WorkflowState.SecurityReview });
    const [first, second] = seen;

    expect(seen).toHaveLength(2);
    expect(second).toBeGreaterThan(first ?? 0);
  });

  it("refuses runtime evidence collected against an earlier revision", async () => {
    const root = await makeProject();
    const harness = makeHarness(root, (request) =>
      request.verification === "runtime"
        ? // A stale bundle: it describes a tree that has since been rewritten, so it is refused rather
          // than applied to code it never saw.
          bundleFor(request, {
            revision: Math.max(0, request.revision - 1),
            checks: [runtimeCheckFor(request, { status: "passed", reason: null })],
          })
        : bundleFor(request),
    );

    await driveToRuntimeVerification(harness);
    const result = await runUntilRuntime(harness);

    expect(result).toMatchObject({ status: "rejected" });
    expect(result?.error?.code).toBe("verification_evidence_mismatch");
    expect(result?.error?.message).toContain("revision");
    expect(result?.state).toBe(WorkflowState.RuntimeVerification);
  });

  it("binds evidence to the request that asked for it, so a passing stage cannot be moved to another", async () => {
    const root = await makeProject();
    const provider = new ProjectVerificationProvider({ projectRoot: root });

    expect(
      bindVerificationEvidenceToRequest(
        {
          verification: "runtime",
          outcome: "passed",
          revision: 4,
          implementationFingerprint: FINGERPRINT,
          workspace: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
          controlPlane: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
          collectedAt: fixedTimestamp,
          projectRoot: root,
          workspaceId: null,
          project: profileSummary(),
          checks: [],
        },
        {
          featureId: "F-001",
          stage: "static_verification",
          verification: "static",
          revision: 4,
          projectRoot: root,
          workspaceId: null,
        },
      ),
    ).toMatchObject({ ok: false });
    expect(provider.projectRoot).toBe(root);
  });

  it("overrules a reported success only for the runtime stage, and only for absence", () => {
    const deferredRuntime: VerificationEvidenceBundle = {
      verification: "runtime",
      outcome: "deferred",
      revision: 4,
      implementationFingerprint: FINGERPRINT,
      workspace: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
      controlPlane: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
      collectedAt: fixedTimestamp,
      projectRoot: "/project",
      workspaceId: null,
      project: profileSummary(),
      checks: [],
    };

    expect(applyDeterministicEvidence(deferredRuntime, "success", "F-001")).toMatchObject({
      outcome: "inconclusive",
      override: "deterministic_inconclusive",
    });
    // A deferral is not a defect, so it does not send the feature back to the fixer...
    expect(applyDeterministicEvidence(deferredRuntime, "needs_fix", "F-001")).toMatchObject({
      outcome: "needs_fix",
      override: "none",
    });
    // ...and a static stage with no commands is still the verifier's to interpret.
    expect(
      applyDeterministicEvidence({ ...deferredRuntime, verification: "static" }, "success", "F-001"),
    ).toMatchObject({ outcome: "success", override: "none" });
  });
});

describe("a project that declared no runtime verification", () => {
  it("collects a deferred stage with a skipped check, and starts nothing", async () => {
    const root = await makeProject(nodeProjectFiles);
    const provider = new ProjectVerificationProvider({ projectRoot: root });

    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "runtime_verification",
      verification: "runtime",
      revision: 2,
      projectRoot: root,
      workspaceId: null,
    });

    expect(bundle.outcome).toBe("deferred");
    expect(bundle.checks).toHaveLength(1);
    expect(bundle.checks[0]).toMatchObject({
      kind: "runtime",
      status: "skipped",
      reason: "runtime_not_configured",
      capability: "runtime",
    });
    // A check that never ran has no command to attribute, so it claims none.
    expect(bundle.checks[0]?.executable).toBeNull();
    expect(bundle.checks[0]?.exitCode).toBeNull();
  });
});
