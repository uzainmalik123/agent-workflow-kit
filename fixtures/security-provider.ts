import {
  deriveSecurityStatus,
  PROVIDER_SECURITY_CHECKS,
  type SecurityCheckEvidence,
  type SecurityCheckId,
  type SecurityReviewEvidence,
  type SecurityReviewProvider,
  type SecurityReviewRequest,
  type SecurityReviewStatus,
} from "@agent-workflow-kit/orchestration";

/**
 * A security review provider for tests that are not about the security review.
 *
 * A workflow test that drives a feature all the way through the security review now needs real
 * evidence to do it, because that stage reached without a provider is refused rather than passed on the
 * reviewer's word. This provider answers every request with a passing record bound to that request,
 * which is the boring case every other test already assumed.
 *
 * `calls` is kept because "was the scan actually run for this stage, and on what tree" is a question a
 * workflow test legitimately asks, and a provider that recorded nothing could not answer it.
 */
export interface FakeSecurityProvider extends SecurityReviewProvider {
  readonly calls: readonly SecurityReviewRequest[];
}

const COLLECTED_AT = "2026-04-05T06:07:08.000Z";

/** A passing record, with every check the framework knows about already answered. */
export function passingSecurityReviewFor(
  request: SecurityReviewRequest,
  overrides: Partial<SecurityReviewEvidence> = {},
): SecurityReviewEvidence {
  const checks: SecurityCheckEvidence[] = PROVIDER_SECURITY_CHECKS.map((check) => ({
    check,
    result: "passed" as const,
    paths: [],
    reason: `The ${check} check found nothing in the added paths.`,
    authority: "provider" as const,
  }));

  return {
    schemaVersion: 1,
    featureId: request.featureId,
    stage: "security_review",
    status: "pass",
    revision: request.revision,
    workspaceFingerprint: request.workspaceFingerprint,
    projectRoot: request.projectRoot,
    workspaceId: request.workspaceId,
    approvedPatterns: [...request.approvedPatterns],
    changedPaths: [...request.changedPaths],
    checks,
    collectedAt: COLLECTED_AT,
    ...overrides,
  };
}

/** A record failing one named check, with the paths that check found. */
export function failedSecurityReviewFor(
  request: SecurityReviewRequest,
  check: SecurityCheckId,
  paths: readonly string[],
  reason: string,
): SecurityReviewEvidence {
  const checks: SecurityCheckEvidence[] = PROVIDER_SECURITY_CHECKS.map((id) =>
    id === check
      ? { check: id, result: "failed" as const, paths: [...paths], reason, authority: "provider" as const }
      : {
          check: id,
          result: "passed" as const,
          paths: [] as readonly string[],
          reason: `The ${id} check found nothing in the added paths.`,
          authority: "provider" as const,
        },
  );

  return {
    ...passingSecurityReviewFor(request),
    status: deriveSecurityStatus(checks),
    checks,
  };
}

export function createFakeSecurityProvider(
  answer: (request: SecurityReviewRequest) => SecurityReviewEvidence = (request) =>
    passingSecurityReviewFor(request),
): FakeSecurityProvider {
  const calls: SecurityReviewRequest[] = [];

  return {
    calls,
    review(request: SecurityReviewRequest): Promise<SecurityReviewEvidence> {
      calls.push(request);
      return Promise.resolve(answer(request));
    },
  };
}

/** Narrows a record to the status the framework would have derived from it. */
export function statusOf(checks: readonly SecurityCheckEvidence[]): SecurityReviewStatus {
  return deriveSecurityStatus(checks);
}
