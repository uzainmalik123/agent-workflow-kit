import { STAGE_DEFINITIONS, type WorkStage } from "@agent-workflow-kit/orchestration";
import type {
  OpenCodeRawResult,
  OpenCodeTransport,
  OpenCodeTransportRequest,
} from "@agent-workflow-kit/opencode";

/**
 * A fake OpenCode transport for tests.
 *
 * Nothing here spawns a process, calls a model, or touches the network. The adapter hands the
 * transport the stage it is about to run, so a test can answer per stage, and every default
 * response is derived from that stage's own output slots - which means the defaults satisfy the
 * workflow contract without the test hand-writing thirteen payloads.
 */

export interface FakeOpenCodeBehavior {
  /** Raw response text, used verbatim. */
  readonly text?: string;
  /** Structured payload, wrapped in a fenced JSON block for you. */
  readonly payload?: unknown;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
  /** Resolve after this delay, which is how a slow run is simulated. */
  readonly delayMs?: number;
  /**
   * Progress lines the fake relays through the request's callback while it runs, in order.
   *
   * This is the seam the progress tests need: the real transport relays the child's tool-use lines,
   * and a fake that could not emit any would leave the executor's forwarding untested.
   */
  readonly activity?: readonly string[];
  /** Answer under a different agent id, to prove a mismatched response is refused. */
  readonly agent?: string;
}

export function renderFencedJson(payload: unknown): string {
  return ["```json", JSON.stringify(payload, null, 2), "```"].join("\n");
}

export interface FakeRunIdentity {
  readonly featureId: string;
  readonly stage: WorkStage;
  readonly role: string;
  readonly fixReturnState: string | null;
}

function defaultArtifactContent(identity: FakeRunIdentity, name: string, kind: string): unknown {
  if (name === "final_summary") {
    return [
      `# Feature ${identity.featureId}`,
      "",
      "- objective: produced by the fake OpenCode transport",
      "- implemented changes: none, this is a test double",
      "- files changed: unknown",
      "- reviews completed: none",
      "- verification results: inconclusive, no command execution in this milestone",
      "- fixes made: none",
      "- security result: not applicable",
      "- skipped checks: project commands, Git",
      "- known limitations: fake transport",
      "- outstanding risks: none recorded",
      "",
    ].join("\n");
  }

  if (name === "fixes") {
    return {
      featureId: identity.featureId,
      fixedFor: identity.fixReturnState,
      summary: `Repaired the finding raised in ${identity.fixReturnState ?? "an unknown state"}.`,
      changes: [],
    };
  }

  if (kind === "section") {
    const kindByStage: Partial<Record<WorkStage, string>> = {
      static_verification: "static",
      test_verification: "test",
      runtime_verification: "runtime",
    };

    return {
      featureId: identity.featureId,
      stage: identity.stage,
      kind: kindByStage[identity.stage] ?? "static",
      results: [
        {
          requirementId: "REQ-1",
          acceptanceCriterionId: "AC-1",
          status: "inconclusive",
          note: "No command execution evidence is provided in this milestone.",
        },
      ],
    };
  }

  return {
    featureId: identity.featureId,
    stage: identity.stage,
    role: identity.role,
    note: `Produced by the fake OpenCode transport for artifact "${name}".`,
  };
}

export function defaultPayload(identity: FakeRunIdentity): Record<string, unknown> {
  return {
    outcome: "success",
    featureId: identity.featureId,
    stage: identity.stage,
    artifacts: STAGE_DEFINITIONS[identity.stage].outputs.map((spec) => ({
      name: spec.name,
      content: defaultArtifactContent(identity, spec.name, spec.kind),
    })),
    findings: [],
    evidence: [],
    summary: `Fake OpenCode result for ${identity.stage} on ${identity.featureId}.`,
  };
}

function identityOf(request: OpenCodeTransportRequest): FakeRunIdentity {
  return {
    featureId: request.featureId,
    stage: request.stage,
    role: request.role,
    fixReturnState: request.fixReturnState,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class FakeOpenCodeTransport implements OpenCodeTransport {
  readonly calls: OpenCodeTransportRequest[] = [];
  readonly #default: FakeOpenCodeBehavior | undefined;
  readonly #byStage = new Map<WorkStage, FakeOpenCodeBehavior>();
  readonly #byAgent = new Map<string, FakeOpenCodeBehavior>();

  constructor(defaultBehavior?: FakeOpenCodeBehavior) {
    this.#default = defaultBehavior;
  }

  /** Targets one stage, which is the only way to separate the three stages that share `verifier`. */
  configure(stage: WorkStage, behavior: FakeOpenCodeBehavior): this {
    this.#byStage.set(stage, behavior);
    return this;
  }

  /** Targets every stage that runs as one agent. */
  configureAgent(agent: string, behavior: FakeOpenCodeBehavior): this {
    this.#byAgent.set(agent, behavior);
    return this;
  }

  reset(stage?: WorkStage): this {
    if (stage === undefined) {
      this.#byStage.clear();
      this.#byAgent.clear();
    } else {
      this.#byStage.delete(stage);
    }

    return this;
  }

  get callCount(): number {
    return this.calls.length;
  }

  get stages(): readonly WorkStage[] {
    return this.calls.map((call) => call.stage);
  }

  get agents(): readonly string[] {
    return this.calls.map((call) => call.agent);
  }

  requestFor(stage: WorkStage): OpenCodeTransportRequest | undefined {
    return this.calls.find((call) => call.stage === stage);
  }

  lastRequest(): OpenCodeTransportRequest | undefined {
    return this.calls.at(-1);
  }

  async run(request: OpenCodeTransportRequest): Promise<OpenCodeRawResult> {
    this.calls.push(request);

    const behavior: FakeOpenCodeBehavior = {
      ...this.#default,
      ...this.#byAgent.get(request.agent),
      ...this.#byStage.get(request.stage),
    };

    if (behavior.activity !== undefined) {
      for (const line of behavior.activity) {
        request.onProgress?.({ type: "activity", stage: request.stage, line });
      }
    }

    if (behavior.delayMs !== undefined) {
      await sleep(behavior.delayMs);
    }

    if (behavior.error !== undefined) {
      throw behavior.error;
    }

    const text =
      behavior.text ??
      (behavior.payload === undefined
        ? renderFencedJson(defaultPayload(identityOf(request)))
        : renderFencedJson(behavior.payload));

    return {
      agent: behavior.agent ?? request.agent,
      exitCode: behavior.exitCode ?? 0,
      stdout: behavior.stdout ?? text,
      stderr: behavior.stderr ?? "",
      text: behavior.text ?? text,
    };
  }
}

export function createFakeOpenCodeTransport(
  defaultBehavior?: FakeOpenCodeBehavior,
): FakeOpenCodeTransport {
  return new FakeOpenCodeTransport(defaultBehavior);
}
