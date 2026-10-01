import { WorkflowState } from "@agent-workflow-kit/core";
import {
  FIX_PROTECTED_PATTERNS,
  MAX_FIX_ATTEMPTS,
  type FixerInputContract,
} from "@agent-workflow-kit/orchestration";

/**
 * A fixer input contract as the framework builds one, for tests that need the fixer to be handed
 * something real rather than `null`.
 *
 * The values are chosen to be recognisable in a prompt assertion: the failing criterion is `AC-2`,
 * the failing check is `lint`, and the approved scope is a single source file. A test that asserts on
 * rendered output can then say what it expects to find and a reader can tell at a glance whether the
 * assertion is about the contract or about something else.
 */
export function testFixerContract(
  overrides: Partial<FixerInputContract> = {},
): FixerInputContract {
  return {
    featureId: "F-001",
    failedStage: WorkflowState.StaticVerification,
    failedVerification: "static",
    target: {
      requirementId: "FR-2",
      acceptanceCriterionId: "AC-2",
      description: "The parser rejects malformed input instead of coercing it.",
    },
    deterministicEvidence: null,
    securityEvidence: null,
    failureReason:
      'The deterministic lint check "lint" is failed (pnpm lint). The formatter disagrees with two files.',
    suspectedFiles: ["src/parser.ts"],
    approvedScope: ["src/**"],
    revision: 7,
    implementationFingerprint: "a1b2c3d4",
    attempt: 1,
    maxAttempts: MAX_FIX_ATTEMPTS,
    protectedPaths: [...FIX_PROTECTED_PATTERNS],
    ...overrides,
  };
}
