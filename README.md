# Agent Workflow Kit

Agent Workflow Kit provides a coding-agent-independent software development workflow that can be installed into arbitrary repositories.

Milestones 1–4 establish the repository, domain contracts, the deterministic in-memory lifecycle engine, repository-local persistent feature sessions, and the agent-independent workflow orchestrator. Milestone 4.1 hardens that orchestrator: optimistic revision concurrency, a frozen plan approval checkpoint, and a durable fix history. Milestone 5 adds the first real agent adapter: `adapters/opencode/` drives a workflow stage with OpenCode, under eleven role definitions, least-privilege generated permissions, deterministic prompts, and a structured response protocol. The project still does not execute features on its own: no project command, Git operation, third-party agent integration, template, installer, or CLI behavior is implemented.

## Workspace

The repository is a pnpm workspace:

- `core/` contains the agent-independent domain model and public core package.
- `orchestration/` maps workflow state to work, artifacts, and a legal transition; it depends on the core and on the persistence adapter.
- `apps/cli/` reserves the future CLI package and its dependency on the core; it contains no CLI implementation yet.
- `adapters/` is the boundary for agent adapters and project adapters; `adapters/persistence/` provides the repository-local session and artifact store, and `adapters/opencode/` provides the OpenCode agent adapter.
- `integrations/` is the boundary for external-system integrations.
- `templates/` will hold reusable workflow and project templates.
- `fixtures/` contains deterministic sample data for tests, including a fake stage executor and a fake OpenCode transport, neither of which ever calls a model.
- `tests/` contains cross-package contract and behavior tests.

The workspace configuration also reserves package locations below `adapters/`, `integrations/`, and `apps/` so those boundaries can grow independently.

## Architecture

### Workflow core

The core owns stable workflow vocabulary, data contracts, and the deterministic lifecycle engine. It must remain independent of every coding agent and external system. It contains workflow contracts, the `WorkflowState` enum, and the pure `WorkflowStateMachine`; it does not execute features, orchestrate external work, or invoke tools.

### Deterministic state machine

`WorkflowStateMachine` starts in `draft` and accepts typed `WorkflowEvent` values. Automatic `advance` events follow only the main lifecycle path. The `approve_plan` and `approve_push` events are the only exits from their approval gates. `request_fix` records an eligible review or verification state, and `complete_fix` returns to that exact state. The `fail` event enters terminal `failed`; neither `complete` nor `failed` has an exit. The `snapshot` getter returns plain serializable state, and the constructor restores only validated snapshots. The engine performs no filesystem or persistence I/O.

### Persistent/session layer

`adapters/persistence/` is the project adapter for durable repository-local workflow state. It stores authoritative `session.json` files, controlled feature artifacts, and append-only `events.jsonl` records under `.agentflow/features/`. Feature sessions persist only workflow metadata, machine snapshots, artifact references/statuses, and the plan approval checkpoint; artifact contents remain in their deterministic files. Session writes use a temporary file followed by an atomic rename, and a successful transition persists the session before appending its event.

Every session carries a `revision` that starts at `0` and increases by exactly one per successful mutation, and every mutation goes through `store.mutate(featureId, { expectedRevision, prepare })`. A short per-feature lock guards the critical section: the revision is re-checked inside it, `prepare` sees the state it is about to replace, and the lock is released before any external call. Artifacts are written first, then the session with its next revision, then the event log, so a reported failure can always be classified by reloading the session and a stale `expectedRevision` is refused with `REVISION_CONFLICT` before any artifact is touched.

The persistence layer depends on core contracts, while core remains filesystem independent. Missing, malformed, mismatched, and unsupported persisted data fails explicitly; it never silently falls back to a draft state. Storage paths are guarded against symbolic links at every level for both reads and writes, a session update cannot patch the workflow state machine, and artifact writes roll back when the session update fails. The persisted layout, session document, and store API are described in `adapters/README.md`.

### Orchestration

`orchestration/` is the workflow coordinator. Given a persisted feature session it decides what work is legal next, routes only the artifacts that stage needs, invokes a generic `StageExecutor` port, validates the structured result, stores the produced artifacts, and applies exactly one legal state-machine event. `runNext()` executes at most one work stage per call, so recovery and human control stay explicit. Human approval states, the commit and push states, and terminal states are never executed by the orchestrator. Failures are classified as workflow, executor, or persistence problems, and only an explicit `failFeature()` decision can terminate a feature. An ambiguous persistence failure is resolved by reloading the authoritative session and comparing machine snapshots and revisions, never by retrying the transition.

Every decision is a revision-guarded mutation, so a stage result produced against an older session revision is reported as `conflict` instead of overwriting the winner or skipping a stage. `approvePlan()` freezes the approved `spec`, `plan`, and `plan_review` bytes as SHA-256 digests in the session, and every later stage re-verifies them before it runs, so a changed plan stops the workflow instead of being silently implemented. The fixer's own report is required on every fix and is appended by the orchestrator to the controlled `fixes.json` history, which is then routed to verification, security review, the final gate, and the final summary. The stage map, context routing, concurrency rules, approval checkpoint, fix history, and gate behavior are described in `orchestration/README.md`.

### Agent adapters and other outer layers

Agent adapters translate between core contracts and a specific coding agent's capabilities, payloads, and responses. An agent adapter implements the orchestration `StageExecutor` port, so agent-specific APIs stay inside adapter packages. The core must never import an adapter or depend on a coding-agent SDK, and the orchestrator must never import an adapter.

`adapters/opencode/` is the first such adapter. It maps the thirteen workflow stages onto eleven OpenCode roles, generates each role's agent file and least-privilege permission map, builds a deterministic prompt from the orchestrator-routed request alone, runs the agent through a substitutable transport, and translates exactly one fenced JSON payload back into a `StageExecutionResult`. It refuses anything else: prose, a foreign feature or stage, an artifact the stage does not own, a workflow-control field, an empty response, a non-zero exit, or a timeout. Nothing in it chooses a transition, approves a gate, runs a command, or touches Git. The roles, permissions, prompt boundary, response protocol, transport properties, generated files, and the recorded installer policy are described in `adapters/opencode/README.md`.

Other agent adapters, integrations, templates, the installer, and the user-facing CLI remain deferred.

### Project adapters

Project adapters encapsulate access to project resources and tools, such as repository files, version control, and task runners. They expose project operations to the rest of the kit without putting tool-specific behavior in the core.

### Integrations

Integrations connect the kit to external systems and services. They own external I/O and service-specific representations while depending on shared contracts. External behavior must not leak into or become a dependency of the core.

The dependency direction is intentionally one-way: outer layers may depend on core contracts; core never depends on a CLI, adapter, integration, or coding agent. The orchestrator sits above the core and the persistence adapter and is depended on only by adapters and the future CLI. The OpenCode adapter sits above all three and is depended on by nothing.

## Toolchain

Use Node.js `^22.13.0 || ^24.0.0 || >=26.0.0` and pnpm `11.27.1`.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm verify
```
