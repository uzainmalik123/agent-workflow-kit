import type { Plan, WorkspaceBaseline } from "@agent-workflow-kit/core";
import {
  approvedScopeFromPlan,
  evaluateWorkspaceIntegrity,
  evaluateWorkspaceScope,
  isEmptyWorkspaceChanges,
  isProtectedWorkspacePath,
  matchesScopePattern,
  normalizeScopePattern,
  validateWorkspaceBaseline,
  type WorkspaceChanges,
  type WorkspaceInspection,
} from "@agent-workflow-kit/orchestration";
import { describe, expect, it } from "vitest";
import { inspectionOf } from "../fixtures/workspace-provider.js";

const COMMIT = "a1b2c3d4".repeat(5);
const OTHER_COMMIT = "2".repeat(40);

/**
 * An inspection whose Git state defaults to this commit, so a test about the scope policy does not have
 * to restate the baseline, and a test about integrity can change one field and mean it.
 */
function inspection(
  changes: Partial<WorkspaceChanges>,
  gitState: { readonly headCommit?: string; readonly stagedPaths?: readonly string[] } = {},
): WorkspaceInspection {
  return inspectionOf(changes, { headCommit: COMMIT, stagedPaths: [], ...gitState });
}

function baseline(overrides: Partial<WorkspaceBaseline> = {}): WorkspaceBaseline {
  return {
    repositoryRoot: "/repo",
    baselineCommit: COMMIT,
    approvedRevision: 4,
    workspaceId: "ws-1",
    capturedAt: "2026-05-06T07:08:09.000Z",
    ...overrides,
  };
}

function planWith(...expectedFilesByStep: readonly (readonly string[])[]): Plan {
  return {
    schemaVersion: 1,
    featureId: "F-001",
    title: "Scopes",
    summary: "Scope handling.",
    requirements: [],
    steps: expectedFilesByStep.map((expectedFiles, index) => ({
      id: `S-${String(index + 1)}`,
      title: `Step ${String(index + 1)}`,
      description: "A step.",
      expectedFiles: [...expectedFiles],
    })),
    risks: [],
    openQuestions: [],
  } as unknown as Plan;
}

describe("approved scope comes only from the approved plan", () => {
  it("collects the expected files of every step, normalized and deduplicated", () => {
    const outcome = approvedScopeFromPlan(
      planWith(["src/app.ts", "src/app.ts"], ["docs/"], ["src/**/*.ts"]),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.patterns : []).toEqual(["docs/**", "src/**/*.ts", "src/app.ts"]);
  });

  it("approves nothing when there is no plan to read", () => {
    for (const absent of [null, undefined, {}, { steps: "none" }, { steps: [1, 2] }]) {
      const outcome = approvedScopeFromPlan(absent);

      expect(outcome).toEqual({ ok: true, patterns: [] });
    }
  });

  it("drops a protected path from the approved set rather than authorizing it", () => {
    const outcome = approvedScopeFromPlan(
      planWith(["src/app.ts", ".opencode/agents/planner.md", ".agentflow/features", "opencode.json"]),
    );

    // A plan that lists a framework-controlled path is not widened to cover it: the path is simply
    // not approved, and a stage that touches it is refused.
    expect(outcome.ok ? outcome.patterns : []).toEqual(["src/app.ts"]);
  });

  it("asks for a new approval rather than cleaning up a pattern it cannot enforce", () => {
    for (const entry of ["/etc/passwd", "../outside.ts", "src/../../outside.ts", "C:/src/app.ts", "src/{a,b}.ts", "!src/app.ts", "src\\app.ts", "./src/app.ts", "", "   "]) {
      const outcome = approvedScopeFromPlan(planWith(["src/app.ts", entry]));

      expect(outcome.ok).toBe(false);
      expect((outcome.ok ? undefined : outcome.error.code)).toBe("scope_expansion_required");
      expect((outcome.ok ? undefined : outcome.error.failureClass)).toBe("workspace");
    }
  });

  it("refuses a plan whose expectedFiles list is not all text", () => {
    const plan = planWith(["src/app.ts"]);
    const broken = { ...plan, steps: [{ ...plan.steps[0], expectedFiles: ["src/app.ts", 7] }] };

    const outcome = approvedScopeFromPlan(broken);

    expect((outcome.ok ? undefined : outcome.error.code)).toBe("scope_expansion_required");
  });
});

