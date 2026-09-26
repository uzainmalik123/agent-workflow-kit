import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  WorkflowState,
  WorkflowStateMachine,
  type TransitionResult,
  type WorkflowEvent,
} from "@agent-workflow-kit/core";
import {
  FEATURE_ARTIFACT_FILENAMES,
  FEATURE_SESSION_SCHEMA_VERSION,
  createEmptyApprovals,
  createEmptyArtifactReferences,
  type Clock,
  type CreateFeatureSessionInput,
  type FeatureApprovals,
  type FeatureArtifactReference,
  type FeatureEvent,
  type FeatureEventInput,
  type FeatureSession,
  type FeatureSessionUpdater,
  type FeatureArtifactName,
} from "./contracts.js";
import { isFeatureArtifactName, parseArtifact, serializeArtifact } from "./artifacts.js";
import { hasErrorCode, PersistenceError } from "./errors.js";
import { FeatureLock, type FeatureLockOptions } from "./lock.js";
import type {
  FeatureArtifactWrite,
  FeatureMutationPlan,
  FeatureMutationReader,
  FeatureReadContext,
  FeatureMutationRequest,
} from "./mutation.js";
import {
  assertFeatureId,
  formatFeatureDirectoryName,
  parseFeatureDirectoryName,
  sanitizeFeatureSlug,
  type FeatureDirectoryParts,
} from "./names.js";
import {
  isRecord,
  parseFeatureSessionDocument,
} from "./validation.js";

const SESSION_FILENAME = "session.json";
const EVENTS_FILENAME = "events.jsonl";

export interface FeatureSessionStoreOptions {
  readonly clock?: Clock;
  /** Tuning for the short-lived per-feature mutation lock. */
  readonly lock?: FeatureLockOptions;
}

export interface FeatureMutationOutcome {
  readonly session: FeatureSession;
  readonly event: FeatureEvent | null;
  readonly transition: TransitionResult | null;
  readonly artifacts: readonly FeatureArtifactName[];
}

export interface FeatureSessionStoreConfig extends FeatureSessionStoreOptions {
  readonly repositoryRoot: string;
}

interface FeatureLocation {
  readonly directoryPath: string;
  readonly session: FeatureSession;
}

interface FeatureDirectoryCandidate extends FeatureDirectoryParts {
  readonly directoryName: string;
  readonly directoryPath: string;
}

const systemClock: Clock = () => new Date().toISOString();

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    return;
  }
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PersistenceError("INVALID_ARGUMENT", `${fieldName} must be a non-empty string.`);
  }

  return value;
}

function isTimestampString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function requireTimestamp(value: string): string {
  if (!isTimestampString(value)) {
    throw new PersistenceError("INVALID_ARGUMENT", "Clock returned an invalid timestamp.");
  }

  return value;
}

function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  return (
    value === "advance" ||
    value === "request_fix" ||
    value === "complete_fix" ||
    value === "fail" ||
    value === "approve_plan" ||
    value === "approve_push"
  );
}

function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === "string" && Object.values(WorkflowState).includes(value as WorkflowState);
}

interface ValidatedEventFields {
  readonly previousState: WorkflowState;
  readonly event: WorkflowEvent;
  readonly resultingState: WorkflowState;
  readonly success: boolean;
  readonly revision: number;
  readonly errorCode?: string;
}

function readEventFields(value: Record<string, unknown>, subject: string): ValidatedEventFields {
  const previousState = value["previousState"];
  if (!isWorkflowState(previousState)) {
    throw new PersistenceError("MALFORMED_EVENT_LOG", `${subject} has an invalid previousState.`);
  }

  const event = value["event"];
  if (!isWorkflowEvent(event)) {
    throw new PersistenceError("MALFORMED_EVENT_LOG", `${subject} has an invalid event.`);
  }

  const resultingState = value["resultingState"];
  if (!isWorkflowState(resultingState)) {
    throw new PersistenceError("MALFORMED_EVENT_LOG", `${subject} has an invalid resultingState.`);
  }

  const success = value["success"];
  if (typeof success !== "boolean") {
    throw new PersistenceError("MALFORMED_EVENT_LOG", `${subject} has an invalid success value.`);
  }

  const revision = value["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    throw new PersistenceError("MALFORMED_EVENT_LOG", `${subject} has an invalid revision.`);
  }

  const errorCode = value["errorCode"];
  if (errorCode !== undefined && (typeof errorCode !== "string" || errorCode.length === 0)) {
    throw new PersistenceError("MALFORMED_EVENT_LOG", `${subject} has an invalid errorCode.`);
  }

  if (errorCode === undefined) {
    return { previousState, event, resultingState, success, revision };
  }

  return { previousState, event, resultingState, success, revision, errorCode };
}

