# Orchestration

`@agent-workflow-kit/orchestration` is the workflow coordinator. It owns no state of its own: it reads the authoritative session from the persistence adapter, decides what work is allowed next, asks a `StageExecutor` port to perform exactly that work, validates the result, stores the produced artifacts, and applies the one legal workflow event that follows.

```
core            deterministic lifecycle rules
persistence     durable repository-local state
orchestration   state -> work -> artifacts -> legal transition
agent adapter   implementation of StageExecutor
project adapter implementation of VerificationProvider
```

The dependency direction stays one-way: `orchestration` depends on `core` and `persistence`; `core` never imports an adapter, an orchestrator, or a coding agent. A future agent adapter implements `StageExecutor` and depends on this package, never the other way around.

## API

```ts
const orchestrator = createWorkflowOrchestrator({ store, executor });

await orchestrator.createFeature({ featureId, title, request?, slug? });
await orchestrator.runNext(featureId);
await orchestrator.approvePlan(featureId);
await orchestrator.approvePush(featureId);
await orchestrator.failFeature(featureId);
```

- `createFeature` creates the session in `draft` and, when a request is supplied, writes `request.md`. It never transitions.
- `runNext` performs **at most one** work stage. It never loops, never approves anything, and never calls a second stage in the same call.
- `approvePlan` / `approvePush` / `failFeature` apply the corresponding legal state-machine event. `approvePlan` also records the approval checkpoint; `approvePush` only moves the session to `committing`, no Git work exists.
- Usage and storage errors on `createFeature` and on the initial `load` of `runNext` propagate as `PersistenceError`. Everything the orchestrator decides is returned as an `OrchestrationResult`.

Every decision the orchestrator makes is a single persistence mutation carrying the revision it read, so a caller may drive the same feature from several processes and a losing writer is told so instead of overwriting the winner.

### Stage executor port

```ts
interface StageExecutor {
  execute(request: StageExecutionRequest): Promise<StageExecutionResult>;
}
```

A request carries the session identity, the current state, the stage and role, the routed context artifacts, the artifact slots the stage may fill, and the pending `fixReturnState`. An executor may not receive the whole history, may not name a file, and may not request a transition: it can only answer with a structured outcome.

```ts
type StageOutcome = "success" | "needs_fix" | "failed" | "inconclusive";

interface StageExecutionResult {
  outcome: StageOutcome;
  featureId: string;
  stage: WorkStage;
  artifacts: readonly { name: FeatureArtifactName; content: unknown }[];
  findings: readonly ReviewFinding[];   // core contract
  evidence: readonly VerificationEvidence[]; // core contract
  summary: string | null;
}
```

## State -> stage -> artifact -> event

`draft` and `spec_ready` are passive checkpoints, the two approval states are human gates, `committing` and `pushing` are deferred to Git integration, and `complete` and `failed` are terminal. The workflow graph already represents `Grill -> resolved specification -> Plan`: the `grill` stage emits `grill.json` **and** `spec.json` before the legal `advance` into `spec_ready`, and `spec_ready` executes no work. `WorkflowState` is unchanged by this package.

| state | stage | role | required artifacts | event on success | fixable |
| --- | --- | --- | --- | --- | --- |
| `draft` | none | none | none | `advance` | no |
| `grilling` | `grill` | `griller` | `grill`, `spec` | `advance` | no |
| `spec_ready` | none | none | none | `advance` | no |
| `planning` | `planning` | `planner` | `plan` | `advance` | no |
| `plan_review` | `plan_review` | `plan_reviewer` | `plan_review` | `advance` | yes |
| `awaiting_plan_approval` | human gate | none | none | `approve_plan` | no |
| `implementing` | `implementation` | `implementer` | `implementation` | `advance` | no |
| `code_review` | `code_review` | `code_reviewer` | `code_review` | `advance` | yes |
| `scope_review` | `scope_review` | `scope_reviewer` | `scope_review` | `advance` | yes |
| `static_verification` | `static_verification` | `verifier` | `verification` | `advance` | yes |
| `test_verification` | `test_verification` | `verifier` | `verification` | `advance` | yes |
| `runtime_verification` | `runtime_verification` | `verifier` | `verification` | `advance` | yes |
| `fixing` | `fixing` | `fixer` | `fixes` (fix report) | `complete_fix` | no |
| `security_review` | `security_review` | `security_reviewer` | `security_review` | `advance` | yes |
| `final_gate` | `final_gate` | `final_gate_reviewer` | none | `advance` | no |
| `final_summary` | `final_summary` | `summarizer` | `final_summary` | `advance` | no |
| `awaiting_push_approval` | human gate | none | none | `approve_push` | no |
| `committing`, `pushing` | deferred | none | none | none | no |
| `complete`, `failed` | terminal | none | none | none | no |

