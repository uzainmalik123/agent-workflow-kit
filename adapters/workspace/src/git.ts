import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

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

const READ_ONLY_CONFIG_OVERRIDES = [
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

/**
 * The publishing overrides, which differ from the read-only ones in exactly two places.
 *
 * `protocol.file.allow` is `user` rather than `never` because a push needs a transport and the operator
 * chooses it. `user` still means the *repository* cannot widen it: the `-c` override outranks anything
 * in the repository's own config, so a config that sets `protocol.file.allow=always` to redirect a push
 * at a local path is overridden, while the operator's own `origin` — ssh, https, or a local bare
 * repository — pushes exactly as configured. `never` would have been safer and would have made the
 * adapter unable to publish to a repository on the same machine, which is a deployment this framework
 * has no reason to forbid.
 *
 * The `push.*` settings are pinned so that no repository configuration can widen what a push does. With
 * no refspec ever left implicit (`push.default=nothing`), with submodules never pushed
 * (`push.recurseSubmodules=no`), and with tags never followed (`push.followTags=false`), the only ref
 * this runner can move is the explicit one in the argument vector.
 */
const PUBLISHING_CONFIG_OVERRIDES = [
  ...READ_ONLY_CONFIG_OVERRIDES.slice(0, -2),
  "-c",
  "protocol.file.allow=user",
  "-c",
  "push.default=nothing",
  "-c",
  "push.recurseSubmodules=no",
  "-c",
  "push.followTags=false",
] as const;

/**
 * What a runner is allowed to do.
 *
 * Two of them exist because there are two jobs, and they are kept apart deliberately. The read-only
 * runner asks a repository questions. The publishing runner asks the same questions and then writes
 * three things: a commit, a branch ref, and one remote ref. Merging them into one allowlist would mean
 * either letting every `ls-tree` query reach `push`, or making the push refuse to ask; keeping them
 * apart means the push is checked against a list that contains nothing it does not need.
 *
 * The policy is enforced on the argument vector, not on the call site, so it holds for the publishing
 * adapter the same way it holds for the read-only one. A call site that wants `push --force` has to get
 * past this list, and this list has no force in it.
 */
interface GitPolicy {
  /** What the refusal messages call this runner, so a refusal says which one refused. */
  readonly label: string;
  readonly allowedSubcommands: ReadonlySet<string>;
  readonly refusedArguments: readonly string[];
  readonly refusedArgumentPrefixes: readonly string[];
  readonly configOverrides: readonly string[];
}

/**
 * The read-only policy: questions, plus the worktree lifecycle.
 *
 * `checkout` and `rm` are here only to put one framework-named path back, and are always called with
 * `--` and a validated path after it. `branch` and `switch` are absent because nothing in the read-only
 * job creates a branch or moves HEAD, and their absence is what lets the publishing policy say the same
 * thing about its own work: publishing moves no HEAD either, so it does not need them either.
 */
const READ_ONLY_POLICY: GitPolicy = {
  label: "workspace adapter",
  allowedSubcommands: new Set(["rev-parse", "ls-tree", "status", "worktree", "checkout", "rm"]),
  refusedArguments: [
    "-c",
    "--config",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--upload-pack",
    "--receive-pack",
    "--exec",
  ],
  refusedArgumentPrefixes: [],
  configOverrides: READ_ONLY_CONFIG_OVERRIDES,
};

/**
 * The publishing policy: the read-only verbs it needs, plus the ones that write a commit and a ref.
 *
 * Two absences are the point. There is no `switch`, `checkout`, `branch`, or `reset`, so no publishing
 * call can move a worktree's HEAD — the invariant the workspace provider's open check rests on is kept
 * by what this list omits rather than by what the code remembers to do. And there is no force, no
 * deletion, no mirror, no prune, no tags, and no `--set-upstream`, so the only ref this policy can
 * create or move is the one the orchestration layer named, and only additively.
 *
 * The refusals are listed by prefix as well as by name because Git's dangerous options have long,
 * compound spellings (`--force-with-lease=<ref>`, `--receive-pack=<path>`) and a list of exact strings
 * would be one edit away from a hole.
 *
 * `config` and `diff` are here for two jobs and not for browsing: `config --get user.name` is how the
 * commit identity is *read*, never set, and `diff --cached` is how the temporary index is read back to
 * confirm it holds the approved change set and nothing else. Both are read-only in the one shape this
 * adapter calls them in, and neither can write a setting or a tree — `update-ref` and `commit-tree` are
 * the only verbs here that write anything at all.
 */
const PUBLISHING_POLICY: GitPolicy = {
  label: "publishing adapter",
  allowedSubcommands: new Set([
    "rev-parse",
    "ls-tree",
    "status",
    "for-each-ref",
    "log",
    "cat-file",
    "diff",
    "config",
    "remote",
    "add",
    "read-tree",
    "write-tree",
    "commit-tree",
    "update-ref",
    "push",
  ]),
  refusedArguments: [
    "-c",
    // `push --all` is "every branch", and `log --all` is every ref. `--all` is refused by spelling rather
    // than per verb because the verbs that want it are the dangerous ones, and a call site that needs a
    // whole-ref query has to say so in a list a reviewer can read.
    "--all",
    "--delete",
    "--dry-run",
    "--follow-tags",
    "--force",
    "--force-with-lease",
    "--mirror",
    "--prune",
    "--recurse-submodules",
    "--set-upstream",
    "-u",
    "--tags",
    "-f",
    "-d",
  ],
  refusedArgumentPrefixes: [
    "--config",
    "--delete",
    "--exec",
    "--force",
    "--git-dir",
    "--mirror",
    "--namespace",
    "--prune",
    "--receive",
    "--recurse-submodules",
    "--set-git-dir",
    "--set-upstream",
    "--super-prefix",
    "--tags",
    "--upload",
    "+",
  ],
  configOverrides: PUBLISHING_CONFIG_OVERRIDES,
};

export interface GitRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | null;
  /** Values this adapter adds to the scrubbed environment. See {@link ADDABLE_ENVIRONMENT}. */
  readonly env?: Readonly<Record<string, string>>;
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

/**
 * Environment variables a caller may add, with the values each may take.
 *
 * Scrubbing is the wrong tool for these two, and the distinction is worth stating: the scrubbed list
 * exists because an *inherited* value would silently retarget the repository Git talks about, whereas
 * `GIT_INDEX_FILE` and `GIT_TERMINAL_PROMPT` are values the adapter chooses on purpose and validates
 * before passing. Each is still absent from the environment of a run that does not ask for it.
 */
const ADDABLE_ENVIRONMENT: Readonly<Record<string, (value: string) => boolean>> = {
  /** A temporary index the adapter created, which is why the value must be an absolute path. */
  GIT_INDEX_FILE: (value) => value.length > 0 && isAbsolute(value),
  /** Zero or nothing: the only credential-prompt behaviour a non-interactive publish may have. */
  GIT_TERMINAL_PROMPT: (value) => value === "0",
};

function scrubbedEnvironment(policy: GitPolicy, additions?: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRUBBED_ENVIRONMENT.includes(name)) {
      environment[name] = value;
    }
  }

  for (const [name, value] of Object.entries(additions ?? {})) {
    const accepts = ADDABLE_ENVIRONMENT[name];

    if (accepts === undefined || !accepts(value)) {
      throw new WorkspaceAdapterError(
        "git_failed",
        `The ${policy.label} refuses to run git with ${name}=${JSON.stringify(value)}: it is not a value this adapter sets.`,
      );
    }

    environment[name] = value;
  }

  return environment;
}

