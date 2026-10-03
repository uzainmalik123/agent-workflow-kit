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
const orchestrator = createWorkflowOrchestrator({ store, executor, maxFixAttempts });

await orchestrator.createFeature({ featureId, title, request?, slug? });
await orchestrator.runNext(featureId);
await orchestrator.approvePlan(featureId);
await orchestrator.approvePush(featureId, { actor });   // actor is optional and recorded verbatim
await orchestrator.failFeature(featureId);
```

- `createFeature` creates the session in `draft` and, when a request is supplied, writes `request.md`. It never transitions.
- `runNext` performs **at most one** work stage. It never loops, never approves anything, and never calls a second stage in the same call.
- `publishFeature` runs one publishing step: the first call commits and reports `committed`, the second pushes and reports `published`. It is the only entry point to `committing` and `pushing`, it runs no stage, and it never runs both steps in one call. See [Publishing](#publishing).
- `approvePlan` / `approvePush` / `failFeature` apply the corresponding legal state-machine event. Each records a durable checkpoint rather than only moving the session. See [Approvals](#approvals).
- `approvePush` records a `PushApprovalRecord` bound to the summary it was given, the gate that certified it, and the working-tree fingerprint measured at that moment. It refuses rather than records anything when the evidence is stale, and it never refreshes an approval.
- `maxFixAttempts` bounds one repair loop per origin stage and defaults to `MAX_FIX_ATTEMPTS`. `workspace`, `verification`, and `security` are optional; without them the framework records that it measured nothing rather than passing for a clean run. See [Fixer trust model](#fixer-trust-model) and [Security review](#security-review).
- Usage and storage errors on `createFeature` and on the initial `load` of `runNext` propagate as `PersistenceError`. Everything the orchestrator decides is returned as an `OrchestrationResult`.

Every decision the orchestrator makes is a single persistence mutation carrying the revision it read, so a caller may drive the same feature from several processes and a losing writer is told so instead of overwriting the winner.

### Stage executor port

```ts
interface StageExecutor {
  execute(request: StageExecutionRequest): Promise<StageExecutionResult>;
}
```

A request carries the session identity, the current state, the stage and role, the routed context artifacts, the artifact slots the stage may fill, the pending `fixReturnState`, the workspace it may work in, the deterministic evidence collected for the stage, and `fix: FixerInputContract | null` — the whole of a fixer's authority, present exactly when the stage is `fixing`. An executor may not receive the whole history, may not name a file, and may not request a transition: it can only answer with a structured outcome.

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

`draft` and `spec_ready` are passive checkpoints, the two approval states are human gates, `committing` and `pushing` run publishing steps rather than work stages, and `complete` and `failed` are terminal. The workflow graph already represents `Grill -> resolved specification -> Plan`: the `grill` stage emits `grill.json` **and** `spec.json` before the legal `advance` into `spec_ready`, and `spec_ready` executes no work. `WorkflowState` is unchanged by this package.

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
| `final_gate` | `final_gate` | `final_gate_reviewer` | `final_gate` (framework) | `advance` | no |
| `final_summary` | `final_summary` | `summarizer` | `final_summary` (framework) | `advance` | no |
| `awaiting_push_approval` | human gate | none | none | `approve_push` | no |
| `committing` | `publishFeature` (commit step) | none | `publish` (framework) | `publish_commit` | no |
| `pushing` | `publishFeature` (push step) | none | `publish` (framework) | `publish_push` | no |
| `complete`, `failed` | terminal | none | none | none | no |

Two artifacts are framework-written rather than agent-written, and neither appears in a stage's `outputs`:

- `final_gate` is the passing `FinalGateResult`, written in the same mutation as the `advance` out of `final_gate`. It exists so that the stages after it — the summary and the approval — have a verdict to point at rather than re-deriving one, and so that a summary can be refused when no usable verdict is recorded.
- `final_summary` is composed from the recorded artifacts by `buildFinalSummary`, in the same mutation that records it. The `summarizer` role still runs read-only with its context, and has no slot to write.

`fixing` produces exactly one: the fixer report, which the orchestrator records in the controlled `fixes.json` history rather than letting a stage write it.

A third framework-written artifact appears after the publishing approval rather than in a stage's `outputs`: `publish` is the record of what was published, written once as `committed` and rewritten as `pushed`. See [Publishing](#publishing).

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
2. The next `runNext` builds a `FixerInputContract`, executes the `fixer` against it, measures what it did, and applies `complete_fix` if the attempt was accepted.
3. The returning stage is **not** marked as passed. A later `runNext` executes it again against the persisted state, and it must succeed on its own evidence.

`needs_fix` from a stage that is not fixable is rejected as `illegal_needs_fix`, so the graph can never record a fix for a state that cannot return.

### Fixer trust model

The fixer is the only stage that writes, and the only stage whose job is to make a failing check stop failing. That combination is the whole problem: an agent that may edit code can also remove the evidence that the code was broken, widen its own goal, and report success. The framework's answer is that the fixer is given authority and given nothing else. `FixerInputContract` names the failing stage, the failure summary, the deterministic evidence that decided it, the criteria those checks assert, the paths it may write, the paths it may not, which attempt this is, and how many attempts remain. It has no field for the acceptance criteria, the verification commands, the workflow state, or the approval checkpoint, because those are not the fixer's to read and change.

What the fixer says about itself is never what is recorded. The attempt number, the outcome, the revisions, the changed paths, and the integrity digests are the framework's, measured after the executor returns; the fixer's own text survives only as a `report` claim inside the entry, beside the framework's verdict on it. A stage that cannot produce a measured attempt cannot write a history entry at all, so there is no shape in which an unmeasured record is defaulted into existence.

**Bounded attempts.** `maxFixAttempts` is a construction option, defaults to `MAX_FIX_ATTEMPTS` (5), and is counted per origin stage from the durable history — so one repair loop cannot spend another's budget, and a restart cannot reset it. A value that is not a positive integer is ignored in favour of the default, because a malformed configuration behaving exactly like no configuration is the only safe reading of "I did not say". The attempt after the limit is refused before the executor is called: the fixer is never asked to try again, and the feature fails with the limit named.

**What one attempt is measured against.** Four digests, taken from the persisted bytes rather than from anything the fixer said:

| surface | refused as |
| --- | --- |
| `spec.json`, `plan.json`, `plan-review.json` | `fix_target_modified` |
| the failing stage's recorded deterministic verification configuration | `fix_verification_config_modified` |
| a framework-controlled path: `.git`, `.agentflow`, `.opencode`, `opencode.json(c)`, `agent-workflow.config.json(c)` | `fix_protected_file_touched` |
| a verification check file, by path convention | `fix_check_removed` |
| any path the approved plan does not name | `fix_outside_approved_scope` |

Every rejection is named at once rather than first-one-wins, because a fixer that rewrote the plan and deleted a test file is one finding and not two.

A check file is recognized by convention — `*.test.*`, `*.spec.*`, `test_*`, `*_test.*`, `*_spec.*`, `conftest.*`, and `test`/`tests`/`spec`/`__tests__` directories — not by reading it, so the refusal is a statement about what the fixer touched and never a claim to have understood it. This is a path-and-hash boundary, not a semantic one: a fixer that satisfies a check by rewriting what the check asserts is visible to the approved-scope rule, and invisible to everything here. That limit is deliberate, and it is why a human still owns the goal.

**Nothing is restored after a refusal**, including for `fix_outside_approved_scope`. The rejection is the finding, and a framework that quietly put the files back would be deleting it while explaining that it kept it; restoring only the unauthorized paths while leaving the rest would produce a tree the fixer never wrote, which is a third thing, and not a finding at all. The fix guard runs before `#enforceScope`, so its verdict stands and the worktree keeps everything the attempt did. The refused attempt is appended to the history and the feature fails in one mutation, so the workspace, the history, and the result all describe the same refusal. An ordinary stage that wanders outside its scope is still reversed, because nothing about it is evidence and a clean tree is the useful outcome.

