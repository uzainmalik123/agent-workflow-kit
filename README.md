# Agent Workflow Kit

Agent Workflow Kit provides a coding-agent-independent software development workflow that can be installed into arbitrary repositories.

Milestones 1–4 establish the repository, domain contracts, the deterministic in-memory lifecycle engine, repository-local persistent feature sessions, and the agent-independent workflow orchestrator. Milestone 4.1 hardens that orchestrator: optimistic revision concurrency, a frozen plan approval checkpoint, and a durable fix history. Milestone 5 adds the first real agent adapter: `adapters/opencode/` drives a workflow stage with OpenCode, under eleven role definitions, least-privilege generated permissions, deterministic prompts, and a structured response protocol. Milestone 5.1 aligns that adapter with OpenCode V2 natively: the generated `permissions` rulesets, the `opencode run` invocation and its NDJSON event stream, a safe local capability probe, and an optional generated-configuration smoke test. Milestone 6 adds deterministic project discovery and verification: `adapters/project/` classifies a repository, selects its own lint, typecheck, test, and build commands, and runs them outside any agent session, so a verification verdict is a process result rather than a model's opinion. The project still does not execute features on its own: no Git operation, third-party agent integration, template, installer, or CLI behavior is implemented.

## Workspace

The repository is a pnpm workspace:

- `core/` contains the agent-independent domain model and public core package.
- `orchestration/` maps workflow state to work, artifacts, and a legal transition; it depends on the core and on the persistence adapter.
- `apps/cli/` reserves the future CLI package and its dependency on the core; it contains no CLI implementation yet.
- `adapters/` is the boundary for agent adapters and project adapters; `adapters/persistence/` provides the repository-local session and artifact store, `adapters/project/` provides deterministic project discovery and command execution, and `adapters/opencode/` provides the OpenCode agent adapter.
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

`adapters/opencode/` is the first such adapter. It maps the thirteen workflow stages onto eleven OpenCode roles, generates each role's agent file as an ordered OpenCode V2 `permissions` ruleset, builds a deterministic prompt from the orchestrator-routed request alone, runs the agent through a substitutable transport, and translates exactly one fenced JSON payload back into a `StageExecutionResult`. It refuses anything else: prose, a foreign feature or stage, an artifact the stage does not own, a workflow-control field, an empty response, a non-zero exit, a timeout, or an event stream it does not recognize. Nothing in it chooses a transition, approves a gate, runs a command, or touches Git. The roles, V2 permissions, prompt boundary, response protocol, transport properties, capability probe, generated files, and the recorded installer policy are described in `adapters/opencode/README.md`.

Other agent adapters, integrations, templates, the installer, and the user-facing CLI remain deferred.

### Project adapters

Project adapters encapsulate access to project resources and tools, such as repository files, version control, and task runners. They expose project operations to the rest of the kit without putting tool-specific behavior in the core.

`adapters/project/` is the project adapter for verification. It reads a repository the way a build tool reads one, decides what its own verification commands are, runs them, and reports what happened.

Discovery is a lookup, never an inference. It reads a fixed list of well-known files, resolves symbolic links nowhere, and refuses a manifest it cannot parse instead of reporting a project with no commands. A Node project is classified by its lockfile first (`pnpm`, then `bun`, then `yarn`, then `npm`) and by its manifest's `packageManager` or `devEngines.packageManager` only when no lockfile exists, with a conflict recorded rather than resolved silently. A capability is `applicable`, `not_applicable`, `unsupported`, `unavailable`, or `blocked`, and the reason is a stable code: a plain JavaScript project has no typecheck, a Python project has no adapter yet, a project with no `node_modules` is blocked and is never installed into, and runtime verification is deferred to Reticle.

A command is an executable and an argument array, and it is `shell: false` always. A command comes from a script the project declares or from `agent-workflow.config.json`, never from a model: the file accepts only `{ id, capability, executable, args }` plus an optional `cwd` that must stay inside the repository, and refuses any other field, so there is no shape in which a shell line can be written, and the generated OpenCode permissions deny every role the ability to write it. `add`, `install`, `remove`, `exec`, lifecycle scripts, and any other package-manager invocation that would run repository-defined code at run time are refused structurally. A configured command may only cover the capability its own section exists for, so a `test` section cannot quietly acquire a `build` command.

