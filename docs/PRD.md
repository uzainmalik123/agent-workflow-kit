# Agent Workflow Kit — Single Truth PRD

**Document:** `PRD.md`  
**Product:** Agent Workflow Kit  
**Status:** Canonical product requirements document  
**Scope:** Milestones M0–M14 + productization P1–P6  
**Primary supported coding agent:** OpenCode  
**Future integrations:** Claude Code, Codex, Freebuff, and other compatible agent runtimes

---

## 1. Product Definition

### 1.1 What Agent Workflow Kit is

Agent Workflow Kit is a reusable developer tool that turns an AI coding agent from an open-ended code generator into one component inside a **structured, stateful, verifiable, approval-gated software-development workflow**.

The kit is designed to help a developer take a feature request from idea to a safely published Git branch/commit through a repeatable process:

```text
Feature Request
      ↓
GRILL
      ↓
SPEC
      ↓
PLAN
      ↓
PLAN REVIEW
      ↓
HUMAN PLAN APPROVAL
      ↓
IMPLEMENTATION
      ↓
CODE REVIEW
      ↓
SCOPE REVIEW
      ↓
STATIC VERIFICATION
      ↓
TEST VERIFICATION
      ↓
RUNTIME VERIFICATION
      ↓
FIXER LOOP (when necessary)
      ↓
SECURITY REVIEW
      ↓
FINAL GATE
      ↓
FINAL SUMMARY
      ↓
HUMAN PUSH APPROVAL
      ↓
FEATURE BRANCH
      ↓
COMMIT
      ↓
PUSH
      ↓
COMPLETE
```

The core product is **not** an AI model, not a replacement IDE, and not a second software-development framework. It is a workflow/orchestration layer that constrains, coordinates, records, verifies, and safely publishes work performed by coding agents.

### 1.2 Primary product promise

The product must make it materially easier for a developer to:

1. give an AI agent a meaningful feature request;
2. force the request through clarification and planning before implementation;
3. keep the agent inside explicit workflow and permission boundaries;
4. verify the resulting repository with deterministic checks rather than trusting agent claims;
5. automatically route failed work through a bounded fixer loop;
6. require explicit human approval at the important decision boundaries;
7. produce a trustworthy final summary tied to the exact repository state;
8. publish only the approved, verified result through protected Git operations.

### 1.3 Product audience

The primary user is a developer who already works with coding agents and wants faster development **without giving up structure, reviewability, verification, and control**.

The workflow is intentionally useful for a developer building real projects, not only for demos or toy repositories.

---

# 2. Product Principles / Non-Negotiables

These principles apply across every milestone and implementation detail.

## 2.1 Human decision authority

The human remains the authority for meaningful approval decisions.

The system must require explicit approval before:

- implementation starts after planning;
- repository publishing begins after final verification.

Agents cannot approve themselves, transition workflow state on their own, or manufacture an approval through response content.

## 2.2 Deterministic evidence is authoritative

Model output can propose, explain, review, or diagnose.

It must **not** be treated as proof that software works.

The authoritative gates are deterministic system evidence such as:

- repository state/fingerprint;
- configured static checks;
- configured tests;
- configured runtime checks;
- security verification;
- approval records;
- final-gate status;
- Git head/revision validation.

## 2.3 Core must be agent/vendor independent

The core workflow engine must not depend directly on OpenCode, Claude Code, Codex, Freebuff, or another vendor.

Agent runtimes are adapters behind a stable interface.

OpenCode is the first supported adapter and is the only production adapter required for the initial product release.

## 2.4 One workflow engine

CLI commands, adapters, tests, and integrations must use the existing orchestration/state machine.

The product must never grow a second independent workflow engine hidden inside a CLI or agent integration.

## 2.5 No arbitrary agent shell execution

Coding-agent execution must not become arbitrary shell execution selected by the model.

Agent invocations use structured argument arrays and `shell:false`.

The supported OpenCode profiles do not grant agent shell execution.

## 2.6 No automatic installation of agent-selected software

The workflow must not allow an agent to silently install packages, tools, plugins, or other executable software as part of its normal execution.

## 2.7 Protected publishing

The workflow must never turn successful model output into an unrestricted `git push` path.

Publishing is an explicitly gated, validated, protected operation.

---

# 3. Canonical Workflow

## 3.1 Workflow states

The canonical state machine contains:

```ts
export enum WorkflowState {
  Draft = "draft",
  Grilling = "grilling",
  SpecReady = "spec_ready",
  Planning = "planning",
  PlanReview = "plan_review",
  AwaitingPlanApproval = "awaiting_plan_approval",
  Implementing = "implementing",
  CodeReview = "code_review",
  ScopeReview = "scope_review",
  StaticVerification = "static_verification",
  TestVerification = "test_verification",
  RuntimeVerification = "runtime_verification",
  Fixing = "fixing",
  SecurityReview = "security_review",
  FinalGate = "final_gate",
  FinalSummary = "final_summary",
  AwaitingPushApproval = "awaiting_push_approval",
  Committing = "committing",
  Pushing = "pushing",
  Complete = "complete",
  Failed = "failed",
}
```

These states define the canonical lifecycle and must remain authoritative.

## 3.2 Workflow events

The canonical workflow events are:

```ts
export type WorkflowEvent =
  | "advance"
  | "request_fix"
  | "complete_fix"
  | "fail"
  | "approve_plan"
  | "approve_push";
```

## 3.3 Fix-return states

A fixer invocation must preserve where the workflow came from and return only to an explicitly valid origin:

- Plan Review
- Code Review
- Scope Review
- Static Verification
- Test Verification
- Runtime Verification
- Security Review

The workflow may not use an unrestricted arbitrary return state.

## 3.4 Success path

The normal feature-development path is:

`Draft → Grilling → SpecReady → Planning → PlanReview → AwaitingPlanApproval → Implementing → CodeReview → ScopeReview → StaticVerification → TestVerification → RuntimeVerification → SecurityReview → FinalGate → FinalSummary → AwaitingPushApproval → Committing → Pushing → Complete`

## 3.5 Failure path

A stage that fails validation or verification may route to `Fixing`.

The fixer is bounded and must return to the recorded stage origin, after which fresh verification is required.

Unrecoverable errors enter `Failed`.

## 3.6 Terminal states

`Complete` and `Failed` are terminal workflow states.

No successful final summary may bypass the final gate or push approval requirements.

---

# 4. Core Data Contracts

The workflow's persisted and in-memory domain model includes explicit contracts for requirements, acceptance criteria, plans, reviews, evidence, features, and workflow state.

