# Milestone 7 Complexity Audit

Negative-code refactor. This document is written before any code changes. Its purpose is to decide
what the kit stops being, on evidence, rather than to describe a rewrite.

- Baseline commit: `b59e7cf`
- Baseline: `pnpm test` -> 29 files, 885 tests, 9.64s, all passing.
- Scope: reduction only. No new workspace isolation, no publishing, no installer, no browser
  verification, no integration work.

---

## 1. Current architecture

Six workspace packages, 64 source files, 17,899 source LOC.

| Package | Source LOC | Files | Owns |
| --- | ---: | ---: | --- |
| `core` | 516 | 5 | `WorkflowState`, legal transitions, workspace baseline |
| `orchestration` | 4,947 | 12 | stage table, stage executor port, run loop, approvals, evidence port |
| `adapters/persistence` | 2,214 | 8 | session store, artifacts, CAS revision, locking, atomic writes |
| `adapters/project` | 3,149 | 12 | discovery, framework detection, command plan, evidence bundle |
| `adapters/workspace` | 1,792 | 7 | git worktree provider, lease, sidecar, status |
| `adapters/opencode` | 5,281 | 19 | role/agent generation, permissions, prompts, CLI transport, config smoke test |

Runtime path of a single `runNext`:

```
orchestrator.runNext(session)
  -> stage table lookup                      orchestration/src/stages.ts
  -> human gate / approval re-verification    orchestration/src/approval.ts
  -> executor.run(StageExecutionRequest)      orchestration/src/executor.ts   (port)
       -> OpenCodeStageExecutor               adapters/opencode/src/executor.ts
            -> project-local config generation  agents.ts
            -> config integrity assert          configuration-integrity.ts
            -> plugin preflight                  plugin-preflight.ts
            -> prompt render                     prompts.ts
            -> CLI transport                     cli-transport.ts  -> `opencode run`
       -> response parse / validate            result-validation.ts
  -> verification provider collect            adapters/project/src/provider.ts
  -> session store mutate (revision CAS)       adapters/persistence/src/session-store.ts
```

The state machine, transition legality, single-stage `runNext`, approval checkpoints, plan hashes,
revision CAS, atomic persistence, fix return state, and evidence freshness rules are the kernel.
They are not candidates for reduction.

`adapters/workspace` already exists and already carries real guarantees. This milestone does not
extend it, and it is not in the deletion set.

---

## 2. Responsibilities and whether they are justified

| # | Responsibility | Justified? | Disposition |
| --- | --- | --- | --- |
| 1 | Workflow state machine, legal transitions, gates | Yes | **Keep unchanged.** |
| 2 | Single-stage `runNext`, approval re-verification, fix return state | Yes | **Keep unchanged.** |
| 3 | Session store: atomic writes, revision CAS, rollback, path safety, locking | Yes | **Keep unchanged.** No split, no rewrite. |
| 4 | Deterministic command plan + evidence collection from process exit status | Yes | **Keep.** Authoritative path. |
| 5 | Evidence bracketing (implementation + control-plane fingerprint before/after) | Yes | **Keep.** A command that rewrites what it verified cannot pass. |
| 6 | Stage prompt rendering and structured response validation | Yes | **Keep**, but consolidate prose (see 6). |
| 7 | OpenCode CLI transport (event stream, kill grace, output bounds) | Yes | **Keep.** |
| 8 | OpenCode **role-per-agent** model (11 roles -> 11 agent files) | No | **Collapse to 2 physical profiles.** |
| 9 | Repository-local agent/config **generation** | No | **Delete.** See probe finding F1. |
| 10 | `configuration-integrity.ts` (generated file hashing, precedence scan, alternate config paths) | No | **Delete.** See F1/F3. |
| 11 | `plugin-preflight.ts` (project-local plugin discovery) | No | **Delete.** See F4. |
| 12 | `install-policy.ts` (gitignore, tracking modes, vendored paths) | No | **Delete.** Premise removed. |
| 13 | Framework detection across ecosystems | No | **Delete.** No decision depends on it. |
| 14 | Non-Node ecosystems (python, rust, java) | No | **Delete.** Unsupported result instead. |
| 15 | Capability probe over V1 and V2 flag surfaces | Partly | **Reduce to** version check + one real config smoke test. |
| 16 | `environment.ts` V1-era scrub list | Partly | **Reduce** to the two variables that matter in V2, plus a stated reason. |
| 17 | Manual result validation across ~20 shapes | Partly | **Reduce** with a few small field helpers. |
| 18 | Evidence bundle field count (23 check fields, 12 bundle fields) | No | **Shrink** to `VerificationRun`/`VerificationCheck`. |
| 19 | Public export surface | No | **Shrink** to 5 entry points + contracts. |
| 20 | Narrative JSDoc restating history in source | No | **Move to docs.** Keep invariant comments only. |