**Where a fix may write** follows from the loop it belongs to. `isApprovalVerifiedStage("fixing", hasApprovedPlan)` is the only place that question is answered: a fix sent back from `static_verification` has an approval behind it and runs in an isolated worktree at the approved commit, exactly like the stage that asked for it; a fix sent back from `plan_review` has none, so it reads the human's checkout `read_only` and is held to not writing to it at all.

**Attribution.** Before approval the workspace may already contain a human's uncommitted work, so the change set an attempt is answerable for is the difference between the tree as it looked before the executor ran and the tree as it looks now — after approval, in a worktree, that difference is the whole inspection. Blaming a fixer for edits the human made an hour ago would fail a feature over something nobody in the loop did, and the audit trail would name the wrong author.

**Fresh evidence.** The returning stage is re-run and collects its own evidence, and a bundle is refused as `stale_verification_evidence` when it was collected before the fix was recorded or carries a revision at or below the one the fix was made against. A repair is proved by a check that ran afterwards, never by one that ran before.

### Fix history

The fixer's own report is required on every successful fix and is never written by the stage. The orchestrator appends the measured entry to `fixes.json` inside the same mutation that applies `complete_fix`:

```json
{
  "schemaVersion": 1,
  "fixes": [
    {
      "sequence": 1,
      "attempt": 1,
      "fixReturnState": "static_verification",
      "outcome": "accepted",
      "failureSummary": null,
      "recordedAt": "2026-04-05T06:07:08.000Z",
      "revisionBefore": 11,
      "revisionAfter": 12,
      "sessionRevision": 12,
      "implementationFingerprint": "...",
      "changedPaths": ["src/parser.ts", "src/token.ts"],
      "integrity": {
        "specSha256": "...",
        "planSha256": "...",
        "planReviewSha256": "...",
        "verificationConfigSha256": "..."
      },
      "report": { "featureId": "F-001", "summary": "..." }
    }
  ]
}
```

