import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_OPENCODE_COMMAND,
  OpenCodeAdapterError,
  buildOpenCodeInvocation,
  createOpenCodeCliTransport,
  extractResponseText,
  isOpenCodeAdapterError,
  parseEventStream,
  toCliFormat,
  type OpenCodeTransportRequest,
} from "@agent-workflow-kit/opencode";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-opencode-"));
  roots.push(root);
  return root;
}

/**
 * A stand-in for the OpenCode CLI. `node -e <script>` puts the transport's own arguments at
 * `process.argv[1]`, so a test can assert what the child actually received without a network call,
 * a model, or the real binary.
 */
function fakeOpenCode(script: string): { command: string; extraArgs: string[] } {
  return { command: process.execPath, extraArgs: ["-e", script] };
}

/**
 * A child script that writes the given lines to stdout.
 *
 * The child's source is built with `JSON.stringify` rather than nested quoting, so a test can state
 * the stream as data. The newline separator is written as its own literal for the same reason.
 */
function emitStream(lines: readonly string[]): string {
  return lines
    .map((line) => `process.stdout.write(${JSON.stringify(line)} + ${JSON.stringify("\n")});`)
    .join(" ");
}

/** The answer a stage is expected to return, in the shape the response protocol requires. */
const ANSWER = ['```json', '{"ok":true}', '```'].join("\n");