---

## 3. Footprint

Baseline, measured:

| Metric | Value |
| --- | --- |
| Source LOC | 17,899 |
| Source files | 64 |
| Test LOC | 15,375 |
| Test files | 29 |
| Fixture LOC / files | 917 / 8 |
| Public exported names | 301 |
| Public names per package | core 5, orchestration 70, opencode 112, persistence 24, project 60, workspace 30 |
| OpenCode roles | 11 |
| OpenCode physical permission profiles | 11 (1:1 today) |
| OpenCode production control-plane modules | 4 (`agents`, `configuration-integrity`, `plugin-preflight`, `install-policy`) |
| OpenCode control-plane LOC | 1,693 |
| Supported ecosystems | 5 (`node`, `python`, `rust`, `java`, `unknown`) |
| Verification check fields | 23 |
| Verification bundle fields | 12 |

Verification evidence field inventory (`orchestration/src/verification.ts`): `id`, `kind`,
`capability`, `capabilityStatus`, `label`, `executable`, `args`, `cwd`, `script`, `startedAt`,
`durationMs`, `exitCode`, `signal`, `status`, `reason`, `detail`, `stdoutExcerpt`, `stderrExcerpt`,
`truncated`, `revision`, `implementationFingerprint` (21 declared fields plus inherited).

Bundle: `verification`, `outcome`, `revision`, `implementationFingerprint`, `workspace`,
`controlPlane`, `collectedAt`, `projectRoot`, `workspaceId`, `project`, `checks`.

The redundancy that matters is not the raw count. It is that identity, timing, and revision are
written four times: at bundle level, at check level, at artifact level, and re-checked at bind time.

---

## 4. Hotspots

Largest source files, and what each is actually for.

