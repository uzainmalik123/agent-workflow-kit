import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STAGE_DEFINITIONS, type StageExecutionRequest } from "@agent-workflow-kit/orchestration";
import {
  DEFAULT_FORMAT_RETRIES,
  INVOCATION_MANIFEST_FILENAME,
  OpenCodeAdapterError,
  createOpenCodeCliTransport,
  createOpenCodeStageExecutor,
  formatReplyRejectionNotice,
  isOpenCodeAdapterError,
  renderOpenCodeProjectFiles,
  type StageProgressEvent,
} from "@agent-workflow-kit/opencode";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeOpenCodeTransport,
  defaultPayload,
  renderFencedJson,
} from "../fixtures/opencode-transport.js";
import { testWorkspaceContext } from "../fixtures/workspace.js";

/**
 * The bounded retry for replies that fail the response contract (D-15).
 *
 * A reply with no fenced JSON block — or an empty one, or one that fails validation — is a
 * formatting miss, and it used to kill the stage immediately while the recording showed a clean
 * exit 0 with no error. The contract itself is unchanged: every attempt still has to satisfy
 * exactly one fenced JSON block and the full validation. No test here calls a model.
 */

const roots: string[] = [];

const created = "2026-04-05T06:07:08.000Z";

/** A reply that fails the contract: prose, no fence. Control characters included on purpose. */
const BAD_REPLY = "prose with no fence\u0007\u001b[31m and a newline\nmore prose";

/** What the same reply looks like with its control characters stripped out. */
const BAD_REPLY_PLAIN = "prose with no fence[31m and a newlinemore prose";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-format-retry-"));
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
      title: "Bounded retry",
      slug: "bounded-retry",
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