`final_gate` produces no artifact: the storage layer owns the controlled filenames, and no slot exists for a gate record. `fixing` produces exactly one: the fixer report, which the orchestrator records in the controlled `fixes.json` history rather than letting a stage write it.

### Context routing

`required` artifacts must exist or the stage refuses to run; `optional` artifacts are routed only when present. Order is deterministic.

| stage | required | optional |
| --- | --- | --- |
| `grill` | none | `request` |
| `planning` | `grill`, `spec` | `request` |
| `plan_review` | `spec`, `plan` | `request` |
| `implementation` | `spec`, `plan` | `plan_review` |
| `code_review` | `spec`, `plan`, `implementation` | `plan_review` |
| `scope_review` | `plan`, `implementation` | `spec`, `plan_review` |
| `static_verification`, `test_verification`, `runtime_verification` | `spec`, `plan`, `implementation` | `verification`, `fixes` |
| `security_review` | `spec`, `plan`, `implementation`, `verification` | `code_review`, `scope_review`, `fixes` |
| `final_gate`, `final_summary` | `spec`, `plan`, `plan_review`, `implementation`, `code_review`, `scope_review`, `verification`, `security_review` | `fixes` |
| `fixing` (plan review) | `plan`, `plan_review` | `spec` |
| `fixing` (code review) | `spec`, `plan`, `implementation`, `code_review` | `scope_review`, `verification` |
| `fixing` (scope review) | `spec`, `plan`, `implementation`, `scope_review` | `code_review`, `verification` |
| `fixing` (any verification) | `spec`, `plan`, `implementation`, `verification` | `code_review`, `scope_review` |
| `fixing` (security review) | `spec`, `plan`, `implementation`, `security_review` | `code_review`, `scope_review`, `verification` |

`request` and `grill` are raw history: they reach the stages that create the specification and review intent, and never the stages that implement or verify it.

### Artifact validation

- Only artifact names in the stage's own output slots are accepted; a foreign or arbitrary name is rejected as `unexpected_artifact`.
- `success` and `needs_fix` must produce every declared artifact, exactly once.
- `failed` must produce nothing.
- `inconclusive` may produce a subset.
- A result must echo the requested `featureId` and `stage`, may only use the seven contract fields, and any attempt to smuggle workflow control (`event`, `nextState`, `transition`, `state`, `commit`, `push`, ...) is rejected as `executor_workflow_interference`.
- Filenames are still chosen by the persistence layer; the orchestrator only ever passes controlled artifact names.

### Controlled artifacts

Every output slot declares how its value becomes bytes:

| kind | meaning |
| --- | --- |
| `document` | the stage's value replaces the artifact |
| `section` | the stage's value is merged under `envelopeKey` of a shared envelope |
| `history` | the stage's value is appended to an orchestrator-owned list |

Only the persistence layer chooses filenames (`plan.json`, `verification.json`, `fixes.json`, ...).

### Shared verification file

`verification.json` is shared by the three verification stages. To keep the filename unchanged, the orchestrator stores each stage's own result under a section named after the stage, merging into the existing envelope without interpreting its contents. A non-object `verification.json` is reported as `unmergeable_artifact` instead of being overwritten.

### Deterministic verification evidence

A verification stage is only as good as the process results behind it, so the orchestrator asks a `VerificationProvider` for that stage's evidence and treats the answer as hard data rather than as an opinion. The port is deliberately tiny:

```ts
interface VerificationProvider {
  collect(request: VerificationRequest): Promise<VerificationEvidenceBundle>;
}
```

The orchestrator owns the timing, the validation, and the enforcement; the provider owns discovery, command selection, execution, and the records. A provider that throws, a bundle that fails validation, a bundle that contradicts itself, and a bundle that belongs to another request all stop the stage, write nothing, and are reported with the new `verification` failure class. `runNext` still performs at most one stage.

The provider is optional to construct and required to reach a verification stage. A session created without one is perfectly usable through every other stage, and the first time a verification stage comes up it fails closed with `verification_not_configured`: the stage executor is never called, nothing is written, and `executedStages` reports the empty list. The alternative, calling the executor with no evidence and letting a model describe the code instead, is the thing this milestone exists to remove.

Collection happens after the plan-approval freeze has been re-verified and before the stage executor is involved, which makes running project code a consequence of a human having approved work in this repository rather than something a workflow walk can trigger. The bundle reaches the verifier in the request, is rendered in full in the prompt, and is appended to `verification.json` under the framework-owned `deterministic_evidence` key, beside the model's own section and never over it, one append-only attempt per stage run.

