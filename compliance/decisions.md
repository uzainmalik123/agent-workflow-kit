# Decision log

Last updated: 2026-10-08

Status values: **Proposed** (drafted, not yet confirmed by the owner), **Accepted**, **Rejected**, **Superseded**.

Everything below was drafted from `compliance/prd-issues.md` (its suggested winners and proposed readings) and from the Task E diagnosis. **Nothing here is Accepted until the owner changes its status.** Edit any entry you disagree with before running the compliance audit passes, and tell the audit agent: "Treat compliance/decisions.md as authoritative where an entry is Accepted."

Priority order used for tie-breaks (PRD §42): human approval, deterministic verification, evidence and approval freshness, workspace and configuration boundaries, safe publishing, smallest implementation, explicit extensions.

---

## D-1. The read and write profiles keep the `bash` tool declared, with every command denied except `pwd`

- **Status:** Accepted, conditional on Task G tests (condition 3 below)
- **Date:** 2026-10-08
- **Context:** OpenCode Zen's free tier returns `403 FreeTierError` when the selected agent's configuration removes the `bash` or `read` tool. Task E (19 probes) showed the rule fits every case; `glob` and `grep` are not required and denying `edit` is harmless. Both `agentflow-read` and `agentflow-write` denied shell, so both failed. PRD §2.5 and §10.5 said the profiles grant no agent shell execution.
- **Decision:** both profiles declare the shell tool with exactly these ordered rules, last match wins:
  1. shell, resource `*`, effect `deny`
  2. shell, resource `pwd`, effect `allow`

  No other shell allow rule exists in either profile.

- **Evidence (Task E2):**
  - Gate: the variant passes on `agentflow-read` and `agentflow-write` with `opencode/big-pickle`. An empty allowlist (`allow *` then `deny *`) fails the gate. `ask` passes but is rejected here (see trade-offs).
  - Model-free permission evaluator: `pwd` is allowed; `touch`, `sh -c 'echo x > f'`, `git init`, `cat /etc/passwd`, and `curl` are denied; webfetch is denied; read, glob, and grep are allowed in-project; an external directory is denied.
  - End to end: `pwd` ran; denied commands were rejected by OpenCode; no side-effect files were created and the scratch repo's git config was unchanged.
- **Conditions for keeping this decision:**
  1. The post-stage scope guard stays enabled as a second line of defense.
  2. A test parses the generated agent files and fails closed on malformed YAML, duplicate keys, missing rules, or a changed rule order. Task E showed malformed frontmatter silently yields an unrestricted agent.
  3. Compound and argument forms must evaluate to deny: `pwd; touch x`, `pwd && curl example.com`, `pwd | tee x`, `pwd > x`, `pwd $(touch x)`, backtick substitution, `pwd --version`, `FOO=1 pwd`. If any is allowed, this decision is withdrawn.
  4. The transport never passes an auto-approve flag (asserted by an argv test).
  5. PRD §2.5 and §10.5 are reworded to match this decision.
- **Why not `ask`:** it passes the gate and is safe only because `opencode run` auto-rejects in non-interactive mode. One stray auto-approve flag would allow shell commands. A deny rule has no such dependency. Interactive TUI behavior under `ask` was not tested.
- **Trade-off:** before this change the agent had no shell at all. Now the shell is present and blocked by rules, so a bug in OpenCode's permission enforcement could become a real exposure. Mitigation: the conditions above, plus keeping the scope guard on.
- **Not verified:** the server-side logic of the Zen gate (no payload captured; inferred from behavior), and a model-driven read attempt on a path outside the project. The gate has changed several times and may change again.
- **Fallback:** if the gate changes or this approach stops working, do not weaken the profiles. Use a provider with your own API key through `--model provider/model`. Free Zen is best-effort.

## D-2. Two physical profiles stay the core contract (prd-issues C-1)

