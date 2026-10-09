import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_OPENCODE_COMMAND,
  OpenCodeAdapterError,
  REQUIRED_RUN_FLAGS,
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

  it("builds the exact PRD §10.2 invocation, with the prompt as the final positional", () => {
    const prompt = "reply with the word ok";

    expect(buildOpenCodeInvocation(requestFor({ prompt })).args).toEqual([
      "run",
      "--standalone",
      "--agent",
      "planner",
      "--format",
      "default",
      prompt,
    ]);
  });

  it("never sends a `--` separator or a `--prompt` flag, which the CLI does not have", () => {
    const { args } = buildOpenCodeInvocation(requestFor());

    // `opencode run --help` documents the prompt as the positional `[message..]`. Anything after a
    // `--` is message text, which turned every flag into the prompt and ran the default agent.
    expect(args).not.toContain("--");
    expect(args).not.toContain("--prompt");
  });

  it("passes the agent, the format, and the working directory as the child cwd", () => {
    const { args, cwd } = buildOpenCodeInvocation(requestFor({ workingDirectory: "/tmp/project" }));

    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("planner");
    // V2 removed `--dir`; the repository comes from the child process's own working directory.
    expect(args).not.toContain("--dir");
    expect(cwd).toBe("/tmp/project");
  });

  it("runs standalone, so no stage shares a background service with another", () => {
    const { args } = buildOpenCodeInvocation(requestFor());

    expect(args).toContain("--standalone");
    // V2 removed `--pure`. Plugin isolation is the generated `plugins` configuration now, so a
    // flag that no longer exists must not be sent in its place.
    expect(args).not.toContain("--pure");
  });

  it("sends exactly the flags the capability probe requires", () => {
    const { args } = buildOpenCodeInvocation(requestFor());

    for (const flag of REQUIRED_RUN_FLAGS) {
      expect(args).toContain(flag);
    }
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

  it("keeps the model flag between the format and the prompt", () => {
    const { args } = buildOpenCodeInvocation(
      requestFor({ prompt: "hello", model: "anthropic/claude-sonnet-4-5" }),
    );

    expect(args).toEqual([
      "run",
      "--standalone",
      "--agent",
      "planner",
      "--format",
      "default",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "hello",
    ]);
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
    expect(seen.argv).toContain("--standalone");
    expect(seen.argv).not.toContain("--pure");
    expect(seen.argv).not.toContain("--dir");
    expect(seen.argv[seen.argv.indexOf("--agent") + 1]).toBe("planner");
    expect(seen.argv.at(-1)).toBe(prompt);
    expect(seen.argv.filter((argument) => argument === prompt)).toHaveLength(1);
    // The child runs in the stage's repository, which is how V2 discovers the project config and the
    // generated agents now that there is no `--dir`.
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

describe("invocation recordings", () => {
  const STAGE_PROMPT = "# Stage prompt\n\nReturn one fenced JSON block.";

  const recordingsBase = (root: string): string =>
    join(root, ".agentflow", "recordings", "F-001", "planning");

  async function recordingDirectory(root: string): Promise<string> {
    const entries = await readdir(recordingsBase(root));

    expect(entries).toHaveLength(1);

    return join(recordingsBase(root), entries[0] as string);
  }

  interface RecordedManifest {
    featureId: string;
    stage: string;
    command: string;
    args: string[];
    cwd: string;
    startedAt: string;
    durationMs: number;
    termination: string;
    exitCode: number | null;
    error: { code: string; message: string } | null;
  }

  async function recordingManifest(root: string): Promise<RecordedManifest> {
    const directory = await recordingDirectory(root);

    return JSON.parse(await readFile(join(directory, "invocation.json"), "utf8")) as RecordedManifest;
  }

  it("records argv, streams, exit code, and duration of a successful invocation", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(
      fakeOpenCode('process.stdout.write("the answer"); process.stderr.write("a warning");'),
    );

    const result = await transport.run(requestFor({ workingDirectory: root }));
    const directory = await recordingDirectory(root);
    const manifest = await recordingManifest(root);

    expect(manifest.featureId).toBe("F-001");
    expect(manifest.stage).toBe("planning");
    expect(manifest.command).toBe(process.execPath);
    expect(manifest.cwd).toBe(root);
    expect(manifest.termination).toBe("exited");
    expect(manifest.exitCode).toBe(0);
    expect(manifest.error).toBeNull();
    expect(manifest.durationMs).toBeGreaterThanOrEqual(0);
    expect(manifest.startedAt.length).toBeGreaterThan(0);

    const args = manifest.args;

    // The recording is the argv the child actually received, so the fake CLI's own `-e <script>`
    // prefix comes first and `run` follows it.
    expect(args[2]).toBe("run");
    expect(args).toContain("--standalone");
    expect(args).not.toContain("--");
    expect(args.at(-1)).toBe(STAGE_PROMPT);

    expect(await readFile(join(directory, "stdout.txt"), "utf8")).toBe(result.stdout);
    expect(await readFile(join(directory, "stderr.txt"), "utf8")).toBe("a warning");
  });

  /**
   * What the child was handed, read back from the recording a real spawn writes, rather than what
   * the builder returned.
   *
   * Every option except the executable is production's: this is `createOpenCodeCliTransport()` as
   * `apps/cli/src/stack.ts` builds it, with `autoApprove` never set. `--auto` approves everything
   * the generated rules do not explicitly deny, so its absence from the child's own argv is the
   * property that keeps permission decisions inside the ruleset.
   */
  it("sends no auto-approve flag to the child when the caller did not ask for one", async () => {
    const root = await makeRoot();
    const fake = fakeOpenCode('process.stdout.write("the answer");');
    const transport = createOpenCodeCliTransport(fake);

    await transport.run(requestFor({ workingDirectory: root }));

    const manifest = await recordingManifest(root);

    expect(manifest.args).toEqual([
      ...fake.extraArgs,
      "run",
      "--standalone",
      "--agent",
      "planner",
      "--format",
      "default",
      STAGE_PROMPT,
    ]);
    expect(manifest.args).not.toContain("--auto");
  });

  it("records a non-zero exit with its code and its captured streams", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(
      fakeOpenCode('process.stderr.write("model unavailable"); process.exit(3);'),
    );

    const failure = await transport
      .run(requestFor({ workingDirectory: root }))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("non_zero_exit");

    const manifest = await recordingManifest(root);

    expect(manifest.termination).toBe("exited");
    expect(manifest.exitCode).toBe(3);
    expect(manifest.error?.code).toBe("non_zero_exit");
    expect(manifest.error?.message).toContain("exited with code 3");

    const directory = await recordingDirectory(root);

    expect(await readFile(join(directory, "stderr.txt"), "utf8")).toBe("model unavailable");
  });

  it("records a timeout with no exit code and the partial streams it did capture", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode('process.stdout.write("partial"); setTimeout(() => {}, 30000);'),
      killGraceMs: 100,
    });

    const failure = await transport
      .run(requestFor({ workingDirectory: root, timeoutMs: 250 }))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_timeout");

    const manifest = await recordingManifest(root);

    expect(manifest.termination).toBe("timed_out");
    expect(manifest.exitCode).toBeNull();
    expect(manifest.error?.code).toBe("transport_timeout");
    expect(manifest.error?.message.length ?? 0).toBeGreaterThan(0);

    const directory = await recordingDirectory(root);

    expect(await readFile(join(directory, "stdout.txt"), "utf8")).toBe("partial");
  });

  it("writes no recording when the child never ran, as with an already-cancelled run", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(fakeOpenCode("setTimeout(() => {}, 1000);"));
    const controller = new AbortController();

    controller.abort();

    const failure = await transport
      .run(requestFor({ workingDirectory: root, signal: controller.signal }))
      .catch((error: unknown) => error);

    expect((failure as OpenCodeAdapterError).code).toBe("transport_cancelled");
    await expect(readdir(join(root, ".agentflow"))).rejects.toThrow();
  });

  it("writes no recording when recording is disabled", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport({
      ...fakeOpenCode('process.stdout.write("the answer");'),
      recordInvocations: false,
    });

    await transport.run(requestFor({ workingDirectory: root }));

    await expect(readdir(join(root, ".agentflow"))).rejects.toThrow();
  });

  it("never records outside the working directory, whatever the feature id contained", async () => {
    const root = await makeRoot();
    const transport = createOpenCodeCliTransport(
      fakeOpenCode('process.stdout.write("the answer");'),
    );

    // A hostile feature id is sanitized into one safe segment; the run itself is unaffected.
    await transport.run(requestFor({ workingDirectory: root, featureId: "../../elsewhere" }));

    const recordings = await readdir(join(root, ".agentflow", "recordings"));

    expect(recordings).toEqual(["elsewhere"]);
  });

  it("does not fail a run whose recording could not be written", async () => {
    const root = await makeRoot();

    // `.agentflow` exists as a file, so no recording directory can be created under it.
    await writeFile(join(root, ".agentflow"), "not a directory", "utf8");

    const transport = createOpenCodeCliTransport(
      fakeOpenCode('process.stdout.write("the answer");'),
    );

    const result = await transport.run(requestFor({ workingDirectory: root }));

    expect(result.text).toBe("the answer");
    expect(result.exitCode).toBe(0);
  });
});
