# Known issues

Last updated: 2026-10-10

This file records what is known to be broken, risky, or unproven in agent-workflow-kit. Each entry says where the evidence came from. If a claim is not backed by a command output or a file reference, it says "unverified".

Status values: **Open**, **In progress**, **Resolved**, **Decision needed**.

---

## Product blockers

### P-1. No real model has returned a stage result yet

- **Status:** Open
- **Evidence:** Task C runs ended before any model reply. `stdout.txt` was empty in every recording. Whether real models follow the strict structured-JSON response protocol is **unverified**.
- **Next:** resolve P-2, then re-run Task C and read the raw reply.

### P-2. Zen free tier rejects the framework's restricted agents (403 FreeTierError)

- **Status:** Open. See decision D-1 in `compliance/decisions.md`.
- **Evidence (Task E, 19 probes):** the free tier fails exactly when the selected agent's configuration removes the `bash` or `read` tool. Both `agentflow-read` and `agentflow-write` deny shell, so both fail. The same model works with OpenCode's default agent, with or without `--standalone`. The 403 comes from the server, not a local refusal. `glob` and `grep` are not required, and denying `edit` is harmless.
- **Not verified:** the server's actual logic. No HTTP payload was captured, so this is a behavioral correlation. The gate has changed several times and may change again.
- **Workaround:** use a provider with your own key through `--model provider/model`. Free Zen is best-effort.

### P-3. The real-OpenCode end-to-end harness is not committed

- **Status:** Open
- **Evidence:** `E2E_TEST_REPORT.md` references `tests/e2e-external-project.test.mjs`, which does not exist in the repository.
- **Next:** add a committed opt-in harness (D-12), then prove the full lifecycle through push, the fixer recovery path, and runtime verification with a small HTTP fixture.

### P-4. A repository with no commits fails with a raw git error

- **Status:** Resolved per the Task C report (a `--model` change and a no-commits precheck were merged); not independently re-checked here.
- **Evidence:** a fresh `git init` with zero commits failed at grilling with `git rev-parse HEAD failed`.

### P-5. OpenCode V2 is required

- **Status:** Documented here; README not yet updated
- **Evidence:** the stage runner needs `--standalone`, which V1 (1.18.x) lacks. The capability probe correctly refuses V1. Verified working version: `opencode v2.0.24`.

### P-7. One malformed model reply kills the run (no retry)

- **Status:** Open
- **Evidence (2026-10-09, Big Pickle, scratch runs):** 10 of 11 stage replies were valid fenced JSON. In one run the plan_review stage failed with "The OpenCode response contains no fenced JSON block" and the run stopped with `executor_error`. Sample is small; at this rate a feature with several model-driven stages would often fail somewhere.
- **Next:** read the recording to classify the failure, then decide on a bounded retry (each attempt must still meet the strict contract; the contract is not weakened). Any retry must be recorded per attempt and must not apply to scope violations or credit and gate errors.

### P-8. Write-stage recordings are in the workspace cache

- **Status:** Mitigated (Task K, commit 3db4aee)
- **Detail:** recordings still live under `~/.cache/agent-workflow-kit/workspaces/<hash>/`, but a failed stage now prints its recording folder, and `agentflow status <id>` prints the last stage's folder.

### P-9. No progress output and an unclear stage timeout

- **Status:** Resolved in Task K
- **Detail:** stage start/finish lines, 30-second heartbeats, and live tool-use lines are printed to stderr (`--quiet` disables them). The default stage timeout is 900 seconds (15 minutes) and can be changed with `--stage-timeout <seconds>`. The default may be too generous for free models.

### P-11. Write stages do not see uncommitted or untracked files

