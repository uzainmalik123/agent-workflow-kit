import type { CapabilityDetection, VerificationCapability } from "@agent-workflow-kit/orchestration";
import {
  buildVerificationCommand,
  type NodePackageManager,
  type PlannedVerificationCommand,
} from "./commands.js";

/**
 * Script selection for a Node project.
 *
 * The candidate lists are ordered, and the first script that exists wins. They are deliberately
 * short: a name is a candidate because it is a convention that a human reviewing this file would
 * expect, not because it might match. A script that exists is never run just because it exists; it
 * has to be one of these, on a capability this stage owns.
 */
export const LINT_SCRIPTS: readonly string[] = ["lint"];

/**
 * `typecheck` is the spelling this framework uses; the rest are the alternatives a project may have
 * chosen instead. A plain JavaScript project has no entry here at all: it is recorded
 * `not_applicable` rather than being given a command nobody asked for.
 */
export const TYPECHECK_SCRIPTS: readonly string[] = ["typecheck", "types", "check-types", "check:types"];

export const BUILD_SCRIPTS: readonly string[] = ["build"];

/**
 * Test precedence, and why it avoids duplicate suites.
 *
 * `test` is the whole suite by convention, so when it exists it is the only command that runs: also
 * running `test:unit` would execute the same tests twice and double the wall clock for no extra
 * evidence. When `test` is absent, both halves run if both exist, because reporting only one half
 * would understate what was actually verified. `test:unit` before `test:integration` is the order
 * they appear in the evidence, not a preference.
 */
export const TEST_SCRIPTS: readonly string[] = ["test"];
export const TEST_FALLBACK_SCRIPTS: readonly string[] = ["test:unit", "test:integration"];

export interface NodeScriptSelection {
  readonly scripts: readonly string[];
  readonly capabilities: Readonly<Record<VerificationCapability, CapabilityDetection>>;
  readonly commands: readonly PlannedVerificationCommand[];
}

function detection(
  capability: VerificationCapability,
  status: CapabilityDetection["status"],
  reason: CapabilityDetection["reason"],
  script: string | null,
  detail: string,
): CapabilityDetection {
  return { capability, status, reason, script, detail };
}

/**
 * The whole Node verification plan: which capabilities this project has, and the exact commands that
 * would satisfy them.
 *
 * The plan is computed from the manifest and the lockfile and nothing else. There is no branch here
 * that runs a command to find out what a command does, no fallback that tries `npm` when `pnpm` is
 * absent, and no path that installs anything.
 */
export function planNodeVerification(input: {
  readonly root: string;
  readonly scripts: ReadonlySet<string>;
  readonly packageManager: NodePackageManager | null;
  readonly packageManagerReason: string;
  readonly isTypeScript: boolean;
}): NodeScriptSelection {
  const { root, scripts, packageManager, packageManagerReason, isTypeScript } = input;
  const unusable = packageManager === null;
  const lintScript = LINT_SCRIPTS.find((name) => scripts.has(name)) ?? null;
  const typecheckScript = isTypeScript
    ? (TYPECHECK_SCRIPTS.find((name) => scripts.has(name)) ?? null)
    : null;
  const buildScript = BUILD_SCRIPTS.find((name) => scripts.has(name)) ?? null;
  const wholeSuite = TEST_SCRIPTS.find((name) => scripts.has(name)) ?? null;
  const halves = TEST_FALLBACK_SCRIPTS.filter((name) => scripts.has(name));

  const capabilities: Record<VerificationCapability, CapabilityDetection> = {
    lint: unusable
      ? detection("lint", "blocked", "package_manager_unknown", lintScript, packageManagerReason)
      : lintScript === null
        ? detection("lint", "unavailable", "script_absent", null, 'The manifest declares no "lint" script.')
        : detection("lint", "applicable", "detected", lintScript, `The manifest declares a "${lintScript}" script.`),
    typecheck: !isTypeScript
      ? detection(
          "typecheck",
          "not_applicable",
          "language_without_typecheck",
          null,
          "The project declares no TypeScript configuration or dependency, so it has no typecheck stage.",
        )
      : unusable
        ? detection("typecheck", "blocked", "package_manager_unknown", typecheckScript, packageManagerReason)
        : typecheckScript === null
          ? detection(
              "typecheck",
              "unavailable",
              "script_absent",
              null,
              "The project is TypeScript but declares no typecheck script.",
            )
          : detection(
              "typecheck",
              "applicable",
              "detected",
              typecheckScript,
              `The manifest declares a "${typecheckScript}" script.`,
            ),
    test: unusable
      ? detection("test", "blocked", "package_manager_unknown", wholeSuite, packageManagerReason)
      : wholeSuite === null && halves.length === 0
        ? detection("test", "unavailable", "script_absent", null, "The manifest declares no test script.")
        : detection(
            "test",
            "applicable",
            "detected",
            wholeSuite ?? halves[0] ?? null,
            wholeSuite === null
              ? `The manifest declares ${halves.map((name) => `"${name}"`).join(" and ")}.`
              : 'The manifest declares a "test" script, which is the whole suite.',
          ),
    build: unusable
      ? detection("build", "blocked", "package_manager_unknown", buildScript, packageManagerReason)
      : buildScript === null
        ? detection("build", "unavailable", "script_absent", null, 'The manifest declares no "build" script.')
        : detection("build", "applicable", "detected", buildScript, `The manifest declares a "${buildScript}" script.`),
    runtime: detection(
      "runtime",
      "unsupported",
      "runtime_deferred",
      null,
      "A manifest cannot say how an application starts, and this framework never infers one, so no runtime command is planned from it. Declare the runtime command, the readiness condition, and the checks in agent-workflow.config.json.",
    ),
  };

  if (packageManager === null) {
    return { scripts: [...scripts].sort(), capabilities, commands: [] };
  }

  const commands: PlannedVerificationCommand[] = [];
  const add = (
    id: string,
    capability: VerificationCapability,
    stage: "static" | "test",
    label: string,
    script: string,
  ): void => {
    commands.push(
      buildVerificationCommand({
        id,
        capability,
        stage,
        label,
        executable: packageManager,
        args: ["run", script],
        cwd: root,
        script,
        source: "detected",
      }),
    );
  };

  if (lintScript !== null) {
    add("lint", "lint", "static", "Lint", lintScript);
  }

  if (typecheckScript !== null) {
    add("typecheck", "typecheck", "static", "Typecheck", typecheckScript);
  }

  if (buildScript !== null) {
    add("build", "build", "static", "Build", buildScript);
  }

  if (wholeSuite !== null) {
    add("test", "test", "test", "Tests", wholeSuite);
  } else {
    for (const half of halves) {
      add(half, "test", "test", half === "test:unit" ? "Unit tests" : "Integration tests", half);
    }
  }

  return { scripts: [...scripts].sort(), capabilities, commands };
}