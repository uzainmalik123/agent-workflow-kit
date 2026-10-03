import type {
  FeaturePublisher,
  PublishCommitOutcome,
  PublishCommitRequest,
  PublishPushOutcome,
  PublishPushRequest,
  PublishRefusalCode,
} from "@agent-workflow-kit/orchestration";

/**
 * An in-memory stand-in for the publishing port.
 *
 * Like the fake workspace provider, it fakes the mechanism and nothing else: every request is recorded so
 * a test can assert exactly what the orchestration layer decided to hand to Git, and every answer is one
 * the test asked for. It does not evaluate the branch name, the commit message, or the paths, because the
 * real adapter's refusal codes are tested against real repositories in `tests/publishing-git.test.ts` —
 * a double that agreed with the orchestrator about what is publishable would let a policy bug pass.
 *
 * The commit is a deterministic synthetic object name derived from the request, so two runs of the same
 * test record the same commit and a test can write a `publish.json` that matches what it was told.
 */
export interface FakePublisherOptions {
  /** What `commitFeature` refuses with instead of committing. */
  readonly commitRefusal?: PublishRefusalCode | null;
  /** What `pushBranch` refuses with instead of pushing. */
  readonly pushRefusal?: PublishRefusalCode | null;
  /**
   * How many of the first pushes refuse before the fake starts accepting them.
   *
   * The retry case, in one option: a push that fails and a push that succeeds afterwards are two calls
   * to the same adapter, and a test that has to swap adapters between them is not testing the retry.
   */
  readonly failFirstPushes?: number;
  /** The commit `commitFeature` reports. Defaults to one derived from the request. */
  readonly commit?: string;
  /** The branch `pushBranch` reports having pushed, when the test wants a different name. */
  readonly branch?: string;
  /** Makes `commitFeature` throw instead of answering, for the orchestrator's unexpected-failure path. */
  readonly commitThrows?: Error | null;
}

const ZERO_COMMIT = "0".repeat(40);

export class FakeFeaturePublisher implements FeaturePublisher {
  readonly commits: PublishCommitRequest[] = [];
  readonly pushes: PublishPushRequest[] = [];

  readonly #options: FakePublisherOptions;

  constructor(options: FakePublisherOptions = {}) {
    this.#options = options;
  }

  commitFeature(request: PublishCommitRequest): Promise<PublishCommitOutcome> {
    this.commits.push(request);

    if (this.#options.commitThrows !== undefined && this.#options.commitThrows !== null) {
      return Promise.reject(this.#options.commitThrows);
    }

    if (this.#options.commitRefusal !== undefined && this.#options.commitRefusal !== null) {
      return Promise.resolve({
        ok: false,
        code: this.#options.commitRefusal,
        message: `The fake publisher refused to commit with "${this.#options.commitRefusal}".`,
      });
    }

    return Promise.resolve({
      ok: true,
      commit: this.#options.commit ?? commitFor(request),
      // A second commit for the same approval is the retry case, and the fake answers it as a reuse so a
      // test can assert the orchestration layer records one commit either way.
      reused: this.commits.length > 1,
    });
  }

  pushBranch(request: PublishPushRequest): Promise<PublishPushOutcome> {
    this.pushes.push(request);

    // A configured refusal code with no count refuses every push; with a count it refuses the first
    // `failFirstPushes` of them, which is how the retry case is expressed without swapping adapters.
    const configured = this.#options.pushRefusal ?? null;
    const refusals =
      this.#options.failFirstPushes ??
      (configured === null ? 0 : Number.POSITIVE_INFINITY);

    if (this.pushes.length <= refusals) {
      return Promise.resolve({
        ok: false,
        code: configured ?? "push_rejected",
        message: `The fake publisher refused to push with "${configured ?? "push_rejected"}".`,
      });
    }

    return Promise.resolve({
      ok: true,
      branch: this.#options.branch ?? request.branch,
      commit: request.commit,
      remote: request.remote,
    });
  }
}

export function createFakeFeaturePublisher(options: FakePublisherOptions = {}): FakeFeaturePublisher {
  return new FakeFeaturePublisher(options);
}

/**
 * A commit name that depends on everything a commit's identity depends on.
 *
 * Derived from the branch rather than from a counter so that a test can compute it before running, and
 * from the branch rather than from the paths so that a retry — which hands over the same branch — lands
 * on the same commit, exactly as a real one would.
 */
function commitFor(request: PublishCommitRequest): string {
  return branchDigest(request.branch);
}

/** A deterministic, full object name from any string. Not a real commit: tests only compare it. */
export function branchDigest(value: string): string {
  let digest = 0;

  for (const character of value) {
    digest = (digest * 31 + (character.codePointAt(0) ?? 0)) % (16 ** 10);
  }

  return `${digest.toString(16).padStart(10, "0")}${ZERO_COMMIT.slice(10)}`;
}