A rejected attempt is written the same way, with `outcome: "rejected"`, the rejection named in `failureSummary`, and the paths it touched measured the same, in the same mutation that fails the feature.

Entries are append-only: a later fix never rewrites an earlier one, `sequence` counts them, and `sessionRevision` records the revision that carried the entry, so an audit can line a fix up with the exact state it was made against. Reading is as strict as writing, and for the same reason: a document that declares another schema version, is not a list, or holds an entry missing an outcome, a digest, or its place in the sequence is reported as `unmergeable_artifact` by entry position rather than overwritten, because overwriting it would destroy the record of what the fixer already did. The accumulated history is routed to the verification stages, `security_review`, `final_gate`, and `final_summary`.

## Human gates

`awaiting_plan_approval` and `awaiting_push_approval` return `status: "awaiting_human"` with `action: "approve_plan"` or `action: "approve_push"`, execute no stage, and commit nothing. Only the explicit `approvePlan` / `approvePush` calls apply the approval event, and an approval that is not legal in the current state is rejected as `illegal_transition` — including a publishing approval requested from any state other than `awaiting_push_approval`, which is refused before any evidence is even read.

## Approvals

There are two checkpoints, and they are not the same decision.

`approvePlan` records that a human agreed to build something. `approvePush` records that a human looked at what was built and agreed to publish it. Nothing implies the second: reaching `awaiting_push_approval`, having a summary, having passed a gate, and having approved the plan are four different facts, and none of them is an approval.

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

### Publishing approval

```ts
interface PushApprovalRecord {
  decision: "approved";            // a refusal is not a record, so nothing else is possible
  featureId: string;
  approvedAt: string;
  approvedRevision: number;
  actor: string | null;            // recorded verbatim; never derived, never required
  summarySha256: string;           // digest of the exact bytes of final-summary.md
  summaryRevision: number;
  workingTreeFingerprint: string;  // measured at approval time
  finalGateStatus: "passed";
  finalGateRevision: number;
  finalGateFingerprint: string;    // the tree the gate decided against
  finalGateSha256: string;
}
```

The record is written in the same mutation as the `approve_push` event, so there is no window in which the session is in `committing` without a record of why, or in which a record exists for a transition that was refused. It is bound to specific evidence, and each binding is checked:

| refusal | what it means |
| --- | --- |
| `final_gate_not_recorded` | No readable `final-gate.json`. There is no verdict to rely on, and one is not reconstructed on demand. |
| `final_gate_blocked` | The recorded gate did not pass. |
| `push_approval_stale` | The session revision is not the gate's plus the summary's (`PUSH_APPROVAL_REVISION_OFFSET`), or the tree no longer fingerprints as the gate found it. |
| `push_approval_already_granted` | An approval is already recorded. A second one would be recorded against evidence the first did not cover. |

