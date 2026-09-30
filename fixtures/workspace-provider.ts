import { createHash } from "node:crypto";
import { join } from "node:path";
import type { WorkspaceBaseline } from "@agent-workflow-kit/core";
import type {
  BaselineCapture,
  BaselineCaptureOutcome,
  BaselineRefusalCode,
  EnforceScopeOutcome,
  EnforceScopeRequest,
  InspectWorkspaceOutcome,
  InspectWorkspaceRequest,
  OpenWorkspaceOutcome,
  OpenWorkspaceRequest,
  ProjectWorkspace,
  ProjectWorkspaceProvider,
  ScopeEnforcement,
  WorkspaceChanges,
  WorkspaceGitState,
  WorkspaceInspection,
  WorkspaceRefusalCode,
  WorkspaceUnauthorizedPath,
} from "@agent-workflow-kit/orchestration";

/**
 * An in-memory stand-in for the isolated-execution port.
 *
 * It exists for the tests that are about the workflow rather than about Git, and it is deliberately
 * transparent: every call is recorded, nothing is written to disk, and the values it reports are the
 * ones a test asked it to report. A double that quietly invented a clean scope check would let the
 * orchestration tests pass while the real adapter's guarantees went untested, so the only thing this
 * fakes is the mechanism, and it records the policy inputs it was handed rather than deciding on them.
 *
 * The Git-backed adapter is tested against real repositories in `tests/workspace-git.test.ts`. Between
 * the two, every guarantee is covered once by code that cannot lie about it.
 */
export interface FakeWorkspaceOptions {
  /**
   * Where a stage runs. A fixed path, or a function of the repository root, feature id, and baseline.
   * The default is a path inside the repository root, which is not what a real adapter does and is
   * fine for a test that only needs the orchestrator to have somewhere to point.
   */
  readonly workingDirectory?:
    | string
    | ((repositoryRoot: string, featureId: string, baseline: WorkspaceBaseline) => string);
  /** The change set every `inspect` reports. A function is called per inspection. */
  readonly changes?: Partial<WorkspaceChanges> | (() => Partial<WorkspaceChanges>);
  /** The Git state every `open` and `inspect` reports. */
  readonly gitState?: Partial<WorkspaceGitState>;
  /** What `captureBaseline` reports. A `code` makes it refuse with that reason. */
  readonly baseline?: Partial<BaselineCapture> & { readonly refusal?: BaselineRefusalCode };
  /** Makes `open` refuse with this code instead of returning a workspace. */
  readonly openRefusal?: WorkspaceRefusalCode | null;
  /** What `enforceScope` reports back after acting on the paths it was given. */
  readonly enforcement?: Partial<Omit<ScopeEnforcement, "enforcedAt">>;
}

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function defaultWorkingDirectory(
  repositoryRoot: string,
  featureId: string,
  baseline: WorkspaceBaseline,
): string {
  return join(repositoryRoot, ".agentflow", "test-workspaces", `${featureId}-${baseline.baselineCommit.slice(0, 8)}`);
}