function assertArgumentsAllowed(policy: GitPolicy, args: readonly string[]): void {
  const subcommand = args[0];

  if (subcommand === undefined || !policy.allowedSubcommands.has(subcommand)) {
    throw new WorkspaceAdapterError(
      "git_failed",
      `The ${policy.label} refuses to run git with the subcommand "${subcommand ?? ""}": it runs only ${
        policy === PUBLISHING_POLICY
          ? "the commands that read a repository, write one commit, and move one named ref"
          : "the commands that read a repository, create a worktree, or restore a path it was asked to restore"
      }.`,
    );
  }

  for (const argument of args) {
    const refused =
      policy.refusedArguments.includes(argument) ||
      policy.refusedArgumentPrefixes.some((prefix) => argument.startsWith(prefix));

    if (refused) {
      throw new WorkspaceAdapterError(
        "git_failed",
        `The ${policy.label} refuses to run git with the argument "${argument}": it changes what git does rather than what it reports, and this adapter only ever adds what it names itself.`,
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
  return runGitWithPolicy(request, READ_ONLY_POLICY);
}

/**
 * The same runner with the publishing policy.
 *
 * A separate entry point rather than an option, because the two policies exist for two different jobs
 * and a caller that can choose its own policy is a caller that can choose the read-only one to push.
 */
export function runPublishGit(request: GitRequest): Promise<GitOutcome> {
  return runGitWithPolicy(request, PUBLISHING_POLICY);
}

/**
 * One git command, under a policy, to completion.
 *
 * It never throws for a git failure — a non-zero exit is a result the caller has to reason about,
 * because "exit 1 because the object is not there" and "exit 1 because the index is broken" are
 * different answers to the same command. It does throw for an argument this adapter has decided it will
 * not pass, because that is a programming error rather than a repository's state.
 */
function runGitWithPolicy(request: GitRequest, policy: GitPolicy): Promise<GitOutcome> {
  assertArgumentsAllowed(policy, request.args);

  return new Promise<GitOutcome>((resolvePromise) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let spawnFailed = false;

    const child = spawn("git", [...policy.configOverrides, ...request.args], {
      cwd: request.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: scrubbedEnvironment(policy, request.env),
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
  return tryGitWithPolicy(request, READ_ONLY_POLICY);
}

/** {@link tryGit} under the publishing policy. */
export async function tryPublishGit(request: GitRequest): Promise<GitResult> {
  return tryGitWithPolicy(request, PUBLISHING_POLICY);
}

async function tryGitWithPolicy(request: GitRequest, policy: GitPolicy): Promise<GitResult> {
  const outcome = await runGitWithPolicy(request, policy);

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
