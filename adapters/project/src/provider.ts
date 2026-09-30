import { resolve } from "node:path";
import type {
  CapabilityDetection,
  VerificationCapability,
  VerificationCommandEvidence,
  VerificationEvidenceBundle,
  VerificationProvider,
  VerificationRequest,
  VerificationStage,
} from "@agent-workflow-kit/orchestration";
import { capabilitiesForStage, implicitScriptHook, type PlannedVerificationCommand } from "./commands.js";
import { loadProjectVerificationConfig, type ProjectVerificationConfig } from "./config.js";
import { isDiscoveryRefusal, ProjectAdapterError } from "./errors.js";
import {
  buildBundle,
  capabilityDetectionsFor,
  commandEvidence,
  absentCheck,
} from "./evidence.js";
import { fingerprintControlPlane, fingerprintImplementation } from "./fingerprint.js";
import {
  discoverProject,
  unmeasurableCapabilities,
  type ProjectProfile,
} from "./profile.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  runChildProcess,
  type ChildProcessOutcome,
  type ChildProcessRequest,
} from "./process.js";

/**
 * The fingerprint recorded when the project could not be measured at all. A real digest would be a
 * claim about files that were never read, and an all-zero digest is visibly not one.
 */
const UNMEASURED_FINGERPRINT = "0".repeat(64);

/**
 * The project verification provider.
 *
 * It answers one question per call: for this workflow stage, what did the project's own commands
 * actually do? The order of the path is the trust model:
 *
 * ```
 * discovery (reads files, executes nothing)
 *   -> configuration (validated, never written)
 *   -> command plan (framework-selected commands only)
 *   -> run (shell: false, one executable and an argument array)
 *   -> evidence (exit status is authoritative)
 * ```
 *
 * A model never appears in it. Nothing here reads a stage response, and a stage response cannot add,
 * remove, or reorder a command: the plan is a function of the repository and the configuration file.
 */
export interface ProjectVerificationProviderOptions {
  /**
   * The project the commands may run in. Defaults to `process.cwd()`. Commands are pinned to this
   * directory or to a subdirectory of it that the configuration declared.
   */
  readonly projectRoot?: string;
  /** Injectable millisecond clock, so evidence timestamps are reproducible. */
  readonly clock?: () => number;
  /** Per-command deadline. A command that exceeds it is reported as `timed_out`, never as a pass. */
  readonly timeoutMs?: number;
  /**
   * Substitutable runner. The default is the repository's single process runner; a test may supply
   * another one to prove that discovery and planning run no process at all.
   */
  readonly run?: (request: ChildProcessRequest) => Promise<ChildProcessOutcome>;
  /**
   * Where a request's commands may run, when the framework opened an isolated worktree for it.
   *
   * The default is this provider's own `projectRoot`, which is what a pre-approval stage gets. A kit
   * that opens isolated worktrees supplies a resolver, and it is trusted wiring rather than request
   * data: it is chosen when the provider is constructed, and every request is still checked against
   * its answer, so a request can only ever run in the directory the resolver named. That is the whole
   * point of keeping the check per call -- the resolver says which tree is allowed, and this provider
   * still refuses anything else.
   */
  readonly resolveRunRoot?: (request: VerificationRequest) => string;
}

function detectionFor(
  detections: readonly CapabilityDetection[],
  capability: VerificationCapability,
): CapabilityDetection {
  return (
    detections.find((detection) => detection.capability === capability) ?? {
      capability,
      status: "unavailable",
      reason: "script_absent",
      script: null,
      detail: "The project profile does not classify this capability.",
    }
  );
}