The enforcement is one-directional and is applied by the orchestrator rather than by the prompt. A bundle whose outcome is `failed` or `blocked` turns a reported `success` into `needs_fix` and adds a finding naming each failing or blocked check, its command, and its exit code, whatever the verifier returned. A reported failure, fix request, or `inconclusive` on evidence that passed is left alone, because a reader who can see more than an exit code is worth hearing. A `deferred` stage is not a failure: runtime verification has no deterministic command yet, and treating a deferral as a failure would make the workflow unsatisfiable.

Each record carries the session revision it was collected for and a fingerprint of the working tree the command saw, so evidence from before a fix can never prove the code that fix produced, and a repair is verified by a fresh run rather than by an inherited result. Attempts accumulate; the newest is the only one a stage can turn on, because an earlier attempt describes a tree that no longer exists.

A bundle is bound to the request that asked for it before anything else happens to it. The verification stage, the session revision, the resolved project root, and each check's kind, revision, and fingerprint must all match, so a bundle from a completed session, a bundle from a session that has since moved on, a bundle collected against a different directory, and a bundle whose newest check is quietly from a different tree are each refused with `verification_evidence_mismatch`, before the executor runs and before anything is written. Binding is not validation and validation is not trust: the shape is checked first, then the identity, then the verdict, in that order.

The bundle also carries a workspace measurement: the fingerprint taken before the first command and the one taken after the last. Both are kept. A check carries the `before` digest, because that is the tree it ran against, and `workspace.changed` says whether that assumption survived. A command that rewrites the implementation it is verifying is a way to produce green exit codes about code that no longer exists, so a changed workspace forces `failed` on its own, with a finding naming both digests, and it is not waivable by a `passed` outcome or by anything the verifier says.

The bundle carries a control-plane measurement as well: the same bracketing, applied to `.agentflow/` and
`.opencode/` instead of the implementation. Those two are excluded from the workspace digest on purpose,
because neither is project code, which is exactly why a separate pair of digests is needed. A verification
command that writes to either is a command that reached into the framework, and a changed control plane
forces `failed` with a finding naming both digests, on the same terms as a changed workspace. A bundle
claiming `passed` or `deferred` over one is refused during validation, as is a bundle that carries no
control-plane measurement at all: a provider that measured nothing cannot report that nothing moved.

## Fix loop

1. A review or verification stage returns `needs_fix`; its artifacts are persisted and the legal `request_fix` event moves the session to `fixing`, recording the returning state.
2. The next `runNext` executes the `fixer` with the recorded `fixReturnState`, the report of the stage that asked for the fix, the plan, and the implementation context, then applies `complete_fix`.
3. The returning stage is **not** marked as passed. A later `runNext` executes it again against the persisted state, and it must succeed on its own evidence.

`needs_fix` from a stage that is not fixable is rejected as `illegal_needs_fix`, so the graph can never record a fix for a state that cannot return.

### Fix history

The fixer's own report is required on every successful fix and is never written by the stage. The orchestrator appends it to `fixes.json` inside the same mutation that applies `complete_fix`:

```json
{
  "schemaVersion": 1,
  "fixes": [
    {
      "sequence": 1,
      "fixReturnState": "code_review",
      "recordedAt": "2026-04-05T06:07:08.000Z",
      "sessionRevision": 12,
      "report": { "featureId": "F-001", "summary": "..." }
    }
  ]
}
```

Entries are append-only: a later fix never rewrites an earlier one, `sequence` counts them, and `sessionRevision` records the revision that carried the entry, so an audit can line a fix up with the exact state it was made against. A `fixes.json` that declares another schema version or is not a list is reported as `unmergeable_artifact` instead of being overwritten. The accumulated history is routed to the verification stages, `security_review`, `final_gate`, and `final_summary`.

## Human gates

`awaiting_plan_approval` and `awaiting_push_approval` return `status: "awaiting_human"` with `action: "approve_plan"` or `action: "approve_push"`, execute no stage, and commit nothing. Only the explicit `approvePlan` / `approvePush` calls apply the approval event, and an approval that is not legal in the current state is rejected as `illegal_transition`.

### Plan approval checkpoint

`approvePlan` freezes the approved plan in the same mutation that applies `approve_plan`, so the checkpoint can never disagree with the state it approved:

```ts
session.approvals.plan = {
  approvedAt, approvedRevision,
  specSha256, planSha256, planReviewSha256,
};
```

