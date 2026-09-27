import type {
  CapabilityDetection,
  CapabilityStatus,
  ProjectProfileSummary,
  VerificationCapability,
  VerificationCheckStatus,
  VerificationCommandEvidence,
  VerificationEvidenceBundle,
  VerificationOutcome,
  VerificationStage,
} from "@agent-workflow-kit/orchestration";
import type { PlannedVerificationCommand } from "./commands.js";
import type { ChildProcessOutcome } from "./process.js";
import type { ProjectProfile } from "./profile.js";
import { PROJECT_CAPABILITIES } from "./profile.js";

/**
 * From a process result to a verification record.
 *
 * The status comes from the runner's own termination and exit code, and from nothing else. No
 * substring of the output is ever consulted: a command that prints "0 failing" and exits 3 is a
 * failure, and a command that prints "error: build failed" and exits 0 is a pass, because the exit
 * status is the fact and the prose is a comment about it.
 */
export function statusForOutcome(outcome: ChildProcessOutcome): VerificationCheckStatus {
  switch (outcome.termination) {
    case "exited":
      return outcome.exitCode === 0 ? "passed" : "failed";
    case "signalled":
      return "failed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    case "spawn_failed":
      return "blocked";
    case "output_truncated":
      return "failed";
  }
}

/**
 * A check that has no command to run, or whose command could not be started.
 *
 * The check's own status follows from the capability's, and the distinction is the whole point of the
 * record. A capability that is unsupported, not applicable, or simply absent produces a `skipped`
 * check, which is a stage that had nothing to do. A capability that is `blocked` produces a `blocked`
 * check, which is a stage that should have run something and could not, and a stage that should have
 * run something is not the same as a stage that did not.
 */
export function absentCheck(input: {
  readonly id: string;
  readonly capability: VerificationCapability;
  readonly kind: VerificationStage;
  readonly label: string;
  readonly status: CapabilityStatus;
  readonly reason: string;
  readonly detail: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly collectedAt: string;
  readonly projectRoot: string;
}): VerificationCommandEvidence {
  return {
    id: input.id,
    kind: input.kind,
    capability: input.capability,
    capabilityStatus: input.status,
    label: input.label,
    executable: null,
    args: [],
    cwd: input.projectRoot,
    script: null,
    startedAt: input.collectedAt,
    durationMs: 0,
    exitCode: null,
    signal: null,
    status: input.status === "blocked" ? "blocked" : "skipped",
    reason: input.reason,
    detail: input.detail,
    stdoutExcerpt: "",
    stderrExcerpt: "",
    truncated: false,
    revision: input.revision,
    implementationFingerprint: input.fingerprint,
  };
}

/**
 * The sentence a passed or failed check carries, built from the runner's own result.
 *
 * It is derived from the termination and the exit code and from nothing else, in the same way the
 * status is, so a check's explanation cannot disagree with its verdict. The command is quoted as it
 * was run, because "the lint check failed" is a much worse thing to debug than
 * "`pnpm run lint` exited 2".
 */
export function describeCommandOutcome(outcome: ChildProcessOutcome, command: PlannedVerificationCommand): string {
  const invocation = `${command.executable} ${command.args.join(" ")}`.trim();
  const duration = `${String(outcome.durationMs)}ms`;

  switch (outcome.termination) {
    case "exited":
      return `${invocation} exited ${String(outcome.exitCode)} after ${duration}.`;
    case "signalled":
      return `${invocation} was terminated by signal ${outcome.signal ?? "unknown"} after ${duration}.`;
    case "timed_out":
      return `${invocation} exceeded the ${duration} deadline and was killed.`;
    case "cancelled":
      return `${invocation} was cancelled before it finished.`;
    case "spawn_failed":
      return `${invocation} could not be started (${outcome.reason ?? "no reason recorded"}).`;
    case "output_truncated":
      return `${invocation} produced more output than this framework captures, which is treated as a failure rather than a pass.`;
  }
}

