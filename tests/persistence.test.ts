import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowState,
  WorkflowStateMachine,
  type WorkflowEvent,
} from "@agent-workflow-kit/core";
import {
  FEATURE_ARTIFACT_FILENAMES,
  FeatureSessionStore,
  PersistenceError,
  createFeatureSessionStore,
  restoreWorkflowStateMachine,
  sanitizeFeatureSlug,
  type Clock,
  type FeatureArtifactName,
  type FeatureEventInput,
  type FeatureSession,
  type PersistenceErrorCode,
} from "@agent-workflow-kit/persistence";
import { afterEach, describe, expect, it } from "vitest";

const fixedTimestamp = "2026-01-02T03:04:05.000Z";
const roots: string[] = [];

const advanceToRuntime: readonly WorkflowEvent[] = [
  "advance",
  "advance",
  "advance",
  "advance",
  "advance",
  "approve_plan",
  "advance",
  "advance",
  "advance",
  "advance",
  "advance",
];

const advanceToComplete: readonly WorkflowEvent[] = [
  ...advanceToRuntime,
  "advance",
  "advance",
  "advance",
  "advance",
  "approve_push",
  "advance",
  "advance",
];

function fixedClock(): string {
  return fixedTimestamp;
}

async function makeStore(clock: Clock = fixedClock): Promise<{
  readonly root: string;
  readonly store: FeatureSessionStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-"));
  roots.push(root);
  return { root, store: createFeatureSessionStore(root, { clock }) };
}

async function expectPersistenceError(
  operation: () => Promise<unknown>,
  code: PersistenceErrorCode,
): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ code });
}

async function readSessionDocument(path: string): Promise<Record<string, unknown>> {
  const serialized = await readFile(path, "utf8");
  return JSON.parse(serialized) as Record<string, unknown>;
}

async function reachState(
  store: FeatureSessionStore,
  featureId: string,
  events: readonly WorkflowEvent[],
): Promise<void> {
  for (const event of events) {
    const result = await store.transition(featureId, event);
    expect(result.ok).toBe(true);
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("FeatureSessionStore sessions", () => {
  it("creates, saves, loads, lists, updates, and checks sessions", async () => {
    const { root, store } = await makeStore();

    const created = await store.create({
      featureId: "F-001",
      title: "Google OAuth / API",
    });

    expect(created).toMatchObject({
      schemaVersion: 1,
      featureId: "F-001",
      slug: "google-oauth-api",
      title: "Google OAuth / API",
      createdAt: fixedTimestamp,
      updatedAt: fixedTimestamp,
      machine: { state: WorkflowState.Draft },
    });
    expect(created.artifacts.request).toEqual({
      filename: FEATURE_ARTIFACT_FILENAMES.request,
      status: "missing",
    });
    expect(await store.load("F-001")).toEqual(created);
    expect(await store.exists("F-001")).toBe(true);

    const updated = await store.update("F-001", { title: "Google OAuth integration" });
    expect(updated.title).toBe("Google OAuth integration");
    expect(await store.load("F-001")).toEqual(updated);

    await store.create({ featureId: "F-002", title: "Second feature" });
    expect((await store.list()).map((session) => session.featureId)).toEqual(["F-001", "F-002"]);

    const sessionPath = join(root, ".agentflow", "features", "F-001-google-oauth-api", "session.json");
    const serialized = await readFile(sessionPath, "utf8");
    const persisted = JSON.parse(serialized) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      featureId: "F-001",
      slug: "google-oauth-api",
      machine: { state: "draft" },
    });
    expect(serialized).not.toContain("artifact content");
  });

  it("round trips a session through JSON and restores a terminal machine", async () => {
    const { root, store } = await makeStore();
    const created = await store.create({ featureId: "F-001", title: "Terminal feature" });
    const sessionPath = join(root, ".agentflow", "features", "F-001-terminal-feature", "session.json");
    const parsed = JSON.parse(await readFile(sessionPath, "utf8")) as FeatureSession;

    expect(parsed).toEqual(created);
    expect(new WorkflowStateMachine(parsed.machine).snapshot).toEqual(created.machine);

    await reachState(store, "F-001", advanceToComplete);
    const restoredStore = new FeatureSessionStore(root, { clock: fixedClock });
    const restored = await restoredStore.load("F-001");
    const machine = new WorkflowStateMachine(restored.machine);

    expect(machine.state).toBe(WorkflowState.Complete);
    expect(machine.transition("advance")).toEqual({
      ok: false,
      code: "terminal_state",
      state: WorkflowState.Complete,
      event: "advance",
      message: 'State "complete" is terminal and cannot process event "advance".',
    });
  });

  it("rejects missing sessions without falling back to draft", async () => {
    const { store } = await makeStore();

    expect(await store.exists("F-999")).toBe(false);
    await expectPersistenceError(() => store.load("F-999"), "FEATURE_NOT_FOUND");
  });
});

