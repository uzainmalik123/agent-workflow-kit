import { resolve } from "node:path";
import type { CapabilityDetection, VerificationCapability } from "@agent-workflow-kit/orchestration";
import { isNodePackageManager, type NodePackageManager, type PlannedVerificationCommand } from "./commands.js";
import { ProjectAdapterError } from "./errors.js";
import {
  inspectPath,
  isDirectory,
  isFile,
  isRecord,
  parseJsonFile,
  readProjectFile,
  relativeToRoot,
} from "./fs-safe.js";
import { detectFrameworks, parseDeclaredPackageManager } from "./frameworks.js";
import { planNodeVerification } from "./node-adapter.js";

export const PROJECT_ECOSYSTEMS = ["node", "python", "rust", "java", "unknown"] as const;

export type ProjectEcosystem = (typeof PROJECT_ECOSYSTEMS)[number];

export const PROJECT_LANGUAGES = ["typescript", "javascript", "python", "rust", "java", "unknown"] as const;

export type ProjectLanguage = (typeof PROJECT_LANGUAGES)[number];

export const PROJECT_CAPABILITIES = ["lint", "typecheck", "test", "build", "runtime"] as const;

export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

/**
 * The deterministic facts discovery records about a repository.
 *
 * Every field is derived from the filesystem and from manifests, so two runs over an unchanged
 * repository produce identical profiles. Nothing here is inferred from source code, and nothing is
 * inferred from a model.
 */
export interface ProjectProfile {
  /** Absolute, and already checked not to be a symbolic link. */
  readonly root: string;
  readonly ecosystem: ProjectEcosystem;
  readonly language: ProjectLanguage;
  /** The manager whose script invocation would reproduce what the project already installed. */
  readonly packageManager: NodePackageManager | null;
  /** What the manifest's own `packageManager` or `devEngines` field claims, which may disagree. */
  readonly declaredPackageManager: NodePackageManager | null;
  /** Project-relative lockfile names that were found, sorted. */
  readonly lockfiles: readonly string[];
  readonly manifests: readonly string[];
  readonly configs: readonly string[];
  /** Package script names, sorted. */
  readonly scripts: readonly string[];
  readonly frameworks: readonly string[];
  readonly workspaces: boolean;
  readonly dependenciesInstalled: boolean;
  readonly capabilities: Readonly<Record<ProjectCapability, CapabilityDetection>>;
  /** The exact commands a static, test, or runtime stage would run, in execution order. */
  readonly commands: readonly PlannedVerificationCommand[];
  /** Deterministic statements about anything a reader would otherwise have to guess. */
  readonly notes: readonly string[];
}

/** The fixed filename tables discovery consults. Nothing else is looked for. */
const NODE_MANIFEST = "package.json";

interface LockfileDefinition {
  readonly file: string;
  readonly manager: NodePackageManager;
}

/**
 * Lockfile precedence, and it is a total order.
 *
 * `pnpm` wins, then `bun`, then `yarn`, then `npm`, so a repository that carries a stale lockfile
 * from a previous tool still resolves the same way every time. A `packageManager` field is recorded
 * as a fact and never overrides a lockfile: the field states an intention, the lockfile records what
 * actually installed the tree.
 */
export const NODE_LOCKFILES: readonly LockfileDefinition[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
];

const PYTHON_MARKERS: readonly string[] = [
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "uv.lock",
  "poetry.lock",
  "poetry.toml",
];

const RUST_MARKERS: readonly string[] = ["Cargo.toml"];

const JAVA_MARKERS: readonly string[] = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
];

/**
 * Tool configuration, as opposed to a manifest. Recorded so a profile says what kind of project this
 * is, and never used to decide a command: a project with an ESLint config but no `lint` script has no
 * lint command, because the framework does not invent one.
 */