## 4.1 Acceptance criteria

```ts
export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly verification: string;
}
```

Every meaningful requirement must be expressible as a concrete acceptance criterion with a corresponding verification description.

## 4.2 Requirements

```ts
export interface Requirement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
}
```

## 4.3 Plan steps

```ts
export interface PlanStep {
  readonly id: string;
  readonly description: string;
  readonly requirementIds: readonly string[];
  readonly expectedFiles: readonly string[];
  readonly verification: string;
}
```

A plan must connect implementation steps to requirements and expected repository changes.

## 4.4 Plan

```ts
export interface Plan {
  readonly featureId: string;
  readonly summary: string;
  readonly steps: readonly PlanStep[];
}
```

## 4.5 Review findings

```ts
export interface ReviewFinding {
  readonly featureId: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
}
```

## 4.6 Verification evidence

```ts
export type VerificationEvidenceKind =
  | "static"
  | "test"
  | "runtime"
  | "security";

export interface VerificationEvidence {
  readonly kind: VerificationEvidenceKind;
  readonly description: string;
  readonly reference?: string;
}
```

## 4.7 Verification result

```ts
export interface VerificationResult {
  readonly requirementId: string;
  readonly acceptanceCriterionId: string;
  readonly status: "passed" | "failed" | "inconclusive";
  readonly evidence: readonly VerificationEvidence[];
}
```

`inconclusive` must never be silently treated as success.

## 4.8 Feature

```ts
export interface Feature {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly state: WorkflowState;
  readonly requirements: readonly Requirement[];
  readonly plan?: Plan;
}
```

---

# 5. M0 — Foundation / Product Contract

M0 establishes the repository, product boundaries, architectural direction, and engineering rules required for everything that follows.

## M0 requirements

The product foundation must:

- define Agent Workflow Kit as a reusable coding-agent workflow harness;
- establish the core-first / adapter-based architecture;
- establish the canonical feature lifecycle;
- define explicit state/event contracts;
- separate deterministic workflow control from AI-agent output;
- establish tests as part of every milestone;
- preserve Git hygiene and reproducibility;
- favor incremental changes over large architecture rewrites;
- make security and verification first-class requirements rather than documentation-only claims.

---

# 6. M1 — Core Workflow State Machine

The core package must provide the authoritative state machine used by the entire product.

## M1 features

- canonical workflow states;
- canonical workflow events;
- legal transition enforcement;
- rejection of invalid transitions;
- explicit failure transitions;
- explicit fixer entry and completion transitions;
- plan approval transition;
- push approval transition;
- deterministic state transitions that do not depend on an agent's claimed state.

---

# 7. M2 — State Restoration / Snapshot Integrity

The workflow state machine must be restartable and persistable without losing invariants.

## M2 features

### M2.1 Workflow snapshot

```ts
WorkflowMachineSnapshot {
  state;
  fixReturnState?;
}
```

The state machine must:

- construct from a valid snapshot;
- restore state after process restart;
- validate that `Fixing` has a valid `fixReturnState`;
- reject stale `fixReturnState` data when the state is not `Fixing`;
- test state/event combinations comprehensively, including invalid combinations.

---

# 8. M3 — Persistence Layer

Persistence must provide durable workflow artifacts without coupling the core domain model to a concrete filesystem implementation.

## M3 features

- dedicated persistence adapter/package;
- durable session storage;
- artifact storage for workflow stages;
- request artifact;
- grill artifact;
- specification artifact;
- plan artifact;
- plan-review artifact;
- implementation artifact;
- code-review artifact;
- scope-review artifact;
- verification artifact;
- security-review artifact;
- final-summary artifact;
- fixer/history artifacts;
- revision-aware persistence;
- atomic mutation/rollback behavior;
- cleanup of partially created artifacts;
- path safety;
- symlink-aware safety checks;
- concurrency locking;
- stale lock handling/reclamation under explicit safe rules;
- feature/session isolation;
- persistence validation on read.

The core package must remain filesystem-independent; storage concerns belong in adapters.

---

# 9. M4 — Generic Orchestration

The orchestrator coordinates stages without embedding a vendor-specific agent implementation.

## M4 features

- generic `StageExecutor` abstraction;
- stage execution request/result contracts;
- restricted context routing between stages;
- no vendor imports in core orchestration;
- optimistic/CAS revision checks using expected revision values;
- prevention of stale stage execution;
- plan-approval digest/hash binding;
- fix history tracking;
- deterministic routing of failed stages into the fixer;
- explicit return-to-origin behavior after fixing;
- workflow lock ownership using owner token, PID, hostname, and creation time;
- safe lock reclaim rules;
- persisted workflow recovery after process interruption.

---

# 10. M5 — OpenCode Adapter

OpenCode is the first supported coding-agent runtime.

## M5 features

### 10.1 Adapter boundary

OpenCode-specific behavior must be contained in an adapter package and must not leak into the workflow core.

### 10.2 OpenCode invocation

The adapter must support real OpenCode V2 execution and use the structured invocation form equivalent to:

```text
opencode run --standalone --agent <agent> --format <default|json> [--model] [prompt]
```

The process must run with the intended repository working directory.

The implementation must not rely on unnecessary `--dir` or `--pure` behavior.

### 10.3 Transport

- NDJSON/event-stream parsing;
- structured process transport;
- bounded handling of process output;
- explicit error classification;
- useful version/capability discovery;
- response parsing without allowing model output to control workflow state.

### 10.4 Capability probing

The adapter must detect and record supported OpenCode capabilities rather than blindly assuming them.

### 10.5 Profile-based permissions

The OpenCode integration ultimately uses two physical permission profiles:

- `agentflow-read`
- `agentflow-write`

Logical workflow roles map onto these profiles.

The profiles must preserve the framework's security restrictions:

- read profile can inspect the project;
- read profile cannot edit;
- read profile cannot use shell execution;
- read profile cannot escalate to subagents;
- write profile can make required file edits;
- write profile cannot use arbitrary shell execution;
- write profile cannot escalate to subagents;
- external/tool restrictions remain enforced.

Every invocation must explicitly select the intended physical profile.

### 10.6 Repository control-plane isolation

OpenCode control-plane runtime configuration must not depend on repository-local generated framework configuration.

The runtime configuration is written to a framework-controlled external temporary directory equivalent to:

```text
<tempdir>/agent-workflow-kit/opencode-<sha256(repo-path)>/
```

with generated:

```text
agent/agentflow-read.md
agent/agentflow-write.md
opencode.json
```

The target repository must not be required to contain framework-generated OpenCode profiles.