- **Status:** Proposed
- **Decision:** PRD §10.5's exactly-two-profiles rule is the core contract. §37.6's variable mapping applies to future adapters only.
- **Basis:** security boundary, priority 4. Related: R-084, R-133, R-327.

## D-3. Evidence binding follows §27.5 (prd-issues C-2)

- **Status:** Proposed
- **Decision:** evidence is bound to session and revision, the SHA-256 fingerprint, exact command identity where applicable, fixer-history constraints, and the current final-gate state. Runtime evidence is invalidated by later source changes (§14.8).
- **Basis:** §27.5 is the superset, priority 3. Related: R-111, R-282, R-149, R-177.

## D-4. Determinism has a narrow, testable meaning (C-3, V-1, V-2)

- **Status:** Proposed
- **Decision:** with a scripted agent stub, the state-transition sequence, artifact key structure, evidence bindings, and gate outcomes are identical across two runs. Free-text model fields are excluded. Commit determinism means the same SHA given fixed author, committer date, message, and tree.
- **Related:** R-213, R-199.

## D-5. Plugin policy decides how to block, never whether (C-4)

- **Status:** Proposed
- **Decision:** §10.7's "according to the installed policy" may choose the blocking mechanism. Repository plugin execution is always prevented (§27.2, §10.6).
- **Related:** R-095, R-097, R-281.

## D-6. The stage-to-profile map is enumerated (C-5)

- **Status:** Proposed. **Needs the owner to confirm the table.**
- **Decision:** the implementation documents which stage uses which profile (§28.1). Any stage that mutates files binds to `agentflow-write`. Review, verification, summary, and grill bind to `agentflow-read`.
- **Open question:** the PRD never lists the full table. Confirm it against the code and write it into the architecture doc. Related: R-085, R-087, R-288.

## D-7. The freeze baseline is §36; §37 items are non-gating (C-6)

- **Status:** Proposed
- **Related:** R-215, R-317, R-320 to R-329.

## D-8. Documentation shows the install path that actually works (C-7)

- **Status:** Proposed
- **Decision:** until P6 is done, the quick start says build from source. No `npm install` instructions for the framework's own packages (§25.9). OpenCode V2 is a stated prerequisite (verified `opencode v2.0.24`), and V1 is rejected by the capability probe.
- **Related:** R-266, R-273.

## D-9. Plugin directory rejection rule (V-4)

- **Status:** Proposed. **Needs the owner to approve the extension list.**
- **Decision:** a directory under the four plugin paths is rejected if it contains files with executable intent (`.js`, `.ts`, `.mjs`, `.cjs`, executables, symlinks). Empty directories and text files pass. Test both sides.

## D-10. Package-manager mutation verbs are denied (V-10)

- **Status:** Proposed. **Needs the owner to approve the verb list per package manager.**
- **Decision:** no agent-controlled or verification-stage command may resolve to an install or mutating lifecycle verb (`install`, `add`, `update`, `remove`, `link`, script-hook `exec`). A denylist test covers each verb per supported package manager.

## D-11. Other vague requirements: accept the proposed testable readings

- **Status:** Proposed
- **Accept as proposed:** V-5 (missing runtime config yields `inconclusive` with a `deferred` reason), V-6 (all CLI commands finish without stdin, 5s watchdog), V-8 (stage context allowlist with stripping of undeclared keys), V-11 (approval is SHA-256 digest equality over summary, final-gate result, fingerprint, revision, feature id).
- **Defer as process items, not tests:** V-3, V-7, V-9, V-12.

## D-12. Real-model end-to-end runs are opt-in, not part of `pnpm verify`

- **Status:** Proposed
- **Decision:** the P4 real-OpenCode harness runs as a separate script (for example `pnpm e2e:real`) with a pinned OpenCode version and model, and saves raw transcripts. `pnpm verify` stays free of live-model calls (R-241).

## D-13. Plan-review findings are resolved by the human at the plan approval gate

