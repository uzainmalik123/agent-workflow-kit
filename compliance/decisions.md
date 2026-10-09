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

## D-14. `expectedFiles` is the single authoritative scope key

- **Status:** Proposed
- **Decision:** the plan's per-step `expectedFiles` array is the only input to approved-scope derivation. Prompts must name it and show an example. Scope derivation is NOT widened to read `declaredFileSet` or `steps[].files`. An empty derived scope is surfaced to the human as a warning at plan approval and does not block approval.
- **Basis:** PRD PlanStep contract (compliance/requirements.json:193); R-263; human approval has top priority.
- **Open:** whether an empty scope with declared files should become a hard refusal. That would change approval behavior and needs a versioned decision.