The adapter must:

- force the framework-controlled `OPENCODE_CONFIG_DIR` after environment sanitization;
- reject unsafe environment/configuration boundaries;
- prevent repository-defined profile shadowing;
- prevent repository configuration from overriding framework control-plane boundaries;
- preflight repository plugin locations before execution;
- refuse unsafe repository plugin/configuration behavior.

### 10.7 Project plugin preflight

The adapter must inspect relevant repository plugin locations, including equivalents of:

- `.opencode/plugin`
- `.opencode/plugins`
- `plugin`
- `plugins`

Safe empty/text-only directories and supported non-plugin project content may be permitted; executable repository-controlled plugin code that could compromise framework assumptions must be rejected or blocked according to the installed policy.

### 10.8 Structured response protocol

Agent output must be parsed through a constrained structured protocol.

The adapter must reject attempts to smuggle workflow-control fields or state transitions through ordinary agent responses.

The adapter does not approve stages and does not decide workflow transitions.

---

# 11. M6 — Deterministic Project Verification

The project adapter provides deterministic verification independent of model claims.

## M6 features

### 11.1 Verification configuration

Repositories use a versioned configuration equivalent to:

```text
agent-workflow.config.json
```

with schema versioning and explicit verification configuration.

### 11.2 Package-manager support

The verification system supports the project's declared/recognized package manager from:

- pnpm;
- npm;
- yarn;
- bun.

### 11.3 Command safety

Verification commands must:

- use structured argv;
- run with `shell:false`;
- avoid direct shell-string interpolation;
- have bounded output capture;
- have explicit timeout limits;
- support cancellation via `AbortSignal` where applicable;
- reject arbitrary mutating/install lifecycle behavior as part of the verification policy;
- avoid letting the repository redefine framework control behavior through unsafe command selection.

### 11.4 Static verification

Run deterministic configured static checks such as the repository's type checking, linting, build/static-analysis commands as allowed by the configuration.

### 11.5 Test verification

Run deterministic configured tests and capture exit status, bounded output, and evidence metadata.

### 11.6 Evidence binding

Verification evidence must be bound to the workflow session/revision and a SHA-256 fingerprint of the relevant working tree.

Evidence must not be reused as proof after the repository has changed.

### 11.7 Working-tree fingerprinting

The fingerprint system ignores known framework/build/cache artifacts such as:

```text
.agentflow
.git
caches
.opencode
.next
build
coverage
dist
node_modules
target
venv
```

The fingerprint is designed to represent source state rather than volatile generated data.

### 11.8 Verification result semantics

A failed or inconclusive check cannot be promoted to success merely because the agent claims success.

### 11.9 Verification subprocess environment security

Repository-controlled verification commands must **not inherit the operator's full host environment by default**.

The implementation must use a safe default environment policy, preferably a minimal allowlist, while preserving only environment variables genuinely required for deterministic project execution.

Credential-bearing host variables such as cloud/API credentials, access tokens, signing secrets, and unrelated operator secrets must not be passed into repository-controlled verification processes by default.

This applies to both normal verification and runtime verification subprocesses.

---

# 12. M6.1 — Verification Hardening

M6.1 hardens the deterministic verification layer without weakening its security model.

## Requirements

- preserve package-manager/framework discovery;
- preserve bounded subprocess execution;
- preserve evidence revision/fingerprint binding;
- reject dangerous lifecycle/install behavior;
- improve deterministic configuration validation;
- strengthen file/path safety;
- preserve explicit handling of missing configuration;
- make verification failures diagnosable and routeable to fixing;
- preserve regression tests and fixture coverage.

---

# 13. M7 — Workspace Isolation and Complexity Reset

The workflow must protect the repository being developed while allowing implementation, verification, and publishing to operate on controlled workspace state.

## 13.1 Workspace abstraction

A workspace provider abstracts creation/opening/closing/management of isolated development workspaces.

## 13.2 Git worktree isolation

Implementation/publishing work must use a controlled Git worktree/workspace rather than blindly mutating the user's main checkout.

## 13.3 Lease management

Workspace leases must identify ownership and prevent conflicting concurrent workflow operations.

Lease metadata includes enough information to identify owner/process/time context and safely recover stale state.

## 13.4 Sidecar management

Workspace state may use a framework-controlled sidecar so workflow metadata does not pollute source directories.

## 13.5 Scope enforcement

Changes must be constrained to the approved repository/workspace scope.

The framework must detect and reject inappropriate repository/root/workspace mismatches.

## 13.6 Workspace baseline

An approved baseline is captured and later compared to the repository/workspace under execution.

The workflow must refuse to continue when the baseline cannot be trusted.

## 13.7 Two physical OpenCode profiles

The final M7 architecture intentionally collapses the physical OpenCode execution surface to two profiles while retaining logical stage roles.

This reduces configuration complexity while preserving per-stage authority.

## 13.8 External OpenCode runtime configuration

As described in M5, OpenCode control-plane files must live outside the target repository.

The runtime config directory must be derived deterministically from the repository identity/path and created safely.

## 13.9 Complexity principle

The product must prefer a small number of well-defined capabilities over multiplying agents, profiles, configuration files, or abstractions without a demonstrated need.

---

# 14. M8 — Deterministic Runtime Verification

M8 adds verification that the implemented project actually runs when the feature requires runtime behavior.

## 14.1 Runtime configuration

Runtime verification must use explicitly declared project runtime configuration.

The framework must **not guess** ports, scripts, routes, health endpoints, or startup commands.

## 14.2 Supervised process execution

Runtime processes must be launched through the existing bounded process runner.

Requirements:

- `shell:false`;
- controlled argv;
- bounded output;
- explicit timeout;
- cancellation/termination support;
- proper cleanup.

## 14.3 POSIX process-group cleanup

On supported POSIX systems, the runtime process must use process-group-aware cleanup so child processes are not accidentally left running.

## 14.4 Readiness vs acceptance

Readiness and acceptance are separate concepts.

A process becoming available is not itself proof that the feature works.

## 14.5 Deterministic HTTP acceptance

Where runtime verification uses HTTP:

- use explicitly configured URL/route;
- do not silently follow redirects;
- bound response size/body capture;
- record deterministic result evidence;
- distinguish connection/readiness errors from acceptance failures.

## 14.6 Missing runtime configuration

Missing runtime configuration produces a deferred/inconclusive outcome, **never a false success**.

The resulting workflow state must make the limitation explicit and route appropriately according to policy.

## 14.7 Runtime failures enter the fixer loop

