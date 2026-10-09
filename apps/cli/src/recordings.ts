import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  INVOCATION_MANIFEST_FILENAME,
  OPENCODE_RECORDINGS_DIRECTORY,
  safeRecordingSegment,
} from "@agent-workflow-kit/opencode";
import { defaultCacheRoot, readSidecar } from "@agent-workflow-kit/workspace";

/**
 * Where the last stage's recording is, so `agentflow status` can say so without being told.
 *
 * A recording lives beside the tree the stage ran in, which is the whole problem this solves: a
 * read stage writes into the project's own `.agentflow/recordings/`, and a write stage writes into
 * an isolated worktree under the user's cache directory — a path with the feature's own repository
 * nowhere in it, and the last place anybody would look. So the search covers both, in one pass:
 * the project's recordings root, and every workspace in the cache whose sidecar vouches that it
 * belongs to *this* repository, because a workspace belonging to some other project is not evidence
 * about this one.
 *
 * Every read here is best-effort. `status` answers from persisted state and must keep working with
 * no cache, no workspace, and no recording at all, so a directory that cannot be listed or a
 * manifest that cannot be read simply contributes nothing.
 */

/** One stage run, as its own manifest recorded it. */
export interface LatestStageRecording {
  /** The stage, from the manifest rather than from the directory name. */
  readonly stage: string;
  readonly startedAt: string;
  /** How long that invocation ran, in milliseconds. */
  readonly durationMs: number;
  /** The absolute invocation directory: `invocation.json`, `stdout.txt`, `stderr.txt`. */
  readonly folder: string;
}

async function listDirectory(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

/**
 * The recordings roots this repository's stages could have written into: the project's own, plus
 * one per workspace in the cache that this repository owns.
 */
async function recordingRoots(repoRoot: string): Promise<readonly string[]> {
  const roots: string[] = [join(repoRoot, OPENCODE_RECORDINGS_DIRECTORY)];
  const cacheRoot = defaultCacheRoot();

  for (const entry of await listDirectory(cacheRoot)) {
    const workspace = join(cacheRoot, entry);

    let owner: string;
    try {
      owner = (await readSidecar(workspace)).repositoryRoot;
    } catch {
      // Not a workspace directory, or one this adapter cannot vouch for. Neither is a place to
      // read recordings from on behalf of this repository.
      continue;
    }

    if (owner === repoRoot) {
      roots.push(join(workspace, OPENCODE_RECORDINGS_DIRECTORY));
    }
  }

  return roots;
}

interface InvocationRecord {
  readonly stage: string;
  readonly startedAt: string;
  readonly durationMs: number;
}

/** The three fields the status line needs, or `null` for a manifest that cannot supply all three. */
async function readInvocation(manifestPath: string): Promise<InvocationRecord | null> {
  let text: string;

  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const stage = record["stage"];
  const startedAt = record["startedAt"];
  const durationMs = record["durationMs"];

  if (typeof stage !== "string" || stage.length === 0) {
    return null;
  }

  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) {
    return null;
  }

  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }

  return { stage, startedAt, durationMs };
}

async function recordingsIn(root: string, featureSegment: string): Promise<readonly LatestStageRecording[]> {
  const featureDirectory = join(root, featureSegment);
  const found: LatestStageRecording[] = [];

  for (const stage of await listDirectory(featureDirectory)) {
    const stageDirectory = join(featureDirectory, stage);

    for (const invocation of await listDirectory(stageDirectory)) {
      const folder = join(stageDirectory, invocation);
      const manifest = await readInvocation(join(folder, INVOCATION_MANIFEST_FILENAME));

      if (manifest !== null) {
        found.push({ ...manifest, folder });
      }
    }
  }

  return found;
}

/**
 * The most recently started recording for one feature, or `null` when there is none.
 *
 * "Most recent" is decided by the `startedAt` inside each manifest, so two runs that overlap in
 * wall-clock order still resolve to the one that actually began last, and a directory name is never
 * read as a timestamp.
 */
export async function findLatestRecording(
  repoRoot: string,
  featureId: string,
): Promise<LatestStageRecording | null> {
  const featureSegment = safeRecordingSegment(featureId);

  if (featureSegment.length === 0) {
    return null;
  }

  const root = resolve(repoRoot);
  let latest: LatestStageRecording | null = null;

  for (const recordingsRoot of await recordingRoots(root)) {
    for (const candidate of await recordingsIn(recordingsRoot, featureSegment)) {
      if (latest === null || Date.parse(candidate.startedAt) > Date.parse(latest.startedAt)) {
        latest = candidate;
      }
    }
  }

  return latest;
}