- **Status:** Accepted (option b of Task I)
- **Context:** Task I proved that a `plan_review` `needs_fix` can never be repaired: the fixer has no authority over the plan, the plan is digest-locked before approval, and the fixer's scope is derived from the plan under review. Every path ends in `feature_failed` after up to 5 wasted attempts.
- **Decision:** a `needs_fix` outcome from `plan_review` does not enter the fixer. The feature advances to `AwaitingPlanApproval` with the review stored as part of the approved artifact bytes (it is already one of the three digests approval freezes). The CLI shows the findings at the gate. Approving a plan with unresolved findings requires an explicit acknowledgement flag. An `agentflow abandon <id>` command lets the human end a feature that should not proceed.
- **Not changed:** the state machine, the fixer's authority, scope derivation, and the digest lock. The fixer still handles code-stage failures only. Core transitions that list Plan Review as a legal fix-return state remain, unused in practice.
- **Rejected:** letting the fixer edit the plan (option c). It erodes the guarantee that the human approves text no agent authored.
- **Follow-up (optional):** a bounded replanning loop (option a) needs its own versioned decision (PRD §38.3, R-263).

## D-14. `expectedFiles` is the single authoritative scope key

- **Status:** Proposed
- **Decision:** the plan's per-step `expectedFiles` array is the only input to approved-scope derivation. Prompts must name it and show an example. Scope derivation is NOT widened to read `declaredFileSet` or `steps[].files`. An empty derived scope is surfaced to the human as a warning at plan approval and does not block approval.
- **Basis:** PRD PlanStep contract (compliance/requirements.json:193); R-263; human approval has top priority.
- **Open:** whether an empty scope with declared files should become a hard refusal. That would change approval behavior and needs a versioned decision.

## D-15. Bounded retry for malformed model replies

- **Status:** Accepted
- **Decision:** a reply that fails the response contract (malformed, empty, or schema-invalid) is retried up to 2 times with a fresh invocation and a one-line rejection notice. The contract itself is not weakened. Transport errors, timeouts, scope violations, and provider errors are never retried. Every attempt is recorded.
- **Basis:** a single formatting miss from a free model currently kills a stage. PRD §10.8 and R-263 (adapter hardening, no workflow change).

## D-16. Accepting a bare-JSON-only reply as a valid response