describe("FeatureSessionStore restart behavior", () => {
  it("preserves a fix return state across a process simulation", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Fixable feature" });
    await reachState(store, "F-001", advanceToRuntime);

    const fixResult = await store.transition("F-001", "request_fix");
    expect(fixResult).toEqual({ ok: true, state: WorkflowState.Fixing });

    const reloadedStore = new FeatureSessionStore(root, { clock: fixedClock });
    const reloaded = await reloadedStore.load("F-001");
    const restoredMachine = restoreWorkflowStateMachine(reloaded);

    expect(reloaded.machine).toEqual({
      state: WorkflowState.Fixing,
      fixReturnState: WorkflowState.RuntimeVerification,
    });
    expect(restoredMachine.state).toBe(WorkflowState.Fixing);
    expect(restoredMachine.transition("complete_fix")).toEqual({
      ok: true,
      state: WorkflowState.RuntimeVerification,
    });

    const completion = await reloadedStore.transition("F-001", "complete_fix");
    expect(completion).toEqual({ ok: true, state: WorkflowState.RuntimeVerification });
    expect((await reloadedStore.load("F-001")).machine).toEqual({
      state: WorkflowState.RuntimeVerification,
    });
  });
});

describe("FeatureSessionStore artifacts", () => {
  it("writes and reads controlled text and JSON artifacts", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Artifact feature" });

    await store.writeArtifact("F-001", "request", "# Request\n\nUse OAuth.\n");
    const plan = {
      featureId: "F-001",
      summary: "Implement OAuth.",
      steps: [],
    };
    await store.writeArtifact("F-001", "plan", plan);

    expect(await store.readArtifact("F-001", "request")).toBe("# Request\n\nUse OAuth.\n");
    expect(await store.readArtifact("F-001", "plan")).toEqual(plan);
    expect((await store.load("F-001")).artifacts.request).toEqual({
      filename: "request.md",
      status: "present",
      updatedAt: fixedTimestamp,
    });
    expect((await store.load("F-001")).artifacts.plan).toEqual({
      filename: "plan.json",
      status: "present",
      updatedAt: fixedTimestamp,
    });

    const planPath = join(
      root,
      ".agentflow",
      "features",
      "F-001-artifact-feature",
      FEATURE_ARTIFACT_FILENAMES.plan,
    );
    expect(await readFile(planPath, "utf8")).toBe(`${JSON.stringify(plan, null, 2)}\n`);
  });

  it("distinguishes missing artifacts from malformed JSON artifacts", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Corrupt artifacts" });

    await expectPersistenceError(() => store.readArtifact("F-001", "request"), "ARTIFACT_NOT_FOUND");

    const specPath = join(
      root,
      ".agentflow",
      "features",
      "F-001-corrupt-artifacts",
      FEATURE_ARTIFACT_FILENAMES.spec,
    );
    await writeFile(specPath, "{not-json", "utf8");
    await expectPersistenceError(() => store.readArtifact("F-001", "spec"), "MALFORMED_ARTIFACT");
  });

  it("rejects artifact names that could escape the feature directory", async () => {
    const { store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Safe feature" });

    await expectPersistenceError(
      () => store.writeArtifact("F-001", "../outside" as FeatureArtifactName, "text"),
      "INVALID_ARTIFACT_NAME",
    );
    await expectPersistenceError(
      () => store.readArtifact("F-001", "__proto__" as FeatureArtifactName),
      "INVALID_ARTIFACT_NAME",
    );
  });
});