const TOOL_CONFIGS: readonly string[] = [
  "jsconfig.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  "biome.json",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.js",
  "jest.config.ts",
  "playwright.config.ts",
  "cypress.config.ts",
  "turbo.json",
  "nx.json",
  "pnpm-workspace.yaml",
  ".prettierrc",
  ".prettierrc.json",
  "prettier.config.js",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".python-version",
  "rust-toolchain.toml",
  ".gitignore",
];

/**
 * The configs that make a project a TypeScript project.
 *
 * `jsconfig.json` is deliberately absent. It gives a JavaScript project editor and bundler settings,
 * so its presence says "JavaScript, configured" and not "TypeScript", and treating it as a TypeScript
 * config would give a plain JavaScript project a typecheck stage that cannot pass honestly.
 */
const TYPESCRIPT_CONFIGS: readonly string[] = ["tsconfig.json", "tsconfig.build.json"];

const DEPENDENCY_SECTIONS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function unsupportedCapabilities(
  capability: ProjectCapability,
  ecosystem: ProjectEcosystem,
): CapabilityDetection {
  return {
    capability,
    status: "unsupported",
    reason: "ecosystem_unsupported",
    script: null,
    detail:
      `The ${ecosystem} ecosystem has no adapter in this milestone, so no ${capability} command is ` +
      "inferred. Declare the command in the project configuration to have it verified.",
  };
}

function emptyCapabilities(): Record<ProjectCapability, CapabilityDetection> {
  return {
    lint: unsupportedCapabilities("lint", "unknown"),
    typecheck: unsupportedCapabilities("typecheck", "unknown"),
    test: unsupportedCapabilities("test", "unknown"),
    build: unsupportedCapabilities("build", "unknown"),
    runtime: {
      capability: "runtime",
      status: "unsupported",
      reason: "runtime_deferred",
      script: null,
      detail: "Runtime verification is owned by Reticle and is not implemented.",
    },
  };
}

/**
 * The capability set reported when the project could not be read at all.
 *
 * Every capability is `blocked` rather than `unsupported`: nothing is known about the project, so the
 * honest answer is that its commands could not be determined, and the detail line says why.
 */
export function unmeasurableCapabilities(
  detail: string,
): Record<ProjectCapability, CapabilityDetection> {
  return {
    lint: blockedCapability("lint", detail),
    typecheck: blockedCapability("typecheck", detail),
    test: blockedCapability("test", detail),
    build: blockedCapability("build", detail),
    runtime: blockedCapability("runtime", detail),
  };
}

function blockedCapability(capability: ProjectCapability, detail: string): CapabilityDetection {
  return { capability, status: "blocked", reason: "not_configured", script: null, detail };
}

interface NodeManifestFacts {
  readonly scripts: ReadonlySet<string>;
  readonly dependencies: ReadonlySet<string>;
  readonly declaredPackageManager: NodePackageManager | null;
}

async function readNodeManifest(root: string): Promise<{ facts: NodeManifestFacts } | null> {
  const path = resolve(root, NODE_MANIFEST);

  if (!(await isFile(path))) {
    return null;
  }

  const text = await readProjectFile(path, "The Node manifest");
  const parsed = parseJsonFile(text, path, "The Node manifest");

  if (!isRecord(parsed)) {
    throw new ProjectAdapterError("manifest_malformed", `The Node manifest at "${path}" is not an object.`);
  }

  const scriptsSection = parsed["scripts"];
  const scripts = new Set<string>();

  if (scriptsSection !== undefined) {
    if (!isRecord(scriptsSection)) {
      throw new ProjectAdapterError(
        "manifest_malformed",
        `The "scripts" field of "${path}" is not an object.`,
      );
    }

    for (const name of Object.keys(scriptsSection)) {
      if (typeof scriptsSection[name] === "string") {
        scripts.add(name);
      }
    }
  }

  const dependencies = new Set<string>();

  for (const section of DEPENDENCY_SECTIONS) {
    const value = parsed[section];

    if (isRecord(value)) {
      for (const name of Object.keys(value)) {
        dependencies.add(name);
      }
    }
  }

  const packageManagerField = parsed["packageManager"];
  const devEngines = parsed["devEngines"];
  let declared: string | null = typeof packageManagerField === "string" ? packageManagerField : null;

  if (declared === null && isRecord(devEngines) && isRecord(devEngines["packageManager"])) {
    const name = devEngines["packageManager"]["name"];
    declared = typeof name === "string" ? name : null;
  }

  return {
    facts: {
      scripts,
      dependencies,
      declaredPackageManager: parseDeclaredPackageManager(declared),
    },
  };
}