| File | LOC | Assessment |
| --- | ---: | --- |
| `orchestration/src/orchestrator.ts` | 1,718 | Kernel. Run loop, gates, evidence application. Protected. |
| `adapters/persistence/src/session-store.ts` | 1,055 | Kernel. Atomicity, CAS, rollback, locking. Protected. |
| `orchestration/src/verification.ts` | 951 | Evidence types + 300 lines of structural validation. Shrink. |
| `adapters/opencode/src/configuration-integrity.ts` | 802 | Delete. |
| `adapters/workspace/src/provider.ts` | 717 | Out of scope. Untouched. |
| `adapters/project/src/profile.ts` | 506 | Multi-ecosystem discovery. Reduce to Node. |
| `adapters/project/src/provider.ts` | 502 | Command selection + evidence assembly. Keep shape, shrink fields. |
| `adapters/opencode/src/prompts.ts` | 492 | Stage prompts. Consolidate with role prose. |
| `adapters/opencode/src/smoke-test.ts` | 570 | Reduce to two named profiles. |
| `orchestration/src/stages.ts` | 459 | Stage table. Single authority. Keep. |
| `adapters/project/src/commands.ts` | 442 | Node command plan. Keep. |
| `adapters/opencode/src/roles.ts` | 404 | Collapse to 2 profiles. |
| `adapters/opencode/src/capabilities.ts` | 353 | Reduce to version + one smoke test. |
| `adapters/opencode/src/agents.ts` | 361 | Delete generation; keep 2 profile definitions. |
| `orchestration/src/result-validation.ts` | 318 | Repeated boilerplate. Small helpers. |
| `adapters/persistence/src/validation.ts` | 293 | Repeated boilerplate. Small helpers. |
| `adapters/project/src/evidence.ts` | 257 | Shrink with the evidence types. |
| `adapters/opencode/src/permissions.ts` | 260 | Reduce to 2 rulesets. |
| `adapters/project/src/fingerprint.ts` | 257 | Keep. Integrity is a guarantee. |
| `adapters/project/src/config.ts` | 231 | Keep. Deterministic command override. |
| `adapters/opencode/src/executor.ts` | 233 | Keep. This is where stage behavior lives. |
| `adapters/opencode/src/index.ts` | 200 | 112 exports. Shrink. |
| `adapters/opencode/src/environment.ts` | 168 | Reduce. |
| `adapters/opencode/src/response-protocol.ts` | 154 | Keep. |
| `adapters/opencode/src/process.ts` | 150 | Keep. |
| `adapters/project/src/fs-safe.ts` | 165 | Keep. Path safety. |
| `adapters/persistence/src/lock.ts` | 327 | Kernel. Protected. |

---

## 5. Duplication

| Duplication | Where | Resolution |
| --- | --- | --- |
| Stage purpose written 4+ times | `stages.ts` role + `roles.ts` definition + `prompts.ts` prose + `agents.ts` frontmatter | One stage table is the authority. `StageExecutionRequest` carries stage, profile, context, output spec, response requirements. Prompts render from it. |
| `access` level stated twice | `stages.ts` `access: read_only/read_write` and `roles.ts` `READ_ONLY_ROLES`/`WRITE_CAPABLE_ROLES` | Stage table is the authority. The adapter maps `access` to one of two profiles. |
| Write-surface sets | `WRITE_CAPABLE_WORK_STAGES`, `WRITE_CAPABLE_ROLES`, `writeCapableRoles()` | One derived set from the stage table. |
| Identity/timing/revision on evidence | bundle fields + check fields + `bindVerificationEvidenceToRequest` re-checks + `DETERMINISTIC_EVIDENCE_KEY` nesting | One `VerificationRun` and one `VerificationCheck`. Identity checked once, at the boundary. |
| Response validation shape | `result-validation.ts` field-by-field, `persistence/validation.ts` field-by-field, `verifyRuleset` | 3-4 small helpers: `str`, `optStr`, `oneOf`, `arr`. No schema library. |
| Same integrity-pair validator twice in one file | `validateWorkspaceIntegrity` and `validateControlPlaneIntegrity` are identical wrappers | One function, two call sites. Already close; collapse. |
| Non-passing status set | `NON_PASSING_STATUSES` in orchestration, separate set logic in `adapters/project/src/evidence.ts` | Export one set from the port. |
| Framework prose in 3 files | `frameworks.ts` names, `profile.ts` notes, `commands.ts` labels | Delete; no decision reads a framework name. |
| V1/V2 branches | `capabilities.ts` V1-vs-V2 field set, `environment.ts` V1-era suppression flags, `cli-transport.ts` historical flag branches | One V2 contract. |

---

## 6. Unnecessary public API

Target: 5 entry points plus the contracts they need.

Keep as public:

```
createWorkflowOrchestrator
createFeatureSessionStore
createProjectVerificationProvider
createOpenCodeStageExecutor
createOpenCodeCliTransport
```

Everything else becomes internal or is deleted. Specifically removed from the public surface (112 ->
roughly 20 for `adapters/opencode` alone):