/** A stand-in OpenCode CLI: `node -e <script>`, so no model and no binary are needed. */
function fakeOpenCode(script: string): { command: string; extraArgs: string[] } {
  return { command: process.execPath, extraArgs: ["-e", script] };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("bounded retry for a rejected reply", () => {
  it("succeeds when the first reply is rejected and the retry is good", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configureSequence("grill", [{ text: BAD_REPLY }, {}]);

    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });
    const result = await executor.execute(requestFor("grill", root));

    expect(result.outcome).toBe("success");
    expect(transport.callCount).toBe(2);
  });

  it("retries with the identical prompt plus one appended rejection line", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configureSequence("grill", [{ text: BAD_REPLY }, {}]);

    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });
    await executor.execute(requestFor("grill", root));

    const first = transport.calls[0];
    const second = transport.calls[1];

    if (first === undefined || second === undefined) {
      throw new Error("expected two transport calls");
    }

    expect(first.prompt.includes("Your previous reply was rejected")).toBe(false);
    expect(second.prompt).toBe(
      `${first.prompt.endsWith("\n") ? first.prompt : `${first.prompt}\n`}${formatReplyRejectionNotice(
        "malformed_response",
      )}\n`,
    );
  });

  it("emits one format_retry progress event per retry, naming the code", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { text: BAD_REPLY });

    const events: StageProgressEvent[] = [];
    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      onProgress: (event) => {
        events.push(event);
      },
    });

    await executor.execute(requestFor("grill", root)).catch(() => undefined);

    expect(events.map((event) => event.type)).toEqual([
      "stage_started",
      "format_retry",
      "format_retry",
      "stage_finished",
      "stage_failed",
    ]);

    const retries = events.filter(
      (event): event is Extract<StageProgressEvent, { type: "format_retry" }> =>
        event.type === "format_retry",
    );

    expect(retries).toEqual([
      { type: "format_retry", stage: "grill", code: "malformed_response", retry: 1, maxRetries: 2 },
      { type: "format_retry", stage: "grill", code: "malformed_response", retry: 2, maxRetries: 2 },
    ]);
  });

  it("fails after every attempt with the code, the attempts, the reply's shape, and the folder", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { text: BAD_REPLY });

    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);

    if (!isOpenCodeAdapterError(failure)) {
      throw new Error("expected an OpenCodeAdapterError");
    }

    expect(failure.code).toBe("malformed_response");
    // 1 original attempt + DEFAULT_FORMAT_RETRIES retries.
    expect(DEFAULT_FORMAT_RETRIES).toBe(2);
    expect(transport.callCount).toBe(1 + DEFAULT_FORMAT_RETRIES);

    const message = failure.message;

    expect(message).toContain('"malformed_response"');
    expect(message).toContain(`after ${String(1 + DEFAULT_FORMAT_RETRIES)} attempts`);
    expect(message).toContain(`${String(Buffer.byteLength(BAD_REPLY, "utf8"))} bytes`);
    expect(message).toContain(BAD_REPLY_PLAIN);
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\u0007");
    expect(message).not.toContain("\n");
    expect(message).toContain(
      `Recording folder: ${join(root, ".agentflow", "recordings", "F-001", "grill")}`,
    );
  });

  it("honours a configured retry count", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { text: BAD_REPLY });

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      formatRetries: 1,
    });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(transport.callCount).toBe(2);
    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect((failure as OpenCodeAdapterError).message).toContain("after 2 attempts");
  });

  it("retries an empty reply, which is the same class of failure", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configureSequence("grill", [{ text: "   " }, {}]);

    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });
    const result = await executor.execute(requestFor("grill", root));

    expect(result.outcome).toBe("success");
    expect(transport.callCount).toBe(2);
  });

  it("retries an invalid_result, which is the same class of failure", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    // A structurally perfect fenced JSON object that smuggles a workflow control field.
    transport.configureSequence("grill", [
      {
        payload: {
          outcome: "success",
          featureId: "F-001",
          stage: "grill",
          artifacts: [],
          findings: [],
          evidence: [],
          summary: "ok",
          nextState: "implemented",
        },
      },
      {},
    ]);

    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });
    const result = await executor.execute(requestFor("grill", root));

    expect(result.outcome).toBe("success");
    expect(transport.callCount).toBe(2);
    expect(transport.calls[1]?.prompt).toContain(formatReplyRejectionNotice("invalid_result"));
  });

  it("never retries a transport timeout", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", {
      error: new OpenCodeAdapterError(
        "transport_timeout",
        'The OpenCode run for agent "agentflow-read" exceeded its 900000ms budget after 900123ms.',
      ),
    });

    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect((failure as OpenCodeAdapterError).code).toBe("transport_timeout");
    expect(transport.callCount).toBe(1);
    // Not the format-failure message: a timeout is never reworded as a rejected reply.
    expect((failure as OpenCodeAdapterError).message).not.toContain("rejected");
  });

  it("never retries a non-zero exit", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { text: BAD_REPLY, exitCode: 3 });

    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect((failure as OpenCodeAdapterError).code).toBe("non_zero_exit");
    expect(transport.callCount).toBe(1);
  });

  it("never retries a mismatched agent, which is a transport failure", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { agent: "some-other-agent" });

    const executor = createOpenCodeStageExecutor({ transport, projectRoot: root });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect((failure as OpenCodeAdapterError).code).toBe("transport_failed");
    expect(transport.callCount).toBe(1);
  });

  it("restores the single-attempt behaviour when retries are disabled", async () => {
    const root = await makeRoot();
    const transport = createFakeOpenCodeTransport();
    transport.configure("grill", { text: BAD_REPLY });

    const executor = createOpenCodeStageExecutor({
      transport,
      projectRoot: root,
      formatRetries: 0,
    });
    const failure = await executor
      .execute(requestFor("grill", root))
      .catch((error: unknown) => error);

    expect(transport.callCount).toBe(1);
    expect(isOpenCodeAdapterError(failure)).toBe(true);
    expect((failure as OpenCodeAdapterError).code).toBe("malformed_response");
    expect((failure as OpenCodeAdapterError).message).toContain("after 1 attempt");
  });
});

describe("every attempt is recorded", () => {
  it("writes one recording per attempt, each naming its attempt number and reply outcome", async () => {
    const root = await makeRoot();
    // A real spawn, a fake CLI: the script answers with prose until it sees the rejection notice,
    // then with the payload the workflow contract expects. No model is involved.
    const good = renderFencedJson(
      defaultPayload({
        featureId: "F-001",
        stage: "grill",
        role: STAGE_DEFINITIONS["grill"].role,
        fixReturnState: null,
      }),
    );
    const script = [
      "const prompt = process.argv.at(-1);",
      `const good = ${JSON.stringify(good)};`,
      'if (prompt.includes("Your previous reply was rejected")) { process.stdout.write(good); }',
      'else { process.stdout.write("prose with no fence"); }',
    ].join(" ");

    const executor = createOpenCodeStageExecutor({
      transport: createOpenCodeCliTransport(fakeOpenCode(script)),
      projectRoot: root,
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

    // Newest-last by directory name is not guaranteed — the suffix is random — so the attempt
    // number inside each manifest is what orders them.
    const byAttempt = new Map(
      manifests.map((manifest) => [manifest["attempt"], manifest["responseOutcome"]]),
    );

    expect(byAttempt.get(1)).toBe("malformed_response");
    expect(byAttempt.get(2)).toBe("accepted");

    for (const manifest of manifests) {
      // A parse failure used to be invisible: exit 0 and no error in the manifest.
      expect(manifest["exitCode"]).toBe(0);
      expect(manifest["error"]).toBeNull();
    }
  });
});
