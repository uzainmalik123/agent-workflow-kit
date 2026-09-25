# Agent Workflow Kit

Agent Workflow Kit provides a coding-agent-independent software development workflow that can be installed into arbitrary repositories.

Milestones 1–2.1 and 3 establish the repository, domain contracts, deterministic in-memory lifecycle engine, and repository-local persistent feature sessions. The project still does not execute features or implement agent integrations, templates, or CLI behavior.

## Workspace

The repository is a pnpm workspace:

- `core/` contains the agent-independent domain model and public core package.
- `apps/cli/` reserves the future CLI package and its dependency on the core; it contains no CLI implementation yet.
- `adapters/` is the boundary for agent adapters and project adapters; `adapters/persistence/` provides the repository-local session and artifact store.
- `integrations/` is the boundary for external-system integrations.
- `templates/` will hold reusable workflow and project templates.
- `fixtures/` contains deterministic sample data for tests.
- `tests/` contains cross-package contract and behavior tests.

The workspace configuration also reserves package locations below `adapters/`, `integrations/`, and `apps/` so those boundaries can grow independently.

## Architecture

### Workflow core

The core owns stable workflow vocabulary, data contracts, and the deterministic lifecycle engine. It must remain independent of every coding agent and external system. It contains workflow contracts, the `WorkflowState` enum, and the pure `WorkflowStateMachine`; it does not execute features, orchestrate external work, or invoke tools.

### Deterministic state machine

`WorkflowStateMachine` starts in `draft` and accepts typed `WorkflowEvent` values. Automatic `advance` events follow only the main lifecycle path. The `approve_plan` and `approve_push` events are the only exits from their approval gates. `request_fix` records an eligible review or verification state, and `complete_fix` returns to that exact state. The `fail` event enters terminal `failed`; neither `complete` nor `failed` has an exit. The `snapshot` getter returns plain serializable state, and the constructor restores only validated snapshots. The engine performs no filesystem or persistence I/O.

### Persistent/session layer

`adapters/persistence/` is the project adapter for durable repository-local workflow state. It stores authoritative `session.json` files, controlled feature artifacts, and append-only `events.jsonl` records under `.agentflow/features/`. Feature sessions persist only workflow metadata, machine snapshots, and artifact references/statuses; artifact contents remain in their deterministic files. Session writes use a temporary file followed by an atomic rename, and a successful transition persists the session before appending its event.

The persistence layer depends on core contracts, while core remains filesystem independent. Missing, malformed, mismatched, and unsupported persisted data fails explicitly; it never silently falls back to a draft state. Storage paths are guarded against symbolic links at every level for both reads and writes, transition events are written only by `transition`, and artifact writes roll back when the session update fails. The persisted layout, session document, and store API are described in `adapters/README.md`.

### Agent adapters and other outer layers

Agent adapters translate between core contracts and a specific coding agent's capabilities, payloads, and responses. Agent-specific APIs stay inside adapter packages. The core must never import an adapter or depend on a coding-agent SDK. Agent adapters, integrations, templates, and the user-facing CLI remain deferred beyond this persistence foundation.

### Project adapters

Project adapters encapsulate access to project resources and tools, such as repository files, version control, and task runners. They expose project operations to the rest of the kit without putting tool-specific behavior in the core.

### Integrations

Integrations connect the kit to external systems and services. They own external I/O and service-specific representations while depending on shared contracts. External behavior must not leak into or become a dependency of the core.

The dependency direction is intentionally one-way: outer layers may depend on core contracts; core never depends on a CLI, adapter, integration, or coding agent.

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