describe("pattern normalization", () => {
  it("turns a directory pattern into the whole directory", () => {
    expect(normalizeScopePattern("src/")).toBe("src/**");
    expect(normalizeScopePattern("src")).toBe("src");
  });

  it("treats brackets as literal characters, so an ambiguous pattern authorizes less", () => {
    // `app/[id]/page.tsx` is a real Next.js-style directory name, and `app/[ab].ts` is a glob that
    // means two other files. Reading brackets as a character class would authorize every sibling a
    // human did not name, so the pattern means the one path it spells out.
    expect(normalizeScopePattern("app/[id]/page.tsx")).toBe("app/[id]/page.tsx");
    expect(matchesScopePattern("app/[id]/page.tsx", "app/[id]/page.tsx")).toBe(true);
    expect(matchesScopePattern("app/[id]/page.tsx", "app/idx/page.tsx")).toBe(false);
    expect(matchesScopePattern("app/[ab].ts", "app/[ab].ts")).toBe(true);
    expect(matchesScopePattern("app/[ab].ts", "app/a.ts")).toBe(false);
  });

  it("refuses everything that is not a repository-relative path or glob", () => {
    expect(normalizeScopePattern("\0src")).toBeNull();
    expect(normalizeScopePattern("src\\app.ts")).toBeNull();
    expect(normalizeScopePattern("/src/app.ts")).toBeNull();
    expect(normalizeScopePattern("!src")).toBeNull();
    expect(normalizeScopePattern("src/{a,b}")).toBeNull();
    expect(normalizeScopePattern("src//app.ts")).toBeNull();
    expect(normalizeScopePattern("src/")).not.toBeNull();
  });
});