/** A stable digest of a change set, so two inspections of the same tree agree. */
export function fingerprintOfChanges(changes: WorkspaceChanges): string {
  const canonical = JSON.stringify({
    added: [...changes.added].sort(),
    deleted: [...changes.deleted].sort(),
    modified: [...changes.modified].sort(),
    renamed: changes.renamed
      .map((rename) => [rename.from, rename.to])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    untracked: [...changes.untracked].sort(),
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class FakeWorkspaceProvider implements ProjectWorkspaceProvider {
  readonly opens: OpenWorkspaceRequest[] = [];
  readonly inspections: ProjectWorkspace[] = [];
  readonly enforcements: EnforceScopeRequest[] = [];
  readonly closed: ProjectWorkspace[] = [];

  readonly #options: FakeWorkspaceOptions;

  constructor(options: FakeWorkspaceOptions = {}) {
    this.#options = options;
  }

  captureBaseline(repositoryRoot: string): Promise<BaselineCaptureOutcome> {
    const configured = this.#options.baseline ?? {};
    const capture: BaselineCapture = {
      repositoryRoot,
      headCommit: configured.headCommit ?? "1".repeat(40),
      clean: configured.clean ?? true,
      stagedPaths: configured.stagedPaths ?? [],
      unstagedPaths: configured.unstagedPaths ?? [],
      capturedAt: configured.capturedAt ?? FIXED_TIMESTAMP,
    };

    if (configured.refusal !== undefined) {
      return Promise.resolve({
        ok: false,
        code: configured.refusal,
        message: `The fake workspace provider refused the baseline with "${configured.refusal}".`,
        capture,
      });
    }

    return Promise.resolve({ ok: true, capture });
  }

  open(request: OpenWorkspaceRequest): Promise<OpenWorkspaceOutcome> {
    this.opens.push(request);

    if (this.#options.openRefusal !== undefined && this.#options.openRefusal !== null) {
      return Promise.resolve({
        ok: false,
        code: this.#options.openRefusal,
        message: `The fake workspace provider refused to open with "${this.#options.openRefusal}".`,
      });
    }

    const configured =
      typeof this.#options.workingDirectory === "function"
        ? this.#options.workingDirectory(request.baseline.repositoryRoot, request.featureId, request.baseline)
        : (this.#options.workingDirectory ??
          defaultWorkingDirectory(request.baseline.repositoryRoot, request.featureId, request.baseline));

    return Promise.resolve({
      ok: true,
      workspace: {
        workspaceId: request.baseline.workspaceId,
        repositoryRoot: request.baseline.repositoryRoot,
        workingDirectory: configured,
        baseline: request.baseline,
        access: { level: request.access },
        gitState: this.#gitState(request.baseline.baselineCommit),
      },
    });
  }

  inspect(request: InspectWorkspaceRequest): Promise<InspectWorkspaceOutcome> {
    this.inspections.push(request.workspace);
    const changes = this.#changes();

    return Promise.resolve({
      ok: true,
      inspection: {
        workspaceId: request.workspace.workspaceId,
        changes,
        // A pre-approval workspace has no approved commit, so its Git state is whatever the fake is
        // configured with rather than something derived from a baseline that does not exist.
        gitState: this.#gitState(request.workspace.baseline?.baselineCommit),
        fingerprint: fingerprintOfChanges(changes),
        collectedAt: FIXED_TIMESTAMP,
      },
    });
  }

  enforceScope(request: EnforceScopeRequest): Promise<EnforceScopeOutcome> {
    this.enforcements.push(request);

    const configured = this.#options.enforcement ?? {};
    const restorable = request.paths.filter(
      (entry) =>
        !configured.unsafePaths?.includes(entry.path) &&
        (entry.category === "tracked" ? entry.existedAtBaseline : true),
    );

    return Promise.resolve({
      ok: true,
      enforcement: {
        restored: configured.restored ?? restorable.filter((entry) => entry.category === "tracked").map((entry) => entry.path),
        removed: configured.removed ?? restorable.filter((entry) => entry.category === "untracked").map((entry) => entry.path),
        unsafePaths: configured.unsafePaths ?? [],
        enforcementErrors: configured.enforcementErrors ?? [],
        enforcedAt: FIXED_TIMESTAMP,
      },
    });
  }

  close(workspace: ProjectWorkspace): Promise<void> {
    this.closed.push(workspace);
    return Promise.resolve();
  }

  #changes(): WorkspaceChanges {
    const configured =
      typeof this.#options.changes === "function" ? this.#options.changes() : (this.#options.changes ?? {});

    return {
      modified: configured.modified ?? [],
      added: configured.added ?? [],
      deleted: configured.deleted ?? [],
      renamed: configured.renamed ?? [],
      untracked: configured.untracked ?? [],
    };
  }

  #gitState(headCommit: string | undefined): WorkspaceGitState {
    return {
      headCommit: this.#options.gitState?.headCommit ?? headCommit ?? "0".repeat(40),
      stagedPaths: this.#options.gitState?.stagedPaths ?? [],
    };
  }
}

export function createFakeWorkspaceProvider(options: FakeWorkspaceOptions = {}): FakeWorkspaceProvider {
  return new FakeWorkspaceProvider(options);
}

export function unauthorized(paths: readonly string[]): WorkspaceUnauthorizedPath[] {
  return paths.map((path) => ({
    path,
    category: "untracked" as const,
    existedAtBaseline: false,
  }));
}

export function inspectionOf(
  changes: Partial<WorkspaceChanges>,
  gitState?: Partial<WorkspaceGitState>,
): WorkspaceInspection {
  const full: WorkspaceChanges = {
    modified: changes.modified ?? [],
    added: changes.added ?? [],
    deleted: changes.deleted ?? [],
    renamed: changes.renamed ?? [],
    untracked: changes.untracked ?? [],
  };

  return {
    workspaceId: "test-workspace",
    changes: full,
    gitState: { headCommit: "1".repeat(40), stagedPaths: [], ...gitState },
    fingerprint: fingerprintOfChanges(full),
    collectedAt: FIXED_TIMESTAMP,
  };
}
