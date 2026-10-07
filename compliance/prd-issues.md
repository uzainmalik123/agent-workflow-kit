# PRD Issues — conflicts, vague items, duplicates, non-local verification

Analysis of `docs/PRD.md` against the requirement matrix in `compliance/requirements.json` / `requirements.md`.
**Conflicts are documented, not resolved.** Where §42's priority list (human approval → deterministic verification → evidence/approval freshness → workspace/config boundaries → safe publishing → smallest implementation → explicit extensions) suggests which side should win, that is noted as a *recommendation* only.

---

## (a) Conflicting requirements

### C-1. Two-profile mandate vs. logical-role mapping (minor, direction ambiguity)

- **§10.5** requires *exactly* two physical profiles (`agentflow-read`, `agentflow-write`) and says logical roles "map onto" them.
- **§37.6** says logical roles "should remain stable" and that runtimes "may map several logical roles to a small number of physical permission profiles" — i.e., the mapping is runtime-specific and potentially variable.
- Tension: §10.5 reads as a hard product constant (two, always); §37.6 frames profile count as an adapter decision.
- **Suggested winner per §42:** keep the two-profile rule as the core contract (it is a security-boundary decision → priority 4 "preserve workspace and configuration boundaries"), and treat §37.6 as future-facing guidance for *other* adapters only. Related rows: R-084, R-133, R-327.

### C-2. Evidence binding breadth: §11.6 vs §27.5 vs §11.9/§14.8

- **§11.6** binds evidence to "workflow session/revision and a SHA-256 fingerprint."
- **§27.5** additionally requires binding to "exact/reproducible command identity where applicable," fixer-history constraints, and the current final-gate state.
- **§14.8** requires runtime evidence specifically to be invalidated by later source change.
- These are compatible but not identical; implementing only §11.6 would under-satisfy §27.5.
- **Suggested winner per §42:** §27.5 (superset, evidence-freshness is priority 3). Related rows: R-111, R-282, R-149, R-177.

### C-3. Determinism ambition vs. agent-in-the-loop reality

- **§20.6** wants "stable workflow behavior and artifacts" for equivalent runs; but §18.1's FinalSummary, §25.7's demo, and review artifacts inherently contain model-generated text that will vary run to run.
- Also **§19.7** demands commit "determinism" while commits include timestamps/author by nature.
- Not a hard contradiction, but as written §20.6/§19.7 are untestable at full strength.
- **Proposed testable reading (see V-1/V-2):** determinism applies to state sequence, artifact structure, and evidence bindings; commit determinism means reproducible given fixed committer date/author/tree.
- **Suggested winner per §42:** the narrower reading (priority 6: smallest implementation that satisfies the requirement). Related rows: R-213, R-199.

### C-4. Plugin policy deference vs. framework authority

- **§10.7** permits "safe empty/text-only directories and supported non-plugin project content" and says executable plugin code is "rejected **or blocked according to the installed policy**."
- **§27.2 / §10.6** require the framework to unconditionally prevent repository plugin execution from compromising the control plane.
- Tension: "according to the installed policy" implies a configurable escape hatch; §27.2 admits none.
- **Suggested winner per §42:** §27.2 (workspace/configuration boundary, priority 4; also priority 2 deterministic verification). The policy knob may decide *how* to block, never *whether*. Related rows: R-095, R-097, R-281.

### C-5. "Agentflow read profile cannot edit" vs. fixer stage needing writes

- **§10.5** read profile "cannot edit"; **§15** requires the fixer to mutate the implementation. This forces every fixer invocation onto the write profile.
- Not a contradiction (stage→profile binding in §28.1 resolves it), but the PRD never states which stages use which profile, leaving the read/write split under-specified for stages like code review that might plausibly want edits.
- **Suggested resolution direction (not decided):** §28.1's stage-table binding should enumerate the stage→profile map; any stage that mutates files must bind to `agentflow-write`. Related rows: R-085, R-087, R-288.

### C-6. Freeze (§20.8/§36) vs. extension sections (§37)

- **§20.8/§36** freeze the core after M14; **§37** lists 13 future feature areas. §38.3 reconciles them ("extensions," "explicit versioned product decision"), but §37.7 (parallelism) and §37.9 (browser automation) brush against §36's exclusions ("browser automation as a mandatory verification mechanism," §36 phrased as out-of-scope for the *core*).
- **Suggested winner per §42:** §36 for the current baseline; §37 items are non-gating future work (matrix marks them `future (§37)`). Related rows: R-215, R-317, R-320–R-329.

### C-7. P5 quick-start npm instructions vs. P6 ordering

- **§25.9** forbids claiming npm installation "before P6 is complete," while **§25.3** requires a quick start that begins with "install." If P5 ships before P6, the quick start cannot honestly say `npm install`.
- **Suggested winner per §42:** §25.9 (documentation accuracy is a form of evidence integrity; the quick start should show the actual available install path, e.g., build-from-source, until P6 lands). Related rows: R-266, R-273.

