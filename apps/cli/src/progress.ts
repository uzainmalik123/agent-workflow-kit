import type { StageProgressCallback, StageProgressEvent } from "@agent-workflow-kit/opencode";
import { extractToolUseLine } from "@agent-workflow-kit/opencode";

/**
 * What the CLI prints while a stage runs, and where it prints it: stderr, always.
 *
 * stdout carries the workflow's own results — the state lines, the gate messages, the feature
 * summary — and a redirect of it must stay exactly what it was. Progress is a different stream for
 * a different reader, so it goes to stderr as plain one-line writes: no spinners, no cursor
 * dances, no difference between a terminal and a pipe. Whatever a CI log captures is what a person
 * at a terminal saw.
 *
 * The timers are injectable, which is the whole reason the heartbeat can be tested: a test advances
 * a clock by thirty seconds instead of spending thirty seconds, and the production path uses
 * `setInterval` unchanged.
 */

/** One heartbeat per stage, this far apart. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

export interface ProgressTimers {
  readonly setInterval: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface StageProgressReporterOptions {
  /** Where a line goes. Defaults to `console.error`, i.e. stderr. */
  readonly write?: (line: string) => void;
  /** The clock the heartbeat measures against. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** The heartbeat's timers. Defaults to the process's own. */
  readonly timers?: ProgressTimers;
  readonly heartbeatMs?: number;
  /**
   * Suppresses progress — the started line, activity, heartbeats, and the finished line — but not
   * the failure line that names a stage's recording folder.
   *
   * That exception is deliberate: `--quiet` promises no progress, and "your stage failed, its
   * evidence is here" is not progress. It is the one line a quiet run still owes a human.
   */
  readonly quiet?: boolean;
}

function elapsedSeconds(elapsedMs: number): number {
  return Math.max(0, Math.round(elapsedMs / 1000));
}

const defaultTimers: ProgressTimers = {
  setInterval: (callback: () => void, intervalMs: number): NodeJS.Timeout =>
    setInterval(callback, intervalMs),
  clearInterval: (handle: unknown): void => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

/**
 * Turns a stage's progress events into stderr lines.
 *
 * The reporter owns the heartbeat's lifetime: a timer starts on `stage_started` and is cleared on
 * `stage_finished` or `stage_failed`, so a stage that ends never leaves a timer behind to report on
 * a stage that has already moved on.
 *
 * Activity lines are filtered here as well as at the transport — a line that would print the prompt
 * is dropped at this last hop no matter which transport produced it, because this is the function
 * that is actually holding the output.
 */
export function createStageProgressReporter(
  options: StageProgressReporterOptions = {},
): StageProgressCallback {
  const write =
    options.write ??
    ((line: string): void => {
      console.error(line);
    });
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const quiet = options.quiet === true;

  let heartbeat: unknown = null;
  let startedAtMs = 0;

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) {
      timers.clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  return (event: StageProgressEvent): void => {
    if (event.type === "stage_failed") {
      stopHeartbeat();
      write(
        `stage ${event.stage} failed after ${String(elapsedSeconds(event.elapsedMs))}s; recording folder: ${event.recordingFolder}`,
      );
      return;
    }

    if (quiet) {
      return;
    }

    if (event.type === "stage_started") {
      stopHeartbeat();
      startedAtMs = now();
      write(`stage ${event.stage} started`);
      heartbeat = timers.setInterval(() => {
        write(
          `${event.stage}: still running, ${String(elapsedSeconds(now() - startedAtMs))}s elapsed`,
        );
      }, heartbeatMs);
      return;
    }

    if (event.type === "activity") {
      const line = extractToolUseLine(event.line);

      if (line !== null) {
        write(line);
      }

      return;
    }

    stopHeartbeat();
    write(`stage ${event.stage} finished in ${String(elapsedSeconds(event.elapsedMs))}s`);
  };
}