describe("pattern matching", () => {
  it("separates a single star from a globstar", () => {
    expect(matchesScopePattern("src/*.ts", "src/app.ts")).toBe(true);
    expect(matchesScopePattern("src/*.ts", "src/nested/app.ts")).toBe(false);
    expect(matchesScopePattern("src/**/*.ts", "src/nested/deep/app.ts")).toBe(true);
    // `**/` is zero or more whole directories, so the direct child matches too.
    expect(matchesScopePattern("src/**/*.ts", "src/app.ts")).toBe(true);
  });

  it("keeps a directory pattern to that directory and nothing above it", () => {
    expect(matchesScopePattern("src/**", "src")).toBe(true);
    expect(matchesScopePattern("src/**", "src/app.ts")).toBe(true);
    expect(matchesScopePattern("src/**", "src/a/b.ts")).toBe(true);
    expect(matchesScopePattern("src/**", "src-gen/app.ts")).toBe(false);
    expect(matchesScopePattern("src/**", "other/src/app.ts")).toBe(false);
  });

  it("does not treat a pattern as a regular expression", () => {
    expect(matchesScopePattern("src/app.ts", "src/appXts")).toBe(false);
    expect(matchesScopePattern("src/app.ts", "src/app.ts")).toBe(true);
    expect(matchesScopePattern("a.b", "a.b")).toBe(true);
    expect(matchesScopePattern("a.b", "axb")).toBe(false);
  });

  it("matches a question mark to exactly one non-separator character", () => {
    expect(matchesScopePattern("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchesScopePattern("src/?.ts", "src/ab.ts")).toBe(false);
    expect(matchesScopePattern("src/?.ts", "src//.ts")).toBe(false);
  });
});

describe("protected paths are protected whatever a plan says", () => {
  it("covers the framework's own control plane and the generated OpenCode configuration", () => {
    for (const path of [
      ".git/config",
      ".git",
      ".agentflow/features/F-001/session.json",
      ".opencode/agents/planner.md",
      ".opencode/plugins/evil.ts",
      "opencode.json",
      "opencode.jsonc",
      "agent-workflow.config.json",
      "agent-workflow.config.jsonc",
    ]) {
      expect(isProtectedWorkspacePath(path)).toBe(true);
    }
  });

  it("protects the root configuration only, because that is the one the framework reads", () => {
    // A file with the same name inside a package is ordinary project content: the kit reads one
    // configuration, from the repository root, and refusing to let a feature touch an unrelated
    // package's file would be a scope rule with no security value behind it.
    expect(isProtectedWorkspacePath("packages/app/agent-workflow.config.json")).toBe(false);
  });

  it("leaves ordinary project paths alone", () => {
    for (const path of ["src/app.ts", "agent-workflow.config.example.json", "docs/git.md", "src/git/config.ts", "src/app.gitignore"]) {
      expect(isProtectedWorkspacePath(path)).toBe(false);
    }
  });
});

describe("scope enforcement decides from observed changes, not from prose", () => {
  it("accepts a change set inside the approved set", () => {
    const seen: WorkspaceInspection = inspection({
      modified: ["src/app.ts"],
      added: ["src/nested/new.ts"],
      untracked: ["notes.md"],
    });

    const verdict = evaluateWorkspaceScope(seen, {
      approvedPatterns: ["src/**", "notes.md"],
    });

    expect(verdict.ok).toBe(true);
  });

  it("reports every category, including a deletion and a rename's old path", () => {
    // Nothing is approved here, so every category has to appear: a deletion is a change to an approved
    // path, and a rename that removes a file is as much a change as an edit to it.
    const seen = inspection({
      modified: ["docs/readme.md"],
      deleted: ["src/removed.ts"],
      renamed: [{ from: "src/old.ts", to: "other/new.ts" }],
      untracked: ["scratch.txt"],
    });

    const verdict = evaluateWorkspaceScope(seen, { approvedPatterns: [] });

    expect(verdict.ok).toBe(false);
    expect((verdict.ok ? undefined : verdict.unauthorized.map((entry) => entry.path))).toEqual([
      "docs/readme.md",
      "other/new.ts",
      "scratch.txt",
      "src/old.ts",
      "src/removed.ts",
    ]);
  });

  it("leaves an approved deletion and an approved rename alone, and still names the new path", () => {
    const seen = inspection({
      deleted: ["src/removed.ts"],
      renamed: [{ from: "src/old.ts", to: "src/new.ts" }],
    });

    expect(evaluateWorkspaceScope(seen, { approvedPatterns: ["src/**"] })).toEqual({
      ok: true,
      approved: ["src/new.ts", "src/old.ts", "src/removed.ts"],
    });

    const moved = evaluateWorkspaceScope(seen, { approvedPatterns: ["src/removed.ts", "src/old.ts"] });

    expect((moved.ok ? undefined : moved.unauthorized.map((entry) => entry.path))).toEqual(["src/new.ts"]);
  });

  it("treats a protected path as unauthorized even when the plan approves it", () => {
    const seen = inspection({ modified: [".opencode/agents/planner.md"] });

    const verdict = evaluateWorkspaceScope(seen, { approvedPatterns: [".opencode/**"] });

    expect(verdict.ok).toBe(false);
    expect((verdict.ok ? undefined : verdict.unauthorized[0]?.path)).toBe(".opencode/agents/planner.md");
  });

  it("separates what Git tracks from what the baseline contained", () => {
    const seen = inspection({
      modified: ["src/app.ts"],
      added: ["src/staged.ts"],
      untracked: ["src/new.ts"],
    });

    const verdict = evaluateWorkspaceScope(seen, { approvedPatterns: [] });

    // A staged add is in the index, so it is a tracked path, and it did not exist at the baseline, so
    // there is nothing to restore it from. Reading "tracked" as "restore from the baseline" would try to
    // restore a file that was never there.
    expect((verdict.ok ? undefined : verdict.unauthorized)).toEqual([
      { path: "src/app.ts", category: "tracked", existedAtBaseline: true },
      { path: "src/new.ts", category: "untracked", existedAtBaseline: false },
      { path: "src/staged.ts", category: "tracked", existedAtBaseline: false },
    ]);
  });

  it("reports a path once even when two categories name it", () => {
    const seen = inspection({ modified: ["src/app.ts"], untracked: ["src/app.ts"] });

    const verdict = evaluateWorkspaceScope(seen, { approvedPatterns: [] });

    expect((verdict.ok ? undefined : verdict.unauthorized)).toHaveLength(1);
  });

  it("treats an empty change set as empty", () => {
    expect(isEmptyWorkspaceChanges(inspectionOf({}).changes)).toBe(true);
    expect(isEmptyWorkspaceChanges(inspectionOf({ untracked: ["a"] }).changes)).toBe(false);
    expect(isEmptyWorkspaceChanges(inspectionOf({ renamed: [{ from: "a", to: "b" }] }).changes)).toBe(false);
  });
});

describe("integrity decides whether the workspace is still the approved starting point", () => {
  it("accepts an unstaged change at the approved commit", () => {
    const seen = inspection({ modified: ["src/app.ts"] });

    expect(evaluateWorkspaceIntegrity(seen, baseline())).toEqual({ ok: true });
  });

  it("refuses a commit made inside the workspace, and names both commits", () => {
    const seen = inspection({}, { headCommit: OTHER_COMMIT });

    const verdict = evaluateWorkspaceIntegrity(seen, baseline());

    expect(verdict.ok).toBe(false);
    expect((verdict.ok ? undefined : verdict.reason)).toContain(COMMIT);
    expect((verdict.ok ? undefined : verdict.reason)).toContain(OTHER_COMMIT);
  });

  it("refuses a staged path, because staging is the step before a commit", () => {
    const seen = inspection({ modified: ["src/app.ts"] }, { stagedPaths: ["src/app.ts"] });

    const verdict = evaluateWorkspaceIntegrity(seen, baseline());

    expect(verdict.ok).toBe(false);
    expect((verdict.ok ? undefined : verdict.reason)).toContain("src/app.ts");
  });

  it("refuses even when the head is back where it started, if something is still staged", () => {
    const seen = inspection({}, { stagedPaths: ["src/app.ts"] });

    expect(evaluateWorkspaceIntegrity(seen, baseline()).ok).toBe(false);
  });
});

describe("a baseline is a claim about a specific commit in a specific repository", () => {
  it("accepts a well-formed baseline, and returns it as it will be persisted", () => {
    const verdict = validateWorkspaceBaseline(baseline());

    expect(verdict.ok).toBe(true);
    expect(verdict.ok ? verdict.baseline : null).toEqual(baseline());
  });

  it("refuses an abbreviated commit, because a prefix is not a commit", () => {
    const verdict = validateWorkspaceBaseline(baseline({ baselineCommit: "abc1234" }));

    expect(verdict.ok).toBe(false);
    expect((verdict.ok ? undefined : verdict.message)).toContain("40-character");
  });

  it("refuses an uppercase commit hash", () => {
    expect(validateWorkspaceBaseline(baseline({ baselineCommit: COMMIT.toUpperCase() })).ok).toBe(false);
  });

  it("refuses a baseline for a different repository than the one it is validated against", () => {
    // The validator takes the expected root because a baseline is only meaningful against the
    // repository it was captured from.
    expect(validateWorkspaceBaseline(baseline(), "/other")).toEqual({
      ok: false,
      message: "A workspace baseline must name the repository it was captured from: it names /repo, and the caller is running in /other.",
    });
  });

  it("refuses a workspace id that is not a safe directory name", () => {
    for (const workspaceId of ["../escape", "a/b", "", "ws 1", ".git"]) {
      expect(validateWorkspaceBaseline(baseline({ workspaceId })).ok).toBe(false);
    }
  });

  it("refuses a baseline stamped before anything was written", () => {
    // The approval is itself a mutation, so its revision is at least one; a zero is a record of a
    // moment the workflow cannot be in.
    expect(validateWorkspaceBaseline(baseline({ approvedRevision: 0 })).ok).toBe(false);
    expect(validateWorkspaceBaseline(baseline({ approvedRevision: 1 })).ok).toBe(true);
  });

  it("refuses a capture timestamp that is not a timestamp", () => {
    expect(validateWorkspaceBaseline(baseline({ capturedAt: "yesterday" })).ok).toBe(false);
  });

  it("refuses a repository root that is relative", () => {
    expect(validateWorkspaceBaseline(baseline({ repositoryRoot: "repo" })).ok).toBe(false);
  });
});

describe("change sets are compared structurally", () => {
  it("keeps a rename as a pair rather than two independent edits", () => {
    const changes: WorkspaceChanges = {
      modified: [],
      added: [],
      deleted: [],
      renamed: [{ from: "src/a.ts", to: "src/b.ts" }],
      untracked: [],
    };

    // A rename inside the approved set is not two unapproved edits, and `git status` would report it
    // as one entry, so the policy has to see the same thing the diff shows.
    expect(evaluateWorkspaceScope(inspectionOf(changes), { approvedPatterns: ["src/**"] }).ok).toBe(true);
  });

  it("refuses a rename whose destination is outside the approved set", () => {
    const changes: WorkspaceChanges = {
      modified: [],
      added: [],
      deleted: [],
      renamed: [{ from: "src/a.ts", to: "docs/a.ts" }],
      untracked: [],
    };

    // The approved set is the source directory only, so the destination is the unauthorized half.
    const verdict = evaluateWorkspaceScope(inspectionOf(changes), { approvedPatterns: ["src/a.ts"] });

    expect((verdict.ok ? undefined : verdict.unauthorized.map((entry) => entry.path))).toEqual(["docs/a.ts"]);
  });
});