When runtime acceptance fails, the workflow must route the failure through the bounded fixer process and then perform fresh verification.

## 14.8 Fresh evidence

A runtime verification result must refer to the current revision/fingerprint and cannot satisfy a later gate after the source changes.

## 14.9 Runtime fixture coverage

The product must include a disposable fixture application/test path proving the runtime verifier works end to end.

Browser automation is not part of this requirement.

---

# 15. M9 — Fixer Hardening

The fixer exists to recover from real verification/review failures without becoming an unrestricted autonomous coding loop.

## M9 features

- bounded number of fix attempts;
- deterministic fixer routing;
- immutable original requirements;
- immutable acceptance criteria;
- immutable verification configuration;
- protected framework configuration/files;
- anti-cheating checks;
- prevention of changing verification rules merely to obtain a pass;
- prevention of changing protected configuration to bypass gates;
- fresh verification after each relevant mutation;
- preserved `FixReturnState` behavior;
- fixer history and evidence;
- focused tests for every important protection;
- clear failure when attempts are exhausted.

The fixer must improve the implementation, not rewrite the rules used to evaluate it.

---

# 16. M10 — Security Review

Security review is a dedicated workflow stage before the final gate.

## M10 features

- deterministic security gate;
- protected security-related configuration;
- security review artifact;
- security-stage fixer integration;
- fresh evidence binding;
- security-specific validation;
- tests covering failure and recovery behavior;
- no assumption that passing ordinary tests equals passing security review.

A security failure must be able to route through the bounded fixer path and return to security verification with fresh evidence.

## Security-review revalidation requirement

Any mutation by the fixer that can affect security-relevant behavior must invalidate prior security-review evidence/verdicts so that security review is re-armed over the post-fix tree.

---

# 17. M11 — Final Gate

The final gate is the deterministic barrier that decides whether the result is eligible for human push approval.

## M11 features

FinalGate must require, as applicable to the project/configuration:

- all required workflow stages completed;
- all required acceptance criteria passed;
- fresh deterministic verification evidence;
- valid scope/workspace state;
- security gate passed;
- fixer state resolved;
- approval records valid and current;
- final-gate inputs tied to the exact revision/fingerprint;
- no unresolved blocking failure.

The final summary cannot bypass FinalGate.

FinalGate failure must route to the correct failure/fixer state rather than silently succeeding.

---

# 18. M12 — Final Summary and Human Push Approval

The final result presented to the developer must summarize what was implemented and what evidence supports it.

## 18.1 Final summary

FinalSummary is read-only and must contain enough information for a human to understand:

- what was requested;
- what requirements were implemented;
- what files/areas changed;
- verification results;
- security status;
- notable failures/fixes;
- resulting revision/fingerprint;
- final-gate status;
- readiness for publishing.

## 18.2 Push approval state

After FinalSummary, the workflow enters:

`AwaitingPushApproval`

No branch/commit/push operation may begin before explicit human approval.

## 18.3 Approval integrity

Approval must be bound to the exact state being approved, including relevant:

- feature identity;
- workflow revision;
- summary digest/hash;
- working-tree fingerprint;
- final-gate status/digest/fingerprint.

A stale or modified summary/working tree invalidates the approval.

---

# 19. M13 — Safe Git Publisher

The publisher is responsible for turning an approved, verified workspace into a protected Git branch, commit, and push.

## 19.1 Explicit approval precondition

Publishing must refuse to run without a valid push approval bound to the current workflow/repository state.

## 19.2 Dedicated feature branch

Publishing must create/use a dedicated feature branch rather than publishing directly to protected/default branches.

## 19.3 Protected branch rules

The publisher must reject attempts targeting branches such as:

- `main`;
- `master`;
- other configured protected branches.

## 19.4 Structured Git execution

Git commands must use structured argv and `shell:false`.

## 19.5 Git flag firewall

The publisher/Git adapter must reject dangerous Git arguments and force-update paths including forms equivalent to:

- `--force`;
- `--force-with-lease*`;
- `--delete`;
- `--receive-pack*`;
- compound/spelling variants that could bypass the policy.

No force-push route is allowed through the publisher.

## 19.6 Pre-publish recheck

Before committing/pushing, the framework must revalidate the approval and repository state.

A changed head, fingerprint, final-gate state, or relevant approval input must cause publishing to stop.

## 19.7 Deterministic commit

Commit creation must be deterministic enough to provide a traceable release artifact containing the approved change.

## 19.8 Push result artifact

The publisher must record the push outcome and relevant branch/commit information.

## 19.9 Completion rule

The workflow reaches `Complete` **only after a successful publish operation**.

A failed push is not a successful workflow completion.

## 19.10 Safe test remote

Automated tests must use a disposable/local test remote or otherwise controlled non-production remote. No product test may accidentally push to a real production repository.

---

# 20. M14 — Comprehensive End-to-End Validation and Freeze

M14 validates the whole system as one product rather than only testing isolated components.

## 20.1 Happy-path E2E

A disposable project must be able to execute the full lifecycle:

```text
request
→ grill
→ specification
→ plan
→ plan approval
→ implementation
→ code review
→ scope review
→ static verification
→ test verification
→ runtime verification
→ security review
→ final gate
→ final summary
→ push approval
→ branch
→ commit
→ push
→ complete
```

## 20.2 Failure-path E2E

The test suite must prove that controlled failures route into the fixer and return to the correct origin with fresh evidence.

## 20.3 Security failure E2E

Security-stage failure must be independently testable and must not be bypassed by ordinary test/static/runtime success.

## 20.4 Approval boundaries

Tests must demonstrate that:

- implementation cannot start without plan approval;
- publishing cannot start without push approval;
- stale approval cannot be reused;
- modified repository state invalidates the approval/evidence as designed;
- agents cannot manufacture approvals.

## 20.5 Publishing failure

A failed branch/commit/push operation must produce a failed/non-complete outcome with useful evidence.

## 20.6 Determinism

Equivalent runs over equivalent fixture inputs should produce stable workflow behavior and artifacts to the extent practical.

## 20.7 Regression coverage

The comprehensive suite must cover prior milestone behavior and critical security boundaries.

## 20.8 Freeze requirement

After M14, the core workflow is considered feature-frozen.

Future work should focus on **productization, packaging, usability, documentation, supported adapters, and distribution**, not uncontrolled expansion of the workflow engine.

---

# 21. Productization P1 — Buildable / Distributable Packages

The finished source repository must be installable and buildable outside its development-only monorepo context.

## P1 requirements