- **Status:** Confirmed (Task J); warning added in Task L
- **Evidence:** write stages run in a detached worktree of the approved commit (`git worktree add --detach`, `adapters/workspace/src/provider.ts:300`). Untracked files neither block approval nor travel with the stage. Pre-approval stages (grill, planning, plan review) run in the human checkout and can see them.
- **Warning (Task L):** `agentflow run` at start and `agentflow approve plan` list untracked files from `git status --porcelain=v1 -z --untracked-files=all` and warn that write stages run in a worktree of the approved commit and will not see them. Advisory only, tested with the fake stack in `tests/cli-warnings.test.ts`.
- **Guidance:** commit everything the feature needs before `agentflow run`.

### P-12. The implementer wrote its output to a file

- **Status:** Resolved in Task L (prompt side)
- **Evidence:** the implementer and the fixer now each carry the sentence "The structured response is returned in your reply and is NEVER written to a file: do not create or edit `implementation.json` or any other artifact filename in the repository." (`adapters/opencode/src/roles.ts`), which reaches both write-capable prompts. `tests/opencode-roles.test.ts` asserts the sentence for every write-capable role; `tests/opencode-prompts.test.ts` asserts it in both rendered prompts.
- **Not verified:** whether a real model follows it — unverified until P-1 is resolved. The old evidence stands: the stage took 508s, 91% of it model latency, and the agent wrote and edited `implementation.json`, triggering a scope violation.

### P-13. Planner output never authorizes any path (scope contract mismatch)

- **Status:** Resolved in Task L (prompt names the key; approval warns). The derivation was deliberately NOT widened: `approvedScopeFromPlan` still reads only `steps[].expectedFiles` (D-14, R-263).
- **Evidence:** the planner role names `steps[].expectedFiles` and says files named anywhere else authorize nothing (`adapters/opencode/src/roles.ts`); the planning prompt carries a "Plan artifact shape" section whose JSON is `PLAN_EXAMPLE` (`adapters/opencode/src/prompts.ts`). `tests/plan-scope-contract.test.ts` feeds that same exported constant through `approvedScopeFromPlan`, asserts the patterns are non-empty and authorize exactly the example's files, that files outside them are unauthorized, and that `declaredFileSet`/`steps[].files` still derive nothing — so the prompt example and the derivation cannot drift apart silently. `agentflow approve plan` derives the scope from the stored plan with the same exported `approvedScopeFromPlan` and, when it yields zero patterns, prints a warning that implementation will fail the scope check without blocking approval (`apps/cli/src/commands.ts`, `tests/cli-warnings.test.ts`).

### P-14. plan_review replies rejected: model returns bare JSON without the fence

- **Status:** Open (Task M)
- **Evidence (recordings, 2026-10-09/10, Big Pickle):** two plan_review replies (7,149 B and 6,536 B) were complete, plausible JSON with zero fence lines; one reply was empty (0 B). Earlier replies from other stages had fences. The contract (exactly one fenced block) rejected the unfenced replies as "no fenced JSON block". Parse failures show exit 0 and no error in `invocation.json`.
- **Unverified:** why the fence was omitted, and whether it correlates with reply length.

### P-15. Final summary cannot match glob entries in expectedFiles

- **Status:** Open, low severity
- **Evidence (Task L report):** `final-summary.ts:154-186` matches entries against exact observed paths, so a glob entry can never be "observed" and its step reports partial.

---

## Security-relevant

### S-1. Malformed agent frontmatter silently produced an unrestricted agent

- **Status:** Resolved in Task G (commit 7407743). After every runtime-config write and before OpenCode is spawned, `assertOpenCodeRuntimeConfigIntegrity` re-reads and parses the generated agent files and refuses malformed YAML, duplicate keys, missing or extra rules, and changed rule order. 11 tests cover it.
- **Remaining:** the check cannot be exercised end to end through the executor without a test seam; the evaluator test is opt-in (`AGENTFLOW_OPENCODE_EVALUATOR=1`).

### S-2. Recordings contain full prompts and model output