- **Status:** Proposed. Decide after Task M's retry results.
- **Context:** see P-14. Models sometimes return the correct JSON object without the markdown fence.
- **Decision (draft):** a reply is accepted if it is exactly one fenced JSON block with nothing after it (today's rule), OR if the whole trimmed reply is a single JSON object and nothing else. Prose before or after, two objects, or an object in the middle of text are rejected. The same schema validation applies to both forms.
- **Basis:** the contract's purpose is unambiguous extraction with no prose smuggling; a bare-object-only reply preserves that. It does change PRD §10.8 and needs a versioned decision.

## D-18. Plan-review findings must reach the human at the gate

- **Status:** Proposed
- **Context:** see P-23. D-13 sends plan-review findings to the human, but the gate currently shows only what the reviewer put in the artifact content.
- **Options:** (1) the reviewer role must include `verdict` and `findings` in the artifact content (prompt plus contract test, model-dependent); (2) the orchestrator persists the validated stage-result findings (changes stored outputs and approval evidence, needs a versioned decision); (3) the CLI reads findings from the recording (rejected: recordings are diagnostics, not evidence).
- **Recommendation:** (1) now, (2) if models fail to comply in practice.

## D-19. A capability the project does not declare is skipped, visibly; a declared one that cannot run is blocked

- **Status:** Accepted (owner decision, 2026-10-11)
- **Context:** in the first real run, `build` was blocked with `package_manager_unknown` although the project has no build script, which blocked the whole static stage.
- **Decision:** the framework checks whether a script or configured command exists for a capability before checking whether the package manager is known. No script or command declared: the capability is **skipped**, reported as `skipped (<reason>)` in the verification summary and the CLI. A declared script or command that cannot run (unknown package manager, missing dependencies, unsupported ecosystem) stays **blocked** with an actionable explanation (D-20). The set of required capabilities does not change, and nothing a plan or the project declares may be skipped.
- **Basis:** a blocked result is evidence a human must resolve. Blocking on something that would never run adds noise, while skipping something declared would weaken verification. Changes verification evidence (R-263), so it is this decision, not a quiet change.

## D-20. Every refusal, failure, or blocked result must explain itself

- **Status:** Accepted (owner decision, 2026-10-11)
- **Decision:** every message the CLI prints for a refusal, failure, blocked result, or inconclusive result has four parts: (1) what happened, (2) why, in plain words naming the real cause (for example "this project has no lockfile and no `packageManager` field in package.json"), (3) how to fix it, with the exact command or edit, and (4) where the evidence is (a file path), plus the next command. The raw reason code appears in parentheses so it can be searched. "Unknown error" is never printed; if the cause is not known, the message says "cause not determined" and gives the evidence path and `agentflow status <id>`.
- **Implementation rule:** messages come from one catalog module that maps every known reason or error code to a message builder. A test iterates all capability reason codes and all adapter and orchestration error codes, so a new code without a message fails the build.
- **Raw message rule (added 2026-10-11):** the CLI always prints the raw error message from the result (verbatim, wrapped, control characters stripped) as a "Detail:" line, even when the catalog has a specific explanation. "Cause not determined" appears only when the message is empty. The catalog may add the fix and evidence path; it may never remove the message.

## D-21. Verification stages state which criteria they can and cannot judge

- **Status:** Accepted, conditional on the final gate enforcing coverage (Task W item 2)
- **Decision:** a verifier's prompt states which capabilities its bundle covers. Criteria that need another stage's evidence are listed as deferred with the owning stage and do not by themselves make the stage inconclusive. The final gate must require every criterion to be satisfied by some stage; if it does not, the prompt change does not ship.

## D-22. A skipped check carries no fabricated start time

- **Status:** Accepted (owner decision, 2026-10-11)
- **Decision:** evidence for a check that never started is valid without a start timestamp, but only for a skipped check with a declared reason. Any check that ran must carry a valid timestamp. Basis: R-146 (missing runtime config yields deferred, never a false success), and invented timestamps would make evidence say something untrue.

## D-23. A project with no runtime configuration advances with a recorded gap

- **Status:** Proposed (recommendation: option A). Blocked on Task X confirming the final gate can carry a deferred gap.
- **Context:** F-002 (2026-10-11/12): with no runtime config, runtime_verification returned `inconclusive` after a 368s model call and could not advance; re-running repeats it. A second attempt failed with a provider connection reset after 544s.
- **Decision (draft):** when the runtime bundle is `deferred` because no runtime verification is configured, the orchestrator records the bundle, makes no model call, and advances. The final summary lists "runtime verification: not performed (not configured)" and `approve push` requires `--accept-unverified runtime`. A runtime that is configured but fails, blocks, or cannot start is not covered and still stops the workflow.
- **Basis:** PRD R-146 (never a false success): the gap is recorded and a human acknowledges it. Priority: human approval over automatic verification. Changes workflow behavior (R-263), so it needs this decision.

## D-24. Bounded retry for transient provider failures

- **Status:** Accepted (owner decision needed only if the retry budget changes; Task Y)
- **Context:** see P-33. In F-002, OpenCode exited 1 with `ECONNRESET` on its stderr twice, and both times the stage died with `executor_error` after hundreds of seconds of work.
- **Decision:** a run that dies on a recognized transient provider failure — a dropped connection, a socket or DNS failure, HTTP 502/503/504, an overloaded provider — is attempted again after a 15s/45s backoff, up to 2 extra invocations (`--transient-retries <n>` changes the budget; 0 disables it), inside a wall-clock budget of twice the stage timeout. A `429` is retried at most once. Accounting and identity failures (credit, billing, free-tier, unauthorized, invalid API key) and any other HTTP 4xx are never retried; anything the detector does not recognize is never retried. Only `non_zero_exit` and `transport_failed` are retry candidates — timeouts, cancelled runs, truncated output, refused replies (D-15 owns those), and scope violations are never retried here. `stage_started`/`stage_finished`/`stage_failed` are emitted exactly once no matter how many attempts run, and the retry itself is announced as a `transient_retry` progress line naming the retry and the backoff.
- **Basis:** the same spirit as the reply retry (D-15): a failure a fresh invocation can plausibly survive is retried, and nothing else is. Adapter hardening under R-263, flagged as such: every attempt keeps its own recording, and a retried run is evidence of provider trouble, not a weakened contract.

## D-25. One predicate excuses the framework's own recordings for every change-set consumer

- **Status:** Proposed (accept after Task Z)
- **Context:** see P-35, P-36, P-37. The recorder writes `.agentflow/recordings/<id>/<stage>/<stamp>/{invocation.json,stdout.txt,stderr.txt}` into the worktree after a stage's deterministic evidence was collected, and in a post-approval worktree — whose committed tree carries no `.agentflow/.gitignore` — those files are untracked change-set paths. Reproduced first, with the real recorder, the real transport against a fake `opencode` executable, and the real workspace adapter over a real temporary repository and worktree: `security_review` failed `protected_configuration_changed` on 15 recording paths (and `shell_execution` on 5 `invocation.json`), `evaluateFixIntegrity` rejected a fixing stage as `fix_protected_file_touched` (3 paths), `buildFinalSummary` listed them as changed files, and publish staging put them in the published commit — the P-37 leak, read back out of the remote as `.agentflow/recordings/F-001/implementation/20260405T060708Z-686b/{invocation.json,stderr.txt,stdout.txt}`.
- **Decision:** `isFrameworkRecordingPath` (orchestration/src/workspace.ts:576) stays the single predicate, and `withoutFrameworkRecordings` applies it once per consumer, leaving the measured change set itself intact: the security request and its policy merge (orchestration/src/orchestrator.ts:3435, :3477; orchestration/src/security.ts:379), publish staging (orchestration/src/orchestrator.ts:1133 → :1174), fix integrity (orchestration/src/fix-policy.ts:317), and the final summary (orchestration/src/final-summary.ts:191, :202). The scope guard already excuses them (orchestration/src/workspace.ts:622) and is unchanged. Every other `.agentflow/**` path still fails the scan, the guard, and fix integrity — the near-miss under the recorder's own directory included.
- **Decision (evidence measurement, R-263 flagged):** `fingerprintOfChanges` (adapters/workspace/src/provider.ts:711) excludes the same predicate from every list in the digest. The recording a stage's own transport writes *between* two measurements was changing the digest, so the final gate reported `working_tree_changed` and `security_evidence_stale` for a tree that differed only by the framework's own log files — a run that could never certify itself. The change set still lists the recordings; only the question "is this the same tree the evidence described?" ignores them. The accepted cost is Task F's, now stated plainly: a file written at exactly the recorder's shape and location is indistinguishable from the recorder's output, and no other `.agentflow/**` path is excused anywhere.
- **Decision (presentation only):** the CLI's `stage_failed`/`stage_reported_failure` message no longer says "repair the defect, then re-run"; it names the failed check id, its measured paths summarized to three plus a count, that re-running without changing those paths reports the same failure, and where the record lives. No evidence or state-machine behavior changes (no R-263 flag needed for this part).
- **Basis:** PRD R-263 flagged for the scan, scope, fix-integrity, publish, and fingerprint halves above; the recordings are this framework's own diagnostics, not a write the work made.
