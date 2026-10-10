import { Command } from "commander";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { discoverProject, PROJECT_CONFIG_FILENAME } from "@agent-workflow-kit/project";
import { DEFAULT_TIMEOUT_MS, type StageProgressCallback } from "@agent-workflow-kit/opencode";
import { approvedScopeFromPlan } from "@agent-workflow-kit/orchestration";
import { parseStatus } from "@agent-workflow-kit/workspace";
import type { FeatureSession } from "@agent-workflow-kit/persistence";
import { createStageProgressReporter } from "./progress.js";
import { findLatestRecording } from "./recordings.js";
import { createRealStack, type OrchestratorStack } from "./stack.js";
import { join, dirname, resolve } from "node:path";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let packageVersion = "0.0.0";
try {
  const packageJson = await import("../package.json", { assert: { type: "json" } });
  packageVersion = packageJson.default.version;
} catch {
  // fallback to default
}

const MAX_RUN_ATTEMPTS = 100;

/** The options `agentflow run` declares. */
interface RunCommandOptions {
  readonly verbose?: boolean;
  readonly model?: string;
  readonly quiet?: boolean;
  readonly stageTimeout?: string;
}

/**
 * What a command needs from the stack: the orchestrator it drives and the store whose sessions it
 * reads, plus the optional runtime preflight described on {@link OrchestratorStack}.
 */
export type CliStack = OrchestratorStack;

/** Construction inputs a command passes to the stack factory. */
export interface CliStackRequest {
  /** The model to ask OpenCode for; `null` leaves the choice to OpenCode's own default. */
  readonly model?: string | null;
  /** Live progress from the stages the stack's executor runs; absent means no progress at all. */
  readonly onProgress?: StageProgressCallback;
  /** The per-stage budget in milliseconds; absent means the adapter's own default. */
  readonly stageTimeoutMs?: number;
}

/**
 * Builds the stack for one command invocation.
 *
 * The default is {@link createRealStack}. Tests pass their own factory — the seam that keeps every
 * fake executor, fake verifier, and fake reviewer out of the product path while letting the CLI
 * commands themselves be exercised end to end.
 */
export type CliStackFactory = (repoRoot: string, request: CliStackRequest) => CliStack;

export interface CreateCliOptions {
  readonly createStack?: CliStackFactory;
  /** Where commands look for the repository. Defaults to `process.cwd()`. */
  readonly cwd?: () => string;
  /** How a command reports a failure. Defaults to `process.exit`, which never returns. */
  readonly exit?: (code: number) => void;
}

function getRepoRoot(cwd: string): string {
  return resolve(cwd);
}

async function findRepositoryRoot(directory: string): Promise<string | null> {
  let current = resolve(directory);

  for (;;) {
    const gitPath = join(current, ".git");
    try {
      const stats = await lstat(gitPath);
      if (stats.isDirectory() || stats.isFile()) {
        return current;
      }
    } catch {
      // .git not found, continue to parent
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  verification: {
    static: [],
    test: [],
  },
} as const;

/**
 * The single line that makes `.agentflow/` impossible to commit by accident: a directory whose own
 * `.gitignore` matches everything, itself included, so nothing under it can ever be staged. The
 * repository's own `.gitignore` at the root is never touched.
 */
const AGENTFLOW_GITIGNORE_CONTENT = "*\n";

/**
 * Insists a path is a real directory before anything is created inside it.
 *
 * The rule the persistence layer writes by, applied here: `lstat`, never a followed link. `.agentflow`
 * as a symlink would send everything init creates — including the ignore file below — to a location
 * outside the repository, and a link is precisely the shape of a path nobody agreed to.
 */
async function ensureRealDirectory(path: string): Promise<void> {
  let stats;

  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`"${path}" must be a real directory, not a symbolic link.`);
  }
}

/**
 * Creates `.agentflow/.gitignore` — what makes `.agentflow/` invisible to Git — without ever
 * overwriting one that is already there.
 *
 * Same discipline as the persistence layer: `lstat` instead of a followed symlink, the `wx` flag so an
 * existing file is never opened for truncation, and a file that already exists with other content is
 * reported and left exactly as it is. A re-run over the framework's own `*` is a no-op, which is what
 * makes init safe to run repeatedly.
 */