---

## (b) Requirements too vague to test as written (with proposed testable readings)

### V-1. §20.6 Determinism — "to the extent practical"
"Equivalent runs … should produce stable workflow behavior and artifacts to the extent practical" has no measurable bar.
**Proposed reading:** for a fixed fixture with a scripted (deterministic) agent stub, the recorded *state-transition sequence*, *artifact key structure*, *evidence bindings*, and *gate outcomes* must be byte-identical across two runs; free-text model output fields are excluded from comparison.

### V-2. §19.7 Deterministic commit — "deterministic enough"
No threshold given.
**Proposed reading:** with fixed author/committer identity, fixed timestamps, fixed message, and identical tree, `git commit-tree` output SHA is reproducible; the publisher records the SHA in the push-outcome artifact.

### V-3. §21 "No bundler unless necessary" / "use `module` only when actually required"
"Necessary"/"actually required" are judgment calls.
**Proposed reading:** a documented build decision record states the module strategy; any bundler dependency added to runtime packages requires an accompanying ADR; CI lint rule (or code-inspection checklist) fails if `module` field exists without a documented rationale.

### V-4. §10.7 "supported non-plugin project content may be permitted"
Undefined what "supported" means; policy-dependent rejection is untestable.
**Proposed reading:** concretely — a directory is rejected iff it contains files with executable intent (e.g., `.js`/`.ts`/`.mjs`/`.cjs` entry files, executables, or symlinks) under the four plugin paths; empty dirs and text files (`.md`, `.txt`, `.json` without script fields) pass. Enumerate the exact extension list in the implementation and test both sides.

### V-5. §14.6 "route appropriately according to policy"
Which policy? What state?
**Proposed reading:** missing runtime config → verification result `inconclusive` with explicit `deferred` reason; workflow either (a) halts before FinalGate, or (b) proceeds only if the project config explicitly marks runtime verification as not required. Both branches get named tests.

### V-6. §34 "Non-interactive operation where appropriate"
"Where appropriate" is untestable.
**Proposed reading:** all listed CLI commands complete without stdin input when given required arguments; a test asserts no command blocks on a TTY-less stdin with a 5s watchdog.

### V-7. §27.10 Auditability
"The architecture should support independent … audits without undocumented assumptions" is aspirational.
**Proposed reading:** a security-audit walkthrough doc exists listing every trust boundary with a pointer to the enforcing module and its test; external findings are triaged in a recorded decision log within a defined SLA (e.g., one release cycle).

### V-8. §9 "restricted context routing between stages"
No definition of what context is restricted.
**Proposed reading:** each stage's request contract has an explicit allowlist of context keys; the orchestrator strips undeclared keys; a test feeds extra keys and asserts they do not reach the stage.

### V-9. §33.3 "Maintain disposable fixture projects" (maintenance burden, not a testable unit)
**Proposed reading:** CI includes a job that instantiates every fixture, runs it, and tears it down; fixture inventory is asserted in a test (each named fixture exists and executes).

### V-10. §2.6 / §11.3 "no silently install … as part of its normal execution"
"Silently" and "normal execution" are fuzzy.
**Proposed reading:** no agent-controlled or verification-stage command may resolve to a package-manager install/mutating lifecycle verb (`install`, `add`, `update`, `remove`, `link`, `exec` with script hooks, lifecycle scripts); the verification policy denylist test covers each verb per supported package manager.

### V-11. §18.3 / §27.6 approval "cryptographically/deterministically bound"
Crypto language without algorithm/key guidance.
**Proposed reading:** approval record stores SHA-256 digests of (summary, final-gate result, fingerprint, revision, feature id) and revalidation recomputes and compares; "cryptographic" is satisfied by SHA-256 digest equality (no signatures required unless a product decision adds them).

### V-12. §13.9 Complexity principle
"Prefer a small number of well-defined capabilities … without a demonstrated need" is a design value, not a test.
**Proposed reading:** process check — any PR adding a new profile, agent, or config file must include a justification section; count of physical profiles remains exactly two (already tested via R-084).

---

## (c) Duplicates / superseded items