- **Status:** Mitigated, with a gap
- **Evidence:** recordings include argv with the complete prompt, plus stdout and stderr, under `.agentflow/recordings/`. Task D made `agentflow init` write `.agentflow/.gitignore` containing `*`, and a test shows the publisher stages no `.agentflow/` path.
- **Gap:** if a different `.agentflow/.gitignore` already exists, init leaves it alone and only warns (exit 0), so protection may be silently missing. **Decision needed:** make that case fail or tell the user how to fix it.

### S-3. The publisher adapter has no refusal of its own for `.agentflow/` paths

- **Status:** Decision needed
- **Evidence (Task D):** the adapter stages exactly the paths it is given (`publisher.ts:513`); only the orchestration scope check (`orchestrator.ts`, protected list in `orchestration/src/workspace.ts:48-59`) keeps `.agentflow/` out. Adding an adapter-level refusal changes publishing behavior and needs an explicit decision (PRD R-263).

### S-4. Recorder files tripped the framework's own scope guard

- **Status:** Resolved in Task F (commit d1b4c8f). The guard now excuses exactly `.agentflow/recordings/<id>/<stage>/<stamp>/{invocation.json,stdout.txt,stderr.txt}`. Near-miss paths and all other `.agentflow/**` paths remain violations. Tests cover this.

### S-5. Executor failures are not recorded in `events.jsonl`

- **Status:** Open, needs review
- **Evidence (Task C):** after an `executor_error`, `events.jsonl` held only the draft to grilling transition. Only the CLI output and the recording captured the failure. Check against the PRD's audit-completeness requirements (§29, R-294, R-295).

### S-6. Stale OpenCode runtime directories accumulate

- **Status:** Open, low severity
- **Evidence (Task E):** about 300 `opencode-*` directories under `/tmp/agent-workflow-kit/`, each holding generated agent configs. No cleanup exists.

### S-7. A scope violation hides the executor error

- **Status:** Open (Task H)
- **Evidence (Task F, Q7):** when both occur, the scope check at `orchestrator.ts:2020` returns before the executor-failure branch, so the user never sees the executor error. This is why a real 403 appeared as `scope_violation`.

### S-8. Recordings in publish worktrees and in fix stages are unverified

- **Status:** Open (Task H)
- **Evidence:** in a post-approval worktree there is no `.agentflow/.gitignore`, so recordings appear as untracked changes. It is unproven that the publisher never stages them (the "inert" claim in Task F conflicts with `approvedPathsOf` being used for `request.paths`). `evaluateFixIntegrity` would also reject a recorded fixing stage.

---

## Documentation debt

- README: state the Zen free-tier limitation (P-2), that no real model run has completed (P-1), and that OpenCode V2 is required (P-5).
- README: add `.agentflow/.gitignore` to the list of files `init` creates.
- README: add the "Using it on another project" section with commands that were actually run, with unfinished parts marked as planned.
- README and docs: one authoritative workflow state count (21, per the enum).
- The M14 freeze document must not claim production readiness; real-OpenCode end-to-end is not yet proven.
- Replace the outdated P4 fixture config and OpenCode version text in `E2E_TEST_REPORT.md` (verify against `tests/fixtures/p4-basic`).
- Update PRD §2.5 and §10.5 once decision D-1 is accepted.

---

## Resolved (kept for the record)

- **Wrong OpenCode invocation.** The transport used `opencode run -- ... --prompt`, which treated the flags as message text and selected the wrong agent. Fixed to the PRD §10.2 form, with diagnostics (Task 0, verified by `pnpm verify`).
- **CLI used a stub executor.** Wired to the real stack (B1). A missing OpenCode now gives a clear error and a non-zero exit.
- **`.agentflow/` could be committed by accident.** Fixed by `.agentflow/.gitignore` (Task D); see S-2 for the remaining gap.
- **Wrong diagnosis in an earlier report.** The "free tier refused client-side" claim was incorrect; it is a server-side 403.