function requestFor(overrides: Partial<OpenCodeTransportRequest> = {}): OpenCodeTransportRequest {
  return {
    agent: "planner",
    prompt: "# Stage prompt\n\nReturn one fenced JSON block.",
    workingDirectory: process.cwd(),
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

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("invocation construction", () => {
  it("runs the OpenCode CLI by default", () => {
    const invocation = buildOpenCodeInvocation(requestFor());

    expect(invocation.command).toBe(DEFAULT_OPENCODE_COMMAND);
    expect(invocation.args[0]).toBe("run");
  });

  it("passes the agent, the format, and the working directory", () => {
    const { args } = buildOpenCodeInvocation(requestFor({ workingDirectory: "/tmp/project" }));

    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("planner");
    expect(args[args.indexOf("--dir") + 1]).toBe("/tmp/project");
  });

  it("runs in pure mode by default so a project plugin cannot alter a role", () => {
    expect(buildOpenCodeInvocation(requestFor()).args).toContain("--pure");
    expect(buildOpenCodeInvocation(requestFor(), { pure: false }).args).not.toContain("--pure");
  });

  it("never auto-approves unless asked", () => {
    expect(buildOpenCodeInvocation(requestFor()).args).not.toContain("--auto");
    expect(buildOpenCodeInvocation(requestFor(), { autoApprove: true }).args).toContain("--auto");
  });

  it("adds a model only when one is configured", () => {
    expect(buildOpenCodeInvocation(requestFor()).args).not.toContain("--model");
    expect(
      buildOpenCodeInvocation(requestFor({ model: "anthropic/claude-sonnet-4-5" })).args,
    ).toContain("--model");
    expect(
      buildOpenCodeInvocation(requestFor({ model: "x" }), { model: null }).args,
    ).not.toContain("--model");
  });

  it("passes the prompt as a single argument", () => {
    const prompt = "a prompt with $(whoami) and `id` and ; rm -rf /";
    const { args } = buildOpenCodeInvocation(requestFor({ prompt }));

    expect(args.at(-1)).toBe(prompt);
  });

  it("refuses a prompt that would be parsed as an option", () => {
    expect(() => buildOpenCodeInvocation(requestFor({ prompt: "--dangerous" }))).toThrow(
      OpenCodeAdapterError,
    );
  });

  it("never builds a shell command line", () => {
    const { args } = buildOpenCodeInvocation(requestFor({ prompt: "a; b && c | d" }));

    expect(args.every((argument) => typeof argument === "string")).toBe(true);
    expect(args.at(-1)).toBe("a; b && c | d");
  });
});

describe("response text extraction", () => {
  it("reads the formatted answer from stdout", () => {
    expect(extractResponseText("  the answer  ", "text")).toBe("the answer");
  });

  it("maps its own format names onto the ones the current CLI accepts", () => {
    expect(toCliFormat("text")).toBe("default");
    expect(toCliFormat("json")).toBe("json");
  });

  it("asks the CLI for the default format, never a format named text", () => {
    const { args } = buildOpenCodeInvocation(requestFor());

    expect(args[args.indexOf("--format") + 1]).toBe("default");
    expect(args).not.toContain("text");
  });
});

describe("the current V2 event stream", () => {
  const event = (type: string, part?: unknown, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type, timestamp: 1, sessionID: "ses_1", ...(part === undefined ? {} : { part }), ...extra });

  const COMPLETED_TEXT = { type: "text", text: "done", time: { start: 1, end: 2 } };

  it("reads a completed text event", () => {
    const stream = parseEventStream(event("text", COMPLETED_TEXT));

    expect(stream.text).toBe("done");
    expect(stream.textParts).toBe(1);
    expect(stream.error).toBeNull();
    expect(stream.malformedLines).toBe(0);
  });

  it("joins every text part, so an answer split across parts is not truncated", () => {
    const stdout = [
      event("step_start", { id: "step_1" }),
      event("text", { type: "text", text: "first " }),
      event("reasoning", { type: "reasoning", text: "ignored" }),
      event("tool_use", { type: "tool", tool: "read", state: { status: "completed" } }),
      event("text", { type: "text", text: "second" }),
      event("step_finish", { cost: 0 }),
    ].join("\n");

    const stream = parseEventStream(stdout);

    expect(stream.text).toBe("first \nsecond");
    expect(stream.textParts).toBe(2);
    expect(stream.eventTypes).toEqual([
      "step_start",
      "text",
      "reasoning",
      "tool_use",
      "text",
      "step_finish",
    ]);
  });

  it("extracts the answer from a full run", () => {
    const stdout = [event("text", COMPLETED_TEXT), event("step_finish", {})].join("\n");

    expect(extractResponseText(stdout, "json")).toBe("done");
  });

  it("reports a session error instead of returning an answer", () => {
    const stdout = [
      event("text", { type: "text", text: "partial" }),
      event("error", undefined, { error: { name: "MessageAbortedError" } }),
    ].join("\n");

    const stream = parseEventStream(stdout);

    expect(stream.error).toBe("MessageAbortedError");
  });

  it("reads an error message from a provider error object", () => {
    const stdout = event("error", undefined, {
      error: { name: "ProviderAuthError", data: { message: "no credentials" } },
    });

    expect(parseEventStream(stdout).error).toBe("no credentials");
  });

  it("never reads an event it does not recognize as output", () => {
    const stdout = [
      event("session.updated", { info: { id: "ses_1" } }),
      event("some_future_event", { type: "text", text: "not our answer" }),
    ].join("\n");

    const stream = parseEventStream(stdout);

    expect(stream.text).toBe("");
    expect(stream.textParts).toBe(0);
    expect(stream.eventTypes).toEqual(["session.updated", "some_future_event"]);
  });

  it("counts unreadable lines without inventing an answer from them", () => {
    const stdout = [
      "not json at all",
      '{"type": "text", "part"',
      JSON.stringify([1, 2, 3]),
      event("text", COMPLETED_TEXT),
    ].join("\n");

    const stream = parseEventStream(stdout);

    expect(stream.malformedLines).toBe(3);
    expect(stream.text).toBe("done");
  });

  it("finds nothing in output that is not a stream at all", () => {
    const stream = parseEventStream(ANSWER);

    expect(stream.text).toBe("");
    expect(stream.textParts).toBe(0);
    expect(stream.malformedLines).toBe(2);
  });
});

describe("running a child process", () => {
  it("returns the answer and the captured streams on success", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(
      fakeOpenCode(
        'process.stdout.write("```json\\n{\\"ok\\":true}\\n```"); process.stderr.write("a warning");',
      ),
    );

    const result = await transport.run(requestFor({ workingDirectory: root }));

    expect(result.agent).toBe("planner");
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe('```json\n{"ok":true}\n```');
    expect(result.stdout).toContain('{"ok":true}');
    expect(result.stderr).toBe("a warning");
  });

  it("passes the agent, the prompt, and the directory to the child as separate arguments", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(
      fakeOpenCode(
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }));',
      ),
    );

    const prompt = "prompt with $(id) and `uname` and \"quotes\"";
    const result = await transport.run(requestFor({ workingDirectory: root, prompt }));
    const seen = JSON.parse(result.text) as { argv: string[]; cwd: string };

    expect(seen.argv[0]).toBe("run");
    expect(seen.argv).toContain("--pure");
    expect(seen.argv[seen.argv.indexOf("--agent") + 1]).toBe("planner");
    expect(seen.argv[seen.argv.indexOf("--dir") + 1]).toBe(root);
    expect(seen.argv.at(-1)).toBe(prompt);
    expect(seen.argv.filter((argument) => argument === prompt)).toHaveLength(1);
    expect(seen.cwd).toBe(root);
  });

  it("fails a run whose event stream has no answer, rather than reading the raw output", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode('process.stdout.write(JSON.stringify({ type: "text", part: { type: "text" } }));'),
      responseFormat: "json",
    });

    const failure = await transport.run(requestFor({ workingDirectory: root })).catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect((failure as OpenCodeAdapterError).code).toBe("transport_failed");
    expect((failure as Error).message).toContain("no assistant text");
  });

  it("fails a run whose stream holds only events it does not recognize", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode(
        'process.stdout.write(JSON.stringify({ type: "session.updated", part: { text: "sneaky" } }));',
      ),
      responseFormat: "json",
    });

    const failure = await transport.run(requestFor({ workingDirectory: root })).catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_failed");
    expect((failure as Error).message).toContain("session.updated");
  });

  it("fails a run whose stream is not a stream at all", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({ ...fakeOpenCode(emitStream([ANSWER])), responseFormat: "json" });

    const failure = await transport.run(requestFor({ workingDirectory: root })).catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_failed");
  });

  it("fails a run that reported an error in the stream even though it exited zero", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode(
        emitStream([
          JSON.stringify({ type: "text", part: { type: "text", text: "x" } }),
          JSON.stringify({ type: "error", error: "provider exploded" }),
        ]),
      ),
      responseFormat: "json",
    });

    const failure = await transport.run(requestFor({ workingDirectory: root })).catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_failed");
    expect((failure as Error).message).toContain("provider exploded");
  });

  it("returns the text parts of a well-formed json run", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode(
        emitStream([
          JSON.stringify({
            type: "text",
            timestamp: 1,
            sessionID: "ses_1",
            part: { type: "text", text: ANSWER, time: { start: 1, end: 2 } },
          }),
        ]),
      ),
      responseFormat: "json",
    });

    const result = await transport.run(requestFor({ workingDirectory: root }));

    expect(result.text).toBe(ANSWER);
  });

  it("refuses a non-zero exit and reports the code", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(
      fakeOpenCode('process.stderr.write("model unavailable"); process.exit(3);'),
    );

    const failure = await transport.run(requestFor({ workingDirectory: root })).catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect((failure as OpenCodeAdapterError).code).toBe("non_zero_exit");
    expect((failure as Error).message).toContain("exited with code 3");
    expect((failure as Error).message).toContain("model unavailable");
  });

  it("keeps the stage prompt out of the failure message", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(
      fakeOpenCode('process.stderr.write("failed"); process.exit(1);'),
    );

    const prompt = "SECRET-PROMPT-CONTENT";
    const failure = await transport
      .run(requestFor({ workingDirectory: root, prompt }))
      .catch((error: unknown) => error);

    expect((failure as Error).message).not.toContain("SECRET-PROMPT-CONTENT");
  });

  it("truncates a long stderr excerpt", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode('process.stderr.write("e".repeat(5000)); process.exit(1);'),
      stderrExcerptLimit: 100,
    });

    const failure = await transport
      .run(requestFor({ workingDirectory: root }))
      .catch((error: unknown) => error);

    expect((failure as Error).message).toContain("(truncated)");
    expect((failure as Error).message.length).toBeLessThan(500);
  });

  it("stops a run that exceeds the output cap", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode('process.stdout.write("x".repeat(200000)); setTimeout(() => {}, 5000);'),
      maxOutputBytes: 1_000,
      killGraceMs: 100,
    });

    const failure = await transport
      .run(requestFor({ workingDirectory: root }))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("output_truncated");
  });

  it("refuses a run that exceeds its time budget", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode("setTimeout(() => {}, 30000);",),
      killGraceMs: 100,
    });

    const started = Date.now();
    const failure = await transport
      .run(requestFor({ workingDirectory: root, timeoutMs: 250 }))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses a run that is already cancelled", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(fakeOpenCode("setTimeout(() => {}, 1000);",));
    const controller = new AbortController();

    controller.abort();

    const failure = await transport
      .run(requestFor({ workingDirectory: root, signal: controller.signal }))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_cancelled");
  });

  it("terminates a run that is cancelled mid-flight", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode("setTimeout(() => {}, 30000);",),
      killGraceMs: 100,
    });
    const controller = new AbortController();

    const pending = transport
      .run(requestFor({ workingDirectory: root, signal: controller.signal, timeoutMs: 20_000 }))
      .catch((error: unknown) => error);

    setTimeout(() => {
      controller.abort();
    }, 100);

    const failure = await pending;

    expect((failure as OpenCodeAdapterError).code).toBe("transport_cancelled");
  });

  it("refuses a run when the executable does not exist", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      command: join(root, "no-such-opencode-binary"),
    });

    const failure = await transport
      .run(requestFor({ workingDirectory: root }))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_failed");
  });

  it("does not leak the environment into a result or an error", async () => {
    const root = await makeRoot();
    const scriptPath = join(root, "leak.js");
    await writeFile(
      scriptPath,
      'process.stdout.write(process.env.OPENCODE_FAKE_TOKEN ?? "unset");\nprocess.exit(1);\n',
      "utf8",
    );

    const transport = createOpenCodeCliTransport({
      command: process.execPath,
      extraArgs: [scriptPath],
      env: { OPENCODE_FAKE_TOKEN: "super-secret-value" },
    });

    const failure = await transport
      .run(requestFor({ workingDirectory: root }))
      .catch((error: unknown) => error);

    expect((failure as Error).message).not.toContain("super-secret-value");
  });

  it("does not run anything when the environment is not inherited", async () => {
    const root = await makeRoot();
    const scriptPath = join(root, "env.js");
    await writeFile(scriptPath, 'process.stdout.write(String(process.env.PATH ?? "unset"));\n');

    const transport = createOpenCodeCliTransport({
      command: process.execPath,
      extraArgs: [scriptPath],
      inheritEnv: false,
      env: { AGENT_WORKFLOW_KIT_TEST: "1" },
    });

    const result = await transport.run(requestFor({ workingDirectory: root }));

    expect(result.text).toBe("unset");
  });

  it("has a bounded default output cap", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(16_000_000);
  });
});
