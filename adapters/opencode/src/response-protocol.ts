import {
  validateStageExecutionResult,
  type StageExecutionRequest,
  type StageExecutionResult,
} from "@agent-workflow-kit/orchestration";
import { OpenCodeAdapterError } from "./errors.js";

/** Bumped only when the wire shape changes incompatibly. */
export const RESPONSE_PROTOCOL_VERSION = 1;

export const STRUCTURED_RESPONSE_FIELDS = [
  "outcome",
  "featureId",
  "stage",
  "artifacts",
  "findings",
  "evidence",
  "summary",
] as const;

export const STRUCTURED_RESPONSE_FIELD_LIST = STRUCTURED_RESPONSE_FIELDS.join(", ");

/**
 * Keys an agent may never put in its response. The orchestrator rejects them as well; the adapter
 * checks first so the failure names the actual problem instead of reporting malformed JSON.
 */
export const WORKFLOW_CONTROL_FIELDS: readonly string[] = [
  "event",
  "events",
  "workflowEvent",
  "nextState",
  "state",
  "transition",
  "transitions",
  "machine",
  "session",
  "revision",
  "commit",
  "push",
  "approve",
  "approvals",
];

const FENCE_OPEN_JSON = /```json[ \t]*\r?\n/gu;
const FENCE_OPEN_BARE = /```[ \t]*\r?\n/gu;
const FENCE_CLOSE = "```";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts the structured payload from an agent's response text.
 *
 * A ```json fence is preferred; a bare fence is accepted as a fallback because a model that
 * omits the language tag is still producing a machine-readable payload, and the strict field
 * validation downstream is what actually keeps the contract honest.
 *
 * The span runs from the opening fence to the **last** closing fence, so a payload that
 * legitimately contains Markdown fences - a final summary quoting a shell command, for example -
 * still parses. Anything that is not exactly one parsable JSON object is refused: prose, a
 * completion sentence, or several competing payloads are never scraped for meaning.
 */
export function extractStructuredResponse(text: string): Record<string, unknown> {
  const opens = [...text.matchAll(FENCE_OPEN_JSON)];
  const opening = opens[0] ?? [...text.matchAll(FENCE_OPEN_BARE)][0];

  if (opening === undefined) {
    throw new OpenCodeAdapterError(
      "malformed_response",
      "The OpenCode response contains no fenced JSON block. The response protocol requires exactly one fenced JSON block.",
    );
  }

  const start = opening.index + opening[0].length;
  const close = text.lastIndexOf(FENCE_CLOSE);

  if (close < start) {
    throw new OpenCodeAdapterError(
      "malformed_response",
      "The fenced JSON block in the OpenCode response is not closed.",
    );
  }

  const body = text.slice(start, close).trim();

  let parsed: unknown;

  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new OpenCodeAdapterError(
      "malformed_response",
      "The fenced JSON block in the OpenCode response is not valid JSON.",
      { cause: error },
    );
  }

  if (!isPlainObject(parsed)) {
    throw new OpenCodeAdapterError(
      "malformed_response",
      "The structured response must be a JSON object.",
    );
  }

  return parsed;
}

function assertRequiredFields(payload: Record<string, unknown>): void {
  for (const field of STRUCTURED_RESPONSE_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      throw new OpenCodeAdapterError(
        "malformed_response",
        `The structured response is missing the required field "${field}". Required fields: ${STRUCTURED_RESPONSE_FIELD_LIST}.`,
      );
    }
  }

  for (const field of WORKFLOW_CONTROL_FIELDS) {
    if (Object.hasOwn(payload, field)) {
      throw new OpenCodeAdapterError(
        "invalid_result",
        `The structured response carries the workflow control field "${field}". An agent may not choose a workflow transition, approve a gate, or report a session.`,
      );
    }
  }
}

/**
 * Turns an OpenCode response into a workflow result, or refuses it.
 *
 * The adapter validates before returning anything, and the orchestrator validates the same value
 * again afterwards. The second pass is deliberate: the adapter's check is the first line, not the
 * only one.
 */
export function parseStageResponse(
  text: string,
  request: StageExecutionRequest,
): StageExecutionResult {
  const payload = extractStructuredResponse(text);

  assertRequiredFields(payload);

  const validation = validateStageExecutionResult(payload, request);

  if (!validation.ok) {
    throw new OpenCodeAdapterError(
      "invalid_result",
      `The OpenCode structured response was rejected (${validation.code}): ${validation.message}`,
    );
  }

  return validation.result;
}