- inspect and normalize workspace/package definitions;
- provide a deterministic top-level `pnpm build`;
- build packages in dependency order;
- emit JavaScript runtime output and TypeScript declarations for intended runtime packages;
- emit `dist` (or the final agreed build output) for packages intended for distribution;
- package `main`, `types`, and `exports` must point to built output, not raw source `.ts` files;
- use `module` only when actually required by the runtime/package strategy;
- internal package dependencies must resolve from compiled artifacts rather than depending on monorepo source paths;
- do not introduce a bundler unless necessary;
- preserve the existing module-system strategy;
- generated build output must not be committed unless the release strategy explicitly requires it;
- add built output to `.gitignore` where appropriate;
- support a clean-checkout build;
- prove compiled runtime output can resolve its internal package dependencies without importing source TypeScript directly;
- preserve test/typecheck/lint behavior.

P1 must not add CLI behavior, initialization logic, npm publishing, or new workflow features.

---

# 22. Productization P2 — CLI Foundation

The product must expose the existing workflow through a thin command-line interface rather than forcing users to write internal API calls.

## 22.1 Required commands

The CLI must provide equivalents of:

```text
agentflow --help
agentflow --version
agentflow status
agentflow start
agentflow run
agentflow approve plan
agentflow approve push
```

Exact argument syntax may evolve, but these capabilities must exist.

## 22.2 CLI principles

- thin layer over the existing orchestration APIs;
- no second state machine;
- no hidden workflow semantics in command handling;
- useful exit codes;
- useful, human-readable errors;
- no stack traces by default for ordinary user errors;
- version comes from package metadata;
- `status` is read-only;
- `start` invokes existing orchestration APIs;
- `run` must not bypass human approval gates;
- `approve plan` uses existing approval mechanisms;
- `approve push` uses existing approval mechanisms;
- commands must work against persisted workflow state.

## 22.3 CLI testing

CLI commands must have fixture/mocked tests for:

- help;
- version;
- status;
- start;
- run;
- plan approval;
- push approval;
- error/exit behavior.

The CLI tests must not require live OpenCode for every unit test.

---

# 23. Productization P3 — External Project Initialization

The kit must be usable from a completely separate target repository.

## 23.1 `agentflow init`

`agentflow init` must:

- detect the target repository;
- validate that the target is a Git repository;
- create the required `.agentflow` configuration/state structure;
- be safe to run repeatedly;
- preserve compatible existing configuration;
- avoid overwriting unrelated user files;
- make no source-code changes;
- create no commits;
- perform no pushes;
- copy no workflow source into the target repository.

## 23.2 Target files

`.agentflow` is the location for the target project's workflow configuration/state and related framework metadata.

The initializer must create only files actually required by the implementation.

The product must **not** create `.opencode/` merely because an older development architecture used it. OpenCode runtime control-plane configuration remains framework-controlled and external to the target repository.

## 23.3 Configuration

The initialized configuration must have:

- documented schema/version;
- deterministic defaults;
- clear required/optional fields;
- validation before execution;
- compatibility behavior for re-running initialization.

## 23.4 Fixture validation

P3 must be tested against a disposable external Git project and must prove:

- expected files are created;
- unexpected files are not created;
- existing unrelated files remain unchanged;
- second `init` is safe/idempotent;
- `status` can read the initialized state;
- target project source files are untouched.

---

# 24. Productization P4 — Real OpenCode End-to-End External Project

This milestone proves that the product works outside its own repository with the real supported agent runtime.

## P4 requirements

Use a disposable real Git repository outside the Agent Workflow Kit repository.

The main E2E must use **real OpenCode**, not a fake CLI or mocked transport.

The test must start with:

```text
agentflow init
```

and then execute the full feature lifecycle through successful publishing.

## P4 acceptance

The real E2E must prove:

- real OpenCode invocation;
- real agent profile selection;
- real implementation of a useful fixture feature;
- deterministic static/test/runtime/security verification;
- workspace isolation;
- OpenCode runtime configuration isolation;
- read/write profile restrictions;
- no arbitrary shell authority for the agent;
- verification environment restrictions;
- evidence freshness;
- approval integrity;
- Git publishing protections;
- real branch creation;
- real deterministic commit creation;
- safe push to a disposable test remote;
- `Complete` only after successful push.

A controlled failure must enter the fixer and then re-verify successfully where the fixture is designed for recovery.

P4 documentation must record:

- exact prerequisites;
- OpenCode version;
- setup commands;
- workflow transitions;
- verification results;
- resulting branch;
- resulting commit;
- push result.

No new workflow feature may be added solely to make P4 easier.

---

# 25. Productization P5 — README / Documentation / Quick Start

The README becomes the user's main path from discovery to first successful run.

## 25.1 README content

The README must explain:

- what Agent Workflow Kit is;
- the problem it solves;
- who it is for;
- the end-to-end workflow;
- why deterministic verification matters;
- where humans approve work;
- how safe publishing works;
- OpenCode as the supported production adapter;
- how the architecture is separated.

## 25.2 Architecture documentation

Document the boundaries among:

- core contracts/state machine;
- orchestration;
- persistence;
- project verification;
- workspace isolation;
- OpenCode adapter;
- CLI;
- publishing.

## 25.3 Quick start

The README must show the actual validated flow from installation to:

```text
install
→ agentflow init
→ configure request/project verification
→ agentflow start
→ agentflow run
→ approve plan
→ implementation/review/verification
→ final summary
→ approve push
→ branch/commit/push
```

The exact commands must match the shipped CLI.

## 25.4 Target repository files

Documentation must explicitly state:

- what `.agentflow/` contains;
- what files the workflow creates/changes;
- that `.opencode/` is not generated merely to host framework profiles;
- where temporary OpenCode runtime config lives;
- which files are user/project configuration versus framework runtime state.

## 25.5 Human approval documentation

The README must clearly identify the plan approval and push approval boundaries.

## 25.6 Security documentation

Security claims must reflect implemented behavior only.

Do not claim protection that the code does not actually enforce.

## 25.7 Demo

The README must link/reference the real P4 external-project demo and use it as evidence that the workflow works in practice.

## 25.8 Contributor guide

Document development setup, builds, tests, lint/typecheck, fixture setup, and milestone validation.

## 25.9 Documentation accuracy

Remove outdated/hypothetical claims.

Do not claim support for agent runtimes that are not implemented.

Do not claim npm installation before P6 is complete.

Every quick-start command must be tested.

---

# 26. Productization P6 — Distribution / npm / GitHub Release

The product is ready for public installation/discovery after P1–P5 are proven.

## 26.1 Package metadata

Review and finalize:

