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
  createEmptyArtifactReferences,
  type Clock,
  type CreateFeatureSessionInput,
  type FeatureEvent,
  type FeatureEventInput,
  type FeatureSession,
  type FeatureSessionUpdater,
  type FeatureArtifactName,
} from "./contracts.js";
import { isFeatureArtifactName, parseArtifact, serializeArtifact } from "./artifacts.js";
import { hasErrorCode, PersistenceError } from "./errors.js";
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

  const errorCode = value["errorCode"];
  if (errorCode !== undefined && (typeof errorCode !== "string" || errorCode.length === 0)) {
    throw new PersistenceError("MALFORMED_EVENT_LOG", `${subject} has an invalid errorCode.`);
  }

  if (errorCode === undefined) {
    return { previousState, event, resultingState, success };
  }

  return { previousState, event, resultingState, success, errorCode };
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
      createdAt: timestamp,
      updatedAt: timestamp,
      machine: new WorkflowStateMachine().snapshot,
      artifacts: createEmptyArtifactReferences(),
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
      const existingSerialized = await this.#readOptionalText(join(directoryPath, SESSION_FILENAME));

      if (existingSerialized !== undefined) {
        const existingDocument = this.#parseSessionJson(existingSerialized, join(directoryPath, SESSION_FILENAME));
        const existing = parseFeatureSessionDocument(existingDocument, {
          expectedFeatureId: normalized.featureId,
          expectedDirectoryName: directoryName,
        });

        if (existing.featureId !== normalized.featureId) {
          throw new PersistenceError(
            "FEATURE_MISMATCH",
            "Refusing to overwrite a session belonging to a different feature.",
          );
        }
      }
    } else {
      await this.#ensureFeaturesRoot();

      try {
        await mkdir(directoryPath);
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          await this.#assertDirectory(directoryPath);
        } else {
          throw new PersistenceError(
            "IO_ERROR",
            `Unable to create feature directory "${directoryPath}".`,
            { cause: error, path: directoryPath },
          );
        }
      }
    }

    const sessionPath = join(directoryPath, SESSION_FILENAME);
    await this.atomicWriteFile(sessionPath, this.#serializeSession(normalized));
    return normalized;
  }

  async update(featureId: string, update: FeatureSessionUpdater): Promise<FeatureSession> {
    const current = await this.load(featureId);
    const patch = typeof update === "function" ? update(current) : update;

    if (!isRecord(patch)) {
      throw new PersistenceError("INVALID_ARGUMENT", "Session update must be an object or function.");
    }

    const next: FeatureSession = {
      schemaVersion: current.schemaVersion,
      featureId: current.featureId,
      slug: current.slug,
      title: patch["title"] === undefined ? current.title : patch["title"] as string,
      createdAt: current.createdAt,
      updatedAt: requireTimestamp(this.#clock()),
      machine: patch["machine"] === undefined ? current.machine : patch["machine"] as FeatureSession["machine"],
      artifacts:
        patch["artifacts"] === undefined
          ? current.artifacts
          : patch["artifacts"] as FeatureSession["artifacts"],
    };

    return this.save(next);
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

  async transition(featureId: string, event: WorkflowEvent): Promise<TransitionResult> {
    if (!isWorkflowEvent(event)) {
      throw new PersistenceError("INVALID_EVENT", "Workflow event is not recognized.");
    }

    const location = await this.#loadLocation(featureId);
    const machine = new WorkflowStateMachine(location.session.machine);
    const previousState = machine.state;
    const result = machine.transition(event);
    const timestamp = requireTimestamp(this.#clock());

    if (result.ok) {
      const updatedSession: FeatureSession = {
        ...location.session,
        updatedAt: timestamp,
        machine: machine.snapshot,
      };

      await this.save(updatedSession);
    }

    const eventInput: FeatureEventInput = result.ok
      ? {
          previousState,
          event,
          resultingState: result.state,
          success: true,
        }
      : {
          previousState,
          event,
          resultingState: result.state,
          success: false,
          errorCode: result.code,
        };

    await this.#appendEventAt(location.directoryPath, makeEvent(featureId, timestamp, eventInput));
    return result;
  }

  async writeArtifact(
    featureId: string,
    name: FeatureArtifactName,
    content: unknown,
  ): Promise<FeatureSession> {
    if (!isFeatureArtifactName(name)) {
      throw new PersistenceError("INVALID_ARTIFACT_NAME", "Artifact name is not controlled by the library.");
    }

    const location = await this.#loadLocation(featureId);
    const filename = FEATURE_ARTIFACT_FILENAMES[name];
    const artifactPath = join(location.directoryPath, filename);
    const previous = await this.#readOptionalText(artifactPath);
    const serialized = serializeArtifact(name, content);
    const timestamp = requireTimestamp(this.#clock());
    await this.atomicWriteFile(artifactPath, serialized);
    const updatedSession: FeatureSession = {
      ...location.session,
      updatedAt: timestamp,
      artifacts: {
        ...location.session.artifacts,
        [name]: {
          filename,
          status: "present",
          updatedAt: timestamp,
        },
      },
    };

    try {
      return await this.save(updatedSession);
    } catch (error) {
      await this.#restoreArtifact(artifactPath, previous, error);
      throw error;
    }
  }

  async readArtifact(featureId: string, name: FeatureArtifactName): Promise<unknown> {
    if (!isFeatureArtifactName(name)) {
      throw new PersistenceError("INVALID_ARTIFACT_NAME", "Artifact name is not controlled by the library.");
    }

    const location = await this.#loadLocation(featureId);
    const filename = FEATURE_ARTIFACT_FILENAMES[name];
    const artifactPath = join(location.directoryPath, filename);
    const serialized = await this.#readOptionalText(artifactPath);

    if (serialized === undefined) {
      throw new PersistenceError(
        "ARTIFACT_NOT_FOUND",
        `Artifact "${name}" does not exist for feature "${featureId}".`,
        { path: artifactPath },
      );
    }

    return parseArtifact(name, serialized);
  }

  async readEvents(featureId: string): Promise<FeatureEvent[]> {
    const location = await this.#loadLocation(featureId);
    return this.#readEventsAt(location.directoryPath, featureId);
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
