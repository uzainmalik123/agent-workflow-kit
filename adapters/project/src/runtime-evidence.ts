import type {
  RuntimeCheckEvidence,
  RuntimeVerificationResult,
  VerificationCommandEvidence,
} from "@agent-workflow-kit/orchestration";

/**
 * From a runtime result to the one check record the workflow reads.
 *
 * The runtime provider is deliberately given its own vocabulary — `RuntimeCheckEvidence` carries an
 * expected status, an actual status, and whether a body fragment was found, which a lint exit code has
 * no room for. This function is where that becomes the shared record, and it is the only place the two
 * are allowed to meet.
 *
 * Two decisions are load-bearing here.
 *
 * A runtime check reports `executable` but no exit code. The command in the evidence is the application
 * the framework started, which a reader needs in order to reproduce the run, but the check itself is a
 * request and a response: `GET /health` returned 503. Attributing the HTTP status to the application's
 * exit code would describe a process that nobody asked to exit and never did.
 *
 * A runtime check's expected status, actual status, and body verdict do not survive into this record,
 * and that is worth knowing rather than discovering. The shared record has one `detail` sentence and
 * one bounded excerpt, and both are filled with the fact that explains the failure — "returned status
 * 503, the configured criterion is status 200" is what an artifact and a fixer actually read. A caller
 * that needs the statuses as values calls the runtime provider directly and reads its own evidence
 * type, rather than parsing this record back into them.
 *
 * The exit status of the *stage* comes from the runtime result's own status, not from re-deriving it
 * from these checks. The provider already weighed a check that could not run against one that ran and
 * was refused, and re-deciding that here would give the verdict two homes.
 */
export function runtimeCheckEvidence(input: {
  readonly check: RuntimeCheckEvidence;
  readonly result: RuntimeVerificationResult;
  readonly cwd: string;
  readonly revision: number;
  readonly fingerprint: string;
}): VerificationCommandEvidence {
  const { check, result } = input;
  const command = result.diagnostics.command;
  // A check that never ran has no command to attribute, and saying `executable: ""` would be a
  // command nobody wrote.
  const started = command !== null && check.reason !== "not_attempted";

  return {
    id: check.id,
    kind: "runtime",
    capability: "runtime",
    // A check that ran is applicable by definition: the project declared it and the framework
    // attempted it. One that never ran is not applicable, because nothing about the project's
    // support for it was ever established.
    capabilityStatus: started ? "applicable" : "not_applicable",
    label: `Runtime ${check.kind} check "${check.id}"`,
    executable: started ? command.executable : null,
    args: started ? command.args : [],
    cwd: input.cwd,
    script: started ? command.script : null,
    startedAt: result.diagnostics.process.startedAt,
    durationMs: check.durationMs,
    exitCode: null,
    signal: started ? result.diagnostics.process.signal : null,
    // The provider already put this on the shared scale, with the distinctions between a timeout, a
    // cancellation, and a refusal that a bare `failed` would lose. There is no second opinion here.
    status: check.status,
    reason: check.reason,
    detail: check.detail,
    // The check's own capture is what was examined, so it is what belongs in the excerpt. Putting the
    // application's stdout here instead would bury the one piece of output that explains this check.
    stdoutExcerpt: check.responseExcerpt,
    stderrExcerpt: started ? result.diagnostics.process.stderrExcerpt : "",
    truncated: check.truncated || result.diagnostics.process.outputTruncated,
    revision: input.revision,
    implementationFingerprint: input.fingerprint,
  };
}
