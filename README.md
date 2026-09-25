# Agent Workflow Kit

Agent Workflow Kit provides a coding-agent-independent software development workflow that can be installed into arbitrary repositories.

Milestones 1 and 1.1 establish the repository, domain foundations, and hardened verification contracts only. They do not implement orchestration, adapters, integrations, templates, or CLI behavior.

## Workspace

The repository is a pnpm workspace:

- `core/` contains the agent-independent domain model and public core package.
- `apps/cli/` reserves the future CLI package and its dependency on the core; it contains no CLI implementation yet.
- `adapters/` is the boundary for agent adapters and project adapters.
- `integrations/` is the boundary for external-system integrations.
- `templates/` will hold reusable workflow and project templates.
- `fixtures/` contains deterministic sample data for tests.
- `tests/` contains cross-package contract and behavior tests.

The workspace configuration also reserves package locations below `adapters/`, `integrations/`, and `apps/` so those boundaries can grow independently.

## Architecture

### Workflow core

The core owns stable workflow vocabulary and data contracts. It must remain independent of every coding agent and external system. It currently contains only the `Feature`, `Requirement`, `AcceptanceCriterion`, `Plan`, `PlanStep`, `ReviewFinding`, `VerificationEvidence`, and `VerificationResult` contracts plus the `WorkflowState` enum. It performs no orchestration and invokes no tools.

### Agent adapters

Agent adapters translate between core contracts and a specific coding agent's capabilities, payloads, and responses. Agent-specific APIs stay inside adapter packages. The core must never import an adapter or depend on a coding-agent SDK.

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
