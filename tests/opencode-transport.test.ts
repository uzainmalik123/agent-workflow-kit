import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_OPENCODE_COMMAND,
  OpenCodeAdapterError,
  buildOpenCodeInvocation,
  createOpenCodeCliTransport,
  extractEventStreamText,
  extractResponseText,
  isOpenCodeAdapterError,
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

  it("reads text parts from the raw event stream", () => {
    const stdout = [
      JSON.stringify({ type: "part", part: { type: "text", text: "first " } }),
      JSON.stringify({ type: "part", part: { type: "reasoning", text: "ignored" } }),
      JSON.stringify({ type: "part", part: { type: "text", text: "second" } }),
    ].join("\n");

    expect(extractResponseText(stdout, "json")).toBe("first second");
  });

  it("reads an assistant message event", () => {
    const stdout = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });

    expect(extractEventStreamText(stdout)).toBe("hello");
  });

  it("returns the raw output when no event is recognized, so parsing fails closed", () => {
    expect(extractEventStreamText("nothing structured here")).toBe("nothing structured here");
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
