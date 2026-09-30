import { spawn } from "node:child_process";

import { WorkspaceAdapterError } from "./errors.js";

/**
 * The Git runner for the workspace adapter.
 *
 * This runs repository-controlled configuration — `core.hooksPath`, `alias.*`, `include.path`, and a
 * `filter` or `diff` driver that can execute an arbitrary command — against a working tree the agent
 * is about to be pointed at. So the runner is built so that no argument can become anything but an
 * argument:
 *
 * - an executable plus an argument vector, `shell: false`, and never a command string. A path with a
 *   space, a quote, or a semicolon in it is one argv entry, not a fragment of a script;
 * - a fixed cwd, always the repository or the worktree, never a caller-supplied string;
 * - an argument allowlist per call site. `--upload-pack` and `--config` are not things this adapter
 *   ever wants, and an allowlist says so in a way a comment cannot;
 * - `-c` overrides that neutralize the configuration hooks above, so a repository cannot redirect a
 *   read-only query into something that runs;
 * - a bounded output capture and a timeout, because `git` talking forever is a failure, not progress;
 * - a scrubbed environment for the same reason the OpenCode transport scrubs its own: variables that
 *   change how Git behaves, like `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_CONFIG_*`,
 *   would point the command at a different repository than the one the caller named.
 */
export const GIT_TIMEOUT_MS = 30_000;

/** Far more than any status or diff listing this adapter asks for. */
export const GIT_MAX_OUTPUT_BYTES = 8_000_000;

/**
 * The only git subcommands this adapter will run.
 *
 * An allowlist of verbs, not a denylist of them, because a denylist is a list of the dangerous things
 * someone thought of. Every verb below is a question, or the one operation that creates a workspace,
 * except `checkout` and `rm`, which exist only to put one framework-named path back and are always
 * called with `--` and a validated path after it.
 *
 * What is absent is the point. There is no call site that can issue `commit`, `push`, `fetch`, `pull`,
 * `reset`, `clean`, `rebase`, `merge`, `stash`, `update-ref`, `symbolic-ref`, `gc`, or `prune`, so no
 * argument a repository, a stage, or a future edit can reach can move a branch, rewrite history, or
 * delete anything the framework did not name itself. `branch` and `switch` are absent for the same
 * reason: this milestone creates a detached worktree and never a branch.
 */
const ALLOWED_SUBCOMMANDS = new Set([
  "rev-parse",
  "ls-tree",
  "status",
  "worktree",
  "checkout",
  "rm",
]);

/** Arguments Git accepts that change what it does rather than what it reports. Refused outright. */
const REFUSED_ARGUMENTS = [
  "-c",
  "--config",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--upload-pack",
  "--receive-pack",
  "--exec",
];

export interface GitRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | null;
}

export interface GitOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
  readonly durationMs: number;
}

/**
 * Repository-level settings that make a query run something, or point it somewhere else.
 *
 * These are passed as `-c` overrides, which beat anything the repository's own config, system config,
 * or `~/.gitconfig` could say, and which a worktree cannot change — an agent that edits `.gitconfig`
 * mid-run changes what the *next* command would do, and these say it may not.
 *
 * `core.hooksPath` is pointed at `/dev/null` because a hook is executable code that Git runs on the
 * agent's behalf. `include.path` is neutralized for the same reason: an include is how a config file
 * pulls in another, and a repository that includes one gets that file's settings whether or not the
 * repository itself is trusted. `protocol.file.allow` is pinned closed because this adapter never
 * fetches or clones, so the only thing a widened value could enable is something it has no use for.
 *
 * Aliases need nothing here: Git refuses to let an alias shadow a built-in command, so `status`,
 * `diff`, and `worktree` cannot be redefined this way. The remaining settings are about the read
 * cache — a stale `fsmonitor` or `untrackedCache` would let Git answer "nothing changed" about a tree
 * the agent just changed, which is the one answer this adapter must never be wrong about.
 */
const CONFIG_OVERRIDES = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "include.path=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "gc.auto=0",
  "-c",
  "protocol.file.allow=never",
] as const;

/** Environment variables that would silently retarget or rewrite the repository Git talks about. */
const SCRUBBED_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_ATTR_NOSYSTEM",
];

function scrubbedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRUBBED_ENVIRONMENT.includes(name)) {
      environment[name] = value;
    }
  }

  return environment;
}

function assertRefusedArgumentsAreAbsent(args: readonly string[]): void {
  const subcommand = args[0];

  if (subcommand === undefined || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new WorkspaceAdapterError(
      "git_failed",
      `The workspace adapter refuses to run git with the subcommand "${subcommand ?? ""}": it runs only the commands that read a repository, create a worktree, or restore a path it was asked to restore.`,
    );
  }

  for (const argument of args) {
    if (REFUSED_ARGUMENTS.includes(argument)) {
      throw new WorkspaceAdapterError(
        "git_failed",
        `The workspace adapter refuses to run git with the argument "${argument}": it changes what git does rather than what it reports, and this adapter only ever asks git questions.`,
      );
    }
  }
}

/**
 * Runs one git command to completion and describes what happened.
 *
 * It never throws for a git failure — a non-zero exit is a result the caller has to reason about,
 * because "exit 1 because there is nothing to commit" and "exit 1 because the index is broken" are
 * different answers to the same command. It does throw for an argument this adapter has decided it
 * will not pass, because that is a programming error rather than a repository's state.
 */
export function runGit(request: GitRequest): Promise<GitOutcome> {
  assertRefusedArgumentsAreAbsent(request.args);

  return new Promise<GitOutcome>((resolvePromise) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let spawnFailed = false;

    const child = spawn("git", [...CONFIG_OVERRIDES, ...request.args], {
      cwd: request.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: scrubbedEnvironment(),
    });

    const collect = (target: "stdout" | "stderr", chunk: string): void => {
      if (stdout.length + stderr.length + chunk.length > GIT_MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }

      if (target === "stdout") {
        stdout += chunk;
      } else {
        stderr += chunk;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      collect("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      collect("stderr", chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs ?? GIT_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill("SIGKILL");
    };

    request.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode,
        stdout,
        stderr,
        timedOut,
        spawnFailed,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", () => {
      // A missing binary arrives as an error without a close in every Node version this repository
      // supports, so it is settled here rather than left to a close that may never come.
      spawnFailed = true;
      finish(127);
    });

    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}

/**
 * A git call as a decision rather than an exception: the caller gets the diagnostic and chooses whether
 * a non-zero exit is a refusal, a recovery, or a fact to report.
 */
export type GitResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly detail: string; readonly timedOut: boolean; readonly spawnFailed: boolean };

function summarize(outcome: GitOutcome): string {
  const stderr = outcome.stderr.trim();

  if (stderr !== "") {
    return stderr;
  }

  const stdout = outcome.stdout.trim();

  if (stdout !== "") {
    return stdout;
  }

  if (outcome.spawnFailed) {
    return "git could not be started";
  }

  if (outcome.timedOut) {
    return "git did not finish and was stopped";
  }

  return `git exited with code ${String(outcome.exitCode)} and said nothing`;
}

export async function tryGit(request: GitRequest): Promise<GitResult> {
  const outcome = await runGit(request);

  if (outcome.exitCode === 0 && !outcome.spawnFailed && !outcome.timedOut) {
    return { ok: true, stdout: outcome.stdout, stderr: outcome.stderr };
  }

  return {
    ok: false,
    detail: summarize(outcome),
    timedOut: outcome.timedOut,
    spawnFailed: outcome.spawnFailed,
  };
}

/** Runs git and throws unless it exited zero, for the queries with no meaningful failure state. */
export async function gitOrThrow(request: GitRequest): Promise<string> {
  const outcome = await runGit(request);

  if (outcome.spawnFailed) {
    throw new WorkspaceAdapterError(
      "git_unavailable",
      "git could not be started. The isolated workspace is a git worktree, so there is nothing to fall back to.",
    );
  }

  if (outcome.timedOut) {
    throw new WorkspaceAdapterError(
      "git_failed",
      `git ${request.args[0] ?? ""} did not finish and was stopped.`.trim(),
    );
  }

  if (outcome.exitCode !== 0) {
    throw new WorkspaceAdapterError(
      "git_failed",
      `git ${request.args[0] ?? ""} exited ${String(outcome.exitCode)}.`,
    );
  }

  return outcome.stdout;
}