describe("FeatureSessionStore events", () => {
  it("appends one JSON object per line and keeps session state authoritative", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Event feature" });

    expect(await store.transition("F-001", "advance")).toEqual({
      ok: true,
      state: WorkflowState.Grilling,
    });
    const failed = await store.transition("F-001", "request_fix");
    expect(failed.ok).toBe(false);

    const events = await store.readEvents("F-001");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      timestamp: fixedTimestamp,
      featureId: "F-001",
      previousState: WorkflowState.Draft,
      event: "advance",
      resultingState: WorkflowState.Grilling,
      success: true,
    });
    expect(events[1]).toMatchObject({
      previousState: WorkflowState.Grilling,
      event: "request_fix",
      resultingState: WorkflowState.Grilling,
      success: false,
      errorCode: "illegal_transition",
    });

    const eventPath = join(root, ".agentflow", "features", "F-001-event-feature", "events.jsonl");
    const lines = (await readFile(eventPath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => JSON.parse(line) !== null)).toBe(true);
    expect((await store.load("F-001")).machine).toEqual({ state: WorkflowState.Grilling });

    await store.appendEvent("F-001", {
      previousState: WorkflowState.Grilling,
      event: "advance",
      resultingState: WorkflowState.SpecReady,
      success: true,
    });
    expect((await store.load("F-001")).machine).toEqual({ state: WorkflowState.Grilling });
    expect(await store.readEvents("F-001")).toHaveLength(3);
  });

  it("rejects event inputs that are not valid workflow events", async () => {
    const { store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Event input feature" });

    await expectPersistenceError(
      () =>
        store.appendEvent("F-001", {
          previousState: WorkflowState.Draft,
          event: "teleport" as WorkflowEvent,
          resultingState: WorkflowState.Draft,
          success: true,
        }),
      "INVALID_EVENT",
    );
    await expectPersistenceError(
      () => store.appendEvent("F-001", undefined as unknown as FeatureEventInput),
      "INVALID_EVENT",
    );
    expect(await store.readEvents("F-001")).toEqual([]);
  });

  it("persists a successful transition before a failed event append is reported", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Ordering feature" });
    const eventsPath = join(root, ".agentflow", "features", "F-001-ordering-feature", "events.jsonl");
    await mkdir(eventsPath);

    await expectPersistenceError(() => store.transition("F-001", "advance"), "UNSAFE_PATH");
    expect((await store.load("F-001")).machine).toEqual({ state: WorkflowState.Grilling });
  });
});

