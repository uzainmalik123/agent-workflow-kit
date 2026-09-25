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
- `approvePlan` / `approvePush` / `failFeature` apply the corresponding legal state-machine event. `approvePush` only moves the session to `committing`; no Git work exists.
- Usage and storage errors on `createFeature` and on the initial `load` of `runNext` propagate as `PersistenceError`. Everything the orchestrator decides is returned as an `OrchestrationResult`.

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
| `fixing` | `fixing` | `fixer` | none | `complete_fix` | no |
| `security_review` | `security_review` | `security_reviewer` | `security_review` | `advance` | yes |
| `final_gate` | `final_gate` | `final_gate_reviewer` | none | `advance` | no |
| `final_summary` | `final_summary` | `summarizer` | `final_summary` | `advance` | no |
| `awaiting_push_approval` | human gate | none | none | `approve_push` | no |
| `committing`, `pushing` | deferred | none | none | none | no |
| `complete`, `failed` | terminal | none | none | none | no |

`fixing` and `final_gate` produce no artifact: the storage layer owns the controlled filenames, and no slot exists for a fix note or a gate record.

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
| `static_verification`, `test_verification`, `runtime_verification` | `spec`, `plan`, `implementation` | `verification` |
| `security_review` | `spec`, `plan`, `implementation`, `verification` | `code_review`, `scope_review` |
| `final_gate`, `final_summary` | `spec`, `plan`, `plan_review`, `implementation`, `code_review`, `scope_review`, `verification`, `security_review` | none |
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

### Shared verification file

`verification.json` is shared by the three verification stages. To keep the filename unchanged, the orchestrator stores each stage's own result under a section named after the stage, merging into the existing envelope without interpreting its contents. A non-object `verification.json` is reported as `unmergeable_artifact` instead of being overwritten.

## Fix loop

1. A review or verification stage returns `needs_fix`; its artifacts are persisted and the legal `request_fix` event moves the session to `fixing`, recording the returning state.
2. The next `runNext` executes the `fixer` with the recorded `fixReturnState`, its report, the plan, and the implementation context, then applies `complete_fix`.
3. The returning stage is **not** marked as passed. A later `runNext` executes it again against the persisted state, and it must succeed on its own evidence.

`needs_fix` from a stage that is not fixable is rejected as `illegal_needs_fix`, so the graph can never record a fix for a state that cannot return.

## Human gates

`awaiting_plan_approval` and `awaiting_push_approval` return `status: "awaiting_human"` with `action: "approve_plan"` or `action: "approve_push"`, execute no stage, and commit nothing. Only the explicit `approvePlan` / `approvePush` calls apply the approval event, and an approval that is not legal in the current state is rejected as `illegal_transition`.

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
| `persistence_error` | durable storage prevented or obscured progress | see below |
| `terminal` | the feature is `complete` or `failed` | none |

Failures are classified instead of collapsed: `workflow` (a legal-decision problem, including a reported stage failure), `executor` (a throw or an unusable result), and `persistence` (storage could not keep up). Only `failFeature` moves a feature to the terminal `failed` state; no exception and no stage result can terminate a feature.

## Persistence recovery

`FeatureSessionStore.transition` persists `session.json` before appending `events.jsonl`, so a transition can throw after the session already advanced. The orchestrator therefore previews every event on a `WorkflowStateMachine` to know the exact expected snapshot, attempts the transition once, and never retries it blindly. After any ambiguous failure it reloads the authoritative session and compares snapshots:

- match -> `persistence_error` with `committed: true` and `persistence_transition_committed`; the caller continues from the already-advanced state.
- no match -> `committed: false` and `persistence_transition_not_committed`; the stage is retryable.
- unreadable -> `persistence_verification_failed`; nothing is assumed.

Artifacts are written before the transition, so durable state never claims progress it did not record. A stage result is also discarded if the session moved while the executor was running (`state_conflict`).

## Deferred

No AI model, OpenCode, Freebuff, project command, Git operation, or third-party skill is used or simulated. `runUntilBlocked()` is deliberately not implemented: it belongs on top of `runNext` once the one-stage guarantee is trusted in production use.