async function ensureAgentflowGitignore(agentflowDir: string): Promise<void> {
  const path = join(agentflowDir, ".gitignore");

  let stats;

  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    try {
      await writeFile(path, AGENTFLOW_GITIGNORE_CONTENT, { encoding: "utf8", flag: "wx" });
      console.log("Created .agentflow/.gitignore");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Something created the file between the check and the write. Not ours, so not overwritten.
    }

    return;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`"${path}" must be a real file, not a symbolic link.`);
  }

  const existing = await readFile(path, "utf8");

  if (existing === "*" || existing === AGENTFLOW_GITIGNORE_CONTENT) {
    return;
  }

  console.warn(
    "Warning: .agentflow/.gitignore exists with other content, so it was left untouched. Until it ignores the directory, files under .agentflow/ may show up as untracked.",
  );
}

async function initializeProject(repoRoot: string): Promise<void> {
  // Validate it's a Git repository
  const gitRoot = await findRepositoryRoot(repoRoot);
  if (gitRoot === null) {
    throw new Error("Not a Git repository. Run 'git init' first.");
  }

  if (gitRoot !== repoRoot) {
    throw new Error(`Git repository root is at "${gitRoot}", not "${repoRoot}". Run 'agentflow init' from the repository root.`);
  }

  // Validate it's a supported project by running discovery
  try {
    await discoverProject(repoRoot);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error : undefined;
    const err = new Error(`Project validation failed: ${message}`);
    if (cause !== undefined) {
      (err as Error & { cause: unknown }).cause = cause;
    }
    throw err;
  }

  const agentflowDir = join(repoRoot, ".agentflow");
  await ensureRealDirectory(agentflowDir);

  // Create .agentflow/features directory structure
  const featuresDir = join(agentflowDir, "features");
  await mkdir(featuresDir, { recursive: true });

  // Make the structure Git can never stage or commit by accident.
  await ensureAgentflowGitignore(agentflowDir);

  // Create minimal default config if it doesn't exist
  const configPath = join(repoRoot, PROJECT_CONFIG_FILENAME);
  try {
    await lstat(configPath);
    // Config exists, leave it alone
  } catch {
    // Config doesn't exist, create minimal default
    await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    console.log(`Created ${PROJECT_CONFIG_FILENAME}`);
  }

  console.log("Initialized Agent Workflow Kit project");
}

