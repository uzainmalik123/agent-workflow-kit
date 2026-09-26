import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeatureSession, FeatureSessionStore } from "@agent-workflow-kit/persistence";

/**
 * Test-only access to the on-disk session document.
 *
 * The supported store API intentionally cannot express every precondition a test wants to set up:
 * there is no public way to clear an approval checkpoint, or to model a session written by an
 * older or hand-edited version. These helpers write the file directly so a test can create such a
 * state and then assert how the library reacts to it. Nothing in `core/`, `orchestration/`, or the
 * persistence adapter may use them.
 */

/** The absolute path of a feature's session directory. */
export async function featureDirectoryOf(
  store: Pick<FeatureSessionStore, "featuresRoot">,
  featureId: string,
): Promise<string> {
  const directories = await readdir(store.featuresRoot);
  const match = directories.find((entry) => entry.startsWith(`${featureId}-`));

  if (match === undefined) {
    throw new Error(`No session directory found for feature "${featureId}".`);
  }

  return join(store.featuresRoot, match);
}

/** Writes a session document verbatim, matching the store's own serialization. */
export async function writeSessionDocument(
  store: Pick<FeatureSessionStore, "featuresRoot">,
  featureId: string,
  session: FeatureSession,
): Promise<void> {
  const directory = await featureDirectoryOf(store, featureId);

  await writeFile(
    join(directory, "session.json"),
    `${JSON.stringify(session, null, 2)}\n`,
    "utf8",
  );
}

/** Reads the session document as raw bytes, for tests that assert exact persisted content. */
export async function writeRawSessionDocument(
  store: Pick<FeatureSessionStore, "featuresRoot">,
  featureId: string,
  serialized: string,
): Promise<void> {
  const directory = await featureDirectoryOf(store, featureId);

  await writeFile(join(directory, "session.json"), serialized, "utf8");
}
