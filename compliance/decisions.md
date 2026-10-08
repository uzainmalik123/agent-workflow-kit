# Decision log

Last updated: 2026-10-08

Status values: **Proposed** (drafted, not yet confirmed by the owner), **Accepted**, **Rejected**, **Superseded**.

Everything below was drafted from `compliance/prd-issues.md` (its suggested winners and proposed readings) and from the Task E diagnosis. **Nothing here is Accepted until the owner changes its status.** Edit any entry you disagree with before running the compliance audit passes, and tell the audit agent: "Treat compliance/decisions.md as authoritative where an entry is Accepted."

Priority order used for tie-breaks (PRD §42): human approval, deterministic verification, evidence and approval freshness, workspace and configuration boundaries, safe publishing, smallest implementation, explicit extensions.

---

## D-1. The read and write profiles keep the `bash` tool declared, with every command denied

- **Status:** Proposed. Blocked on Task E2 evidence.
- **Context:** OpenCode Zen's free tier returns `403 FreeTierError` when the selected agent's configuration removes the `bash` or `read` tool. Task E ran 19 probes and the rule fit all of them. `glob` and `grep` are not required, and denying `edit` is fine. Both `agentflow-read` and `agentflow-write` deny shell today, so both fail. PRD §2.5 says the supported OpenCode profiles grant no agent shell execution, and §10.5 says the read profile cannot use shell execution.
- **Decision (draft):** keep `bash` declared in both profiles so the provider accepts the request, but deny every command (or allow only an explicitly listed harmless command). The agent must still be unable to run any command that reads secrets, writes, or touches the network.
- **Accepted only if all of these hold:**
  1. E2 finds a variant that passes the gate and blocks commands, with a positive control (the allowlisted command is allowed) and negative controls (`touch`, `sh -c 'echo x > f'`, `git init`, `cat /etc/passwd`, `curl` are refused and no file appears).
  2. A test parses the generated agent file and asserts the effective permission rules are the intended ones. A malformed file must fail closed. Task E showed that malformed frontmatter silently yields an unrestricted agent.
  3. The post-stage scope guard stays enabled as a second line of defense.
  4. PRD §2.5 and §10.5 are reworded to match this decision.
  5. Free Zen is documented as best-effort, with a keyed provider as the reliable path.
- **Trade-off:** today the read agent has no shell at all. After this change the shell exists but is blocked by rules. A bug in OpenCode's permission enforcement would become a real exposure.
- **Fallback if E2 finds nothing:** do not weaken the profiles. Use a provider with the owner's own API key through `--model provider/model`, and document that free Zen is unsupported with the restricted profiles.

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