async function resolvePackageManager(
  root: string,
  declared: NodePackageManager | null,
  notes: string[],
): Promise<{ readonly manager: NodePackageManager | null; readonly lockfiles: readonly string[] }> {
  const found: LockfileDefinition[] = [];

  for (const definition of NODE_LOCKFILES) {
    if (await isFile(resolve(root, definition.file))) {
      found.push(definition);
    }
  }

  const lockfiles = found.map((definition) => definition.file).sort();
  const winner = found[0]?.manager ?? null;

  if (found.length > 1) {
    notes.push(
      `Several lockfiles are present (${lockfiles.join(", ")}). The precedence pnpm, bun, yarn, npm applies, so "${winner ?? "none"}" is used.`,
    );
  }

  if (winner === null && declared !== null) {
    notes.push(
      `No lockfile is present, so the package manager "${declared}" is taken from the manifest field.`,
    );

    return { manager: declared, lockfiles };
  }

  if (winner !== null && declared !== null && winner !== declared) {
    notes.push(
      `The manifest declares the package manager "${declared}" but "${winner}" is recorded in a lockfile. The lockfile wins, because it records what actually installed the tree.`,
    );
  }

  if (winner === null) {
    notes.push(
      "No lockfile and no package manager field are present, so no package manager command can be formed. Declare the verification commands in the project configuration instead.",
    );
  }

  return { manager: winner, lockfiles };
}

/**
 * Discovers a project.
 *
 * Deterministic by construction: a fixed list of filenames, a fixed precedence, a fixed script
 * candidate order, and no execution of anything. Two calls over the same tree return equal profiles.
 */
export async function discoverProject(root: string): Promise<ProjectProfile> {
  const rootPath = resolve(root);
  const inspected = await inspectPath(rootPath);

  if (inspected === undefined || inspected.kind !== "directory") {
    throw new ProjectAdapterError(
      "root_unavailable",
      `The project root "${rootPath}" is not a readable directory.`,
    );
  }

  const notes: string[] = [];
  const manifest = await readNodeManifest(rootPath);

  if (manifest === null) {
    return await discoverUnsupportedProject(rootPath, notes);
  }

  const present = new Set<string>();
  const configs: string[] = [];
  const lockfileCandidates = [...NODE_LOCKFILES.map((entry) => entry.file), ...PYTHON_MARKERS, ...RUST_MARKERS, ...JAVA_MARKERS];

  for (const name of [...TOOL_CONFIGS, ...lockfileCandidates]) {
    if (await isFile(resolve(rootPath, name))) {
      present.add(name);

      if (TOOL_CONFIGS.includes(name)) {
        configs.push(name);
      }
    }
  }

  const { manager, lockfiles } = await resolvePackageManager(
    rootPath,
    manifest.facts.declaredPackageManager,
    notes,
  );
  const isTypeScript =
    TYPESCRIPT_CONFIGS.some((name) => present.has(name)) || manifest.facts.dependencies.has("typescript");
  const plan = planNodeVerification({
    root: rootPath,
    scripts: manifest.facts.scripts,
    packageManager: manager,
    packageManagerReason:
      manager === null
        ? "No package manager could be determined, so no script invocation can be formed."
        : `The ${manager} package manager will run the script.`,
    isTypeScript,
  });
  const dependenciesInstalled = await isDirectory(resolve(rootPath, "node_modules"));

  if (!dependenciesInstalled) {
    notes.push(
      'The project has no "node_modules" directory, so dependency-backed commands are reported as blocked instead of installing anything.',
    );
  }

  const workspaceManifest = await isFile(resolve(rootPath, "pnpm-workspace.yaml"));

  return {
    root: rootPath,
    ecosystem: "node",
    language: isTypeScript ? "typescript" : "javascript",
    packageManager: manager,
    declaredPackageManager: manifest.facts.declaredPackageManager,
    lockfiles,
    manifests: [NODE_MANIFEST],
    configs: [...new Set(configs)].sort(),
    scripts: plan.scripts,
    frameworks: detectFrameworks(manifest.facts.dependencies, present),
    workspaces: workspaceManifest,
    dependenciesInstalled,
    capabilities: plan.capabilities,
    commands: plan.commands,
    notes,
  };
}

