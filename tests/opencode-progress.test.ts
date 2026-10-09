import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { STAGE_DEFINITIONS, type StageExecutionRequest } from "@agent-workflow-kit/orchestration";
import {
  OpenCodeAdapterError,
  createOpenCodeCliTransport,
  createOpenCodeStageExecutor,
  extractToolUseLine,
  isOpenCodeAdapterError,
  renderOpenCodeProjectFiles,
  type OpenCodeTransportRequest,
  type StageProgressEvent,
} from "@agent-workflow-kit/opencode";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeOpenCodeTransport } from "../fixtures/opencode-transport.js";
import { testWorkspaceContext } from "../fixtures/workspace.js";

/**
 * Live progress through the OpenCode adapter: the executor's own stage events, and the transport's
 * relay of the child's tool-use lines.
 *
 * No test here calls a model. The stages run against the fake transport, and the two tests that
 * need a real child process use `node -e <script>` as the OpenCode stand-in, which is the same
 * stand-in `tests/opencode-transport.test.ts` already uses.
 */

const roots: string[] = [];

const created = "2026-04-05T06:07:08.000Z";

/** The answer a stage returns, in the fenced form the response protocol requires. */
const ANSWER = ['```json', '{"ok":true}', '```'].join("\n");

/** What OpenCode's own stderr looked like in a real recording, ANSI escapes included. */
const RAW_TOOL_LINE =
  "\u001b[0m\u2192 \u001b[0mRead src/index.ts \u001b[90m[offset=1.0, limit=30.0]\u001b[0m";
const PLAIN_TOOL_LINE = "\u2192 Read src/index.ts [offset=1.0, limit=30.0]";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-progress-"));
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
      title: "Live progress",
      slug: "live-progress",
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

function transportRequestFor(
  overrides: Partial<OpenCodeTransportRequest> = {},
): OpenCodeTransportRequest {
  return {
    agent: "agentflow-read",
    prompt: "# Agent Workflow Kit: Planner on stage `planning`\n\nReturn one fenced JSON block.",
    workingDirectory: process.cwd(),
    runtimeConfigDirectory: null,
    featureId: "F-001",
    stage: "planning",
    role: "planner",
    fixReturnState: null,
    model: null,
    timeoutMs: 10_000,
    signal: null,
    ...overrides,
  };
}

/** A stand-in OpenCode CLI: `node -e <script>`, so no model and no binary are needed. */
function fakeOpenCode(script: string): { command: string; extraArgs: string[] } {
  return { command: process.execPath, extraArgs: ["-e", script] };
}

function onlyStageFailed(events: readonly StageProgressEvent[]): Extract<
  StageProgressEvent,
  { type: "stage_failed" }
> {
  const failures = events.filter(
    (event): event is Extract<StageProgressEvent, { type: "stage_failed" }> =>
      event.type === "stage_failed",
  );
  const failure = failures[0];

  if (failure === undefined) {
    throw new Error(`expected one stage_failed event, saw ${String(failures.length)}`);
  }

  return failure;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("stage progress events from the executor", () => {
  it("emits started, activity, and finished, in that order, for a stage", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", {
      activity: ["\u2192 Read grill.json", "\u2731 Glob src/**/*.ts", "\u2190 Write grill.json"],
    });

    const events: StageProgressEvent[] = [];
    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      onProgress: (event) => {
        events.push(event);
      },
    });

    await executor.execute(requestFor("grill", root));

    expect(events.map((event) => event.type)).toEqual([
      "stage_started",
      "activity",
      "activity",
      "activity",
      "stage_finished",
    ]);
    expect(events[0]).toEqual({ type: "stage_started", stage: "grill" });

    const finished = events.at(-1);

    if (finished === undefined || finished.type !== "stage_finished") {
      throw new Error("expected the last event to be stage_finished");
    }

    expect(finished.stage).toBe("grill");
    expect(finished.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("points at the stage's recording folder when the transport fails", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", {
      error: new OpenCodeAdapterError(
        "transport_timeout",
        'The OpenCode run for agent "agentflow-read" exceeded its 900000ms budget after 900123ms.',
      ),
    });

    const events: StageProgressEvent[] = [];
    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      onProgress: (event) => {
        events.push(event);
      },
    });

    const failure = await executor.execute(requestFor("grill", root)).catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "stage_started",
      "stage_finished",
      "stage_failed",
    ]);

    const reported = onlyStageFailed(events);

    expect(reported.stage).toBe("grill");
    expect(isAbsolute(reported.recordingFolder)).toBe(true);
    expect(reported.recordingFolder).toBe(
      join(root, ".agentflow", "recordings", "F-001", "grill"),
    );
  });

  it("points at the recording folder when a stage reports failure", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", {
      payload: {
        outcome: "failed",
        featureId: "F-001",
        stage: "grill",
        artifacts: [],
        findings: [],
        evidence: [],
        summary: "The griller refused the request.",
      },
    });

    const events: StageProgressEvent[] = [];
    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      onProgress: (event) => {
        events.push(event);
      },
    });

    await executor.execute(requestFor("grill", root));

    const reported = onlyStageFailed(events);

    expect(reported.recordingFolder).toBe(
      join(root, ".agentflow", "recordings", "F-001", "grill"),
    );
  });

  it("emits nothing at all when no progress callback is supplied", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });

    const result = await executor.execute(requestFor("grill", root));

    expect(result.outcome).toBe("success");
  });
});