export function commandEvidence(input: {
  readonly command: PlannedVerificationCommand;
  readonly outcome: ChildProcessOutcome;
  readonly capabilityStatus: CapabilityStatus;
  readonly revision: number;
  readonly fingerprint: string;
}): VerificationCommandEvidence {
  const { command, outcome } = input;

  return {
    id: command.id,
    kind: command.stage,
    capability: command.capability,
    capabilityStatus: input.capabilityStatus,
    label: command.label,
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    script: command.script,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    status: statusForOutcome(outcome),
    reason: outcome.reason,
    detail: describeCommandOutcome(outcome, command),
    stdoutExcerpt: outcome.stdout.text,
    stderrExcerpt: outcome.stderr.text,
    truncated: outcome.stdout.truncated || outcome.stderr.truncated,
    revision: input.revision,
    implementationFingerprint: input.fingerprint,
  };
}

/**
 * The stage verdict, and it is a function of the checks and the workspace alone.
 *
 * Any check that did not pass makes the stage fail; a check that could not start makes it blocked;
 * and a stage with nothing but skipped checks is deferred. A stage whose applicable checks all passed
 * passes, with no weight given to how many there were: a project with one lint script and a project
 * with four are both verified when what they have passed.
 *
 * A workspace that changed while the commands ran is a failure regardless of every check's status,
 * including all of them passing. The checks described a tree the run itself replaced, so a pass would
 * be a statement about code that no longer exists, and a lint run that rewrote the source it was
 * checking is precisely the case this exists for.
 */
export function outcomeForChecks(
  checks: readonly VerificationCommandEvidence[],
  workspaceChanged = false,
): VerificationOutcome {
  if (workspaceChanged) {
    return "failed";
  }

  if (checks.length === 0) {
    return "deferred";
  }

  if (checks.every((check) => check.status === "skipped")) {
    return "deferred";
  }

  if (checks.some((check) => check.status === "blocked")) {
    return "blocked";
  }

  if (checks.some((check) => check.status !== "passed" && check.status !== "skipped")) {
    return "failed";
  }

  return "passed";
}

export function profileSummary(profile: ProjectProfile): ProjectProfileSummary {
  return {
    ecosystem: profile.ecosystem,
    language: profile.language,
    packageManager: profile.packageManager,
    declaredPackageManager: profile.declaredPackageManager,
    dependenciesInstalled: profile.dependenciesInstalled,
    frameworks: profile.frameworks,
    capabilities: PROJECT_CAPABILITIES.map((capability) => profile.capabilities[capability]),
  };
}

export function buildBundle(input: {
  readonly verification: VerificationStage;
  readonly revision: number;
  readonly fingerprint: string;
  readonly workspaceAfter: string;
  readonly collectedAt: string;
  readonly projectRoot: string;
  readonly project: ProjectProfile;
  readonly checks: readonly VerificationCommandEvidence[];
}): VerificationEvidenceBundle {
  // The bundle carries the fingerprint its commands saw, which is the measurement from before the run.
  // `changed` is derived here rather than accepted, so no caller can report an unchanged workspace
  // over two different digests.
  const changed = input.workspaceAfter !== input.fingerprint;

  return {
    verification: input.verification,
    outcome: outcomeForChecks(input.checks, changed),
    revision: input.revision,
    implementationFingerprint: input.fingerprint,
    workspace: { before: input.fingerprint, after: input.workspaceAfter, changed },
    collectedAt: input.collectedAt,
    projectRoot: input.projectRoot,
    project: profileSummary(input.project),
    checks: input.checks,
  };
}

/** Every capability this stage covers, classified, whether or not a command resulted. */
export function capabilityDetectionsFor(
  profile: ProjectProfile,
  capabilities: readonly VerificationCapability[],
): readonly CapabilityDetection[] {
  return capabilities.map((capability) => profile.capabilities[capability]);
}