Two command shapes are refused because they turn a declared tool into a string some shell interprets. A detected script that declares a `pre<name>` or `post<name>` hook is blocked, because running it through pnpm, npm, yarn, or bun would execute code the manifest never offered the stage; the block names the hook and points at declaring the tool directly, and a configured command is the way out. And a command-string flag aimed at a known interpreter is refused, whether the executable is the shell itself or a general interpreter carrying that shell as an argument, so `sh -c`, `/bin/bash -lc`, `busybox sh -c`, `cmd /c`, `command.com /c`, `powershell -Command`, and `pwsh -Command` are all rejected by name, case-insensitively, at any path.

Execution is the repository's single deterministic runner, and it never rejects: a non-zero exit, a timeout, an abort, a signal death, a missing binary, and a runaway stream are all results, because a failing lint run is the evidence the stage exists to record. Each result becomes a check carrying the command, the exit code, the signal, the duration, a bounded head-and-tail capture of both streams, the session revision, and a SHA-256 fingerprint of the working tree. The status comes from the termination and the exit code alone, never from a substring of the output.

The run is bracketed by two measurements of the same tree. The working tree is fingerprinted before any command runs and again after the last one, and both digests are kept: the bundle and every check carry the before digest, and the workspace record carries the pair. A command that rewrites the implementation it is verifying is therefore not judged on the code it produced, so a changed workspace forces a `failed` outcome on its own, however green the exit codes were, and the finding names both digests. It also means the fingerprint is never a stale constant read once and cached.

The same bracketing is applied a second time to the framework's own directories. `.agentflow/` and `.opencode/` are excluded from the implementation fingerprint because neither is project code, and a verification command is repository-defined code that can write to either. A command that moves the session past a stage it never ran, deletes the recorded evidence, or rewrites the generated agent file for the role about to run leaves green exit codes and a workflow that quietly skipped a stage, so the control plane gets its own `before`/`after` pair, a changed control plane forces `failed` with a finding naming both digests, and the OpenCode adapter independently refuses a tampered generated file before any model is invoked. It never repairs it either: overwriting the file would destroy the evidence, and the decision to restore generated content stays with the operator.

Editing the generated file is the obvious way in, so the adapter's own check is written around the sources rather than the file. OpenCode resolves an agent id and a project configuration from more than one place, so a repository does not have to edit the checked file to decide what a run loads. Each run resolves the id the CLI is about to ask for, walks every definition under `.opencode/agent/` and `.opencode/agents/` and refuses unless exactly one file resolves to that id and it is the generated one, refuses the `opencode.jsonc` and `.opencode/opencode.json` forms that OpenCode would also load rather than guessing which wins, and refuses the root config fields that can redefine a role, re-grant a tool, or add an instruction source. The rest of the configuration stays the repository's: `AGENTS.md`, its own agents under its own ids, and the model, provider, and display fields of `opencode.json`.

The orchestrator collects that evidence for a verification stage after the plan approval has been re-verified and before the stage executor is involved, hands it to the verifier in the prompt, and enforces the result itself. A stage reached with no verification provider fails closed with `verification_not_configured`: the executor is never called, nothing is persisted, and `executedStages` says so. A bundle is bound to the request that asked for it, so an old revision, a future revision, another feature's tree, a foreign project root, or a single check whose kind, revision, or fingerprint does not match is refused with `verification_evidence_mismatch` before the executor runs. A bundle that fails validation, one that contradicts itself, or a provider that throws stops the stage and writes nothing, and a recorded `failed` or `blocked` check turns a reported `success` into `needs_fix` regardless of what the verifier said. A `deferred` stage is not a failure, so the workflow stays satisfiable while runtime is deferred. Every attempt is appended under a framework-owned `deterministic_evidence` key in `verification.json`, beside the model's own section and never over it, and the fingerprint means evidence from before a fix can never prove the code that fix produced. The profile, command policy, evidence records, and the orchestrator contract are described in `adapters/project/README.md`.

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