- All of `configuration-integrity` (7 names) -- deleted.
- All of `plugin-preflight` (9 names) -- deleted.
- All of `install-policy` (8 names) -- deleted.
- `OPENCODE_ROLES`, `STAGE_ROLES`-adjacent role lookup helpers (`agentForRole`, `roleForAgent`,
  `roleForStage`, `stagesForRole`, `agentForStage`, `accessForRole`, `isWriteCapableRole`,
  `isStageRole`, `roleDefinition`, `READ_ONLY_ROLES`, `WRITE_CAPABLE_ROLES`, `AGENT_BY_STAGE`) --
  collapse to `openCodeProfileForStage(stage)`.
- `permissions.ts` internals (`effectFor`, `matchesResourcePattern`, `operationEffect`,
  `readOnlyRoles`, `writeCapableRoles`, pattern constants) -- internal.
- `agents.ts` generation API (`renderAgentMarkdown`, `renderOpenCodeProjectConfig`,
  `renderOpenCodeProjectFiles`, `writeOpenCodeProjectFiles`, `agentFilePathForRole`,
  `openCodeAgentIdForPath`, path constants) -- deleted.
- `capabilities.ts` field-level API (`advertisesFlag`, `missingRunCapabilities`,
  `describeCapabilities`, `parseMajorVersion`, `REQUIRED_RUN_FLAGS`) -- internal to the gate.
- `smoke-test.ts` report-building internals -- internal to the gate.
- `environment.ts` scrub-list constants -- internal.
- `project` adapter: `LINT_SCRIPTS`, `TYPECHECK_SCRIPTS`, `BUILD_SCRIPTS`, `TEST_SCRIPTS`,
  `TEST_FALLBACK_SCRIPTS`, framework definitions, `PROJECT_ECOSYSTEMS` -- internal.

---

## 7. Unnecessary APIs and machinery behind them

### 7.1 Project-local OpenCode control plane

Today the adapter writes `.opencode/agents/*.md` and `opencode.json` into the target repository and
then defends that writing with 1,237 LOC of integrity checking. The defense exists only under the
assumption that the repository's own OpenCode configuration must not contribute to a stage run.

**The real V2 probe (section 8) shows the assumption is false, and the defense is unnecessary anyway,
because the guarantee does not depend on the repository's configuration being absent.**

Deletion set:

| Module | LOC | Reason |
| --- | ---: | --- |
| `configuration-integrity.ts` | 802 | Premise removed by finding F1; framework no longer writes into the repo. |
| `plugin-preflight.ts` | 435 | Premise removed by finding F4; a repository plugin was never the thing that decided a profile's permissions. |
| `install-policy.ts` | 95 | Existed to gitignore and version-control generated files. Nothing is generated. |
| `agents.ts` | 361 | Reduces to two profile definitions, no file writing. |
| `opencode-configuration-integrity.test.ts` | 530 | Tests deleted machinery. |
| `opencode-plugin-preflight.test.ts` | 414 | Tests deleted machinery. |
| `opencode-agents.test.ts` | 574 | Reduces to two-profile coverage. |

### 7.2 Framework detection

`adapters/project/src/frameworks.ts` (94 LOC) plus every framework reference in `profile.ts` and
`commands.ts`. Measured: no command selection, hard decision, or capability classification reads a
framework name. The Node command plan reads only `package.json` scripts, the lockfile, and the
TypeScript marker. Framework names survive into `ProjectProfileSummary.frameworks`, which the
verifier reads as prose. **Delete.**

### 7.3 Non-Node ecosystems

`profile.ts` carries python, rust, and java manifests, lockfiles, and capability tables. There are no
tests asserting real python/rust/java command selection, and none is required. **Delete.** A
repository with no recognised Node manifest returns exactly one unsupported result.

### 7.4 Capability probe

