import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveInsideRoot } from "@agent-workflow-kit/project";
import { isOpenCodeAdapterError } from "./errors.js";
import type { ProcessOutcomeObservation } from "./process.js";

/**
 * Invocation recordings: what an OpenCode stage actually ran, kept where a failure can be diagnosed.
 *
 * A refusal message is deliberately small — it travels, and it must never carry a prompt. That makes
 * a message useless for answering "what did the CLI actually receive, say, and exit with", which is
 * the question every transport failure starts with. This module writes that picture to disk, under
 * the stage's own working directory, in the location the install policy reserves for exactly this:
 *
 * ```text
 * <workingDirectory>/.agentflow/recordings/<featureId>/<stage>/<startedAt>-<suffix>/
 *   invocation.json   command, argv, cwd, startedAt, durationMs, exitCode, termination, error kind
 *   stdout.txt        the raw stdout capture
 *   stderr.txt        the raw stderr capture
 * ```
 *
 * Feature ids and stage names are sanitized into single path segments, and the final directory is
 * resolved with the project adapter's `resolveInsideRoot`, so a recording can only ever land inside
 * the working directory it belongs to, no matter what the identity strings contained.
 *
 * Recording is best-effort by design. A recording is diagnostics, so failing to write one must not
 * turn a successful stage into a failure, and it must not mask the error a failed stage already
 * carries. A run whose recording could not be written keeps its original outcome.
 */

/** The reserved runtime location the install policy documents for recordings of agent sessions. */
export const OPENCODE_RECORDINGS_DIRECTORY = ".agentflow/recordings";

export const INVOCATION_MANIFEST_FILENAME = "invocation.json";
export const INVOCATION_STDOUT_FILENAME = "stdout.txt";
export const INVOCATION_STDERR_FILENAME = "stderr.txt";

/** A single segment of the recording path, one level below the recordings root. */
export const INVOCATION_SEGMENT_MAX_LENGTH = 128;

export interface StageInvocationIdentity {
  /** The workflow feature the stage belongs to. Sanitized before it becomes a path segment. */
  readonly featureId: string;
  /** The workflow stage that was running. Sanitized before it becomes a path segment. */
  readonly stage: string;
}

/** Everything needed to reconstruct what one invocation was and how it ended. */
export interface StageInvocationRecording {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** When the child was spawned, as recorded by the shared runner's clock. */
  readonly startedAt: string;
  readonly observation: ProcessOutcomeObservation;
  /**
   * The refusal the invocation ended with, when it ended in one. The message is the same bounded
   * text the caller received: it never contains the prompt.
   */
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface RecordedInvocation {
  readonly directory: string;
  readonly manifestPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/**
 * Reduces an identity string to one safe path segment: letters, digits, dots, dashes, and
 * underscores only, no leading or trailing punctuation, bounded in length. Runs of anything else
 * collapse into a single dash, so a hostile identity cannot carry a separator, a traversal, or a
 * leading dot out of the recordings directory.
 */
export function safeRecordingSegment(value: string): string {
  const segment = value
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[.-]+/u, "")
    .replace(/[.-]+$/u, "")
    .slice(0, INVOCATION_SEGMENT_MAX_LENGTH);

  return segment;
}

function compactStamp(startedAt: string): string {
  const parsed = Date.parse(startedAt);
  const iso = Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();

  return iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 6).padEnd(4, "0");
}

/**
 * Describes the refusal an invocation ended with, in the shape the manifest records. An error that
 * is not the adapter's own is recorded under the code the transport will report for it.
 */
export function describeRecordingError(error: unknown): { code: string; message: string } | null {
  if (isOpenCodeAdapterError(error)) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof Error && error.message.length > 0) {
    return { code: "transport_failed", message: error.message };
  }

  return null;
}

/**
 * Writes one invocation's recording and returns where it landed, or `null` when it could not be
 * written. See the module comment for why a failure here is swallowed rather than raised.
 */
export async function recordStageInvocation(
  workingDirectory: string,
  identity: StageInvocationIdentity,
  recording: StageInvocationRecording,
): Promise<RecordedInvocation | null> {
  const feature = safeRecordingSegment(identity.featureId);
  const stage = safeRecordingSegment(identity.stage);

  if (feature.length === 0 || stage.length === 0) {
    return null;
  }

  try {
    const directory = resolveInsideRoot(
      workingDirectory,
      join(
        OPENCODE_RECORDINGS_DIRECTORY,
        feature,
        stage,
        `${compactStamp(recording.startedAt)}-${randomSuffix()}`,
      ),
    );

    await mkdir(directory, { recursive: true });

    const manifestPath = join(directory, INVOCATION_MANIFEST_FILENAME);
    const stdoutPath = join(directory, INVOCATION_STDOUT_FILENAME);
    const stderrPath = join(directory, INVOCATION_STDERR_FILENAME);

    const manifest = {
      featureId: identity.featureId,
      stage: identity.stage,
      command: recording.command,
      args: [...recording.args],
      cwd: recording.cwd,
      startedAt: recording.observation.startedAt,
      durationMs: recording.observation.durationMs,
      termination: recording.observation.termination,
      exitCode: recording.observation.exitCode,
      error: recording.error,
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(stdoutPath, recording.observation.stdout, "utf8");
    await writeFile(stderrPath, recording.observation.stderr, "utf8");

    return { directory, manifestPath, stdoutPath, stderrPath };
  } catch {
    return null;
  }
}
