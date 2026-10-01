# Security review

The `security_review` stage is a gate. It runs after `runtime_verification` and before `final_gate`, and a feature that has not cleared it does not reach the final gate. What clears it is a deterministic record, not an opinion.

This document explains what the gate measures, who decides each part of the answer, what happens when it fails, and what it deliberately does not do.

## The trust model in one paragraph

A security review is a claim about a change set that a reader cannot check by reading the change. "This diff looks safe" is exactly the kind of claim that is worthless the moment it is made by the same thing that wrote the diff. So the reviewer — a model with no command execution and no file-reading tools — is handed a record of measurements that already happened, and asked to explain it. The framework applies that record whatever the reviewer returns. A reviewer that returns `success` about a failed check is overruled; a reviewer that returns `failed` about a clean record is heard. The asymmetry is deliberate: the model is trusted to say *what a finding means*, and is not trusted to say *whether there is one*.

## The port

```ts
interface SecurityReviewProvider {
  review(request: SecurityReviewRequest): Promise<SecurityReviewEvidence>;
}
```

The port is substitutable and is the only thing the framework believes. `createWorkflowOrchestrator({ security })` takes one; `@agent-workflow-kit/project` exports an implementation.

```ts
const orchestrator = createWorkflowOrchestrator({
  store,
  executor,
  workspace,
  verification,
  security: createProjectSecurityReviewProvider({ projectRoot }),
});
```

`security` is optional, but only in the way `verification` is: it may be absent from a workflow that never reaches the stage. **Reaching the stage without one is a refusal, not a pass.** The orchestrator returns `rejected` with `security_not_configured` and never calls the executor, because a stage whose only evidence is a model's description of a scan nobody performed is the outcome this gate exists to prevent.

## What is measured

The change set is measured by the workspace provider and handed to the provider as `changedPaths`, alongside the session revision, the resolved project root, the workspace identity, the approved scope, the protected patterns, and the workspace fingerprint. Every one of those is also in the record, so the record can be checked against the request that produced it.

Nine checks exist, and they are split by who is allowed to decide them.

| check | decided by | what it asks |
| --- | --- | --- |
| `hardcoded_secret` | provider | does an added file contain a credential-shaped literal |
| `credential_file` | provider | was a `.env`, `.npmrc`, keystore, or similar committed outside approved scope |
| `unexpected_executable` | provider | did an added path become executable, or arrive with a script suffix or shebang it did not need |
| `package_manager_hook` | provider | does a lifecycle script or install hook fetch and execute something |
| `shell_execution` | provider | does added code run a string through a shell or an interpreter |
| `command_restriction_weakened` | provider | does added code add a permissive escape hatch around a restriction — `--no-verify`, a negation pattern, a bypass flag |
| `permission_broadening` | provider | does an added workflow grant `write-all` or a privileged trigger |
| `protected_configuration_changed` | **framework** | is a framework-controlled path in the change set |
| `dependency_configuration_out_of_scope` | **framework** | is a manifest, lockfile, or CI definition in the change set that the approved plan never named |

A record has exactly one entry per check, and a provider that answers for a framework check is refused rather than believed. The framework's two checks are computed from the change set the workspace provider just measured and merged into the record after the provider returns, so a provider that declared every one of its own checks passed still produces a `fail` when a protected path is present.

`protected_configuration_changed` and `dependency_configuration_out_of_scope` are change-shaped and need no tooling, which is exactly why they live in the framework: a decision that requires only the change set is a decision the framework can make for itself, forever, rather than one it has to remember to ask for.

## What a result means

Three statuses, and only three.

| status | meaning |
| --- | --- |
| `pass` | every check passed |
| `fail` | at least one check failed |
| `inconclusive` | nothing failed, but at least one check could not be measured |

`fail` outranks `inconclusive` outranks `pass`. A known finding is a known finding no matter what else was left unmeasured, and reporting that as inconclusive would hand a confirmed problem to a human who then has to go looking for it.

`inconclusive` is a real state rather than a softer `pass`. An unreadable file, a symlink out of the project, and a file above the scan ceiling all produce it. The framework cannot say the change is clean when it could not read all of it, and it will not guess.

## How the status becomes an outcome

| record | reviewer returned | result |
| --- | --- | --- |
| `fail` | `success` | `needs_fix` — the gate overrules the reviewer |
| `inconclusive` | `success` | `inconclusive` — the stage stops for a human |
| `fail` | `failed` | `failed` — the reviewer's own reading stands |
| `fail` | `needs_fix` | `needs_fix` — reported, not overruled |
| anything else | anything | the reviewer's own outcome |

The one line worth dwelling on is the first. This stage is the only place in the workflow where a return value is discarded outright, and it is discarded in the direction that is harder to be wrong about: the framework will not let a clean-looking report stand on a tree that has a failed check in it.