`capabilities.ts` (353 LOC) probes 8 boolean fields across 4 help invocations to support V1 and V2.
Only one contract is supported. **Replace with:** `opencode --version` major check, then one real
`opencode debug agents` smoke test asserting the two named profiles resolve to the intended
permissions. `tests/opencode-capabilities.test.ts` (984 LOC) reduces accordingly.

### 7.5 Evidence surface

`VerificationEvidenceBundle` (12 fields) + `VerificationCommandEvidence` (21 fields) + 300 lines of
structural validation. Target:

```ts
VerificationRun   { stage, revision, implementationFingerprint, integrity, checks[] }
VerificationCheck { id, command, status, exitCode, signal, durationMs, detail, output }
```

`integrity` keeps `{ implementation: {before, after}, controlPlane: {before, after} }` because both
guarantees are load-bearing. `kind` is dropped (it is `run.stage`). `capabilityStatus` is dropped
(the check's own status is the fact). `label`, `script`, `cwd`, `startedAt`, `collectedAt`,
`truncated`, `projectRoot`, `workspaceId`, `declaredPackageManager`, `lockfiles`, `manifests`,
`configs`, `scripts`, `frameworks`, `workspaces`, `notes` are dropped or derived. `revision` and
`implementationFingerprint` are checked once, at the request boundary, not restated per check and
re-checked per check.

`ProjectProfileSummary` collapses to `{ ecosystem, packageManager, dependenciesInstalled }`.

### 7.6 Validation boilerplate

`result-validation.ts` (318) and `persistence/validation.ts` (293) validate field-by-field. Replace
with a few small helpers in one shared internal module. No schema library, no class, no plugin
system. Target under 200 LOC combined.

### 7.7 Environment scrub list

`environment.ts` (168 LOC, 54 lines of it comment) scrubs four injection variables, four suppressing
flags, and two prefixes. The probe shows that in V2 only `OPENCODE_CONFIG_DIR` (adds a source) and
`OPENCODE_CONFIG_CONTENT` change anything, and neither can widen a framework profile (finding F2).
`OPENCODE_DISABLE_PROJECT_CONFIG` is not honoured in V2. **Reduce to** the framework's own two
variables, set by the framework, with the scrub of caller-injected `OPENCODE_CONFIG*` kept as a
one-function guard. Credentials still inherited, unchanged.

---

## 8. Hypothetical abstractions to avoid

| Tempting abstraction | Why it is not needed |
| --- | --- |
| Role registry with per-role permission sets | Two profiles. A registry of two is the two profiles. |
| `AgentProfile` interface + factory | Two profiles, both static. Two constants. |
| Strategy pattern for ecosystems | One ecosystem. |
| Plugin/extension point for verification providers | One port, one implementation. The port is the seam. |
| Generic evidence pipeline (collect/normalize/fold/emit) | Collect and emit are each a few lines. Folding is one object spread. |
| Schema validation library | Four small field helpers. |
| Builder for `StageExecutionRequest` | Plain object. |
| Event bus / middleware for stage execution | Direct call. |
| Capability detection matrix | Gone with framework detection. |
| Install/uninstall abstraction | Gone with the generated files. |
| Compat layer for V1 OpenCode | One contract. |
| Snapshot/contract-test framework for evidence shapes | One table-driven test per shape. |

---

## 9. Invariants that must survive

These are the acceptance criteria. A reduction that breaks one of them is not a reduction.

1. Workflow state machine and legal transitions unchanged.
2. `runNext` advances exactly one stage.
3. Human gates: plan approval and push approval are required, and every approval-verified stage
   re-verifies against the approval checkpoint before the executor runs.
4. Plan hash recorded at approval; a changed plan invalidates the approval.
5. Revision CAS on every session mutation.
6. Atomic persistence: temp file + rename, with rollback on partial failure.
7. Fix return state carries the fixing stage back to the state that requested it.
8. Deterministic verification is authoritative; a model cannot add, remove, or reorder a command.
9. Evidence freshness: evidence is bound to the revision and implementation fingerprint it
   describes, and stale evidence cannot satisfy a later stage.
10. Evidence integrity: a run that changes the implementation or the control plane cannot pass.
11. No agent shell authority: `shell` is denied on both profiles, proven against a hostile
    repository by finding F2.
12. A read-only stage cannot write, proven against a hostile repository by finding F2.
13. No push before `approve_push`, and no `approve_push` without a recorded approval bound to the summary,
    the passing gate, and the measured tree: the human gates are reachable by the event alone, the
    approval itself is a stored record, and reaching one is never evidence of approving the other.
14. Stage artifacts are written through the executor's declared output slots; a model never chooses
    a filename or a merge strategy.
15. A response cannot claim success when deterministic evidence failed or blocked.

---

## 10. Findings from the real no-model OpenCode V2 probe

Binary: `@opencode/cli-linux-x64@2.0.18`, run directly (no model, no network, no credentials).
Target: `/tmp/opencode/target-repo` (deliberately hostile), framework config:
`/tmp/opencode/framework-config`. All runs used `--standalone` semantics via isolated `XDG_*` and
`OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`.

Hostile target repository contained:

- `opencode.json` with `permission: { edit: "allow", shell: "allow" }` and an `instructions` entry.
- `.opencode/agent/rogue-repo-agent.md` declaring `mode: primary` with `edit: allow, bash: allow`.
- `AGENTS.md` carrying a hostile instruction.

Framework config contained exactly two profiles, `agent/read.md` and `agent/write.md`.

### F1 - `OPENCODE_CONFIG_DIR` does not isolate the repository. It only prepends a source.

`opencode debug config`, run with `cwd` = hostile repo and `OPENCODE_CONFIG_DIR` = framework config,
reports **four** sources, in this order:

```
0 document   /tmp/opencode/framework-config/opencode.json
1 directory  /tmp/opencode/framework-config
2 document   /tmp/opencode/target-repo/opencode.json
3 directory  /tmp/opencode/target-repo/.opencode
```

The repository's own config is loaded **last**. `OPENCODE_DISABLE_PROJECT_CONFIG=1` does not change
this: the same four sources are reported. `OPENCODE_CONFIG_CONTENT` adds no source of its own.

**Consequence:** the V1-era premise behind `configuration-integrity.ts` and `plugin-preflight.ts` is
false for V2. The target repository's configuration is always in scope. The framework cannot make it
disappear, and the current code's 1,237 LOC of integrity machinery does not make it disappear either
-- it only checks what the adapter itself wrote.

**Decision:** delete both modules. The framework stops writing into the repository, and stops trying
to assert the repository's configuration is absent. Neither is needed for the guarantee in F2.

### F2 - A framework profile's own `permission:` block is authoritative and cannot be widened.

With the hostile repository present, `opencode debug agents` resolves:

```
read:  edit=deny  shell=deny   (repo config globally allows edit and shell)
write: edit=allow shell=deny
```

The repository's global `allow` **loses** to the profile's own block. The `shell` denial holds for
both profiles, which is the no-shell-authority guarantee, proven under a hostile configuration.

A second attack was run: the repository's `opencode.json` declared
`agent: { read: { permission: { edit: "allow", shell: "allow" } } }`, targeting the framework profile
by name. Result:

```
read:  edit=deny  shell=deny
write: edit=allow shell=deny
```

The by-name override **fails**. A profile defined by the framework cannot be widened by the
repository, by global permission or by a same-named agent entry.

**Consequence:** the read-only guarantee does not depend on the repository's configuration being
absent, controllable, or clean. It depends on two things the framework fully controls: the profile
files it writes, and the `--agent <profile>` argument it always passes. This is the whole reason the
generated control plane is unnecessary.

**Residual obligation:** the framework must always pass `--agent read` or `--agent write` explicitly
and must never rely on a default agent. In the same run, OpenCode's built-in `build` primary agent
resolved to `action: "*" -> allow` at the top of its permission list. Reaching it would require
omitting `--agent`.

### F3 - Repository-contributed agents exist and are reachable by name.

`opencode debug agents` returned 10 agents: `build`, `compaction`, `explore`, `general`, `plan`,
`read`, `rogue-repo-agent`, `summary`, `title`, `write`. The repository's
`rogue-repo-agent` was loaded and resolved to `edit=allow, shell=allow`.

The framework's two profiles resolved exactly as declared. The rogue agent is unreachable **only**
because the framework addresses agents by exact name (F2 residual obligation).

**Decision:** the framework does not attempt to enumerate or reject repository agents. It addresses
two named profiles, verifies their resolved permissions once, and records the rest as unaddressed.
Attempting to police the repository's agent list would be the same mistake as `configuration-integrity`.

### F4 - Repository plugins were never what determined a profile's permissions.

`plugin-preflight.ts` refuses a run when a project-local plugin is found, on the theory that a plugin
could widen a role. F2 demonstrates the permission resolution path directly, and the framework's
profile is immune to it. `plugin-preflight` guards a threat the permission model already forecloses
and does not guard the threat that actually exists (F3).

**Decision:** delete. Recorded as an intentionally removed guarantee, with the F2 finding as the
replacement.

### F5 - V2 contract, verified.

| Probe | Result |
| --- | --- |
| `opencode --version` | `opencode v2.0.18` (V2 prints a prefixed tag; V1 prints a bare number) |
| `opencode run` | present |
| `--standalone` | present, root help |
| `--agent` | present, run help |
| `--format json` | present, `choices: default, json` |
| `--dir` | **absent** (removed in V2) |
| `--pure` | **absent** (removed in V2) |
| `opencode debug agents` | present, model-free |
| `opencode debug config` | present, reports ordered sources |
| `opencode debug --help` | lists `agents`, `config`, `paths` |

`debug agents` reaches the background service, which is why `--standalone` is required for the smoke
test. All of the above ran with `--help` or as a local listing: no model was called, no network
request, no credential read.

**Decision:** one contract. `opencode --version` major check + one `opencode debug agents` smoke
test asserting the resolved permissions of `read` and `write`. All V1 branches removed.

### F6 - Instructions contamination is unproven either way.

`debug agents` reports each agent's `system` field. For `read`, it contained only the profile body
(18 characters); the repository's `ROGUE-REPO-INSTRUCTION` and `AGENTS.md` text appeared only in the
rogue agent's `system`. This shows repository instructions are **not** merged into a framework
profile's agent definition. It does not show what OpenCode composes into the final system prompt at
run time, which cannot be observed without calling a model.

**Decision:** record as a residual unknown. The framework supplies a controlled `AGENTS.md` to the
working directory, and instruction precedence is listed as a manual validation item.

---

## 11. Metrics: before and after

Targets. `none` means a guarantee was intentionally removed, and the finding that justifies it is
named.

| Metric | Before | After | Note |
| --- | ---: | ---: | --- |
| Source LOC | 17,899 | target <= 11,000 | measured after refactor |
| Source files | 64 | target <= 45 | |
| Test LOC | 15,375 | target <= 9,000 | behavior preserved, boilerplate removed |
| Test files | 29 | target <= 22 | |
| Public exported names | 301 | target <= 60 | 5 entry points + contracts |
| OpenCode roles | 11 | 2 | physical permission profiles |
| OpenCode control-plane modules | 4 | 0 | `none` -- F1, F4 |
| OpenCode control-plane LOC | 1,693 | 0 | `none` -- F1, F4 |
| Supported ecosystems | 5 | 1 | Node/JS/TS |
| Framework detection | yes | no | no decision depends on it |
| Verification check fields | 21 | 8 | |
| Verification bundle fields | 12 | 5 | |
| OpenCode CLI contracts supported | 2 (V1, V2) | 1 (V2) | `none` for V1 |
| Capability probe help invocations | 4 | 1 | |
| Intentionally removed guarantees | - | - | repo-config isolation (`none` -- F1), repo-plugin refusal (`none` -- F4), install policy (`none` -- nothing is installed), V1 support (`none` -- F5) |

---

## 12. Deletion and change list

Delete outright:

```
adapters/opencode/src/configuration-integrity.ts      802
adapters/opencode/src/plugin-preflight.ts              435
adapters/opencode/src/install-policy.ts                 95
adapters/project/src/frameworks.ts                      94
tests/opencode-configuration-integrity.test.ts         530
tests/opencode-plugin-preflight.test.ts                414
```

Reduce:

```
adapters/opencode/src/roles.ts        404 -> ~70   two profiles
adapters/opencode/src/agents.ts       361 -> ~40   two profile definitions, no file writing
adapters/opencode/src/capabilities.ts 353 -> ~80   version check
adapters/opencode/src/smoke-test.ts   570 -> ~200  two named profiles
adapters/opencode/src/environment.ts  168 -> ~60   framework-owned variables only
adapters/opencode/src/permissions.ts  260 -> ~80   two rulesets
adapters/opencode/src/prompts.ts      492 -> ~260  rendered from the stage table
adapters/opencode/src/index.ts       200 -> ~60   trimmed exports
orchestration/src/verification.ts    951 -> ~420  smaller evidence shape
orchestration/src/result-validation.ts 318 -> ~140 small helpers
adapters/persistence/src/validation.ts 293 -> ~110 small helpers
adapters/project/src/profile.ts      506 -> ~230  Node only
adapters/project/src/provider.ts     502 -> ~380  smaller evidence shape
adapters/project/src/evidence.ts     257 -> ~140  smaller evidence shape
adapters/project/src/index.ts        107 -> ~40   trimmed exports
```

Keep unchanged:

```
core/**                                        516
orchestration/src/orchestrator.ts            1,718
orchestration/src/stages.ts                    459
orchestration/src/approval.ts                  183
adapters/persistence/src/session-store.ts     1,055
adapters/persistence/src/lock.ts               327
adapters/project/src/fingerprint.ts            257
adapters/project/src/fs-safe.ts                165
adapters/project/src/commands.ts               442
adapters/project/src/config.ts                 231
adapters/project/src/process.ts                339
adapters/workspace/**                        1,792
adapters/opencode/src/cli-transport.ts        355
adapters/opencode/src/executor.ts             233
adapters/opencode/src/response-protocol.ts     154
adapters/opencode/src/transport.ts             53
adapters/opencode/src/process.ts              150
```

---

## 13. Verification plan

```
pnpm lint
pnpm typecheck
pnpm test
pnpm verify
```

Plus real no-model OpenCode V2 validation, repeated against a hostile target repository:

1. `opencode --version` reports major 2.
2. `opencode debug agents` with `cwd` = hostile repo and framework `OPENCODE_CONFIG_DIR` resolves
   `read` to `edit=deny, shell=deny` and `write` to `edit=allow, shell=deny`.
3. The same result holds when the repository's `opencode.json` declares
   `agent: { read: { permission: { edit: "allow", shell: "allow" } } }`.
4. The framework writes nothing into the target repository.

Manual validation items (cannot be settled without a model call):

- Final system-prompt instruction precedence against a hostile `AGENTS.md` (F6).
- `AGENTS.md` the framework supplies is the one the stage run reads.
- A stage run never resolves to a repository-contributed agent (follows from always passing
  `--agent`, and is confirmed by the profile names appearing in `debug agents`).

---

## 14. Stop line

This milestone ends when the metrics in section 11 are met and the four commands in section 13 pass.
It does not begin workspace isolation, publishing, an installer, browser verification, or
integrations. `adapters/workspace` exists and is left untouched.