The digests are SHA-256 over the **exact persisted bytes** of `spec.json`, `plan.json`, and `plan-review.json`, not over a re-serialized object, so a whitespace or key-order change is also a change.

Every stage that runs after the approval (`implementation` and everything downstream) verifies the checkpoint before the executor is called and again while the result is being stored:

| condition | error |
| --- | --- |
| no checkpoint is recorded | `approval_missing` |
| an approved artifact is missing | `approval_evidence_missing` |
| an approved artifact no longer matches its digest | `approval_invalidated` |

A rejected approval never runs a stage, never stores a result, and leaves the checkpoint untouched: the orchestrator never re-approves on the caller's behalf. A human must approve again, which is only reachable by driving the feature back through the gate.

## Workspace isolation

The orchestrator owns the policy and never touches a filesystem path itself. A `ProjectWorkspaceProvider`, supplied at construction and optional, is the only thing that may create, read, or clean up a working tree.

```ts
const orchestrator = createWorkflowOrchestrator({ store, executor, workspace });
```

`workspace` absent means the orchestrator runs every stage against `projectRoot` and records scope evidence with `measured: false`, so "nobody looked" can never be read as "nothing changed".

A stage is either pre- or post-approval, and the difference is not a flag the executor can influence:

| stage | directory | access | `baseline` |
| --- | --- | --- | --- |
| `grill`, `planning`, `plan_review` | the human's checkout | `read_only` | `null` |
| everything after the plan gate | a worktree at the approved commit | `read_write` | the approved baseline |

`StageExecutionRequest.workspace` carries all of it, and the executor is given a directory to work in rather than being asked to find one.

**Before approval.** The orchestrator inspects the human's tree before and after each pre-approval stage and refuses a write. It reports the delta and changes nothing: the framework cannot attribute a difference to itself when it did not cause it, and reverting a human's unsaved work is worse than recording that a stage tried.

**At the gate.** `approvePlan` captures the baseline, and refuses on uncommitted tracked work with `workspace_dirty_baseline`, naming the paths. The provider's verdict is not the authority on that: a capture that claims a clean tree while listing dirty paths, or a dirty tree with no paths, is refused too, because both mean the answer cannot be relied on. Nothing is stashed, reset, or committed to get past it. The baseline is frozen in the same mutation that applies `approve_plan`, and carries the `workspaceId`, the full 40-character commit, and the session revision that approved it.

**After approval.** Before the executor is called, the framework reads the change set and decides authorization itself: a path is allowed only if the approved plan named a pattern that matches it, and `.git`, `.agentflow`, `.opencode`, `opencode.json(c)`, and the root `agent-workflow.config.json(c)` are refused regardless of what a pattern says. The exact unauthorized set goes to the adapter, which restores each path from the approved commit or deletes it, and reports what it actually achieved.

| the stage's effect | result |
| --- | --- |
| every change inside the approved scope | `stage_completed`, scope evidence recorded |
| a path outside it, reversed cleanly | `scope_violation`, the stage's result discarded, `restoredPaths` / `removedPaths` naming what was reversed |
| a path the adapter could not reverse safely | `scope_violation`, `unsafePaths` naming it, result discarded |
| `HEAD` moved, or anything staged | `rejected` with `repository_state_changed` and nothing touched |
| the workspace could not be opened or read | `rejected` with `workspace_unavailable` |

A moved `HEAD` is deliberately not a scope violation. It is a commit a stage made that nobody approved, and reporting it as a path problem would send a reader looking for the wrong evidence.

The workspace is opened once per stage and closed when the stage ends, including when the executor throws, because that is when a half-written worktree is most likely. `close` releases the provider's lease; it never removes the worktree, so a failed stage leaves its work on disk for a human to read and the next run of the feature to find. The orchestrator closes only a workspace it opened itself: closing the human's own checkout would be a request to tidy up files it does not own.

Every post-approval stage records a `WorkspaceScopeEvidence` alongside the result: the approved commit and patterns, every observed path, every unauthorized path, what was restored, removed, or left unsafe, the staged paths, the `HEAD`, and a fingerprint of the tree. It is evidence of what the framework saw, not an approval, and `measured` is there so an unmeasured record cannot pass for a clean one.

## Result contract

`OrchestrationResult` always reports `status`, `failureClass`, `fromState`, `state`, `committed`, `executedStages` (0 or 1), `stage`, `role`, `event`, `artifacts`, `action`, `fixReturnState`, `findings`, `evidence`, and `error`.