| Duplicated statement | Sections | Matrix treatment |
|---|---|---|
| Two physical OpenCode profiles | §10.5, §13.7 | R-084 (primary), R-133 (marked duplicate) |
| External OpenCode runtime config outside repo, deterministic path | §10.6, §13.8, §30.3 | R-088 (primary), R-134 (dup), R-296 (separation across phases) |
| Profile shadowing / repo config cannot override control plane | §10.6, §28.2, §27.2 | R-092/R-093 (primary), R-281 (cross-cutting restatement) |
| Forged response fields rejected | §10.8, §28.3, §27.1/§27.2 | R-098 (primary), R-003/R-280 (principle-level restatements) |
| Approval bound to state/digests; stale approval invalid | §18.3, §27.6, §28.6, §28.7 | R-190–R-192 (primary), R-292/R-293 (read-time + pre-action revalidation angle) |
| Pre-publish head/state re-verification | §19.6, §28.8 | R-198 (merged, both sections cited) |
| Evidence freshness / stale evidence invalid | §11.6, §14.8, §27.5 | R-111/R-112 (primary), R-149 (runtime-specific), R-282 (superset) |
| Idempotent/safe re-init | §23.1, §23.4, §35 | R-244 (primary), R-255 (fixture-proven), R-315 (dup) |
| Resume/recover from persisted state | §7, §9, §35 | R-043 (snapshot), R-072 (orchestration), R-316 (dup) |
| Full lifecycle E2E incl. real OpenCode | §20.1, §24, §33.4 | R-204 (primary), R-257–R-260 (P4 specifics), R-304 (dup) |
| Human approval gates (plan/push) | §2.1, §18.2, §20.4, §39 | R-001/R-002 (principle), R-188/R-189 (state-level), R-207/R-208 (E2E proofs), R-331 (journey-level) |
| Path safety / traversal resistance | §8, §27.9, §28.4 | R-053 (persistence), R-286 (cross-cutting restatement), R-289/R-290 (identifier rules) |
| Process safety posture (argv, shell:false, bounds, cleanup, env) | §2.5, §11.3, §14.2, §27.3, §32 | R-008 (principle), R-102–R-106 (verification), R-138 (runtime), R-299 (unified contract) — §27.3 folded into R-299 to avoid a fifth restatement |
| Freeze after M14 | §20.8, §36, §38.1 | R-215 (merged, all three cited) |
| Fresh-user journey without monorepo access | §26.5, §39 | R-279 (primary), R-331 (dup) |
| Artifact completeness | §8 (stage list), §29 (category list) | R-049 (persistence-side), R-294/R-295 (§29 supersedes the §8 list for audit purposes; both retained because §8 is about storage capability and §29 about answerable audit questions) |
| Milestone regression coverage | §12, §20.7 | R-118 (M6.1-specific), R-214 (M14-wide) |
| Exit codes / error readability | §22.2, §34 | R-233/R-234 (P2), R-306–R-309 (UX restatement) |

**Superseded relationships (recommendation, not decision):** §29's artifact-category list is the richer superset of §8's; §27.5 is the superset of §11.6; §28.2/§28.3 are enforcement mechanisms for principles first stated in §10.6/§10.8. If one must be normative, prefer the superset per §42 priority 3 (evidence integrity) — but keep the narrower ones as regression anchors.

---

## (d) Requirements not verifiable locally (need npm publish, GitHub, or external services)

| Matrix ID | PRD § | What cannot be verified locally | What *can* be verified locally |
|---|---|---|---|
| R-278 | §26.4 | GitHub repo description, topics, and **release information** require GitHub (web/API); a release is a remote act. | `gh repo view` / API check could verify description/topics if CI has token access; release *notes draft* can be inspected as a local file. |
| R-277 (final step) | §26.3 | Actual `npm publish` (non-dry-run) and the version decision are external acts. | Build, tarball content scan, and `npm publish --dry-run` are local. |
| R-279 / R-331 | §26.5, §39 | "New developer discovers the repo and installs" implies npm registry availability. | A fresh-machine walkthrough can substitute build-from-source + local `npm link`. |
| R-273 | §25.9 | "No npm-install instructions before P6 is complete" depends on P6's real-world completion, not repo state alone. | README grep at each milestone; becomes trivially checkable once P6 lands. |
| R-257 / R-258 | §24 | Real-OpenCode E2E depends on an OpenCode binary at a recorded version — external tool availability (though runnable locally if installed). | Harness can pin/record version and fail fast with a clear message when absent. |
| R-203 | §19.10 | "Controlled non-production remote" may be a hosted disposable remote; fully-local is a `file://` or local bare repo. | Local bare-remote test proves the mechanism; policy code-inspection proves production remotes are unreachable from tests. |
| R-287 | §27.10 | Independent *external* security audits are by definition outside local control. | Local: audit-walkthrough doc + triage decision log existence. |
| R-215 | §20.8 | "Feature-frozen" is a process commitment over time, not a verifiable artifact. | Local proxy: change-log/ADR rule + review checklist. |
| R-033 | §5 | "Tests as part of every milestone" is process discipline. | Local proxy: CI config runs full suite; per-milestone test files exist. |

**General note:** everything in the matrix marked `test:` or `code inspection:` is locally verifiable in this repository. Items marked `process:`/`manual:` range from locally checkable (CI inspection) to genuinely external (GitHub release, npm publish). The genuinely external set is small and confined to P6 release acts (§26.3–§26.5), the §24 real-OpenCode dependency, and process commitments.