- package name;
- version;
- description;
- license;
- repository metadata;
- homepage/documentation where appropriate;
- keywords;
- package exports;
- published file list;
- CLI binary metadata.

## 26.2 Package contents

Before release, inspect generated npm tarballs/packages and verify they do not contain:

- temporary directories;
- local machine paths;
- secrets;
- audit leftovers;
- development-only artifacts;
- unintended source or test material where not required.

## 26.3 Publishing process

The release process must include:

- package build;
- package-content inspection;
- `npm publish --dry-run` or equivalent dry-run validation;
- release/version decision;
- changelog/release notes;
- final publication only after P1–P5 acceptance.

## 26.4 GitHub discoverability

The repository must have an accurate:

- repository description;
- topic/tag set;
- release information.

Appropriate topics include concepts such as:

- `ai`
- `coding-agent`
- `developer-tools`
- `agent-workflow`
- `opencode`
- `automation`
- `software-engineering`

Only topics supported by the actual product should be used.

## 26.5 Final product acceptance

A new developer who discovers the repository should be able to follow the README and reach:

```text
Discover repo
→ Read README
→ Install CLI
→ Initialize target project
→ Start/run workflow
→ Use OpenCode
→ Develop a real feature
→ Verify it
→ Approve it
→ Publish it
```

without needing access to the Agent Workflow Kit development monorepo internals.

---

# 27. Security Model

Security is a product requirement, not an optional audit feature.

## 27.1 Agent trust boundaries

The workflow treats agent output as untrusted suggestions/results.

The framework itself owns:

- state transitions;
- approvals;
- verification configuration;
- security gates;
- evidence binding;
- workspace boundaries;
- Git publishing.

## 27.2 Repository trust boundaries

The target repository is not trusted to redefine framework control-plane authority.

This includes protection against:

- repository-defined OpenCode profile shadowing;
- repository configuration boundary crossing;
- repository plugin execution compromising the agent control plane;
- forged workflow response fields;
- verification rule tampering;
- protected configuration modification.

## 27.3 Process execution

Where processes are required:

- use structured argv;
- use `shell:false`;
- bound execution time/output;
- support cancellation;
- clean process groups safely;
- restrict environment exposure.

## 27.4 Verification environment isolation

The target repository may control the verification command because the command belongs to the project, but it must not automatically receive the developer's host credentials.

The default verification environment must be sanitized/minimal.

## 27.5 Evidence integrity

Evidence must be tied to:

- the relevant workflow revision/session;
- exact/reproducible command identity where applicable;
- working-tree fingerprint;
- fixer history constraints;
- the current final-gate state.

Stale evidence is invalid evidence.

## 27.6 Approval integrity

Push approval must be cryptographically/deterministically bound to the approved summary, state, fingerprint, revision, and final-gate result.

## 27.7 Git safety

The publisher must prevent:

- force pushes;
- deletion refspec abuse;
- receive-pack override abuse;
- direct publishing to protected branches;
- unauthorized branch/commit operations;
- shell/argument injection.

## 27.8 Workspace integrity

The framework must validate repository root, workspace identity, approved baseline, lease, and relevant repository state before executing sensitive stages.

Workspace changes outside allowed scope must block progression.

## 27.9 Persistence integrity

Persistence must guard against:

- path traversal;
- unsafe feature identifiers;
- unsafe slug/path construction;
- session cross-contamination;
- lock abuse;
- unsafe symlink behavior;
- malformed artifact/approval records.

## 27.10 Security auditability

The architecture should support independent static/dynamic security audits without requiring undocumented assumptions.

External audit findings must be triaged against actual source behavior rather than accepted blindly or dismissed without evidence.

---

# 28. Canonical Security / Integrity Controls

The following controls are part of the product definition because they represent critical behavior established during the workflow's security maturation.

## 28.1 Stage-table profile binding

The stage definition, not the model request, decides which OpenCode profile is permitted.

A profile/role mismatch must fail the execution.

## 28.2 Configuration boundary validation

Before relevant OpenCode executions, the adapter must validate that repository files cannot shadow or override framework control-plane configuration.

## 28.3 Structured response validation

The response parser must reject response fields that attempt to manufacture workflow control state.

## 28.4 Feature/session identity constraints

Feature identifiers must have a constrained format and path-safe derivation.

Paths/filenames must be normalized and traversal-resistant.

## 28.5 Workspace identifier safety

Workspace identifiers should be derived from validated framework-controlled data rather than directly from user-provided path spellings.

## 28.6 Approval record revalidation

Approval records are validated when read and again before the sensitive action they authorize.

## 28.7 FinalGate binding

A push approval cannot authorize publishing unless the associated FinalGate status is exactly valid and current.

## 28.8 Head re-verification

The publisher must verify the repository head/tree state immediately before committing/pushing.

---

# 29. Observability and Artifacts

The workflow must leave behind enough durable state to explain what happened without relying on chat history.

## Required categories

- request;
- requirements/specification;
- plan;
- plan review;
- implementation result;
- code review;
- scope review;
- static verification;
- test verification;
- runtime verification;
- security review;
- fixer history;
- final gate;
- final summary;
- approval records;
- publishing outcome.

Artifacts should make it possible to answer:

- What was requested?
- What was approved?
- What did the agent do?
- What failed?
- What was fixed?
- What evidence passed?
- Which exact repository state was verified?
- Who/what approved publishing?
- What branch/commit was created?
- Was the push actually successful?

---

# 30. Initialization and Target-Project Contract

When installed into a project, the kit must clearly separate three categories:

## 30.1 Target project state

The actual application's source code, assets, dependencies, and normal Git history remain the user's project.

## 30.2 `.agentflow/`

Framework configuration and persistent workflow/session metadata required by the target project live here unless a future configuration mechanism deliberately changes this contract.

The exact files must be documented by the version of the kit being used.

## 30.3 External OpenCode runtime state

OpenCode control-plane runtime configuration belongs in a framework-controlled external temporary directory, not as user-editable target-project framework files.

This separation must be preserved across initialization, execution, and cleanup.

---

# 31. Project Verification Configuration Contract

A target project must explicitly define whatever the framework needs in order to verify it safely.

The configuration must make explicit, rather than infer, concepts such as:

- package manager where needed;
- static verification commands;
- test verification commands;
- runtime startup configuration;
- runtime readiness information;
- runtime acceptance endpoint/checks;
- timeouts/bounds within supported policy;
- security verification inputs where required.

The framework must refuse to invent critical verification details merely because a project "looks like" it uses a particular stack.

---

# 32. Runtime and Process Safety Contract

