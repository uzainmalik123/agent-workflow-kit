import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Register the no-raw-source hook before any imports
register("./no-raw-source-hook.mjs", import.meta.url);

const packages = [
  "@agent-workflow-kit/core",
  "@agent-workflow-kit/orchestration",
  "@agent-workflow-kit/persistence",
  "@agent-workflow-kit/project",
  "@agent-workflow-kit/workspace",
  "@agent-workflow-kit/opencode",
];

async function runSmoke() {
  console.log("Running package runtime smoke test...\n");

  // 1. Verify each package entry point resolves to dist/
  console.log("1. Checking package exports resolve to dist/...");
  for (const pkg of packages) {
    const resolved = import.meta.resolve(pkg);
    console.log(`  ${pkg} → ${resolved}`);
    if (!resolved.includes("/dist/index.js")) {
      throw new Error(`Expected ${pkg} to resolve to dist/index.js, got ${resolved}`);
    }
    if (!existsSync(fileURLToPath(resolved))) {
      throw new Error(`Resolved file does not exist: ${resolved}`);
    }
  }
  console.log("  ✓ All packages resolve to dist/\n");

  // 2. Import each package and verify key exports exist
  console.log("2. Importing packages and checking exports...");
  const imports = {
    core: await import("@agent-workflow-kit/core"),
    orchestration: await import("@agent-workflow-kit/orchestration"),
    persistence: await import("@agent-workflow-kit/persistence"),
    project: await import("@agent-workflow-kit/project"),
    workspace: await import("@agent-workflow-kit/workspace"),
    opencode: await import("@agent-workflow-kit/opencode"),
  };

  // Core exports
  if (!imports.core.WorkflowState) throw new Error("core.WorkflowState missing");
  if (!imports.core.WorkflowStateMachine) throw new Error("core.WorkflowStateMachine missing");
  if (!imports.core.validateWorkspaceBaseline) throw new Error("core.validateWorkspaceBaseline missing");
  console.log("  ✓ @agent-workflow-kit/core exports loaded");

  // Orchestration exports
  if (!imports.orchestration.STAGE_DEFINITIONS) throw new Error("orchestration.STAGE_DEFINITIONS missing");
  if (!imports.orchestration.WorkflowOrchestrator) throw new Error("orchestration.WorkflowOrchestrator missing");
  if (!imports.orchestration.DEFAULT_RUNTIME_TIMEOUT_MS) throw new Error("orchestration.DEFAULT_RUNTIME_TIMEOUT_MS missing");
  console.log("  ✓ @agent-workflow-kit/orchestration exports loaded");

  // Persistence exports
  if (!imports.persistence.PersistenceError) throw new Error("persistence.PersistenceError missing");
  if (!imports.persistence.FeatureSessionStore) throw new Error("persistence.FeatureSessionStore missing");
  if (!imports.persistence.createFeatureSessionStore) throw new Error("persistence.createFeatureSessionStore missing");
  console.log("  ✓ @agent-workflow-kit/persistence exports loaded");

  // Project exports
  if (!imports.project.discoverProject) throw new Error("project.discoverProject missing");
  if (!imports.project.runChildProcess) throw new Error("project.runChildProcess missing");
  if (!imports.project.createProjectVerificationProvider) throw new Error("project.createProjectVerificationProvider missing");
  console.log("  ✓ @agent-workflow-kit/project exports loaded");

  // Workspace exports
  if (!imports.workspace.GitWorkspaceProvider) throw new Error("workspace.GitWorkspaceProvider missing");
  if (!imports.workspace.acquireLease) throw new Error("workspace.acquireLease missing");
  if (!imports.workspace.runGit) throw new Error("workspace.runGit missing");
  console.log("  ✓ @agent-workflow-kit/workspace exports loaded");

  // Opencode exports
  if (!imports.opencode.OpenCodeStageExecutor) throw new Error("opencode.OpenCodeStageExecutor missing");
  if (!imports.opencode.createOpenCodeStageExecutor) throw new Error("opencode.createOpenCodeStageExecutor missing");
  if (!imports.opencode.probeOpenCodeCapabilities) throw new Error("opencode.probeOpenCodeCapabilities missing");
  console.log("  ✓ @agent-workflow-kit/opencode exports loaded");

  // 3. Verify internal package dependencies resolve through dist/
  console.log("\n3. Verifying internal package dependencies...");
  // orchestration imports core and persistence - if it loads, the internal deps resolved
  // opencode imports core, orchestration, persistence, project - if it loads, all resolved
  const { OrchestrationError } = await import("@agent-workflow-kit/orchestration");
  const { OpenCodeStageExecutor } = await import("@agent-workflow-kit/opencode");
  console.log("  ✓ Internal package dependencies resolved through dist/");

  // 4. Assert no .ts files were loaded (handled by hook, but double-check recorded resolutions)
  console.log("\n4. Verifying no raw TypeScript sources were loaded...");
  const { getRecordedResolutions } = await import("./no-raw-source-hook.mjs");
  const resolutions = getRecordedResolutions();
  const tsResolutions = resolutions.filter((u) => u.endsWith(".ts"));
  if (tsResolutions.length > 0) {
    throw new Error(`Raw TypeScript sources loaded: ${tsResolutions.join(", ")}`);
  }
  console.log(`  ✓ ${resolutions.length} modules loaded, 0 .ts sources`);

  console.log("\n✅ All smoke tests passed!");
}

runSmoke().catch((err) => {
  console.error("\n❌ Smoke test failed:", err.message);
  process.exit(1);
});