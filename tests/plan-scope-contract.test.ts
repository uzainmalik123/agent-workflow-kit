import { STAGE_DEFINITIONS, type StageExecutionRequest } from "@agent-workflow-kit/orchestration";
import { approvedScopeFromPlan, matchesScopePattern } from "@agent-workflow-kit/orchestration";
import { PLAN_EXAMPLE, buildStagePrompt, roleDefinition } from "@agent-workflow-kit/opencode";
import { describe, expect, it } from "vitest";
import { testWorkspaceContext } from "../fixtures/workspace.js";

/**
 * The plan the planner prompt shows and the scope the framework derives from it, as one contract.
 *
 * `PLAN_EXAMPLE` is the single constant both sides read: `buildStagePrompt` renders it verbatim into
 * the planner's prompt, and this file feeds the same object to `approvedScopeFromPlan`. If the
 * derivation ever stops reading the key the example demonstrates, or the prompt stops showing that
 * example, one of the assertions below fails — a drift the model would otherwise discover as a
 * scope violation on its first real write (P-13).
 */

const created = "2026-04-05T06:07:08.000Z";

function requestFor(stage: StageExecutionRequest["stage"]): StageExecutionRequest {
  const definition = STAGE_DEFINITIONS[stage];

  return {
    feature: {
      featureId: "F-001",
      title: "Multiply helper",
      slug: "multiply-helper",
      state: definition.state,
      createdAt: created,
      updatedAt: created,
    },
    stage,
    role: definition.role,
    state: definition.state,
    context: [],
    outputs: definition.outputs,
    fixReturnState: null,
    verification: null,
    fix: null,
    workspace: testWorkspaceContext(),
  };
}

function promptFor(stage: StageExecutionRequest["stage"]): string {
  return buildStagePrompt({ request: requestFor(stage), projectInstructions: null });
}

function plannerPrompt(): string {
  return promptFor("planning");
}

/** The example's own file list, in the order the steps declare it. */
function exampleFiles(): readonly string[] {
  return PLAN_EXAMPLE.steps.flatMap((step) => step.expectedFiles);
}

/** The derived scope, or a failure — this test never treats a refusal as an empty answer. */
function patternsFromExample(): readonly string[] {
  const outcome = approvedScopeFromPlan(PLAN_EXAMPLE);

  if (!outcome.ok) {
    throw new Error(`the example plan was refused: ${outcome.error.message}`);
  }

  return outcome.patterns;
}

describe("plan example and approved-scope derivation", () => {
  it("derives a non-empty scope from the example the prompt shows", () => {
    const patterns = patternsFromExample();

    expect(patterns.length).toBeGreaterThan(0);
  });

  it("authorizes exactly the files the example names", () => {
    const patterns = patternsFromExample();
    const files = exampleFiles();

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(patterns.some((pattern) => matchesScopePattern(pattern, file))).toBe(true);
    }

    // Exact paths in, exact patterns out: the derived set is the example's own list, sorted.
    expect(patterns).toEqual([...new Set(files)].sort());
  });

  it("refuses a file the example never names", () => {
    const patterns = patternsFromExample();

    for (const outside of ["implementation.json", "src/notes.md", "scripts/other.mjs"]) {
      expect(patterns.some((pattern) => matchesScopePattern(pattern, outside))).toBe(false);
    }
  });

  it("ignores the keys the model wrote instead, so the derivation is never widened to compensate", () => {
    const outcome = approvedScopeFromPlan({
      featureId: "F-001",
      summary: "A plan that names its files elsewhere.",
      declaredFileSet: { created: ["src/multiply.mjs"], modified: [], deleted: [] },
      steps: [{ id: "STEP-1", description: "Write it.", files: ["src/multiply.mjs"] }],
    });

    if (!outcome.ok) {
      throw new Error(`unexpected refusal: ${outcome.error.message}`);
    }

    // The fix belongs in the prompt, not in the derivation (D-14, R-263): those keys authorize
    // nothing, and a plan that uses them must derive an empty scope rather than a widened one.
    expect(outcome.patterns).toEqual([]);
  });

  it("shows that exact example in the planner prompt", () => {
    const prompt = plannerPrompt();

    expect(prompt).toContain("## Plan artifact shape");
    expect(prompt).toContain(JSON.stringify(PLAN_EXAMPLE, null, 2));
  });

  it("shows the plan shape only to the stage that produces a plan", () => {
    for (const stage of ["grill", "plan_review", "implementation", "code_review"] as const) {
      expect(promptFor(stage)).not.toContain("## Plan artifact shape");
      expect(promptFor(stage)).not.toContain(JSON.stringify(PLAN_EXAMPLE, null, 2));
    }
  });

  it("names the `expectedFiles` key in the prompt and in the planner role text", () => {
    const prompt = plannerPrompt();
    const definition = roleDefinition("planner");
    const roleText = [...definition.responsibilities, ...definition.deliverables].join("\n");

    expect(prompt).toContain("expectedFiles");
    expect(roleText).toContain("expectedFiles");
    // The key the derivation reads must be the one the role asks for, not a near-name.
    expect(roleText).toContain("`steps[].expectedFiles`");
  });
});