| status | meaning | transition |
| --- | --- | --- |
| `created` | the session was created | none |
| `stage_completed` | a work stage succeeded | `successEvent` |
| `advanced` | a passive checkpoint advanced | `advance` |
| `fix_requested` | a review or verification stage asked for a fix | `request_fix` |
| `awaiting_human` | a human gate is open | none |
| `gate_approved` | an approval was applied | `approve_plan` / `approve_push` |
| `feature_failed` | an explicit failure decision was applied | `fail` |
| `deferred` | the state has no work stage yet | none |
| `stage_failed` | the executor reported `failed` | none |
| `inconclusive` | the executor could not conclude; evidence is stored | none |
| `executor_error` | the executor threw | none |
| `rejected` | the result or the request violated the contract | none |
| `conflict` | another writer advanced the feature first | none |
| `persistence_error` | durable storage prevented or obscured progress | see below |
| `terminal` | the feature is `complete` or `failed` | none |

Failures are classified instead of collapsed: `workflow` (a legal-decision problem, including a reported stage failure), `executor` (a throw or an unusable result), and `persistence` (storage refused the write or could not keep up). Only `failFeature` moves a feature to the terminal `failed` state; no exception and no stage result can terminate a feature.

## Concurrency

The authoritative session carries a `revision`. It starts at `0` and every successful mutation increments it by exactly one, in the same atomic write that moves the state. Orchestration never mutates a session except through `FeatureSessionStore.mutate`, and the store offers no whole-session save or generic patch for anything to go around it with: a mutation plan may only carry `title`, `artifacts`, `approvals`, and `event`, and every other key is refused.

```ts
store.mutate(featureId, { expectedRevision, prepare });
```

The per-feature lock is held for the critical section only: the revision is re-checked inside the lock, `prepare` sees the state it is about to replace, and the lock is released before any executor, AI, or external call runs. The write order inside a mutation is artifacts, then `session.json`, then `events.jsonl`.

Lock ownership is real, not best effort. Each acquisition mints a unique `token` in the lock's `owner.json`, and release only removes the directory when that token is still the current owner's, so a writer whose lock was already taken over cannot delete the lock that replaced it. A lock is reclaimed only when it can be proven abandoned: a dead `pid` on this host, or an owner record that is missing or unreadable and whose directory has passed `staleAfterMs`. A live local `pid` is never reclaimed on age, and a lock owned by another host is never stolen, so a concurrent `runNext` fails fast as `persistence_lock_timeout` instead of corrupting the session.

That gives one guarantee for the one-stage rule: **a stale result can neither overwrite a newer artifact nor skip a stage.** A planner that executed against revision *n* and finishes after someone else committed revision *n + 1* gets `status: "conflict"`, `committed: false`, `error.code: "revision_conflict"`, and the persisted plan stays the winner's. The losing `plan_review` never happens, so `awaiting_plan_approval` still requires a real review of the plan that is actually stored. Nothing is retried automatically and no second stage is executed; the caller decides whether to re-run.

## Persistence recovery

`session.json` is persisted before `events.jsonl` is appended, so a mutation can throw after the session already advanced. The orchestrator therefore previews every event on a `WorkflowStateMachine` to know the exact expected snapshot and revision, attempts the mutation once, and never retries it blindly. After any ambiguous failure it reloads the authoritative session and compares the state **and** the revision:

- match -> `persistence_error` with `committed: true` and `persistence_transition_committed`; the caller continues from the already-advanced state.
- no match -> `committed: false` and `persistence_transition_not_committed`; the stage is retryable.
- a different revision -> `committed: false` and `persistence_transition_superseded`; another writer owns the progress now.
- unreadable -> `persistence_verification_failed`; nothing is assumed.

Artifacts are written before the transition, so durable state never claims progress it did not record, and a failed session write rolls the artifacts of that mutation back.

## Deferred

No AI model, OpenCode, Freebuff, or third-party skill is used or simulated. A project command is run, but not by this package: it is run by a `VerificationProvider` implementation outside the orchestrator, and the orchestrator only collects, validates, enforces, and records the result. Git is likewise not run by this package: worktrees, leases, and restoration belong to a `ProjectWorkspaceProvider` outside it, and the orchestrator only decides, requests, and records. `runUntilBlocked()` is deliberately not implemented: it belongs on top of `runNext` once the one-stage guarantee is trusted in production use.

A lock is a directory created with an exclusive `mkdir` plus an owner record carrying a token, the owner `pid`, and the host, so a lock left behind by a dead process on this machine can be taken over without any age-based guesswork. It is deliberately **not** a distributed lock: it serializes writers on one machine, a lock held by another host is respected rather than reclaimed, and cross-machine coordination is the caller's problem to solve.