Nothing here re-runs the gate or re-reads the work to decide whether it is good. The gate's answer is already recorded, and re-litigating it would give an approval a veto nobody asked it to review. The only recovery from a refusal is a new gate, a new summary, and a new approval; an approval is never silently refreshed, because a record that moves to follow the work is not a record of anything.

### Final summary

`final-summary.md` is the document a human is asked to read before deciding whether to publish, and it is composed by the framework from the recorded artifacts — not by a model. The `summarizer` role still runs read-only with its context; it simply has no output slot, so there is no second account of the same evidence for a human to be asked to choose between.

Deterministic and read-only in one property: `buildFinalSummary` takes parsed artifacts and a measured change set and returns a string. It reads no filesystem, runs no command, holds no clock, and writes nothing, so the same records always produce the same document and composing one cannot change any of them.

It may run only from a recorded passing gate, and writes `final-gate.json` back before the summary does:

| refusal | what it means |
| --- | --- |
| `final_gate_not_recorded` | No readable recorded gate, so there is no verdict to report and no evidence to be fresh against. |
| `final_gate_blocked` | The recorded gate did not pass. |
| `final_gate_evidence_stale` | The session revision is not the gate's plus the summary's, or the tree no longer fingerprints as the gate found it. A summary listing changed files is a claim about specific paths in a specific tree; when the tree has moved it is not written at all rather than written wrong. |

The document carries the feature identity, a description from the specification, the approved requirements, each plan step with what the measurement could support about it, the changed files with the category each was measured in, the per-stage verification results, the security and scope results, the fixer history, the current revision, the current working-tree fingerprint, and the gate result. Two rules govern what may appear in it:

- Nothing is invented. A section whose source is absent says `not recorded`, and an unmeasured tree says so rather than reading as an empty digest. In particular a plan step is never called complete: nothing in the records says so, so the summary reports which of the step's approved files the change set contains and leaves the judgement to the human.
- Everything is bounded. Every list is capped at `MAX_SUMMARY_ITEMS` and says how many entries it elided rather than silently dropping them.

## Workspace isolation

The orchestrator owns the policy and never touches a filesystem path itself. A `ProjectWorkspaceProvider`, supplied at construction and optional, is the only thing that may create, read, or clean up a working tree.

```ts
const orchestrator = createWorkflowOrchestrator({ store, executor, workspace });
```

`workspace` absent means the orchestrator runs every stage against `projectRoot` and records scope evidence with `measured: false`, so "nobody looked" can never be read as "nothing changed". It also means a fix is refused outright with `workspace_not_configured`, before the executor is called: a post-approval fix would otherwise be pointed at the human's checkout, and a pre-approval one would be recorded as having changed nothing when in fact nobody measured it. A repair the framework cannot measure is not one the workflow can accept.

A stage is either pre- or post-approval, and the difference is not a flag the executor can influence:

| stage | directory | access | `baseline` |
| --- | --- | --- | --- |
| `grill`, `planning`, `plan_review` | the human's checkout | `read_only` | `null` |
| everything after the plan gate | a worktree at the approved commit | `read_write` | the approved baseline |
| `fixing` | whichever of the two the loop it belongs to requires | as above | as above |

