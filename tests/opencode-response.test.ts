import { STAGE_DEFINITIONS, type StageExecutionRequest } from "@agent-workflow-kit/orchestration";
import {
  OpenCodeAdapterError,
  RESPONSE_PROTOCOL_VERSION,
  STRUCTURED_RESPONSE_FIELDS,
  STRUCTURED_RESPONSE_FIELD_LIST,
  WORKFLOW_CONTROL_FIELDS,
  isOpenCodeAdapterError,
  parseStageResponse,
} from "@agent-workflow-kit/opencode";
import { describe, expect, it } from "vitest";
import { testWorkspaceContext } from "../fixtures/workspace.js";

const created = "2026-04-05T06:07:08.000Z";

function requestFor(stage: StageExecutionRequest["stage"]): StageExecutionRequest {
  const definition = STAGE_DEFINITIONS[stage];

  return {
    feature: {
      featureId: "F-001",
      title: "Google OAuth / API",
      slug: "google-oauth-api",
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
    workspace: testWorkspaceContext(),
  };
}

function validPayload(
  stage: StageExecutionRequest["stage"] = "planning",
): Record<string, unknown> {
  const request = requestFor(stage);

  return {
    outcome: "success",
    featureId: request.feature.featureId,
    stage: request.stage,
    artifacts: request.outputs.map((spec) => ({
      name: spec.name,
      content: { featureId: request.feature.featureId, stage: request.stage },
    })),
    findings: [],
    evidence: [],
    summary: "The plan covers every requirement.",
  };
}

function fenced(payload: unknown): string {
  return ["```json", JSON.stringify(payload, null, 2), "```"].join("\n");
}

function parse(text: string, stage: StageExecutionRequest["stage"] = "planning") {
  return parseStageResponse(text, requestFor(stage));
}

describe("a valid structured response", () => {
  it("parses a fenced JSON payload", () => {
    expect(parse(fenced(validPayload()))).toMatchObject({
      outcome: "success",
      featureId: "F-001",
      stage: "planning",
      artifacts: [{ name: "plan" }],
      findings: [],
      evidence: [],
    });
  });

  it("parses a payload with surrounding prose", () => {
    const text = [
      "I reviewed the request and wrote the plan.",
      "",
      fenced(validPayload()),
      "",
      "Let me know if the scope should change.",
    ].join("\n");

    expect(parse(text).summary).toBe("The plan covers every requirement.");
  });

  it("ignores prose that tries to state an outcome", () => {
    const text = ["Everything is done and all tests pass.", "", fenced(validPayload())].join("\n");

    expect(parse(text).outcome).toBe("success");
  });

  it("parses a payload with no fence language tag", () => {
    const text = ["```", JSON.stringify(validPayload()), "```"].join("\n");

    expect(parse(text).featureId).toBe("F-001");
  });

  it("accepts an inconclusive result with a subset of the outputs", () => {
    const payload = { ...validPayload(), outcome: "inconclusive", artifacts: [] };

    expect(parse(fenced(payload))).toMatchObject({ outcome: "inconclusive", artifacts: [] });
  });

  it("accepts findings and evidence with the required shape", () => {
    const payload = {
      ...validPayload("code_review"),
      outcome: "needs_fix",
      findings: [
        {
          featureId: "F-001",
          severity: "error",
          message: "The refresh token flow never completes.",
          filePath: "src/auth.ts",
          line: 42,
        },
      ],
      evidence: [
        { kind: "static", description: "Types pass.", reference: "docs/evidence.md" },
      ],
    };

    expect(parse(fenced(payload), "code_review")).toMatchObject({
      outcome: "needs_fix",
      findings: [
        { featureId: "F-001", severity: "error", message: "The refresh token flow never completes." },
      ],
      evidence: [{ kind: "static", description: "Types pass." }],
    });
  });
});

describe("a response that is not machine readable", () => {
  it("rejects prose with no payload", () => {
    expect(() => parse("Done. The plan is written and everything passes.")).toThrow(
      OpenCodeAdapterError,
    );
  });

  it("rejects an empty response", () => {
    expect(() => parse("")).toThrow(OpenCodeAdapterError);
    expect(() => parse("   \n  ")).toThrow(OpenCodeAdapterError);
  });

  it("rejects a fence that is not closed", () => {
    expect(() => parse(["```json", JSON.stringify(validPayload())].join("\n"))).toThrow(
      OpenCodeAdapterError,
    );
  });

  it("rejects malformed JSON", () => {
    expect(() => parse(["```json", "{ outcome: success,", "```"].join("\n"))).toThrow(
      OpenCodeAdapterError,
    );
  });

  it("rejects a JSON array instead of an object", () => {
    expect(() => parse(["```json", "[]", "```"].join("\n"))).toThrow(OpenCodeAdapterError);
  });

  it("rejects a payload with no fence at all", () => {
    expect(() => parse(JSON.stringify(validPayload()))).toThrow(OpenCodeAdapterError);
  });
});

describe("a response with the wrong identity", () => {
  it("rejects another feature id", () => {
    expect(() => parse(fenced({ ...validPayload(), featureId: "F-999" }))).toThrow(
      /does not match the orchestrated feature/i,
    );
  });

  it("rejects another stage", () => {
    expect(() => parse(fenced({ ...validPayload(), stage: "code_review" }))).toThrow(/stage/i);
  });

  it("rejects a lowercase stage name", () => {
    expect(() => parse(fenced({ ...validPayload(), stage: "PLANNING" }))).toThrow(/stage/i);
  });
});

describe("a response with the wrong artifacts", () => {
  it("rejects an artifact the stage did not ask for", () => {
    const payload = { ...validPayload(), artifacts: [{ name: "code_review", content: {} }] };

    expect(() => parse(fenced(payload))).toThrow(/artifact/i);
  });

  it("rejects a missing artifact on a success", () => {
    const payload = { ...validPayload(), artifacts: [] };

    expect(() => parse(fenced(payload))).toThrow(OpenCodeAdapterError);
  });

  it("rejects a duplicate artifact", () => {
    const payload = {
      ...validPayload(),
      artifacts: [
        { name: "plan", content: {} },
        { name: "plan", content: {} },
      ],
    };

    expect(() => parse(fenced(payload))).toThrow(/artifact/i);
  });

  it("rejects an artifact with extra keys", () => {
    const payload = {
      ...validPayload(),
      artifacts: [{ name: "plan", content: {}, filename: "plan.json" }],
    };

    expect(() => parse(fenced(payload))).toThrow(/artifact/i);
  });

  it("rejects an artifact with no content", () => {
    const payload = { ...validPayload(), artifacts: [{ name: "plan" }] };

    expect(() => parse(fenced(payload))).toThrow(/artifact/i);
  });
});

describe("a response with missing fields", () => {
  it("rejects a response with no summary", () => {
    const payload = { ...validPayload() } as Record<string, unknown>;

    delete payload.summary;

    expect(() => parse(fenced(payload))).toThrow(/summary/i);
  });

  it("rejects a response with no findings field", () => {
    const payload = { ...validPayload() } as Record<string, unknown>;

    delete payload.findings;

    expect(() => parse(fenced(payload))).toThrow(OpenCodeAdapterError);
  });

  it("rejects a response with no outcome", () => {
    const payload = { ...validPayload() } as Record<string, unknown>;

    delete payload.outcome;

    expect(() => parse(fenced(payload))).toThrow(OpenCodeAdapterError);
  });

  it("rejects an empty summary", () => {
    expect(() => parse(fenced({ ...validPayload(), summary: "" }))).toThrow(/summary/i);
  });

  it("rejects an unknown outcome", () => {
    expect(() => parse(fenced({ ...validPayload(), outcome: "done" }))).toThrow(/outcome/i);
  });

  it("rejects needs_fix on a stage that is not fixable", () => {
    const payload = { ...validPayload(), outcome: "needs_fix" };

    expect(() => parse(fenced(payload))).toThrow(/needs_fix|fix/i);
  });

  it("rejects artifacts on a failed result", () => {
    const payload = { ...validPayload(), outcome: "failed" };

    expect(() => parse(fenced(payload))).toThrow(OpenCodeAdapterError);
  });

  it("rejects a finding for another feature", () => {
    const payload = {
      ...validPayload(),
      findings: [{ featureId: "F-999", severity: "error", message: "Broken." }],
    };

    expect(() => parse(fenced(payload))).toThrow(/finding/i);
  });

  it("rejects an unknown evidence kind", () => {
    const payload = {
      ...validPayload(),
      evidence: [{ kind: "vibes", description: "It feels right." }],
    };

    expect(() => parse(fenced(payload))).toThrow(/evidence/i);
  });
});

describe("a response that tries to control the workflow", () => {
  for (const field of WORKFLOW_CONTROL_FIELDS) {
    it(`rejects a top-level ${field} field`, () => {
      expect(() => parse(fenced({ ...validPayload(), [field]: "code_review" }))).toThrow(
        /field|control/i,
      );
    });
  }

  it("rejects a needs_fix transition disguised as prose-free data", () => {
    const payload = {
      ...validPayload(),
      outcome: "needs_fix",
      nextState: "fixing",
      findings: [
        { featureId: "F-001", severity: "error", message: "The scope reviewer will fix this." },
      ],
    };

    expect(() => parse(fenced(payload), "code_review")).toThrow(/field|control/i);
  });

  it("rejects an approval claim", () => {
    expect(() => parse(fenced({ ...validPayload(), approvals: ["plan"] }))).toThrow(
      /field|control/i,
    );
  });

  it("rejects a commit request", () => {
    expect(() => parse(fenced({ ...validPayload(), commit: "feat: oauth" }))).toThrow(
      /field|control/i,
    );
  });
});

describe("error reporting", () => {
  it("reports adapter errors with a machine-readable code", () => {
    try {
      parse(fenced({ ...validPayload(), featureId: "F-999" }));
      expect.unreachable("the parser should have rejected a foreign feature id");
    } catch (error) {
      expect(isOpenCodeAdapterError(error)).toBe(true);
      expect(error).toBeInstanceOf(OpenCodeAdapterError);
      expect((error as OpenCodeAdapterError).code).toBe("invalid_result");
    }
  });

  it("keeps the stage and feature in the failure message", () => {
    expect(() => parse(fenced({ ...validPayload(), featureId: "F-999" }))).toThrow(/F-001/);
  });
});

describe("the response protocol contract", () => {
  it("names the seven required fields in a fixed order", () => {
    expect(STRUCTURED_RESPONSE_FIELDS).toEqual([
      "outcome",
      "featureId",
      "stage",
      "artifacts",
      "findings",
      "evidence",
      "summary",
    ]);
  });

  it("renders the required field list for error messages", () => {
    expect(STRUCTURED_RESPONSE_FIELD_LIST).toBe(
      "outcome, featureId, stage, artifacts, findings, evidence, summary",
    );
  });

  it("carries a protocol version", () => {
    expect(RESPONSE_PROTOCOL_VERSION).toBe(1);
  });
});