All framework-owned child process execution must follow a common safety posture:

- structured command arrays/argv;
- `shell:false`;
- bounded output;
- bounded execution time;
- explicit cancellation/termination;
- process cleanup;
- controlled working directory;
- sanitized environment where repository code is executed;
- meaningful error/result classification.

No user-facing feature may bypass these controls for convenience.

---

# 33. Testing Strategy

Testing is part of the product, not a final clean-up step.

## 33.1 Unit testing

Test:

- state transitions;
- snapshot restoration;
- validation;
- persistence mutations;
- path rules;
- lock behavior;
- approval validation;
- evidence binding;
- Git flag firewall;
- CLI command handling;
- OpenCode parsing/configuration policy;
- project verification configuration.

## 33.2 Integration testing

Test interactions among:

- core + orchestration;
- orchestration + persistence;
- orchestration + workspace;
- orchestration + project verification;
- orchestration + OpenCode;
- orchestration + publishing.

## 33.3 Fixture testing

Maintain disposable fixture projects for:

- static verification;
- tests;
- runtime servers;
- controlled failures;
- fixer recovery;
- external initialization;
- safe publishing.

## 33.4 E2E testing

The full happy/failure/security/publishing path must be proven.

P4 specifically proves it using real OpenCode in a separate target repository.

## 33.5 Security regression testing

Security-sensitive tests must protect against regressions in:

- shell execution;
- environment credential leakage;
- profile shadowing;
- plugin/config boundary crossing;
- forged state/approval;
- stale evidence;
- scope escape;
- unsafe Git pushes;
- protected branch bypass;
- verification-rule tampering.

---

# 34. CLI User Experience Contract

The CLI should make the workflow understandable without exposing unnecessary internal implementation details.

## Required UX qualities

- clear command discovery through `--help`;
- readable status output;
- explicit current workflow state;
- explicit blocked/approval state;
- useful failure reason;
- predictable exit codes;
- no silent bypasses;
- non-interactive operation where appropriate;
- explicit indication when human approval is required.

The CLI should feel like an interface to one coherent system, not a collection of unrelated scripts.

---

# 35. Performance / Reliability Expectations

The product should optimize for reliable developer throughput rather than benchmark theater.

Requirements:

- bounded subprocess execution;
- bounded fixer attempts;
- deterministic persistence mutations;
- safe recovery after interruption;
- no orphaned runtime processes where supported cleanup is available;
- no indefinite waits on external agent processes;
- no accidental repeated publishing;
- no duplicate initialization damage;
- ability to resume/recover from persisted workflow state.

Model-token optimization is useful only where it does not weaken workflow correctness or evidence quality.

---

# 36. Out of Scope for the Core Release

The following are deliberately not required to be part of the frozen core workflow unless later promoted through a separate product decision:

- building a second workflow engine for another frontend;
- generating PRDs/project requirements automatically as a standalone product feature;
- browser automation as a mandatory verification mechanism;
- unlimited autonomous agent loops;
- agent-selected arbitrary shell execution;
- automatic installation of tools/packages/plugins;
- claiming support for multiple agents before their adapters exist;
- speculative microservices or cloud infrastructure solely for architecture aesthetics;
- adding features merely because another coding-agent product has them.

The core workflow remains frozen after M14; new capabilities should be implemented as productization or optional extensions unless they require a deliberate versioned workflow change.

---

# 37. Separate Section — Feature Development / Future Integrations

This section contains **future development features and integrations**, intentionally separated from the canonical M0–M14 + P1–P6 product baseline.

These are not required to declare the current core workflow complete. They are extension work built on the same workflow contracts.

## 37.1 Agent Adapter Architecture

The product should expose a stable agent adapter interface so additional coding-agent runtimes can be integrated without changing the core state machine.

Every adapter must obey the same core rules:

- no adapter can own workflow transitions;
- no adapter can grant itself approval;
- structured transport;
- bounded execution;
- explicit capability probing where needed;
- controlled permissions;
- repository/configuration boundary protection;
- compatible response protocol;
- deterministic error handling.

## 37.2 Claude Code Integration

Provide an optional Claude Code adapter implementing the same workflow execution contract.

The integration should map logical workflow roles to the safest practical Claude Code permission/execution model and preserve:

- human approvals;
- deterministic verification;
- workspace isolation;
- environment restrictions;
- evidence freshness;
- protected publishing.

No Claude Code-specific behavior should leak into the core orchestrator.

## 37.3 Codex Integration

Provide an optional Codex adapter using the same workflow contracts and security boundaries.

The integration should support the same logical stage roles and use the safest structured invocation mechanism available for the supported Codex runtime.

Codex execution must remain subordinate to the framework's state machine, verification gates, approval records, and Git publisher.

## 37.4 Freebuff Integration

Freebuff may be supported as a future coding-agent adapter where its runtime/API allows the same control model.

The integration must not revive a second orchestration system or relax the framework's core security model.

## 37.5 Additional Agent Runtimes

Future adapters may support other open-source or commercial coding agents when there is a strong developer-use case.

Every integration should answer:

1. How is execution started safely?
2. How are permissions constrained?
3. How is configuration isolated from repository-controlled configuration?
4. How are outputs parsed?
5. How are capabilities detected?
6. How are agent errors reported?
7. How is the runtime prevented from bypassing approvals and deterministic verification?

## 37.6 Agent-Agnostic Profile/Role Mapping

Logical workflow roles should remain stable even when different agent runtimes have different physical permission models.

Examples of logical roles include:

- analyst/griller;
- specification/planner;
- implementation;
- code reviewer;
- verifier/reviewer;
- fixer;
- security reviewer.

The actual runtime may map several logical roles to a small number of physical permission profiles, as OpenCode does.

## 37.7 Multi-Agent Parallelism

A future optimization may allow suitable analysis/review tasks to run in parallel when their contracts are independent.

Parallelism must not weaken:

- approval ordering;
- state consistency;
- workspace integrity;
- evidence binding;
- deterministic gate behavior.

## 37.8 Alternative Workspace Providers

Future providers may support environments other than local Git worktrees, provided the provider can satisfy the baseline/lease/scope/integrity contract.

Potential future providers may include containers, remote workspaces, or other isolated execution backends.

## 37.9 Richer Runtime Verification

Future verification extensions could support additional protocols beyond HTTP, but they must remain explicit and deterministic.

Browser automation may be offered as an optional adapter/extension only if it can meet the same evidence and security requirements.

## 37.10 More Verification Adapters

Future project adapters may support richer ecosystem-specific checks while preserving the common verification contract.