A `needs_fix` from this stage is a genuine request for repair, which is different from a report. It enters `WorkflowState.Fixing` with `fixReturnState: SecurityReview` and comes back here, not to the final gate.

## Freshness and binding

A record is bound to the request that asked for it before the framework believes any of it. Seven things are compared: the stage, the session revision, the resolved project root, the workspace identity, the workspace fingerprint, the changed path set, and the approved scope. A well-formed record is easy to produce for the wrong tree, and a `pass` for the wrong tree is the one answer that cannot announce itself.

Two checks that are easy to confuse, and both exist:

- **Binding** catches a record whose *identity* does not match the request. A cached record returned verbatim after a fix names the old revision and is refused as `security_evidence_mismatch`.
- **Freshness** catches a record whose identity matches but whose *measurement* predates the last recorded fix. A provider that restamps its old answer with the revision it was asked about passes every binding check; only a comparison against the fix history catches it, and the refusal is `stale_security_evidence`.

The weaker consequence of either refusal is that the stage stops. The stronger one — treating a stale record as current — would report a repair as verified by the failure it was supposed to fix.

## What the fixer is given

A fix loop triggered by this stage carries `securityEvidence` and nothing else. `deterministicEvidence` is null, because the two artifacts are written by different stages and a loop has exactly one origin. Handing a fixer both records would mean asking it to guess which question it was answering, and the two have different remedies: a failing verification wants a line changed, while a failed security check often wants the feature to be smaller.

The contract also carries `failureReason` naming the failed check and its reason, `suspectedFiles` taken from the record's own paths rather than from anything the reviewer wrote, the approved scope, the attempt number, and the protected paths. `failureReasonFrom` and `suspectedFilesFrom` prefer the security record over both the model's account and the acceptance criterion, because a named path and a named pattern are facts about the tree while "this touched the wrong kind of file" is an interpretation.

## Protected paths are reported, not restored

Every stage other than the security review restores an unauthorized protected path and discards its result. The security review does not, and this is the one deliberate exception in the scope policy.

The gate's job is to look at changes it is not allowed to make itself. Restoring them before anyone reads them would destroy the evidence it exists to produce, and the reviewer would end up describing a clean tree while the record said otherwise. So the protected paths are excluded from the set handed to the restore, the stage result is discarded, and the refusal names them.

This is not a widening of scope. It subtracts from what gets restored rather than adding to what is allowed, every other stage is unaffected, and two independent gates still hold: every other stage refuses to write a protected path in the first place, and `protected_configuration_changed` fails the security review regardless of what the provider said. What the exception changes is only which form the refusal takes — a security finding naming the path, rather than a silent restore.

A protected configuration change is also not made approvable by amending the plan. Those files hold the acceptance criteria, the workflow state, and the framework's own configuration, so a change to one is a change to the rules the work is judged by. A human has to decide whether the edit should exist.

## Persistence

Records are written under `deterministic_evidence.security_review` in the `security_review` artifact — the same framework-owned key the verification evidence uses, never over a section the model wrote. Every attempt is appended rather than overwritten, so the artifact is a series of scans rather than a single answer, and `latestRecordedSecurityReview` reads the newest.

Read back off disk, a record is validated by `validateStoredSecurityReview`, which accepts both halves of the record and still requires each check to be labelled with the authority that owns it. `validateSecurityReviewEvidence` is the stricter one and is applied to what a provider returns. The split exists because a stored record necessarily contains the framework's merged checks, and a reader that refused those would make every persisted record unreadable and hand the fixer nothing to work from.

## Limits

Stated plainly, because a security gate that overstates itself is worse than none.

- **Current contents, not a diff.** The scanner reads files as they are now. A credential-shaped string in a modified file may predate this feature, and the reason on a failed check says so for exactly the paths that were modified rather than added. It does not try to attribute a line to a change it cannot see.
- **Pattern matching, not proof.** `hardcoded_secret` and `shell_execution` are regular expressions over plausible shapes. They will produce false positives on fixtures and sample data, and will not catch a secret that does not look like one. A pass means no known shape was found, not that the change is safe.
- **New paths get a bounded read.** Files above 2 MB are not read and produce `inconclusive` rather than a pass.
- **No reachability, no exploitability.** Nothing here establishes that a finding is exploitable. It establishes that the shape is present, which is the part a human cannot cheaply check by reading the change.
- **The approved scope suppresses path-shaped findings only.** A `.env` the plan named is not reported. Content checks — secrets, shell execution, hooks — run regardless of scope, because a plan that legitimately touches a `package.json` does not thereby authorize a postinstall that pipes a download into a shell.

The gate is a floor, not a ceiling. It fails a feature closed; it does not certify one open.
