#!/usr/bin/env node
import { program } from "commander";
import { createWorkflowOrchestrator } from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import { discoverProject, PROJECT_CONFIG_FILENAME } from "@agent-workflow-kit/project";
import { resolve, join, dirname } from "node:path";
import { mkdir, writeFile, lstat } from "node:fs/promises";
import type { StageExecutor, StageExecutionRequest, StageExecutionResult } from "@agent-workflow-kit/orchestration";
import type { FeatureSession } from "@agent-workflow-kit/persistence";

let packageVersion = "0.0.0";
try {
  const packageJson = await import("../package.json", { assert: { type: "json" } });
  packageVersion = packageJson.default.version;
} catch {
  // fallback to default
}

const MAX_RUN_ATTEMPTS = 100;

class StubExecutor implements StageExecutor {
  execute(_request: StageExecutionRequest): Promise<StageExecutionResult> {
    return Promise.reject(
      new Error(
        `Stage executor not configured. Cannot run stage "${_request.stage}". ` +
        `Configure a real executor (e.g., @agent-workflow-kit/opencode) to run workflow stages.`
      )
    );
  }
}

function createOrchestrator(repoRoot: string) {
  const store = createFeatureSessionStore(repoRoot);
  const executor = new StubExecutor();
  return createWorkflowOrchestrator({ store, executor });
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

  // Create .agentflow/features directory structure
  const agentflowDir = join(repoRoot, ".agentflow");
  const featuresDir = join(agentflowDir, "features");
  await mkdir(featuresDir, { recursive: true });

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

async function getTargetFeatureId(store: ReturnType<typeof createFeatureSessionStore>, featureId?: string): Promise<string> {
  if (featureId) {
    return featureId;
  }
  const sessions = await store.list();
  if (sessions.length === 0) {
    console.error("No workflow sessions found.");
    process.exit(1);
  }
  const lastSession = sessions[sessions.length - 1];
  if (!lastSession) {
    console.error("No workflow sessions found.");
    process.exit(1);
  }
  return lastSession.featureId;
}

program
  .name("agentflow")
  .description("Agent Workflow Kit CLI")
  .version(packageVersion, "-v, --version", "Show version")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{ verbose?: boolean }>();
    if (opts.verbose) {
      console.error(`[debug] repo: ${getRepoRoot(process.cwd())}`);
    }
  });

program
  .command("init")
  .description("Initialize Agent Workflow Kit in the current project")
  .action(async () => {
    try {
      const repoRoot = getRepoRoot(process.cwd());
      await initializeProject(repoRoot);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show current workflow status")
  .argument("[feature-id]", "Feature ID to show status for (defaults to most recent)")
  .option("-v, --verbose", "Verbose output")
  .action(async (featureId: string | undefined) => {
    try {
      const repoRoot = getRepoRoot(process.cwd());
      const store = createFeatureSessionStore(repoRoot);

      const targetFeatureId = await getTargetFeatureId(store, featureId);
      const session = await store.load(targetFeatureId);

      console.log(formatStatus(session));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("start")
  .description("Start a new workflow feature")
  .requiredOption("-i, --feature-id <id>", "Feature ID (e.g., F-001)")
  .requiredOption("-t, --title <title>", "Feature title")
  .option("-r, --request <request>", "Feature request description")
  .option("-s, --slug <slug>", "Feature slug (defaults to title)")
  .action(async (options: { featureId: string; title: string; request?: string; slug?: string }) => {
    try {
      const repoRoot = getRepoRoot(process.cwd());
      const orchestrator = createOrchestrator(repoRoot);

      const input: { featureId: string; title: string; request?: string; slug?: string } = {
        featureId: options.featureId,
        title: options.title,
      };
      if (options.request !== undefined) {
        input.request = options.request;
      }
      if (options.slug !== undefined) {
        input.slug = options.slug;
      }

      const result = await orchestrator.createFeature(input);

      if (result.status === "created") {
        console.log(`Created feature ${result.featureId} (${result.state})`);
      } else {
        console.error(`Failed to create feature: ${result.error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("run")
  .description("Run the workflow non-interactively until a human gate")
  .argument("[feature-id]", "Feature ID to run (defaults to most recent)")
  .option("-v, --verbose", "Verbose output")
  .action(async (featureId: string | undefined, options: { verbose?: boolean }) => {
    try {
      const repoRoot = getRepoRoot(process.cwd());
      const store = createFeatureSessionStore(repoRoot);
      const orchestrator = createOrchestrator(repoRoot);

      const targetFeatureId = await getTargetFeatureId(store, featureId);

      let lastResult: Awaited<ReturnType<typeof orchestrator.runNext>> | null = null;

      for (let attempt = 0; attempt < MAX_RUN_ATTEMPTS; attempt++) {
        const result = await orchestrator.runNext(targetFeatureId);
        lastResult = result;

        if (options.verbose) {
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
          process.exit(1);
        }

        if (result.status === "stage_completed" || result.status === "advanced" || result.status === "gate_approved" || result.status === "committed") {
          continue;
        }
      }

      // Loop exhausted without reaching a gate or terminal state
      const finalState = lastResult?.state ?? "unknown";
      console.error(`did not converge after ${String(MAX_RUN_ATTEMPTS)} iterations; last state ${finalState}`);
      process.exit(1);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
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
      const repoRoot = getRepoRoot(process.cwd());
      const store = createFeatureSessionStore(repoRoot);
      const orchestrator = createOrchestrator(repoRoot);

      const targetFeatureId = await getTargetFeatureId(store, featureId);

      const result = await orchestrator.approvePlan(targetFeatureId);

      if (result.status === "gate_approved") {
        console.log(`Plan approved. Workflow advanced to ${result.state}`);
      } else {
        console.error(`Plan approval failed: ${result.error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

approve
  .command("push")
  .description("Approve publishing the feature")
  .argument("[feature-id]", "Feature ID to approve (defaults to most recent)")
  .option("-a, --actor <actor>", "Actor/approver identifier")
  .action(async (featureId: string | undefined, options: { actor?: string }) => {
    try {
      const repoRoot = getRepoRoot(process.cwd());
      const store = createFeatureSessionStore(repoRoot);
      const orchestrator = createOrchestrator(repoRoot);

      const targetFeatureId = await getTargetFeatureId(store, featureId);

      const result = await orchestrator.approvePush(targetFeatureId, {
        actor: options.actor ?? null,
      });

      if (result.status === "gate_approved") {
        console.log(`Push approved. Workflow advanced to ${result.state}`);
      } else {
        console.error(`Push approval failed: ${result.error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});