/**
 * A project this milestone has no adapter for.
 *
 * Python, Rust, and Java are recognised so the report can name them, and every capability is then
 * reported `unsupported` with the reason, rather than approximated from a file name. Only an explicit
 * project configuration makes one of them verifiable.
 */
async function discoverUnsupportedProject(root: string, notes: string[]): Promise<ProjectProfile> {
  const markers: ReadonlyArray<readonly [ProjectEcosystem, readonly string[]]> = [
    ["python", PYTHON_MARKERS],
    ["rust", RUST_MARKERS],
    ["java", JAVA_MARKERS],
  ];

  for (const [ecosystem, files] of markers) {
    const found: string[] = [];

    for (const file of files) {
      if (await isFile(resolve(root, file))) {
        found.push(file);
      }
    }

    if (found.length === 0) {
      continue;
    }

    notes.push(
      `A ${ecosystem} project was detected from ${found.join(", ")}. This milestone has no ${ecosystem} adapter, so every capability is unsupported until commands are declared in the project configuration.`,
    );

    return {
      root,
      ecosystem,
      // An ecosystem is a package manager's world; a language is what the source is written in, and
      // an unsupported ecosystem is not evidence about the language, so the language stays unknown.
      language: "unknown",
      packageManager: null,
      declaredPackageManager: null,
      lockfiles: [],
      manifests: found.sort(),
      configs: [],
      scripts: [],
      frameworks: [],
      workspaces: false,
      dependenciesInstalled: await isDirectory(resolve(root, "node_modules")),
      capabilities: {
        lint: unsupportedCapabilities("lint", ecosystem),
        typecheck: unsupportedCapabilities("typecheck", ecosystem),
        test: unsupportedCapabilities("test", ecosystem),
        build: unsupportedCapabilities("build", ecosystem),
        runtime: {
          capability: "runtime",
          status: "unsupported",
          reason: "runtime_deferred",
          script: null,
          detail: "Runtime verification is owned by Reticle and is not implemented.",
        },
      },
      commands: [],
      notes,
    };
  }

  notes.push(
    "No project manifest was recognized, so this directory is not a project this framework can verify.",
  );

  return {
    root,
    ecosystem: "unknown",
    language: "unknown",
    packageManager: null,
    declaredPackageManager: null,
    lockfiles: [],
    manifests: [],
    configs: [],
    scripts: [],
    frameworks: [],
    workspaces: false,
    dependenciesInstalled: false,
    capabilities: emptyCapabilities(),
    commands: [],
    notes,
  };
}

/** The capability record for a profile, in the fixed capability order. */
export function capabilityList(profile: ProjectProfile): readonly CapabilityDetection[] {
  return PROJECT_CAPABILITIES.map((capability) => profile.capabilities[capability]);
}

export { isNodePackageManager };
export type { VerificationCapability };
export { relativeToRoot };