function makeEvent(
  featureId: string,
  timestamp: string,
  fields: FeatureEventInput,
): FeatureEvent {
  return { timestamp, featureId, ...fields };
}

function validateEventDocument(value: unknown, featureId: string, lineNumber?: number): FeatureEvent {
  const subject =
    lineNumber === undefined ? "Event log entry" : `Event log entry on line ${String(lineNumber)}`;

  if (!isRecord(value)) {
    throw new PersistenceError(
      "MALFORMED_EVENT_LOG",
      `${subject} must be a JSON object.`,
    );
  }

  if (value["featureId"] !== featureId) {
    throw new PersistenceError(
      "MALFORMED_EVENT_LOG",
      `${subject} has a mismatched featureId.`,
    );
  }

  const timestamp = value["timestamp"];
  if (!isTimestampString(timestamp)) {
    throw new PersistenceError(
      "MALFORMED_EVENT_LOG",
      `${subject} has an invalid timestamp.`,
    );
  }

  return { timestamp, featureId, ...readEventFields(value, subject) };
}

export class FeatureSessionStore {
  readonly repositoryRoot: string;
  readonly agentflowRoot: string;
  readonly featuresRoot: string;
  readonly #clock: Clock;
  readonly #lock: FeatureLock;

  constructor(repositoryRoot: string, options?: FeatureSessionStoreOptions);
  constructor(config: FeatureSessionStoreConfig);
  constructor(
    repositoryRootOrConfig: string | FeatureSessionStoreConfig,
    options: FeatureSessionStoreOptions = {},
  ) {
    const repositoryRoot =
      typeof repositoryRootOrConfig === "string"
        ? repositoryRootOrConfig
        : repositoryRootOrConfig.repositoryRoot;
    const clock =
      typeof repositoryRootOrConfig === "string"
        ? options.clock
        : repositoryRootOrConfig.clock;

    if (typeof repositoryRoot !== "string" || repositoryRoot.trim().length === 0) {
      throw new PersistenceError(
        "INVALID_ARGUMENT",
        "Repository root must be a non-empty string.",
      );
    }

    this.repositoryRoot = resolve(repositoryRoot);
    this.agentflowRoot = join(this.repositoryRoot, ".agentflow");
    this.featuresRoot = join(this.agentflowRoot, "features");
    this.#clock = clock ?? systemClock;
    this.#lock = new FeatureLock(
      (typeof repositoryRootOrConfig === "string" ? options : repositoryRootOrConfig).lock,
    );
  }

  featureDirectoryPath(featureId: string, slug: string): string {
    const directoryName = formatFeatureDirectoryName(featureId, slug);
    return join(this.featuresRoot, directoryName);
  }

  async create(input: CreateFeatureSessionInput): Promise<FeatureSession> {
    if (!isRecord(input)) {
      throw new PersistenceError("INVALID_ARGUMENT", "Create input must be an object.");
    }

    const featureId = requireNonEmptyString(input.featureId, "featureId");
    assertFeatureId(featureId);
    const title = requireNonEmptyString(input.title, "title");
    const slug = sanitizeFeatureSlug(input.slug === undefined ? title : input.slug);
    const directoryName = formatFeatureDirectoryName(featureId, slug);
    const directoryPath = join(this.featuresRoot, directoryName);
    const timestamp = requireTimestamp(this.#clock());

    await this.#ensureFeaturesRoot();

    const existingCandidates = await this.#findCandidates(featureId);
    if (existingCandidates.length > 0) {
      throw new PersistenceError(
        "DUPLICATE_FEATURE",
        `Feature "${featureId}" already has a session directory.`,
      );
    }

    try {
      await mkdir(directoryPath);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw new PersistenceError(
          "DUPLICATE_FEATURE",
          `Feature directory "${directoryName}" already exists.`,
        );
      }

      throw new PersistenceError(
        "IO_ERROR",
        `Unable to create feature directory "${directoryPath}".`,
        { cause: error, path: directoryPath },
      );
    }

    const session: FeatureSession = {
      schemaVersion: FEATURE_SESSION_SCHEMA_VERSION,
      featureId,
      slug,
      title,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      machine: new WorkflowStateMachine().snapshot,
      artifacts: createEmptyArtifactReferences(),
      approvals: createEmptyApprovals(),
    };

    const sessionPath = join(directoryPath, SESSION_FILENAME);

    try {
      await this.atomicWriteFile(sessionPath, this.#serializeSession(session));
    } catch (error) {
      await this.#removeEmptyDirectory(directoryPath);
      throw error;
    }

    return session;
  }

  async load(featureId: string): Promise<FeatureSession> {
    return (await this.#loadLocation(featureId)).session;
  }

  /**
   * Low-level escape hatch: writes a session verbatim. Because it is not guarded by an
   * optimistic precondition the caller owns the derivation, so a session may only replace a
   * persisted revision exactly one lower than its own. Use `mutate` for workflow changes.
   */
  async save(session: FeatureSession): Promise<FeatureSession> {
    const normalized = parseFeatureSessionDocument(session);
    const directoryName = formatFeatureDirectoryName(normalized.featureId, normalized.slug);
    const directoryPath = join(this.featuresRoot, directoryName);
    const candidates = await this.#findCandidates(normalized.featureId);

    if (candidates.length > 1) {
      throw new PersistenceError(
        "DUPLICATE_FEATURE_DIRECTORY",
        `Feature "${normalized.featureId}" has multiple session directories.`,
      );
    }

    if (candidates.length === 1 && candidates[0]?.directoryName !== directoryName) {
      throw new PersistenceError(
        "DUPLICATE_FEATURE_DIRECTORY",
        `Feature "${normalized.featureId}" has a conflicting session directory.`,
      );
    }

    const directoryExists = await this.#pathExists(directoryPath);

    if (directoryExists) {
      await this.#assertDirectory(directoryPath);
    } else {
      await this.#ensureFeaturesRoot();

      try {
        await mkdir(directoryPath);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw new PersistenceError(
            "IO_ERROR",
            `Unable to create feature directory "${directoryPath}".`,
            { cause: error, path: directoryPath },
          );
        }

        await this.#assertDirectory(directoryPath);
      }
    }

    return this.#lock.withLock(directoryPath, async () => {
      const existing = await this.#readExistingSession(
        directoryPath,
        normalized.featureId,
        directoryName,
      );

      if (existing !== undefined && existing.revision + 1 !== normalized.revision) {
        throw new PersistenceError(
          "REVISION_CONFLICT",
          `Refusing to write revision ${String(normalized.revision)} over persisted revision ${String(existing.revision)} for feature "${normalized.featureId}".`,
          { path: join(directoryPath, SESSION_FILENAME) },
        );
      }

      await this.#persistSessionFile(directoryPath, normalized);
      return normalized;
    });
  }

  /**
   * Metadata-only patch applied to the freshly re-read session, so a concurrent writer can
   * never make the patch land on top of a newer revision. Workflow state is not patchable here.
   */
  async update(featureId: string, update: FeatureSessionUpdater): Promise<FeatureSession> {
    const located = await this.#loadLocation(featureId);

    return this.#lock.withLock(located.directoryPath, async () => {
      const location = await this.#loadLocation(featureId);
      const patch = typeof update === "function" ? update(location.session) : update;

      if (!isRecord(patch)) {
        throw new PersistenceError("INVALID_ARGUMENT", "Session update must be an object or function.");
      }

      if (patch["machine"] !== undefined) {
        throw new PersistenceError(
          "INVALID_ARGUMENT",
          "Session update cannot patch the workflow state machine. Use a revision guarded event mutation instead.",
        );
      }

      const next: FeatureSession = {
        ...location.session,
        title: patch["title"] === undefined ? location.session.title : patch["title"] as string,
        revision: location.session.revision + 1,
        updatedAt: requireTimestamp(this.#clock()),
        artifacts:
          patch["artifacts"] === undefined
            ? location.session.artifacts
            : patch["artifacts"] as FeatureSession["artifacts"],
        approvals:
          patch["approvals"] === undefined
            ? location.session.approvals
            : patch["approvals"] as FeatureApprovals,
      };

      await this.#persistSessionFile(location.directoryPath, next);
      return next;
    });
  }

  /**
   * The single authoritative mutation path.
   *
   * The per-feature lock is held for the whole critical section, the persisted revision is
   * re-checked inside it, and the plan is prepared against the state the mutation replaces.
   * Artifacts are written first, then the session with the next revision, then the event log,
   * so a reported failure can always be classified by reloading the session.
   */
  async mutate(featureId: string, request: FeatureMutationRequest): Promise<FeatureMutationOutcome> {
    if (!isRecord(request) || typeof request.prepare !== "function") {
      throw new PersistenceError("INVALID_ARGUMENT", "Mutation request must provide a prepare function.");
    }

    const { expectedRevision, prepare } = request;

    if (
      expectedRevision !== undefined &&
      (typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 0)
    ) {
      throw new PersistenceError("INVALID_ARGUMENT", "expectedRevision must be a non-negative integer.");
    }

    const located = await this.#loadLocation(featureId);

    return this.#lock.withLock(located.directoryPath, async () => {
      const location = await this.#loadLocation(featureId);
      const { session, directoryPath } = location;

      if (expectedRevision !== undefined && session.revision !== expectedRevision) {
        throw new PersistenceError(
          "REVISION_CONFLICT",
          `Feature "${featureId}" is at revision ${String(session.revision)} but the mutation expected revision ${String(expectedRevision)}.`,
          { path: join(directoryPath, SESSION_FILENAME) },
        );
      }

      const timestamp = requireTimestamp(this.#clock());
      const plan = await prepare(this.#mutationReader(location, timestamp));

      if (!isRecord(plan)) {
        throw new PersistenceError("INVALID_ARGUMENT", "Mutation plan must be an object.");
      }

      return this.#commitMutation(location, plan, timestamp);
    });
  }

  async #commitMutation(
    location: FeatureLocation,
    plan: FeatureMutationPlan,
    timestamp: string,
  ): Promise<FeatureMutationOutcome> {
    const { session, directoryPath } = location;
    const event = plan.event;
    let machine = session.machine;
    let transition: TransitionResult | null = null;
    const previousState = session.machine.state;

    if (event !== undefined) {
      if (!isWorkflowEvent(event)) {
        throw new PersistenceError("INVALID_EVENT", "Workflow event is not recognized.");
      }

      const workflow = new WorkflowStateMachine(session.machine);
      const applied = workflow.transition(event);
      transition = applied;

      if (!applied.ok) {
        const refused = makeEvent(session.featureId, timestamp, {
          previousState,
          event,
          resultingState: applied.state,
          success: false,
          errorCode: applied.code,
          revision: session.revision,
        });

        await this.#appendEventAt(directoryPath, refused);

        return { session, event: refused, transition: applied, artifacts: [] };
      }

      machine = workflow.snapshot;
    }

    const written = await this.#writeArtifacts(directoryPath, plan.artifacts ?? [], timestamp);
    const next: FeatureSession = {
      ...session,
      title: plan.title === undefined ? session.title : plan.title,
      revision: session.revision + 1,
      updatedAt: timestamp,
      machine,
      artifacts: { ...session.artifacts, ...written.references },
      approvals: plan.approvals === undefined ? session.approvals : plan.approvals,
    };

    try {
      await this.#persistSessionFile(directoryPath, next);
    } catch (error) {
      await written.rollback(error);
      throw error;
    }

    let appended: FeatureEvent | null = null;

    if (event !== undefined && transition !== null && transition.ok) {
      appended = makeEvent(session.featureId, timestamp, {
        previousState,
        event,
        resultingState: transition.state,
        success: true,
        revision: next.revision,
      });
      await this.#appendEventAt(directoryPath, appended);
    }

    return { session: next, event: appended, transition, artifacts: written.names };
  }

  #readContext(location: FeatureLocation): FeatureReadContext {
    return {
      session: location.session,
      readArtifact: async (name) => this.#readArtifactAt(location, name),
      readArtifactText: async (name) => this.#readArtifactTextAt(location, name),
    };
  }

  /**
   * A read-only view for coordination-free verification, such as checking an approval checkpoint
   * before an executor is called. It never mutates and takes no lock.
   */
  async readContext(featureId: string): Promise<FeatureReadContext> {
    return this.#readContext(await this.#loadLocation(featureId));
  }

  #mutationReader(location: FeatureLocation, timestamp: string): FeatureMutationReader {
    return {
      ...this.#readContext(location),
      timestamp,
      nextRevision: location.session.revision + 1,
    };
  }

  async #writeArtifacts(
    directoryPath: string,
    writes: readonly FeatureArtifactWrite[],
    timestamp: string,
  ): Promise<{
    readonly references: Readonly<Record<string, FeatureArtifactReference>>;
    readonly names: FeatureArtifactName[];
    readonly rollback: (failure: unknown) => Promise<void>;
  }> {
    const references: Record<string, FeatureArtifactReference> = {};
    const names: FeatureArtifactName[] = [];
    const previous: { readonly path: string; readonly serialized: string | undefined }[] = [];

    const rollback = async (failure: unknown): Promise<void> => {
      for (const entry of [...previous].reverse()) {
        await this.#restoreArtifact(entry.path, entry.serialized, failure);
      }
    };

    for (const write of writes) {
      if (!isRecord(write) || !isFeatureArtifactName(write.name)) {
        throw new PersistenceError(
          "INVALID_ARTIFACT_NAME",
          "Artifact name is not controlled by the library.",
        );
      }

      if (names.includes(write.name)) {
        throw new PersistenceError(
          "INVALID_ARGUMENT",
          `Artifact "${write.name}" is written twice in one mutation.`,
        );
      }

      const filename = FEATURE_ARTIFACT_FILENAMES[write.name];
      const artifactPath = join(directoryPath, filename);
      const earlier = await this.#readOptionalText(artifactPath);
      const serialized = serializeArtifact(write.name, write.content);

      try {
        await this.atomicWriteFile(artifactPath, serialized);
      } catch (error) {
        await rollback(error);
        throw error;
      }

      previous.push({ path: artifactPath, serialized: earlier });
      names.push(write.name);
      references[write.name] = { filename, status: "present", updatedAt: timestamp };
    }

    return { references, names, rollback };
  }

  async list(): Promise<FeatureSession[]> {
    const candidates = await this.#findCandidates();
    const sessions: FeatureSession[] = [];
    const featureIds = new Set<string>();

    for (const candidate of candidates) {
      const session = await this.#loadDirectory(candidate, candidate.featureId);

      if (featureIds.has(session.featureId)) {
        throw new PersistenceError(
          "DUPLICATE_FEATURE_DIRECTORY",
          `Feature "${session.featureId}" has multiple session directories.`,
        );
      }

      featureIds.add(session.featureId);
      sessions.push(session);
    }

    return sessions.sort((left, right) => {
      if (left.featureId !== right.featureId) {
        return left.featureId < right.featureId ? -1 : 1;
      }

      if (left.slug === right.slug) {
        return 0;
      }

      return left.slug < right.slug ? -1 : 1;
    });
  }

  async exists(featureId: string): Promise<boolean> {
    try {
      await this.load(featureId);
      return true;
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "FEATURE_NOT_FOUND") {
        return false;
      }

      throw error;
    }
  }

  async transition(
    featureId: string,
    event: WorkflowEvent,
    expectedRevision?: number,
  ): Promise<TransitionResult> {
    if (!isWorkflowEvent(event)) {
      throw new PersistenceError("INVALID_EVENT", "Workflow event is not recognized.");
    }

    const result = await this.mutate(
      featureId,
      expectedRevision === undefined
        ? { prepare: () => ({ event }) }
        : { expectedRevision, prepare: () => ({ event }) },
    );

    if (result.transition === null) {
      throw new PersistenceError("INVALID_EVENT", "Workflow event is not recognized.");
    }

    return result.transition;
  }

  async writeArtifact(
    featureId: string,
    name: FeatureArtifactName,
    content: unknown,
  ): Promise<FeatureSession> {
    if (!isFeatureArtifactName(name)) {
      throw new PersistenceError("INVALID_ARTIFACT_NAME", "Artifact name is not controlled by the library.");
    }

    const result = await this.mutate(featureId, {
      prepare: () => ({ artifacts: [{ name, content }] }),
    });

    return result.session;
  }

  async readArtifact(featureId: string, name: FeatureArtifactName): Promise<unknown> {
    return this.#readArtifactAt(await this.#loadLocation(featureId), name);
  }

  /** The exact persisted artifact bytes, which is what approval digests are taken over. */
  async readArtifactText(featureId: string, name: FeatureArtifactName): Promise<string> {
    const location = await this.#loadLocation(featureId);
    const serialized = await this.#readArtifactTextAt(location, name);

    if (serialized === undefined) {
      throw new PersistenceError(
        "ARTIFACT_NOT_FOUND",
        `Artifact "${name}" does not exist for feature "${featureId}".`,
        { path: this.#artifactPath(location, name) },
      );
    }

    return serialized;
  }

  async readEvents(featureId: string): Promise<FeatureEvent[]> {
    const location = await this.#loadLocation(featureId);
    return this.#readEventsAt(location.directoryPath, featureId);
  }

  #artifactPath(location: FeatureLocation, name: FeatureArtifactName): string {
    return join(location.directoryPath, FEATURE_ARTIFACT_FILENAMES[name]);
  }

  async #readArtifactTextAt(
    location: FeatureLocation,
    name: FeatureArtifactName,
  ): Promise<string | undefined> {
    if (!isFeatureArtifactName(name)) {
      throw new PersistenceError("INVALID_ARTIFACT_NAME", "Artifact name is not controlled by the library.");
    }

    return this.#readOptionalText(this.#artifactPath(location, name));
  }

  async #readArtifactAt(location: FeatureLocation, name: FeatureArtifactName): Promise<unknown> {
    const serialized = await this.#readArtifactTextAt(location, name);

    if (serialized === undefined) {
      throw new PersistenceError(
        "ARTIFACT_NOT_FOUND",
        `Artifact "${name}" does not exist for feature "${location.session.featureId}".`,
        { path: this.#artifactPath(location, name) },
      );
    }

    return parseArtifact(name, serialized);
  }

  async #readExistingSession(
    directoryPath: string,
    featureId: string,
    directoryName: string,
  ): Promise<FeatureSession | undefined> {
    const sessionPath = join(directoryPath, SESSION_FILENAME);
    const serialized = await this.#readOptionalText(sessionPath);

    if (serialized === undefined) {
      return undefined;
    }

    const document = this.#parseSessionJson(serialized, sessionPath);

    return parseFeatureSessionDocument(document, { expectedFeatureId: featureId, expectedDirectoryName: directoryName });
  }

  async #persistSessionFile(directoryPath: string, session: FeatureSession): Promise<void> {
    await this.#assertDirectory(directoryPath);
    await this.atomicWriteFile(join(directoryPath, SESSION_FILENAME), this.#serializeSession(session));
  }

  async #loadLocation(featureId: string): Promise<FeatureLocation> {
    assertFeatureId(featureId);
    const candidates = await this.#findCandidates(featureId);

    if (candidates.length === 0) {
      throw new PersistenceError(
        "FEATURE_NOT_FOUND",
        `No session exists for feature "${featureId}".`,
      );
    }

    if (candidates.length > 1) {
      throw new PersistenceError(
        "DUPLICATE_FEATURE_DIRECTORY",
        `Feature "${featureId}" has multiple session directories.`,
      );
    }

    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new PersistenceError(
        "FEATURE_NOT_FOUND",
        `No session exists for feature "${featureId}".`,
      );
    }

    const session = await this.#loadDirectory(candidate, featureId);
    return {
      directoryPath: candidate.directoryPath,
      session,
    };
  }

  async #loadDirectory(
    candidate: FeatureDirectoryCandidate,
    expectedFeatureId: string,
  ): Promise<FeatureSession> {
    await this.#assertDirectory(candidate.directoryPath);
    const sessionPath = join(candidate.directoryPath, SESSION_FILENAME);
    const serialized = await this.#readOptionalText(sessionPath);

    if (serialized === undefined) {
      throw new PersistenceError(
        "FEATURE_NOT_FOUND",
        `Session file does not exist for feature "${expectedFeatureId}".`,
        { path: sessionPath },
      );
    }

    const document = this.#parseSessionJson(serialized, sessionPath);
    return parseFeatureSessionDocument(document, {
      expectedFeatureId,
      expectedDirectoryName: candidate.directoryName,
    });
  }

  async #findCandidates(featureId?: string): Promise<FeatureDirectoryCandidate[]> {
    if (featureId !== undefined) {
      assertFeatureId(featureId);
    }

    await this.#assertStorageRoots();

    let entries;

    try {
      entries = await readdir(this.featuresRoot, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return [];
      }

      throw new PersistenceError(
        "IO_ERROR",
        `Unable to read feature directory "${this.featuresRoot}".`,
        { cause: error, path: this.featuresRoot },
      );
    }

    const candidates: FeatureDirectoryCandidate[] = [];

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        if (entry.name.startsWith("F-")) {
          throw new PersistenceError(
            "UNSAFE_PATH",
            `Feature directory "${entry.name}" must not be a symbolic link.`,
            { path: join(this.featuresRoot, entry.name) },
          );
        }

        continue;
      }

      if (!entry.isDirectory()) {
        if (entry.name.startsWith("F-")) {
          throw new PersistenceError(
            "UNSAFE_PATH",
            `Feature path "${entry.name}" must be a directory.`,
            { path: join(this.featuresRoot, entry.name) },
          );
        }

        continue;
      }

      const parts = parseFeatureDirectoryName(entry.name);
      if (parts === undefined) {
        if (entry.name.startsWith("F-")) {
          throw new PersistenceError(
            "UNSAFE_PATH",
            `Feature directory "${entry.name}" does not use the deterministic naming format.`,
            { path: join(this.featuresRoot, entry.name) },
          );
        }

        continue;
      }

      if (featureId !== undefined && parts.featureId !== featureId) {
        continue;
      }

      candidates.push({
        ...parts,
        directoryName: entry.name,
        directoryPath: join(this.featuresRoot, entry.name),
      });
    }

    return candidates;
  }

  async #appendEventAt(directoryPath: string, event: FeatureEvent): Promise<void> {
    const eventsPath = join(directoryPath, EVENTS_FILENAME);
    await this.#assertDirectory(directoryPath);
    await this.#readEventsAt(directoryPath, event.featureId);

    try {
      await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      throw new PersistenceError(
        "IO_ERROR",
        `Unable to append event log "${eventsPath}".`,
        { cause: error, path: eventsPath },
      );
    }
  }

  async #readEventsAt(directoryPath: string, featureId: string): Promise<FeatureEvent[]> {
    const eventsPath = join(directoryPath, EVENTS_FILENAME);
    const serialized = await this.#readOptionalText(eventsPath);

    if (serialized === undefined) {
      return [];
    }

    const events: FeatureEvent[] = [];

    for (const [index, line] of serialized.split("\n").entries()) {
      if (line.length === 0) {
        continue;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw new PersistenceError(
          "MALFORMED_EVENT_LOG",
          `Event log line ${String(index + 1)} is not valid JSON.`,
          { cause: error, path: eventsPath },
        );
      }

      events.push(validateEventDocument(parsed, featureId, index + 1));
    }

    return events;
  }

  #parseSessionJson(serialized: string, path: string): unknown {
    try {
      return JSON.parse(serialized) as unknown;
    } catch (error) {
      throw new PersistenceError(
        "MALFORMED_SESSION",
        `Session file "${path}" does not contain valid JSON.`,
        { cause: error, path: path },
      );
    }
  }

  #serializeSession(session: FeatureSession): string {
    return `${JSON.stringify(session, null, 2)}\n`;
  }

  async #ensureFeaturesRoot(): Promise<void> {
    await this.#assertStorageRoots();
    await this.#ensureDirectory(this.agentflowRoot);
    await this.#assertDirectory(this.agentflowRoot);
    await this.#ensureDirectory(this.featuresRoot);
    await this.#assertDirectory(this.featuresRoot);
  }

  async #removeEmptyDirectory(path: string): Promise<void> {
    try {
      await rmdir(path);
    } catch {
      return;
    }
  }

  async #restoreArtifact(
    artifactPath: string,
    previous: string | undefined,
    failure: unknown,
  ): Promise<void> {
    try {
      if (previous === undefined) {
        await unlink(artifactPath);
        return;
      }

      await this.atomicWriteFile(artifactPath, previous);
    } catch (rollbackError) {
      if (hasErrorCode(rollbackError, "ENOENT")) {
        return;
      }

      throw new PersistenceError(
        "IO_ERROR",
        `Artifact update failed and "${artifactPath}" could not be restored: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
        { cause: rollbackError, path: artifactPath },
      );
    }
  }

  async #ensureDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
    } catch (error) {
      throw new PersistenceError(
        "IO_ERROR",
        `Unable to create directory "${path}".`,
        { cause: error, path },
      );
    }
  }

  async #assertDirectory(path: string): Promise<void> {
    if (await this.#inspectStorageDirectory(path)) {
      return;
    }

    throw new PersistenceError(
      "FEATURE_NOT_FOUND",
      `Directory "${path}" does not exist.`,
      { path },
    );
  }

  async #inspectStorageDirectory(path: string): Promise<boolean> {
    let stats;

    try {
      stats = await lstat(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return false;
      }

      throw new PersistenceError(
        "IO_ERROR",
        `Unable to inspect directory "${path}".`,
        { cause: error, path },
      );
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new PersistenceError(
        "UNSAFE_PATH",
        `Directory "${path}" must be a real directory, not a symbolic link.`,
        { path },
      );
    }

    return true;
  }

  async #assertStorageRoots(): Promise<void> {
    if (!(await this.#inspectStorageDirectory(this.agentflowRoot))) {
      return;
    }

    await this.#inspectStorageDirectory(this.featuresRoot);
  }

  async #pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return false;
      }

      throw new PersistenceError(
        "IO_ERROR",
        `Unable to inspect path "${path}".`,
        { cause: error, path },
      );
    }
  }

  async #readOptionalText(path: string): Promise<string | undefined> {
    let stats;

    try {
      stats = await lstat(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return undefined;
      }

      throw new PersistenceError(
        "IO_ERROR",
        `Unable to inspect file "${path}".`,
        { cause: error, path },
      );
    }

    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new PersistenceError(
        "UNSAFE_PATH",
        `Path "${path}" must be a regular file.`,
        { path },
      );
    }

    try {
      return await readFile(path, "utf8");
    } catch (error) {
      throw new PersistenceError(
        "IO_ERROR",
        `Unable to read file "${path}".`,
        { cause: error, path },
      );
    }
  }

  protected async atomicWriteFile(path: string, content: string): Promise<void> {
    const parentPath = dirname(path);
    await this.#assertDirectory(parentPath);
    const temporaryPath = join(parentPath, `.${randomUUID()}.tmp`);

    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, path);
    } catch (error) {
      await removeTemporaryFile(temporaryPath);

      throw new PersistenceError(
        "IO_ERROR",
        `Unable to atomically write file "${path}".`,
        { cause: error, path },
      );
    }
  }
}

export function createFeatureSessionStore(
  repositoryRoot: string,
  options?: FeatureSessionStoreOptions,
): FeatureSessionStore {
  return new FeatureSessionStore(repositoryRoot, options);
}