/**
 * Why a command that exists and is well formed still may not run, or `null` when it may.
 *
 * The order is the order of how much is known. An implicit hook is a property of the selected script
 * name, so it is decided before anything about the environment: a project with a `prelint` script has
 * a blocked lint check whether or not its dependencies happen to be installed, and reporting a missing
 * `node_modules` first would blame the environment for a decision the manifest made.
 *
 * The hook rule does not care where the command came from. Being written down explicitly in
 * `agent-workflow.config.json` says which command to run, not which scripts the manifest will run
 * alongside it, so a configured `npm run lint` is blocked by a `prelint` script for the same reason a
 * detected `pnpm run lint` is. The way to state a check whose script has neighbouring hooks is to name
 * the tool itself, which involves no package manager and therefore implies nothing.
 *
 * The two environment preconditions belong to detection rather than to execution, and only to it. A
 * command the project declared as a bare tool names its own executable and does not go through a
 * package manager, so neither a missing manager nor a missing `node_modules` says anything about
 * whether it can run; blocking it would replace a real result with a guess. A detected command is a
 * script invoked through a manager, so both preconditions are facts about it, and reporting them is
 * more useful than running a command that cannot work.
 */
function startupBlock(
  profile: ProjectProfile,
  command: PlannedVerificationCommand,
): { readonly reason: string; readonly detail: string } | null {
  if (command.script !== null) {
    const hook = implicitScriptHook(command.script, profile.scripts);

    if (hook !== null) {
      return {
        reason: "implicit_script_hook",
        detail: `"${command.executable} ${command.args.join(" ")}" would also execute the "${hook}" script, because ${command.executable} runs the pre and post script of a selected script name. Running it would execute a script the framework never selected, so the check is blocked. Declare the tool itself in agent-workflow.config.json to run it directly instead.`,
      };
    }
  }

  if (command.source === "configured") {
    // A configured command that names no script involves no package manager, so there is nothing left
    // to check: no manager to identify, no adjacent script name to imply, and no dependency install
    // that would have to exist for a bare tool to be on the path.
    return null;
  }

  const manager = profile.packageManager;

  if (manager === null) {
    return {
      reason: "package_manager_unknown",
      detail: "The project has no recognised lockfile, so the script that would run this command cannot be determined.",
    };
  }

  if (!profile.dependenciesInstalled) {
    return {
      reason: "dependency_missing",
      detail: "The project's dependencies are not installed, so a script invoked through the package manager cannot run. Nothing is installed to change that.",
    };
  }

  return null;
}

/**
 * A check whose command exists and is well formed but could not be started. It keeps the command's
 * identity, so the report says which check was blocked and why, and never pretends it ran.
 */
function blockedCheck(input: {
  readonly detection: CapabilityDetection;
  readonly command: PlannedVerificationCommand;
  readonly reason: string;
  readonly detail: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly collectedAt: string;
  readonly projectRoot: string;
  readonly kind: VerificationStage;
}): VerificationCommandEvidence {
  const base = absentCheck({
    id: input.command.id,
    capability: input.command.capability,
    kind: input.kind,
    label: input.command.label,
    status: "blocked",
    reason: input.reason,
    detail: input.detail,
    revision: input.revision,
    fingerprint: input.fingerprint,
    collectedAt: input.collectedAt,
    projectRoot: input.projectRoot,
  });

  return {
    ...base,
    // The capability's own status is the profile's classification, which is unchanged by the block;
    // the check's status is what the block is.
    capabilityStatus: input.detection.status,
    status: "blocked",
    executable: input.command.executable,
    args: input.command.args,
    cwd: input.command.cwd,
    script: input.command.script,
  };
}