function formatStatus(session: FeatureSession): string {
  const lines: string[] = [];
  lines.push(`Feature: ${session.featureId} (${session.slug})`);
  lines.push(`Title: ${session.title}`);
  lines.push(`State: ${session.machine.state}`);
  lines.push(`Revision: ${String(session.revision)}`);
  lines.push(`Created: ${session.createdAt}`);
  lines.push(`Updated: ${session.updatedAt}`);

  if (session.machine.fixReturnState) {
    lines.push(`Fix Return State: ${session.machine.fixReturnState}`);
  }

  const planApproval = session.approvals.plan;
  if (planApproval) {
    lines.push(`Plan Approval: granted (rev ${String(planApproval.approvedRevision)}, ${planApproval.approvedAt})`);
  } else {
    lines.push("Plan Approval: pending");
  }

  const pushApproval = session.approvals.push;
  if (pushApproval) {
    lines.push(`Push Approval: granted (rev ${String(pushApproval.approvedRevision)}, ${pushApproval.approvedAt})`);
    if (pushApproval.actor) {
      lines.push(`  Actor: ${pushApproval.actor}`);
    }
  } else {
    lines.push("Push Approval: pending");
  }

  const artifactsPresent = Object.entries(session.artifacts)
    .filter(([, ref]) => ref.status === "present")
    .map(([name]) => name);
  if (artifactsPresent.length > 0) {
    lines.push(`Artifacts: ${artifactsPresent.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * The feature a command without an explicit one acts on, or `null` when there is none and the exit
 * has already been reported.
 */
async function getTargetFeatureId(
  store: CliStack["store"],
  exit: (code: number) => void,
  featureId?: string,
): Promise<string | null> {
  if (featureId) {
    return featureId;
  }
  const sessions = await store.list();
  const lastSession = sessions[sessions.length - 1];
  if (!lastSession) {
    console.error("No workflow sessions found.");
    exit(1);
    return null;
  }
  return lastSession.featureId;
}

/**
 * The environment variable `agentflow run` falls back to when no `--model` flag is given. The flag
 * always wins; a value from either source is validated the same way before it reaches the
 * executor.
 */
const AGENTFLOW_MODEL_ENV = "AGENTFLOW_MODEL";

/**
 * Resolves the model `run` asks OpenCode for, and refuses a value that could not be one argv
 * token.
 *
 * The `--model` flag wins over `AGENTFLOW_MODEL`; `null` — which omits `--model` from the
 * invocation and leaves the choice to OpenCode's own default — only when neither is set. Whichever
 * source wins must be non-empty, free of whitespace, and free of a leading "-", which is what keeps
 * the value a single argument after `--model` rather than an empty or option-like token on its way
 * into the invocation.
 *
 * Thrown, not logged: the `run` action's catch reports it and exits non-zero, so an unusable value
 * stops the command before a stack is built, let alone a stage run.
 */
function resolveRunModel(flag: string | undefined): string | null {
  const source = flag !== undefined ? "--model" : AGENTFLOW_MODEL_ENV;
  const value = flag ?? process.env[AGENTFLOW_MODEL_ENV] ?? null;

  if (value === null) {
    return null;
  }

  if (value.length === 0) {
    throw new Error(`Invalid ${source} value: the model must not be empty.`);
  }

  if (/\s/.test(value)) {
    throw new Error(`Invalid ${source} value: ${JSON.stringify(value)} must not contain spaces.`);
  }

  if (value.startsWith("-")) {
    throw new Error(`Invalid ${source} value: ${JSON.stringify(value)} must not start with "-".`);
  }

  return value;
}

/**
 * The per-stage budget in milliseconds, from `--stage-timeout <seconds>`.
 *
 * The default is not restated here: it is `DEFAULT_TIMEOUT_MS` itself — 900 000 ms, i.e. **900
 * seconds (15 minutes)**, the same value the executor uses when it is given no budget at all — so
 * the flag's help text, this conversion, and the executor's default cannot drift apart. The value
 * has not changed; only where a caller can state it has.
 *
 * A flag that is not a whole number of seconds of at least one is refused before a stack is built,
 * exactly as an unusable `--model` is: an unusable value is this command's answer rather than a
 * surprise inside a stage's invocation.
 */
function resolveStageTimeoutMs(flag: string | undefined): number {
  if (flag === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (!/^[0-9]+$/u.test(flag)) {
    throw new Error(
      `Invalid --stage-timeout value: ${JSON.stringify(flag)} must be a whole number of seconds.`,
    );
  }

  const timeoutMs = Number(flag) * 1000;

  if (timeoutMs < 1000) {
    throw new Error("Invalid --stage-timeout value: the timeout must be at least 1 second.");
  }

  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error(`Invalid --stage-timeout value: ${JSON.stringify(flag)} is too large a number of seconds.`);
  }

  return timeoutMs;
}

/**
 * Whether `git rev-parse HEAD` resolves, i.e. the repository has at least one commit.
 *
 * `run` checks this before the workflow is touched: a stage diffs, verifies, and eventually
 * publishes against commits, and in a repository with no commits that can only fail somewhere deep
 * inside a stage. A failing `rev-parse` — no commits, or no Git at all — is a non-zero exit here.
 */
async function hasInitialCommit(repoRoot: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/** How many untracked paths the warning lists before it summarizes the rest. */
const UNTRACKED_LIST_LIMIT = 10;

/**
 * The untracked paths Git reports, or none at all when the status cannot be taken.
 *
 * A warning is best-effort by construction: a repository whose status cannot be read — no Git, a
 * broken index, a record the parser refuses — produces no warning rather than a command that fails
 * on its way to being helpful. `-z` and `--untracked-files=all` are the same report the workspace
 * adapter reads, so what this prints is what Git actually said, one literal path at a time.
 */
async function untrackedFiles(repoRoot: string): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    return parseStatus(stdout).untracked;
  } catch {
    return [];
  }
}

/**
 * Warns that untracked files will not reach the write stages, and says why in framework terms.
 *
 * This is information, never a gate: it prints and the command continues exactly as it did before.
 * The reason is P-11 — a write stage runs in a detached worktree of the approved commit, so a file
 * nobody committed is invisible to it, while the pre-approval stages that ran in this checkout saw
 * it perfectly well. Saying that at the two commands where the surprise lands is cheaper than a
 * scope violation deep inside an implementation stage.
 */
async function warnAboutUntrackedFiles(repoRoot: string): Promise<void> {
  const untracked = await untrackedFiles(repoRoot);

  if (untracked.length === 0) {
    return;
  }

  const shown = untracked.slice(0, UNTRACKED_LIST_LIMIT);
  const remaining = untracked.length - shown.length;
  const list =
    remaining === 0 ? shown.join(", ") : `${shown.join(", ")}, and ${String(remaining)} more`;

  console.warn(
    `Warning: ${String(untracked.length)} untracked file(s) will not be seen by write stages: ${list}. ` +
      "Write stages run in a worktree of the approved commit and will not see them; only committed work travels. " +
      "Commit them first.",
  );
}

/**
 * The scope-warning text for one feature's stored plan, or `null` when the plan authorizes
 * something.
 *
 * The derivation is the orchestrator's own exported `approvedScopeFromPlan`, on the artifact as it
 * is stored — the same bytes approval is about to accept, read for a warning and for nothing else.
 * Nothing here approves, refuses, or widens anything: an unreadable plan derives no patterns, the
 * warning says so, and the approval decision stays exactly where it was (D-14, R-263).
 */
async function planScopeWarning(
  store: CliStack["store"],
  featureId: string,
): Promise<string | null> {
  let plan: unknown;

  try {
    plan = await store.readArtifact(featureId, "plan");
  } catch {
    plan = undefined;
  }

  const outcome = approvedScopeFromPlan(plan);

  if (!outcome.ok || outcome.patterns.length > 0) {
    return null;
  }

  return (
    `Warning: the plan for ${featureId} derives an approved scope of zero file patterns, so implementation will fail the scope check. ` +
    "Approval is not blocked. Each step must list `expectedFiles` — the only key the scope derivation reads — before the write stages can touch a file."
  );
}

/**
 * Builds the CLI's command tree.
 *
 * Every command is a thin adapter over an existing API: `init` over `initializeProject`, `status`
 * over the session store, `start` over `createFeature`, `run` over `runNext`, and `approve` over the
 * orchestrator's own gate approvals. There is no second state machine here — the loop in `run` only
 * decides when to stop calling `runNext` and never decides what a step means.
 */
export function createCli(options: CreateCliOptions = {}): Command {
  const cwd = options.cwd ?? ((): string => process.cwd());
  const exit = options.exit ?? ((code: number): void => void process.exit(code));
  const createStack = options.createStack ?? createRealStack;
  const program = new Command();

  program
    .name("agentflow")
    .description("Agent Workflow Kit CLI")
    .version(packageVersion, "-v, --version", "Show version")
    .hook("preAction", (thisCommand) => {
      const opts = thisCommand.opts<{ verbose?: boolean }>();
      if (opts.verbose) {
        console.error(`[debug] repo: ${getRepoRoot(cwd())}`);
      }
    });

  program
    .command("init")
    .description("Initialize Agent Workflow Kit in the current project")
    .action(async () => {
      try {
        const repoRoot = getRepoRoot(cwd());
        await initializeProject(repoRoot);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        exit(1);
      }
    });

  program
    .command("status")
    .description("Show current workflow status")
    .argument("[feature-id]", "Feature ID to show status for (defaults to most recent)")
    .option("-v, --verbose", "Verbose output")
    .action(async (featureId: string | undefined) => {
      try {
        const repoRoot = getRepoRoot(cwd());
        // Read-only, and it never constructs a stack: status touches persisted state and nothing
        // else, so it works with no agent runtime installed at all.
        const store = createFeatureSessionStore(repoRoot);

        const targetFeatureId = await getTargetFeatureId(store, exit, featureId);
        if (targetFeatureId === null) {
          return;
        }
        const session = await store.load(targetFeatureId);

        // Where the last stage ran and what it left behind, when it ran at all. Read-only and
        // best-effort: a feature with no recording, and a machine with no cache to search, gets
        // exactly the output this command produced before it existed.
        const latest = await findLatestRecording(repoRoot, targetFeatureId);
        const lines = [formatStatus(session)];

        if (latest !== null) {
          lines.push(`Last stage: ${latest.stage}`);
          lines.push(
            `Last stage elapsed: ${String(Math.max(0, Math.round(latest.durationMs / 1000)))}s`,
          );
          lines.push(`Recording folder: ${latest.folder}`);
        }

        console.log(lines.join("\n"));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        exit(1);
      }
    });

  program
    .command("start")
    .description("Start a new workflow feature")
    .requiredOption("-i, --feature-id <id>", "Feature ID (e.g., F-001)")
    .requiredOption("-t, --title <title>", "Feature title")
    .option("-r, --request <request>", "Feature request description")
    .option("-s, --slug <slug>", "Feature slug (defaults to title)")
    .action(async (opts: { featureId: string; title: string; request?: string; slug?: string }) => {
      try {
        const repoRoot = getRepoRoot(cwd());
        const stack = createStack(repoRoot, {});

        const input: { featureId: string; title: string; request?: string; slug?: string } = {
          featureId: opts.featureId,
          title: opts.title,
        };
        if (opts.request !== undefined) {
          input.request = opts.request;
        }
        if (opts.slug !== undefined) {
          input.slug = opts.slug;
        }

        const result = await stack.orchestrator.createFeature(input);

        if (result.status === "created") {
          console.log(`Created feature ${result.featureId} (${result.state})`);
        } else {
          console.error(`Failed to create feature: ${result.error?.message ?? "Unknown error"}`);
          exit(1);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        exit(1);
      }
    });

  program
    .command("run")
    .description("Run the workflow non-interactively until a human gate")
    .argument("[feature-id]", "Feature ID to run (defaults to most recent)")
    .option("-v, --verbose", "Verbose output")
    .option(
      "--model <model>",
      "Model to ask OpenCode for, as provider/model; falls back to AGENTFLOW_MODEL, then to OpenCode's own default model",
    )
    .option(
      "--quiet",
      "No live stage progress on stderr (a failed stage still names its recording folder)",
    )
    .option(
      "--stage-timeout <seconds>",
      `Per-stage timeout in seconds (default: ${String(DEFAULT_TIMEOUT_MS / 1000)})`,
    )
    .action(async (featureId: string | undefined, opts: RunCommandOptions) => {
      try {
        const repoRoot = getRepoRoot(cwd());
        // Resolved and validated before anything is built, so an unusable value is this command's
        // answer rather than a surprise inside a stage's invocation.
        const model = resolveRunModel(opts.model);
        const stageTimeoutMs = resolveStageTimeoutMs(opts.stageTimeout);

        // Before the stack exists and before any session is read: a repository with no commits
        // cannot diff, verify, or publish, so the run stops here with that answer.
        if (!(await hasInitialCommit(repoRoot))) {
          console.error("Error: this repository has no commits; make an initial commit first.");
          exit(1);
          return;
        }

        // At run start, before anything is built: a file nobody committed is invisible to the write
        // stages this run may reach, which is a surprise worth stating once rather than at the scope
        // check (P-11). Best-effort, and it never changes what the run does.
        await warnAboutUntrackedFiles(repoRoot);

        // Progress goes to stderr through one reporter owned by this command: stage start/finish
        // lines and the 30s heartbeat, silenced entirely by --quiet.
        const reporter = createStageProgressReporter(
          opts.quiet === true ? { quiet: true } : {},
        );
        const stack = createStack(repoRoot, {
          model,
          onProgress: reporter,
          stageTimeoutMs,
        });
        const orchestrator = stack.orchestrator;

        const targetFeatureId = await getTargetFeatureId(stack.store, exit, featureId);
        if (targetFeatureId === null) {
          return;
        }

        // Before the first `runNext`, so an unusable OpenCode fails this command with an answer
        // instead of failing a stage inside the workflow. A stack with no runtime to check — a
        // test's injected stack — has nothing to preflight and goes straight to the workflow.
        if (stack.preflight !== undefined) {
          const probe = await stack.preflight();

          if (opts.verbose) {
            console.error(`[debug] ${probe}`);
          }
        }

        let lastResult: Awaited<ReturnType<typeof orchestrator.runNext>> | null = null;

        for (let attempt = 0; attempt < MAX_RUN_ATTEMPTS; attempt++) {
          const result = await orchestrator.runNext(targetFeatureId);
          lastResult = result;

          if (opts.verbose) {
            console.log(`[${result.status}] ${result.state}${result.stage ? ` (${result.stage})` : ""}`);
          }

          if (result.status === "awaiting_human") {
            const action = result.action ?? "unknown";
            console.log(`Workflow paused at ${result.state} - awaiting ${action}`);
            console.log("Run 'agentflow approve plan' or 'agentflow approve push' to continue.");
            return;
          }

          if (result.status === "terminal") {
            console.log(`Workflow reached terminal state: ${result.state}`);
            return;
          }

          const errorStatuses = new Set([
            "rejected",
            "executor_error",
            "stage_failed",
            "feature_failed",
            "inconclusive",
            "scope_violation",
            "conflict",
            "persistence_error",
          ]);
          if (errorStatuses.has(result.status)) {
            console.error(`Workflow error (${result.status}): ${result.error?.message ?? "Unknown error"}`);
            exit(1);
            return;
          }

          if (result.status === "stage_completed" || result.status === "advanced" || result.status === "gate_approved" || result.status === "committed") {
            continue;
          }
        }

        // Loop exhausted without reaching a gate or terminal state
        const finalState = lastResult?.state ?? "unknown";
        console.error(`did not converge after ${String(MAX_RUN_ATTEMPTS)} iterations; last state ${finalState}`);
        exit(1);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        exit(1);
      }
    });

  const approve = program
    .command("approve")
    .description("Approve workflow gates");

  approve
    .command("plan")
    .description("Approve the current plan")
    .argument("[feature-id]", "Feature ID to approve (defaults to most recent)")
    .action(async (featureId: string | undefined) => {
      try {
        const repoRoot = getRepoRoot(cwd());

        // Before the gate is touched: uncommitted work will not travel to the worktree the write
        // stages run in, and this is the last command that runs in this checkout (P-11). A warning
        // only — approval proceeds exactly as it did before it existed.
        await warnAboutUntrackedFiles(repoRoot);

        const stack = createStack(repoRoot, {});

        const targetFeatureId = await getTargetFeatureId(stack.store, exit, featureId);
        if (targetFeatureId === null) {
          return;
        }

        // Derived from the stored plan before approval completes, so a plan that authorizes nothing
        // is visible to the human who is about to accept it. It prints and never blocks: the
        // approval below runs whether or not there was anything to warn about (D-14, R-263).
        const scopeWarning = await planScopeWarning(stack.store, targetFeatureId);

        if (scopeWarning !== null) {
          console.warn(scopeWarning);
        }

        const result = await stack.orchestrator.approvePlan(targetFeatureId);

        if (result.status === "gate_approved") {
          console.log(`Plan approved. Workflow advanced to ${result.state}`);
        } else {
          console.error(`Plan approval failed: ${result.error?.message ?? "Unknown error"}`);
          exit(1);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        exit(1);
      }
    });

  approve
    .command("push")
    .description("Approve publishing the feature")
    .argument("[feature-id]", "Feature ID to approve (defaults to most recent)")
    .option("-a, --actor <actor>", "Actor/approver identifier")
    .action(async (featureId: string | undefined, opts: { actor?: string }) => {
      try {
        const repoRoot = getRepoRoot(cwd());
        const stack = createStack(repoRoot, {});

        const targetFeatureId = await getTargetFeatureId(stack.store, exit, featureId);
        if (targetFeatureId === null) {
          return;
        }

        const result = await stack.orchestrator.approvePush(targetFeatureId, {
          actor: opts.actor ?? null,
        });

        if (result.status === "gate_approved") {
          console.log(`Push approved. Workflow advanced to ${result.state}`);
        } else {
          console.error(`Push approval failed: ${result.error?.message ?? "Unknown error"}`);
          exit(1);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        exit(1);
      }
    });

  return program;
}
