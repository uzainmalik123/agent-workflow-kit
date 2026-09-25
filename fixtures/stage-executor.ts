import {
  type ReviewFinding,
  type VerificationEvidence,
} from "@agent-workflow-kit/core";
import type { FeatureArtifactName } from "@agent-workflow-kit/persistence";
import type {
  StageArtifactOutput,
  StageExecutionRequest,
  StageExecutionResult,
  StageExecutor,
  StageOutcome,
} from "@agent-workflow-kit/orchestration";
import type { WorkStage } from "@agent-workflow-kit/orchestration";

export interface FakeStageBehavior {
  readonly outcome?: StageOutcome;
  readonly artifacts?: readonly StageArtifactOutput[];
  readonly findings?: readonly ReviewFinding[];
  readonly evidence?: readonly VerificationEvidence[];
  readonly summary?: string;
  readonly featureId?: string;
  readonly stage?: WorkStage;
  readonly raw?: unknown;
  readonly error?: Error;
  readonly after?: (request: StageExecutionRequest) => Promise<void> | void;
}

const evidenceKindByStage: Partial<Record<WorkStage, VerificationEvidence["kind"]>> = {
  static_verification: "static",
  test_verification: "test",
  runtime_verification: "runtime",
  security_review: "security",
};

export function findingFor(
  featureId: string,
  message: string,
  severity: ReviewFinding["severity"] = "error",
): ReviewFinding {
  return { featureId, severity, message };
}

function defaultContent(
  request: StageExecutionRequest,
  name: FeatureArtifactName,
): unknown {
  if (name === "final_summary") {
    return `# ${request.feature.title}\n\n- feature: ${request.feature.featureId}\n- completed stages: ${request.state}\n`;
  }

  if (name === "verification") {
    const kind = evidenceKindByStage[request.stage] ?? "static";

    return {
      featureId: request.feature.featureId,
      stage: request.stage,
      kind,
      results: [],
    };
  }

  return {
    featureId: request.feature.featureId,
    stage: request.stage,
    role: request.role,
    context: request.context.map((entry) => entry.name),
  };
}

export function defaultArtifactsFor(
  request: StageExecutionRequest,
): readonly StageArtifactOutput[] {
  return request.outputs.map((output) => ({
    name: output.name,
    content: defaultContent(request, output.name),
  }));
}

export class FakeStageExecutor implements StageExecutor {
  readonly calls: StageExecutionRequest[] = [];
  readonly #defaultBehavior: FakeStageBehavior;
  readonly #behaviors = new Map<WorkStage, FakeStageBehavior>();

  constructor(defaultBehavior: FakeStageBehavior = {}) {
    this.#defaultBehavior = defaultBehavior;
  }

  configure(stage: WorkStage, behavior: FakeStageBehavior): this {
    this.#behaviors.set(stage, behavior);
    return this;
  }

  reset(stage?: WorkStage): this {
    if (stage === undefined) {
      this.#behaviors.clear();
    } else {
      this.#behaviors.delete(stage);
    }

    return this;
  }

  get callCount(): number {
    return this.calls.length;
  }

  get executedStages(): readonly WorkStage[] {
    return this.calls.map((request) => request.stage);
  }

  requestFor(stage: WorkStage): StageExecutionRequest | undefined {
    return this.calls.find((request) => request.stage === stage);
  }

  async execute(request: StageExecutionRequest): Promise<StageExecutionResult> {
    this.calls.push(request);

    const behavior: FakeStageBehavior = {
      ...this.#defaultBehavior,
      ...this.#behaviors.get(request.stage),
    };

    if (behavior.after !== undefined) {
      await behavior.after(request);
    }

    if (behavior.error !== undefined) {
      throw behavior.error;
    }

    if (behavior.raw !== undefined) {
      return behavior.raw as StageExecutionResult;
    }

    const outcome = behavior.outcome ?? "success";

    return {
      outcome,
      featureId: behavior.featureId ?? request.feature.featureId,
      stage: behavior.stage ?? request.stage,
      artifacts: behavior.artifacts ?? defaultArtifactsFor(request),
      findings: behavior.findings ?? [],
      evidence: behavior.evidence ?? [],
      summary: behavior.summary ?? `Deterministic ${request.stage} result for ${request.feature.featureId}.`,
    };
  }
}

export function createFakeStageExecutor(
  defaultBehavior: FakeStageBehavior = {},
): FakeStageExecutor {
  return new FakeStageExecutor(defaultBehavior);
}