export class ProjectVerificationProvider implements VerificationProvider {
  readonly #root: string;
  readonly #clock: () => number;
  readonly #timeoutMs: number;
  readonly #run: (request: ChildProcessRequest) => Promise<ChildProcessOutcome>;
  readonly #resolveRunRoot: (request: VerificationRequest) => string;
  // Discovery and configuration are cached per root, not per provider. The same provider instance
  // collects for an isolated worktree and for the repository it was configured with, and a profile
  // read from one of those directories says nothing about the other.
  #cache: {
    readonly root: string;
    readonly profile: ProjectProfile;
    readonly config: ProjectVerificationConfig;
  } | null = null;

  constructor(options: ProjectVerificationProviderOptions = {}) {
    this.#root = resolve(options.projectRoot ?? process.cwd());
    this.#resolveRunRoot = options.resolveRunRoot ?? (() => this.#root);
    this.#clock = options.clock ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#run =
      options.run ??
      // The provider's clock reaches the runner so one collection has one timeline: a check's
      // `startedAt` and the bundle's `collectedAt` are read from the same source, and a test that
      // injects a clock gets a fully reproducible record.
      ((request) => runChildProcess(request, { clock: this.#clock }));
  }

  get projectRoot(): string {
    return this.#root;
  }

  /** The profile from the last collection, for a caller that wants to report it. */
  get profile(): ProjectProfile | null {
    return this.#cache?.profile ?? null;
  }

  /** The configuration the last collection loaded, which is null when the project declared none. */
  get config(): ProjectVerificationConfig | null {
    return this.#cache?.config ?? null;
  }

  async collect(request: VerificationRequest): Promise<VerificationEvidenceBundle> {
    // The request's root is data the orchestrator supplies; this provider verifies it agrees with the
    // directory its wiring named for this request and otherwise refuses, so a request cannot redirect
    // a command into a tree the kit did not open.
    const root = resolve(this.#resolveRunRoot(request));

    if (resolve(request.projectRoot) !== root) {
      throw new ProjectAdapterError(
        "command_invalid",
        `The verification request asked for project root "${request.projectRoot}" but this provider runs in "${root}".`,
      );
    }

    const collectedAt = new Date(this.#clock()).toISOString();

    let profile: ProjectProfile;
    let config: ProjectVerificationConfig;

    try {
      profile = await discoverProject(root);
      config = await loadProjectVerificationConfig(root);
      this.#cache = { root, profile, config };
    } catch (error) {
      if (!isDiscoveryRefusal(error)) {
        throw error;
      }

      // A project that cannot be inspected is a blocked verification with an explicit reason, not a
      // crash and not a pass. Nothing was executed to get here.
      const detail = `The project could not be inspected (${error.code}): ${error.message}`;

      return buildBundle({
        verification: request.verification,
        revision: request.revision,
        fingerprint: UNMEASURED_FINGERPRINT,
        // Nothing ran, so there is no second measurement to take: the one pair that is always
        // consistent is a tree that was not measured against itself. Reporting an unmeasured tree as
        // changed would blame the project for a fingerprint the framework never produced.
        workspaceAfter: UNMEASURED_FINGERPRINT,
        // The control plane was never measured either, for the same reason, and the same unmeasured
        // digest on both sides is the consistent answer rather than a claim that nothing changed.
        controlPlaneBefore: UNMEASURED_FINGERPRINT,
        controlPlaneAfter: UNMEASURED_FINGERPRINT,
        collectedAt,
        projectRoot: root,
        workspaceId: request.workspaceId,
        project: {
          root: root,
          commands: [],
          notes: [detail],
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
          capabilities: unmeasurableCapabilities(detail),
        },
        checks: [
          absentCheck({
            id: "discovery",
            capability: capabilitiesForStage(request.verification)[0] ?? "runtime",
            kind: request.verification,
            label: "Project discovery",
            status: "blocked",
            reason: error.code,
            detail,
            revision: request.revision,
            fingerprint: UNMEASURED_FINGERPRINT,
            collectedAt,
            projectRoot: root,
          }),
        ],
      });
    }

    // The tree is measured on both sides of the run. A verification command is repository-defined
    // code and repository-defined code writes files, so a fingerprint taken only beforehand describes
    // a tree the run may itself have replaced. The second measurement is taken after the last command
    // has finished, and any difference is a failure the verifier cannot argue with.
    const fingerprint = (await fingerprintImplementation(root)).hash;
    // The control plane is bracketed the same way. `.agentflow/` and `.opencode/` are outside the
    // implementation fingerprint on purpose, so this is the only measurement that notices a command
    // rewriting the session it is running inside or the agent file the next stage is about to load.
    const controlPlaneBefore = (await fingerprintControlPlane(root)).hash;
    const checks = await this.#runStage(
      request.verification,
      request.revision,
      fingerprint,
      collectedAt,
      root,
      profile,
      config,
      request.signal ?? null,
    );
    const workspaceAfter = (await fingerprintImplementation(root)).hash;
    const controlPlaneAfter = (await fingerprintControlPlane(root)).hash;

    return buildBundle({
      verification: request.verification,
      revision: request.revision,
      fingerprint,
      workspaceAfter,
      controlPlaneBefore,
      controlPlaneAfter,
      collectedAt,
      projectRoot: root,
      workspaceId: request.workspaceId,
      project: profile,
      checks,
    });
  }

  async #runStage(
    stage: VerificationStage,
    revision: number,
    fingerprint: string,
    collectedAt: string,
    root: string,
    profile: ProjectProfile,
    config: ProjectVerificationConfig,
    signal: AbortSignal | null,
  ): Promise<readonly VerificationCommandEvidence[]> {
    const capabilities = capabilitiesForStage(stage);
    const detections = capabilityDetectionsFor(profile, capabilities);
    const configured = config[stage];
    const detected = profile.commands.filter((command) => command.stage === stage);
    const checks: VerificationCommandEvidence[] = [];
    const covered = new Set<VerificationCapability>();

    for (const command of configured) {
      const detection = detectionFor(detections, command.capability);
      covered.add(command.capability);
      const block = startupBlock(profile, command);

      if (block !== null) {
        checks.push(
          blockedCheck({
            detection,
            command,
            reason: block.reason,
            detail: block.detail,
            revision,
            fingerprint,
            collectedAt,
            projectRoot: root,
            kind: stage,
          }),
        );
        continue;
      }

      checks.push(
        commandEvidence({
          command,
          outcome: await this.#execute(command.executable, command.args, command.cwd, signal),
          capabilityStatus: detection.status,
          revision,
          fingerprint,
        }),
      );
    }

    for (const command of detected) {
      if (configured.length > 0 && covered.has(command.capability)) {
        // A configured command replaces detection for the capability it covers, so the same check is
        // never run twice from two sources.
        continue;
      }

      const detection = detectionFor(detections, command.capability);
      covered.add(command.capability);
      const block = startupBlock(profile, command);

      if (block !== null) {
        checks.push(
          blockedCheck({
            detection,
            command,
            reason: block.reason,
            detail: block.detail,
            revision,
            fingerprint,
            collectedAt,
            projectRoot: root,
            kind: stage,
          }),
        );
        continue;
      }

      checks.push(
        commandEvidence({
          command,
          outcome: await this.#execute(command.executable, command.args, command.cwd, signal),
          capabilityStatus: detection.status,
          revision,
          fingerprint,
        }),
      );
    }

    for (const capability of capabilities) {
      if (covered.has(capability)) {
        continue;
      }

      const detection = detectionFor(detections, capability);

      checks.push(
        absentCheck({
          id: capability,
          capability,
          kind: stage,
          label: detection.capability,
          status: detection.status,
          // The capability's own reason, verbatim: "unsupported" and "blocked" have to stay
          // distinguishable here, because one is a fact about the project and the other is a
          // statement that something could not be run.
          reason: detection.reason,
          detail: detection.detail,
          revision,
          fingerprint,
          collectedAt,
          projectRoot: root,
        }),
      );
    }

    return checks;
  }

  #execute(
    executable: string,
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | null,
  ): Promise<ChildProcessOutcome> {
    return this.#run({
      executable,
      args,
      cwd,
      timeoutMs: this.#timeoutMs,
      signal,
    });
  }
}

export function createProjectVerificationProvider(
  options: ProjectVerificationProviderOptions = {},
): ProjectVerificationProvider {
  return new ProjectVerificationProvider(options);
}