`fixing` is the only row that is not a property of the stage alone, so it is decided by `isApprovalVerifiedStage(stage, hasApprovedPlan)` rather than by a set. See [Fixer trust model](#fixer-trust-model).

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

## Publishing

Publishing is two steps, two states, and one approval that both of them re-check.

`approvePush` moves the session to `committing`; `publishFeature` is the only thing that runs from there. The first call writes the commit and reports `committed`, the second pushes the commit that was recorded and reports `published`. Each call does one thing, so a failure is never ambiguous about what had already happened: a `rejected` result from `pushing` means the commit exists in the repository and nothing was sent, and a `rejected` result from `committing` means nothing was written at all. `runNext` does not publish anything and refuses to run a stage in these states — reaching `complete` requires the push to have been confirmed by a remote.

Everything about *what* gets published is decided here, in the orchestration layer: the branch name, the commit message, the paths, the commit to push, and the remote. The port below is given a finished description of the work and asked to make it true, which keeps the half that has to understand a repository as small as the port allows. `publisher` is optional in the same way `workspace` is: a workflow that never reaches the states needs none, and a feature that reaches them without one is refused with `publisher_not_configured` rather than marked complete.

### Before anything is written

The approval is verified again at the commit step, not just at `approvePush`, because a summary that was approved twenty minutes ago and a tree that changed two minutes ago are two different subjects. Each of these is refused rather than reconciled:

| what moved | refusal |
| --- | --- |
| the final summary's bytes | `publish_summary_mismatch` |
| the gate verdict, its revision, its digest, or its fingerprint | `publish_approval_stale` |
| the session revision the approval was recorded at | `publish_approval_stale` |
| the working tree, in any path or category | `publish_tree_changed` |
| a path outside the approved scope | `publish_scope_violation` |
| an empty change set | `publish_change_set_empty` |
| a repository whose `HEAD` is no longer the approved commit | `publish_tree_changed` |
| a repair the gate has not re-tested | `publish_fix_unresolved` |

An approval itself is never refreshed into agreement: a new gate, a new summary, and a new approval are the only way past any of these. The same approval is verified a second time inside the mutation lock that records the result, so a tree that moved between the check and the write cannot be published by a check that has already been overtaken.

### What gets written

The branch is `agentflow/<feature-id>-<12 hex digits>` derived from the feature id and the approval, so the same approval always names the same branch — which is what makes a retry find the branch it created rather than collide with one. A name outside that namespace, or a reserved name inside it, is `publish_branch_unsafe`.

The commit message is `feat(<feature-id>): <title>` with trailers naming the feature, the summary and gate digests, the approval revision, and the actor who gave it. Those trailers are what a later attempt reads to decide whether a branch with that name is *this approval's* branch or somebody else's: if the tip carries them and sits directly on the approved commit it is reused, and otherwise it is `publish_branch_conflict`. Nothing is ever forced, so a branch that moved is `publish_branch_moved` and a remote that would need a force refuses the push.

`publish.json` records the whole thing: the branch, the commit, every path the commit contains, the two revisions it moved through, and `committed` or `pushed`. It is written once as `committed` and rewritten only after a remote confirmed the push, so a record naming a remote that never received the branch does not exist. A publisher that throws is `publish_publisher_failed`; a refusal it reports is mapped to the codes in the table above and a caller can branch on the code without reading the message.

### Publishing without a mechanism

The orchestrator runs no Git command. `FeaturePublisher` is a port with two methods, `commitFeature` and `pushBranch`, and `GitFeaturePublisher` is the implementation in the workspace adapter — which builds the commit with plumbing and a temporary index, so publishing leaves the isolated worktree's `HEAD` where the workspace provider expects to find it and a failed attempt can be retried in the same workspace. See `adapters/workspace/README.md`.

## Security review

`security_review` is a gate between `runtime_verification` and `final_gate`, and it is cleared by a deterministic record rather than by an opinion. `security` is optional in the same way `verification` is: absent from a workflow that never reaches the stage, and a refusal when the stage is reached without one.

```ts
const orchestrator = createWorkflowOrchestrator({ store, executor, security });
```

```ts
interface SecurityReviewProvider {
  review(request: SecurityReviewRequest): Promise<SecurityReviewEvidence>;
}
```

Before the executor runs, the framework asks the provider for a record of the change set and then does four things to it, in this order:

1. **Validates** it. Structural rules for the persisted artifact, plus two semantic ones: a status has to be the one its own checks support, and a provider may not answer for the framework's own checks.
2. **Binds** it to the request — stage, revision, resolved root, workspace identity, workspace fingerprint, changed paths, and approved scope. A well-formed record is easy to produce for the wrong tree, and a `pass` for the wrong tree is the one answer that cannot announce itself.
3. **Merges** the framework's own two checks, computed from the measured change set: `protected_configuration_changed` and `dependency_configuration_out_of_scope`. These are not negotiable by anything the provider said.
4. **Checks freshness** against the last recorded fix, so a cached answer restamped with the current revision cannot decide whether a repair worked.

The record is applied to the stage outcome whatever the executor returns:

| record | reviewer returned | result |
| --- | --- | --- |
| `fail` | `success` | `needs_fix` — the gate overrules the reviewer |
| `inconclusive` | `success` | `inconclusive` — the stage stops for a human |
| `fail` | `failed` or `needs_fix` | reported, not overruled |

This is the only stage in the workflow where a return value is discarded outright, and it is discarded in the direction that is harder to be wrong about. A `needs_fix` enters `WorkflowState.Fixing` with `fixReturnState: SecurityReview` and comes back here rather than to the final gate, carrying `FixerInputContract.securityEvidence` — the record that decided the failure, and `deterministicEvidence: null`, because a loop has exactly one origin.

Records are appended under `deterministic_evidence.security_review` in the `security_review` artifact, the same framework-owned key the verification evidence uses. `validateSecurityReviewEvidence` is applied to what a provider returns; `validateStoredSecurityReview` is applied on read-back and accepts both halves of the record, so a persisted record containing the merged framework checks is still readable.

One deliberate exception to the scope policy lives here: protected paths are **reported, not restored**, during this stage, because restoring them would destroy the evidence the gate exists to produce. The stage result is discarded and the refusal names them; every other stage is unaffected, and the framework-owned check fails the stage regardless of what the provider said.

Full detail, including the nine checks, who decides each, and the stated limits, is in [`docs/security-review.md`](../docs/security-review.md).

## Result contract

`OrchestrationResult` always reports `status`, `failureClass`, `fromState`, `state`, `committed`, `executedStages` (0 or 1), `stage`, `role`, `event`, `artifacts`, `action`, `fixReturnState`, `findings`, `evidence`, `verification`, `security`, `scope`, `fix`, and `error`.

`fix` is a `FixOutcomeSummary` and is null on every result that is not about a repair. On a `fixing` stage it carries the origin stage, the attempt, the limit, the outcome, the measured `changedPaths`, and the rejection codes — so a caller learns why a repair was refused without reopening `fixes.json`, and learns it from the same record the audit trail holds.

`security` is the deterministic security record for the run, and is null on every result that never reached the gate. That is not the same as an absent provider: reaching the gate without one is a `rejected` result, not a null field.

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
| `committed` | the publishing commit step succeeded | `publish_commit` |
| `published` | the push step succeeded | `publish_push` |
| `stage_failed` | the executor reported `failed` | none |
| `inconclusive` | the executor could not conclude; evidence is stored | none |
| `executor_error` | the executor threw | none |
| `rejected` | the result or the request violated the contract | none |
| `conflict` | another writer advanced the feature first | none |
| `persistence_error` | durable storage prevented or obscured progress | see below |
| `terminal` | the feature is `complete` or `failed` | none |

Failures are classified instead of collapsed: `workflow` (a legal-decision problem, including a reported stage failure), `executor` (a throw or an unusable result), `verification` and `security` (a deterministic gate was reached and could not produce a trustworthy record), `workspace` (the change set could not be measured), and `persistence` (storage refused the write or could not keep up). Only `failFeature` moves a feature to the terminal `failed` state; no exception and no stage result can terminate a feature.

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

No AI model, OpenCode, Freebuff, or third-party skill is used or simulated. A project command is run, but not by this package: it is run by a `VerificationProvider` implementation outside the orchestrator, and the orchestrator only collects, validates, enforces, and records the result. Git is likewise not run by this package: worktrees, leases, and restoration belong to a `ProjectWorkspaceProvider` outside it, and the commit and push belong to a `FeaturePublisher` outside it. The orchestrator decides the branch, the message, the paths, the commit, and the remote; it requests them, and records what came back. `runUntilBlocked()` is deliberately not implemented: it belongs on top of `runNext` once the one-stage guarantee is trusted in production use.

A lock is a directory created with an exclusive `mkdir` plus an owner record carrying a token, the owner `pid`, and the host, so a lock left behind by a dead process on this machine can be taken over without any age-based guesswork. It is deliberately **not** a distributed lock: it serializes writers on one machine, a lock held by another host is respected rather than reclaimed, and cross-machine coordination is the caller's problem to solve.
