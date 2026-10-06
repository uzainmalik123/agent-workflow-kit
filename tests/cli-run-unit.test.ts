import { describe, expect, it, vi } from "vitest";
import type { OrchestrationResult } from "@agent-workflow-kit/orchestration";
import { WorkflowState } from "@agent-workflow-kit/core";

interface MockOrchestrator {
  runNext: (featureId: string) => Promise<OrchestrationResult>;
}

interface MockStore {
  list: () => Promise<Array<{ featureId: string }>>;
  load: (featureId: string) => Promise<unknown>;
}

const MAX_RUN_ATTEMPTS = 100;

async function runWorkflow(
  orchestrator: MockOrchestrator,
  store: MockStore,
  featureId: string | undefined,
  verbose: boolean,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const mockConsoleLog = vi.fn((...args: unknown[]) => stdout.push(args.join(" ")));
  const mockConsoleError = vi.fn((...args: unknown[]) => stderr.push(args.join(" ")));
  const mockProcessExit = vi.fn((code: number) => {
    throw new Error(`PROCESS_EXIT:${String(code)}`);
  });

  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalProcessExit = process.exit.bind(process);

  console.log = mockConsoleLog;
  console.error = mockConsoleError;
  process.exit = mockProcessExit;

  try {
    const targetFeatureId = featureId ?? (await store.list()).pop()?.featureId ?? "";

    if (!targetFeatureId) {
      console.error("No workflow sessions found.");
      process.exit(1);
    }

    for (let attempt = 0; attempt < MAX_RUN_ATTEMPTS; attempt++) {
      const result = await orchestrator.runNext(targetFeatureId);

      if (verbose) {
        console.log(`[${result.status}] ${result.state}${result.stage ? ` (${result.stage})` : ""}`);
      }

      if (result.status === "awaiting_human") {
        const action = result.action ?? "unknown";
        console.log(`Workflow paused at ${result.state} - awaiting ${action}`);
        console.log("Run 'agentflow approve plan' or 'agentflow approve push' to continue.");
        return { exitCode: 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
      }

      if (result.status === "terminal") {
        console.log(`Workflow reached terminal state: ${result.state}`);
        return { exitCode: 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
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
        return { exitCode: 1, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
      }

      if (result.status === "stage_completed" || result.status === "advanced" || result.status === "gate_approved" || result.status === "committed") {
        continue;
      }
    }

    // Loop exhausted without converging
    const lastResult = await orchestrator.runNext(targetFeatureId);
    console.error(`did not converge after ${String(MAX_RUN_ATTEMPTS)} iterations; last state ${lastResult.state}`);
    return { exitCode: 1, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("PROCESS_EXIT:")) {
      const parts = error.message.split(":");
      const code = parts[1] !== undefined ? parseInt(parts[1], 10) : 1;
      return { exitCode: code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return { exitCode: 1, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
  }
}

function createMockOrchestrator(results: OrchestrationResult[]): MockOrchestrator {
  let callIndex = 0;
  const fn = (): Promise<OrchestrationResult> => {
    if (callIndex < results.length) {
      const result = results[callIndex++];
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return Promise.resolve(result!);
    }
    // Return a result that keeps the loop going
    return Promise.resolve({
      status: "stage_completed",
      failureClass: "none",
      featureId: "F-001",
      fromState: WorkflowState.Planning,
      state: WorkflowState.Planning,
      executedStages: ["planning"],
      stage: "planning",
      role: "planner",
      event: "advance",
      committed: false,
      artifacts: ["plan"],
      action: null,
      fixReturnState: null,
      findings: [],
      evidence: [],
      verification: null,
      security: null,
      scope: null,
      finalGate: null,
      publish: null,
      fix: null,
      error: null,
    });
  };
  return {
    runNext: vi.fn(fn),
  };
}

function createMockStore(featureId: string): MockStore {
  return {
    list: () => Promise.resolve([{ featureId }]),
    load: () => Promise.resolve({ featureId }),
  };
}

describe("runWorkflow loop logic", () => {
  it("exits 0 when reaching awaiting_human", async () => {
    const orchestrator = createMockOrchestrator([
      {
        status: "awaiting_human",
        failureClass: "none",
        featureId: "F-001",
        fromState: WorkflowState.AwaitingPlanApproval,
        state: WorkflowState.AwaitingPlanApproval,
        executedStages: [],
        stage: null,
        role: null,
        event: null,
        committed: false,
        artifacts: [],
        action: "approve_plan",
        fixReturnState: null,
        findings: [],
        evidence: [],
        verification: null,
        security: null,
        scope: null,
        finalGate: null,
        publish: null,
        fix: null,
        error: null,
      },
    ]);
    const store = createMockStore("F-001");

    const result = await runWorkflow(orchestrator, store, "F-001", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("awaiting");
    expect(result.stdout).toContain("approve plan");
  });

  it("exits 0 when reaching terminal state (complete)", async () => {
    const orchestrator = createMockOrchestrator([
      {
        status: "terminal",
        failureClass: "none",
        featureId: "F-001",
        fromState: WorkflowState.Complete,
        state: WorkflowState.Complete,
        executedStages: [],
        stage: null,
        role: null,
        event: null,
        committed: false,
        artifacts: [],
        action: null,
        fixReturnState: null,
        findings: [],
        evidence: [],
        verification: null,
        security: null,
        scope: null,
        finalGate: null,
        publish: null,
        fix: null,
        error: null,
      },
    ]);
    const store = createMockStore("F-001");

    const result = await runWorkflow(orchestrator, store, "F-001", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("terminal state");
    expect(result.stdout).toContain("complete");
  });

  it("exits 0 when reaching terminal state (failed)", async () => {
    const orchestrator = createMockOrchestrator([
      {
        status: "terminal",
        failureClass: "none",
        featureId: "F-001",
        fromState: WorkflowState.Failed,
        state: WorkflowState.Failed,
        executedStages: [],
        stage: null,
        role: null,
        event: null,
        committed: false,
        artifacts: [],
        action: null,
        fixReturnState: null,
        findings: [],
        evidence: [],
        verification: null,
        security: null,
        scope: null,
        finalGate: null,
        publish: null,
        fix: null,
        error: null,
      },
    ]);
    const store = createMockStore("F-001");

    const result = await runWorkflow(orchestrator, store, "F-001", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("terminal state");
    expect(result.stdout).toContain("failed");
  });

  it("exits non-zero with message when loop exhausts without converging", async () => {
    // Create an orchestrator that always returns stage_completed, never reaching a gate
    const orchestrator = createMockOrchestrator([]);
    const store = createMockStore("F-001");

    const result = await runWorkflow(orchestrator, store, "F-001", false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`did not converge after ${String(MAX_RUN_ATTEMPTS)} iterations`);
    expect(result.stderr).toContain("last state planning");
  });

  it("exits non-zero on error status", async () => {
    const orchestrator = createMockOrchestrator([
      {
        status: "rejected",
        failureClass: "workflow",
        featureId: "F-001",
        fromState: WorkflowState.Planning,
        state: WorkflowState.Planning,
        executedStages: [],
        stage: null,
        role: null,
        event: null,
        committed: false,
        artifacts: [],
        action: null,
        fixReturnState: null,
        findings: [],
        evidence: [],
        verification: null,
        security: null,
        scope: null,
        finalGate: null,
        publish: null,
        fix: null,
        error: { code: "illegal_transition", message: "Test error", failureClass: "workflow" },
      },
    ]);
    const store = createMockStore("F-001");

    const result = await runWorkflow(orchestrator, store, "F-001", false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Workflow error");
    expect(result.stderr).toContain("Test error");
  });

  it("stops at plan approval gate and does not advance past it (R-238)", async () => {
    const orchestrator = createMockOrchestrator([
      {
        status: "awaiting_human",
        failureClass: "none",
        featureId: "F-001",
        fromState: WorkflowState.AwaitingPlanApproval,
        state: WorkflowState.AwaitingPlanApproval,
        executedStages: [],
        stage: null,
        role: null,
        event: null,
        committed: false,
        artifacts: [],
        action: "approve_plan",
        fixReturnState: null,
        findings: [],
        evidence: [],
        verification: null,
        security: null,
        scope: null,
        finalGate: null,
        publish: null,
        fix: null,
        error: null,
      },
    ]);
    const store = createMockStore("F-001");

    const result = await runWorkflow(orchestrator, store, "F-001", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("awaiting");
    expect(result.stdout).toContain("approve_plan");
    // The loop should break at awaiting_human, not continue past it
  });

  it("stops at push approval gate and does not advance past it (R-238)", async () => {
    const orchestrator = createMockOrchestrator([
      {
        status: "awaiting_human",
        failureClass: "none",
        featureId: "F-001",
        fromState: WorkflowState.AwaitingPushApproval,
        state: WorkflowState.AwaitingPushApproval,
        executedStages: [],
        stage: null,
        role: null,
        event: null,
        committed: false,
        artifacts: [],
        action: "approve_push",
        fixReturnState: null,
        findings: [],
        evidence: [],
        verification: null,
        security: null,
        scope: null,
        finalGate: null,
        publish: null,
        fix: null,
        error: null,
      },
    ]);
    const store = createMockStore("F-001");

    const result = await runWorkflow(orchestrator, store, "F-001", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("awaiting");
    expect(result.stdout).toContain("approve_push");
    // The loop should break at awaiting_human, not continue past it
  });
});