describe("FeatureSessionStore corruption and safety", () => {
  it("rejects malformed session JSON and unknown schema versions", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Schema feature" });
    const sessionPath = join(root, ".agentflow", "features", "F-001-schema-feature", "session.json");

    const document = await readSessionDocument(sessionPath);
    await writeFile(sessionPath, "{broken", "utf8");
    await expectPersistenceError(() => store.load("F-001"), "MALFORMED_SESSION");

    await writeFile(
      sessionPath,
      JSON.stringify({ ...document, schemaVersion: 2 }),
      "utf8",
    );
    await expectPersistenceError(() => store.load("F-001"), "UNSUPPORTED_SCHEMA_VERSION");
  });

  it("rejects invalid workflow snapshots and stale fix return state", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Snapshot feature" });
    const sessionPath = join(root, ".agentflow", "features", "F-001-snapshot-feature", "session.json");
    const document = await readSessionDocument(sessionPath);

    await writeFile(
      sessionPath,
      JSON.stringify({ ...document, machine: { state: "unknown" } }),
      "utf8",
    );
    await expectPersistenceError(() => store.load("F-001"), "INVALID_WORKFLOW_SNAPSHOT");

    await writeFile(
      sessionPath,
      JSON.stringify({
        ...document,
        machine: { state: "draft", fixReturnState: "runtime_verification" },
      }),
      "utf8",
    );
    await expectPersistenceError(() => store.load("F-001"), "INVALID_WORKFLOW_SNAPSHOT");
  });

  it("rejects a session whose featureId does not match its directory", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Mismatch feature" });
    const sessionPath = join(root, ".agentflow", "features", "F-001-mismatch-feature", "session.json");
    const document = await readSessionDocument(sessionPath);

    await writeFile(sessionPath, JSON.stringify({ ...document, featureId: "F-002" }), "utf8");
    await expectPersistenceError(() => store.load("F-001"), "FEATURE_MISMATCH");
    expect(await store.exists("F-002")).toBe(false);
  });

  it("rejects a session file belonging to another feature", async () => {
    const { root, store } = await makeStore();
    const created = await store.create({ featureId: "F-001", title: "Protected" });
    const sessionPath = join(root, ".agentflow", "features", "F-001-protected", "session.json");
    const document = await readSessionDocument(sessionPath);
    const conflicting = JSON.stringify({ ...document, featureId: "F-002" });
    await writeFile(sessionPath, conflicting, "utf8");

    await expectPersistenceError(() => store.save(created), "FEATURE_MISMATCH");
    expect(await readFile(sessionPath, "utf8")).toBe(conflicting);
  });

  it("rejects a symlinked workflow root instead of writing outside the repository", async () => {
    const { root, store } = await makeStore();
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, ".agentflow"), "dir");

    await expectPersistenceError(
      () => store.create({ featureId: "F-001", title: "Escaping feature" }),
      "UNSAFE_PATH",
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects duplicate feature IDs and duplicate feature directories", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Original" });
    await expectPersistenceError(
      () => store.create({ featureId: "F-001", title: "Another", slug: "different" }),
      "DUPLICATE_FEATURE",
    );

    const sourcePath = join(root, ".agentflow", "features", "F-001-original", "session.json");
    const alternatePath = join(root, ".agentflow", "features", "F-001-alternate");
    await mkdir(alternatePath);
    await writeFile(join(alternatePath, "session.json"), await readFile(sourcePath), "utf8");
    await expectPersistenceError(() => store.load("F-001"), "DUPLICATE_FEATURE_DIRECTORY");
  });

  it("sanitizes slugs and rejects unsafe feature identifiers", async () => {
    const { root, store } = await makeStore();

    expect(sanitizeFeatureSlug("../../Google OAuth / API")).toBe("google-oauth-api");
    expect(store.featureDirectoryPath("F-001", "../outside")).toBe(
      join(root, ".agentflow", "features", "F-001-outside"),
    );
    await expect(store.load("../F-001")).rejects.toThrow("Feature ID");
    await expect(
      store.create({ featureId: "F-001", title: "Unsafe", slug: "../../outside" }),
    ).resolves.toMatchObject({ slug: "outside" });
    expect((await lstat(join(root, ".agentflow", "features", "F-001-outside"))).isDirectory()).toBe(
      true,
    );
  });

  it("does not treat a missing session file as a valid draft", async () => {
    const { root, store } = await makeStore();
    await store.create({ featureId: "F-001", title: "Missing file" });
    const sessionPath = join(root, ".agentflow", "features", "F-001-missing-file", "session.json");
    await rm(sessionPath);

    expect(await store.exists("F-001")).toBe(false);
    await expectPersistenceError(() => store.load("F-001"), "FEATURE_NOT_FOUND");
  });
});

describe("FeatureSessionStore contract", () => {
  it("uses a versioned session document without artifact contents", () => {
    const session: FeatureSession = {
      schemaVersion: 1,
      featureId: "F-001",
      slug: "contract",
      title: "Contract",
      createdAt: fixedTimestamp,
      updatedAt: fixedTimestamp,
      machine: { state: WorkflowState.Draft },
      artifacts: {
        request: { filename: "request.md", status: "missing" },
        grill: { filename: "grill.json", status: "missing" },
        spec: { filename: "spec.json", status: "missing" },
        plan: { filename: "plan.json", status: "missing" },
        plan_review: { filename: "plan-review.json", status: "missing" },
        implementation: { filename: "implementation.json", status: "missing" },
        code_review: { filename: "code-review.json", status: "missing" },
        scope_review: { filename: "scope-review.json", status: "missing" },
        verification: { filename: "verification.json", status: "missing" },
        security_review: { filename: "security-review.json", status: "missing" },
        final_summary: { filename: "final-summary.md", status: "missing" },
      },
    };

    expect(PersistenceError.prototype).toBeInstanceOf(Error);
    expect(session).not.toHaveProperty("request");
  });
});
