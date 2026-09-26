# Orchestration

`@agent-workflow-kit/orchestration` is the workflow coordinator. It owns no state of its own: it reads the authoritative session from the persistence adapter, decides what work is allowed next, asks a `StageExecutor` port to perform exactly that work, validates the result, stores the produced artifacts, and applies the one legal workflow event that follows.

```
core            deterministic lifecycle rules
persistence     durable repository-local state
orchestration   state -> work -> artifacts -> legal transition
agent adapter   future implementation of StageExecutor
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

The authoritative session carries a `revision`. It starts at `0` and every successful mutation increments it by exactly one, in the same atomic write that moves the state. Orchestration never mutates a session except through `FeatureSessionStore.mutate`:

```ts
store.mutate(featureId, { expectedRevision, prepare });
```

The per-feature lock is held for the critical section only: the revision is re-checked inside the lock, `prepare` sees the state it is about to replace, and the lock is released before any executor, AI, or external call runs. The write order inside a mutation is artifacts, then `session.json`, then `events.jsonl`.

That gives one guarantee for the one-stage rule: **a stale result can neither overwrite a newer artifact nor skip a stage.** A planner that executed against revision *n* and finishes after someone else committed revision *n + 1* gets `status: "conflict"`, `committed: false`, `error.code: "revision_conflict"`, and the persisted plan stays the winner's. The losing `plan_review` never happens, so `awaiting_plan_approval` still requires a real review of the plan that is actually stored. Nothing is retried automatically and no second stage is executed; the caller decides whether to re-run.

## Persistence recovery

`session.json` is persisted before `events.jsonl` is appended, so a mutation can throw after the session already advanced. The orchestrator therefore previews every event on a `WorkflowStateMachine` to know the exact expected snapshot and revision, attempts the mutation once, and never retries it blindly. After any ambiguous failure it reloads the authoritative session and compares the state **and** the revision:

- match -> `persistence_error` with `committed: true` and `persistence_transition_committed`; the caller continues from the already-advanced state.
- no match -> `committed: false` and `persistence_transition_not_committed`; the stage is retryable.
- a different revision -> `committed: false` and `persistence_transition_superseded`; another writer owns the progress now.
- unreadable -> `persistence_verification_failed`; nothing is assumed.

Artifacts are written before the transition, so durable state never claims progress it did not record, and a failed session write rolls the artifacts of that mutation back.

## Deferred

No AI model, OpenCode, Freebuff, project command, Git operation, or third-party skill is used or simulated. `runUntilBlocked()` is deliberately not implemented: it belongs on top of `runNext` once the one-stage guarantee is trusted in production use.

A lock is a directory created with an exclusive `mkdir` plus an owner record, so a lock left behind by a dead process can be taken over. It is deliberately **not** a distributed lock: it serializes writers on one machine, and cross-machine coordination is the caller's problem to solve.