The core must continue treating verification outcomes as evidence rather than trusting framework-specific claims.

## 37.11 External Security Skills / Auditors

The workflow may expose interfaces for external security audit tools/skills so a completed repository can undergo independent read-only security auditing.

Examples may include external skill-based scanners or security-analysis agents.

Such tools must be treated as **advisory/audit inputs** unless their findings are explicitly integrated into a deterministic gate.

They must not be granted permission to alter the repository simply because they are performing an audit.

## 37.12 Optional Workflow-Optimization Tools

Future development may evaluate tools intended to reduce unnecessary agent cost or improve reliability, such as:

- context/token management tools;
- post-agent application testing tools;
- skill/package security scanners;
- design/UX review skills;
- agent session optimization tools.

Any adoption must be justified by measurable value and integrated without weakening the core contracts.

## 37.13 Feature Development Rule

All future integrations must plug into the current workflow rather than replacing it.

The guiding architecture is:

```text
                 AGENT WORKFLOW KIT CORE
                 ------------------------
                 State + Approvals
                 Orchestration
                 Persistence
                 Verification
                 Workspace
                 Publishing
                        │
          ┌─────────────┼─────────────┐
          ↓             ↓             ↓
      OpenCode      Claude Code     Codex
                                      ...
          ↓             ↓             ↓
            Future Agent Adapters
```

The agent is replaceable. The workflow contract is not.

---

# 38. Release / Versioning Philosophy

## 38.1 Core freeze

M0–M14 define the core workflow baseline.

## 38.2 Productization

P1–P6 turn the frozen workflow into a usable distributable developer product.

## 38.3 Extensions

Post-release capabilities should normally be introduced as:

- adapters;
- optional verification providers;
- workspace providers;
- CLI improvements;
- documentation/tooling improvements;
- independently versioned integrations.

A change that alters workflow safety, approval semantics, state transitions, evidence semantics, or publishing authority is a **core workflow change** and should require an explicit versioned product decision rather than being smuggled in as an adapter feature.

---

# 39. Definition of Done — Complete Agent Workflow Kit

The product is considered fully complete only when all of the following are true:

## Core workflow

- M0–M14 requirements are implemented and regression-tested.
- The state machine is authoritative.
- Persistence is durable and safe.
- Orchestration is deterministic and vendor-neutral.
- OpenCode is a real supported adapter.
- Workspace isolation is active.
- Static/test/runtime/security verification works.
- Fixing is bounded and cannot rewrite acceptance rules.
- FinalGate is deterministic.
- FinalSummary is read-only and evidence-backed.
- Plan approval and push approval are explicit human gates.
- Git publishing is protected and safe.

## Security

- Repository configuration cannot hijack the OpenCode control plane.
- Agent output cannot manufacture workflow state or approval.
- Verification commands cannot receive the operator's full host credential environment by default.
- Stale evidence and approvals are rejected.
- Scope/workspace integrity is enforced.
- Force/deletion/receive-pack Git abuse is blocked.
- Protected branches cannot be published to by the safe publisher.

## Productization

- P1 build artifacts are distributable.
- P2 CLI works.
- P3 can initialize a separate target repository.
- P4 passes with real OpenCode in a separate target repository.
- P5 documentation matches reality.
- P6 package/release/distribution process is validated.

## User journey

A developer must be able to obtain the product and understand how to use it without reading the implementation source first.

The final public-facing journey is:

```text
GitHub / package discovery
        ↓
README
        ↓
Install
        ↓
agentflow init
        ↓
Configure target project
        ↓
Start feature workflow
        ↓
OpenCode executes bounded stages
        ↓
Human approves plan
        ↓
Implementation + review + deterministic verification
        ↓
Fix/re-verify when required
        ↓
Security + FinalGate
        ↓
Final Summary
        ↓
Human approves push
        ↓
Feature branch + deterministic commit
        ↓
Safe push
        ↓
Complete
```

---

# 40. Canonical Product Positioning

Agent Workflow Kit should be presented as:

> **A reusable, verification-first workflow harness for AI-assisted software development.**
>
> It gives coding agents a structured path from feature request to verified, human-approved, safely published code — while keeping workflow control, deterministic verification, and Git publishing in the framework rather than in the model.

The product's differentiating idea is not simply "use an AI coding agent."

The product is the **workflow around the agent**: specification, planning, approval, controlled execution, review, deterministic verification, bounded fixing, security gating, evidence integrity, and safe publishing.

---

# 41. Canonical Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         HUMAN / DEVELOPER                    │
│  request · plan approval · final summary · push approval     │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     CLI / PRODUCT INTERFACE                  │
│             status · start · run · approve · init            │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    WORKFLOW ORCHESTRATOR                     │
│ state machine · stage routing · approvals · fixer · gates   │
└───────┬──────────────────┬─────────────────┬─────────────────┘
        │                  │                 │
        ▼                  ▼                 ▼
┌───────────────┐  ┌────────────────┐  ┌─────────────────────┐
│  Persistence  │  │ Project Verify │  │ Workspace Provider  │
│ sessions/art. │  │ static/test/   │  │ baseline/lease/     │
│ locks/records │  │ runtime/sec    │  │ isolation/scope     │
└───────────────┘  └────────────────┘  └─────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │    Agent Adapter    │
                    │   vendor-neutral    │
                    └─────────┬───────────┘
                              │
                     ┌────────┴────────┐
                     ▼                 ▼
                ┌─────────┐       Future adapters
                │ OpenCode│       Claude / Codex /
                │ current │       Freebuff / others
                └────┬────┘
                     │
                     ▼
              bounded agent execution

                               │
                               ▼
                    ┌─────────────────────┐
                    │    Final Gate       │
                    │ evidence + security │
                    │ + scope + approvals│
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   Safe Git Publish  │
                    │ branch · commit     │
                    │ protected push      │
                    └─────────────────────┘
```

---

# 42. Final Requirement

This document is the **single source of truth for the complete Agent Workflow Kit product direction** represented by M0–M14 and P1–P6.

When implementation decisions conflict with this document:

1. preserve human approval authority;
2. preserve deterministic verification;
3. preserve evidence/approval freshness and integrity;
4. preserve workspace and configuration boundaries;
5. preserve safe Git publishing;
6. prefer the smallest implementation that satisfies the requirement;
7. add new functionality as an explicit extension rather than silently changing the meaning of the workflow.

The goal is not to build the largest agent framework possible.

The goal is to build a **reusable, secure, verifiable, installable, developer-friendly workflow that makes AI-assisted software development faster without making it uncontrolled.**
