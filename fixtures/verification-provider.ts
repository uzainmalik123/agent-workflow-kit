import type {
  VerificationEvidenceBundle,
  VerificationProvider,
  VerificationRequest,
} from "@agent-workflow-kit/orchestration";

/**
 * A verification provider for tests that are not about verification.
 *
 * A workflow test that drives a feature all the way through the three verification stages now needs
 * real evidence to do it, because a verification stage reached without a provider is refused rather
 * than passed on the executor's word. This provider answers every request with a passing bundle
 * bound to that request, which is the boring case every other test already assumed.
 *
 * `calls` is kept because "how many times did the framework actually run a command for this stage" is
 * a question a workflow test legitimately asks, and a provider that counted nothing could not answer
 * it.
 */
export interface FakeVerificationProvider extends VerificationProvider {
  readonly calls: readonly VerificationRequest[];
}

const FINGERPRINT = "f".repeat(64);

function profileSummary(): VerificationEvidenceBundle["project"] {
  return {
    ecosystem: "node",
    language: "typescript",
    packageManager: "pnpm",
    declaredPackageManager: "pnpm",
    dependenciesInstalled: true,
    frameworks: [],
    capabilities: [
      { capability: "lint", status: "unavailable", reason: "script_absent", script: null, detail: "Not measured." },
      {
        capability: "typecheck",
        status: "unavailable",
        reason: "script_absent",
        script: null,
        detail: "Not measured.",
      },
      { capability: "test", status: "unavailable", reason: "script_absent", script: null, detail: "Not measured." },
      { capability: "build", status: "unavailable", reason: "script_absent", script: null, detail: "Not measured." },
      {
        capability: "runtime",
        status: "unsupported",
        reason: "runtime_deferred",
        script: null,
        detail: "Runtime is deferred.",
      },
    ],
  };
}

/** A passing bundle bound to the request that asked for it. */
export function passingEvidenceFor(
  request: VerificationRequest,
  overrides: Partial<VerificationEvidenceBundle> = {},
): VerificationEvidenceBundle {
  return {
    verification: request.verification,
    outcome: "passed",
    revision: request.revision,
    implementationFingerprint: FINGERPRINT,
    workspace: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
    controlPlane: { before: FINGERPRINT, after: FINGERPRINT, changed: false },
    collectedAt: "2026-04-05T06:07:08.000Z",
    projectRoot: request.projectRoot,
    workspaceId: request.workspaceId,
    project: profileSummary(),
    checks: [],
    ...overrides,
  };
}

export function createFakeVerificationProvider(
  answer: (request: VerificationRequest) => VerificationEvidenceBundle = (request) =>
    passingEvidenceFor(request),
): FakeVerificationProvider {
  const calls: VerificationRequest[] = [];

  return {
    calls,
    collect(request: VerificationRequest): Promise<VerificationEvidenceBundle> {
      calls.push(request);
      return Promise.resolve(answer(request));
    },
  };
}