describe("relayed tool-use lines", () => {
  it("strips ANSI escapes and keeps the tool line", () => {
    expect(extractToolUseLine(RAW_TOOL_LINE)).toBe(PLAIN_TOOL_LINE);
  });

  it("drops headers, prose, and prompt text", () => {
    expect(extractToolUseLine("> agentflow-write \u00b7 big-pickle")).toBeNull();
    expect(extractToolUseLine("# Agent Workflow Kit: Implementer on stage `implementation`")).toBeNull();
    expect(extractToolUseLine("Created file successfully: multiply.mjs")).toBeNull();
    expect(extractToolUseLine("")).toBeNull();
  });

  it("keeps every tool marker OpenCode writes", () => {
    expect(extractToolUseLine("\u2192 Read a.ts")).toBe("\u2192 Read a.ts");
    expect(extractToolUseLine("\u2190 Write a.ts")).toBe("\u2190 Write a.ts");
    expect(extractToolUseLine("\u2731 Glob *.ts")).toBe("\u2731 Glob *.ts");
    expect(extractToolUseLine("\u2717 Read a.ts failed")).toBe("\u2717 Read a.ts failed");
  });

  it("never returns more than 120 characters", () => {
    const line = extractToolUseLine(`\u2192 Read ${"x".repeat(500)}`);

    expect(line).not.toBeNull();
    expect((line ?? "").length).toBeLessThanOrEqual(120);
    expect((line ?? "").startsWith("\u2192 Read")).toBe(true);
  });
});

describe("the transport's live relay", () => {
  it("relays tool-use lines from the child's stderr and never the prompt", async () => {
    const root = await makeRoot();
    const prompt =
      "# Agent Workflow Kit: Implementer on stage `implementation`\nSECRET-PROMPT-CONTENT";
    const script = [
      `process.stderr.write(${JSON.stringify(`${RAW_TOOL_LINE}\n`)});`,
      `process.stderr.write(${JSON.stringify(`${prompt}\n`)});`,
      `process.stderr.write(${JSON.stringify("> agentflow-write \u00b7 big-pickle\n")});`,
      `process.stdout.write(${JSON.stringify(`${ANSWER}\n`)});`,
    ].join(" ");

    const events: StageProgressEvent[] = [];
    const transport = createOpenCodeCliTransport(fakeOpenCode(script));
    const result = await transport.run(
      transportRequestFor({
        workingDirectory: root,
        prompt,
        onProgress: (event) => {
          events.push(event);
        },
      }),
    );

    const lines = events
      .filter((event) => event.type === "activity")
      .map((event) => event.line);

    expect(lines).toEqual([PLAIN_TOOL_LINE]);
    expect(JSON.stringify(events)).not.toContain("SECRET-PROMPT-CONTENT");
    expect(result.exitCode).toBe(0);
  });

  it("relays a line while the child is still running, not after it exits", async () => {
    const root = await makeRoot();
    const script = [
      `process.stderr.write(${JSON.stringify("\u2192 Read early.ts\n")});`,
      "setTimeout(() => {",
      `process.stderr.write(${JSON.stringify("\u2190 Write late.ts\n")});`,
      `process.stdout.write(${JSON.stringify(`${ANSWER}\n`)});`,
      "}, 500);",
    ].join(" ");

    const activityTimes: number[] = [];
    const transport = createOpenCodeCliTransport(fakeOpenCode(script));

    const startedAt = Date.now();
    await transport.run(
      transportRequestFor({
        workingDirectory: root,
        onProgress: (event) => {
          if (event.type === "activity") {
            activityTimes.push(Date.now());
          }
        },
      }),
    );
    const finishedAt = Date.now();

    expect(activityTimes).toHaveLength(2);
    // The child writes the first line and then waits 500ms before the second. A transport that
    // buffered stderr until the process exited would timestamp both lines at the end of the run.
    expect((activityTimes[0] ?? finishedAt) - startedAt).toBeLessThan(400);
    expect(finishedAt - (activityTimes[0] ?? finishedAt)).toBeGreaterThan(250);
  });
});

describe("the stage timeout", () => {
  it("reports transport_timeout with the elapsed time", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode("setTimeout(() => {}, 30000);"),
      killGraceMs: 100,
    });

    const failure = await transport
      .run(transportRequestFor({ workingDirectory: root, timeoutMs: 250 }))
      .catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);

    if (!isOpenCodeAdapterError(failure)) {
      throw new Error("expected an OpenCodeAdapterError");
    }

    expect(failure.code).toBe("transport_timeout");
    expect(failure.message).toMatch(/after \d+ms/u);
  });
});
