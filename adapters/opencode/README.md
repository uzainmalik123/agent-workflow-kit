# OpenCode adapter

`@agent-workflow-kit/opencode` is the first real agent adapter in the kit. It implements the orchestration `StageExecutor` port on top of [OpenCode](https://opencode.ai), so the workflow drives a coding agent without the core or the orchestrator ever importing an agent-specific API.

The adapter translates and refuses. It decides nothing: the orchestrator still owns stage selection, context routing, the legal transition, the human approval gates, and the artifact writes. A stage the agent did not finish is a failure, not a partial success.

```text
StageExecutionRequest
  -> agent id + deterministic prompt   (orchestrator-routed context only)
  -> OpenCodeTransport                (a port; the CLI is one implementation)
  -> structured response parsing      (one fenced JSON payload, never prose)
  -> StageExecutionResult
```

## Package boundary

Dependencies point one way: `core -> persistence -> orchestration -> opencode`. The adapter depends on the core, the persistence adapter, and the orchestrator. Nothing below it depends on it, and no OpenCode type, config key, or CLI name appears outside `adapters/opencode/`.

| Module | Responsibility |
| --- | --- |
| `roles.ts` | The eleven role definitions, their access level, and the stage-to-agent map. |
| `permissions.ts` | Least-privilege OpenCode permission maps, including the protected path rules. |
| `hard-rules.ts` | Framework rules that are re-sent to every run, and the `AGENTS.md` precedence statement. |
| `agents.ts` | Deterministic `.opencode/agents/*.md` and `opencode.json` generation, plus a guarded writer. |
| `project-instructions.ts` | Reads `AGENTS.md` from the project, truncated and marked when it is too long. |
| `prompts.ts` | Builds the per-stage prompt from the request and nothing else. |
| `response-protocol.ts` | Extracts and validates the structured payload. |
| `transport.ts` | The `OpenCodeTransport` port every executor depends on. |
| `cli-transport.ts` | The real transport: `opencode run` as a child process, with no shell. |
| `executor.ts` | The `StageExecutor` implementation that wires the two together. |
| `install-policy.ts` | The recorded installer decision. No installer exists. |

## Roles

Eleven roles cover the thirteen workflow stages. The three verification stages deliberately share one `verifier` agent: static, test, and runtime verification are the same judgement over different evidence, and the stage in the prompt is what distinguishes them.

| Stage | Role | Agent | Access |
| --- | --- | --- | --- |
| `grill` | `griller` | `griller` | read only |
| `planning` | `planner` | `planner` | read only |
| `plan_review` | `plan_reviewer` | `plan-reviewer` | read only |
| `implementation` | `implementer` | `implementer` | writes project files |
| `code_review` | `code_reviewer` | `code-reviewer` | read only |
| `scope_review` | `scope_reviewer` | `scope-reviewer` | read only |
| `static_verification`, `test_verification`, `runtime_verification` | `verifier` | `verifier` | read only |
| `fixing` | `fixer` | `fixer` | writes project files |
| `security_review` | `security_reviewer` | `security-reviewer` | read only |
| `final_gate` | `final_gate_reviewer` | `final-gate-reviewer` | read only |
| `final_summary` | `summarizer` | `summarizer` | read only |

Nine roles are read only. Only the `implementer` and the `fixer` may change a project file, and the `fixer` is the only role that repairs a reported finding.

Each role has its own purpose, responsibilities, prohibitions, and deliverables. The definitions in `roles.ts` are the single source: the generated agent file and the per-stage prompt are both rendered from them, so a role cannot drift between the file OpenCode loads and the prompt the adapter sends.

## Permissions

Permissions are generated, not requested in prose. A generated agent file carries an OpenCode `permission` map and, for read-only roles, an explicit tool deny list.

| Capability | Read-only roles | `implementer`, `fixer` |
| --- | --- | --- |
| `edit` on a project file | `deny` | `allow` |
| `edit` on `.agentflow/**` or `*.agentflow/**` | `deny` | `deny` |
| `edit` on `.git/**` or `*.git/**` | `deny` | `deny` |
| `read` on a project file | `allow` | `allow` |
| `read` on workflow state or Git state | `deny` | `deny` |
| `bash` | `deny` | `deny` |
| `webfetch`, `websearch` | `deny` | `deny` |
| `task` | `deny` | `deny` |
| `external_directory` | `deny` | `deny` |

`bash: deny` is what makes "no agent receives commit or push authority" structural rather than a promise: with no shell there is no `git commit`, no `git push`, and no project command execution either, which is consistent with command execution being deferred in this milestone. `task: deny` keeps the roles separate, because a reviewer cannot delegate to an implementer and no role can collapse the workflow into one generalist agent. A project's own `.gitignore` is deliberately editable: only version-control state is protected.

`mode: primary` is set for every agent, and `--pure` is passed to the CLI by default so a project plugin cannot alter a role's behaviour at runtime.

## The prompt boundary

A prompt is built from the request and nothing else. It contains the role instructions, the feature identity, the current stage, the artifacts the orchestrator routed to that stage, the output slots that stage may fill, the response protocol, the optional `AGENTS.md`, and the framework hard rules. It never contains the rest of the feature history, the stored session, the event log, or a file the orchestrator did not route. The same request always produces the same prompt.

`AGENTS.md` is project convenience, not framework policy. It is included verbatim under an explicit precedence statement, and the framework rules are re-sent **after** it, so a repository instruction cannot grant approval authority, write access, Git access, or permission to disable verification. A file longer than the limit is truncated with the cut marked, and the agent is told that something was withheld rather than left to guess.

## The response protocol

Every run answers with exactly one fenced JSON block:

```json
{
  "outcome": "success | needs_fix | failed | inconclusive",
  "featureId": "F-001",
  "stage": "planning",
  "artifacts": [{ "name": "plan", "content": { "steps": [] } }],
  "findings": [],
  "evidence": [],
  "summary": "one or two sentences a human can act on"
}
```

The adapter refuses, rather than repairs, when the response is prose, malformed JSON, an empty block, an array, a foreign `featureId`, another `stage`, an artifact the stage does not own, a duplicate artifact, an extra field, a missing field, an empty `summary`, a `needs_fix` on a stage that cannot fix, a finding for another feature, an unknown evidence kind, or any workflow-control field such as `event`, `nextState`, `transition`, `session`, `commit`, `push`, `approve`, or `approvals`. Refusals are thrown as `OpenCodeAdapterError` with a `code`, so the orchestrator reports an executor failure and the feature stays where it was.

Prose is never scraped for meaning. A completion sentence, an "all tests pass" claim, or a bare "done" carries no workflow meaning, and the orchestrator's own `validateStageExecutionResult` still validates whatever the adapter forwards.

## Transport

The executor depends on the `OpenCodeTransport` port, not on a process, so tests substitute a fake and a server or SDK deployment can be added without touching the executor or the prompt boundary. `OpenCodeTransportRequest` carries the workflow identity of the run — `featureId`, `stage`, `role`, `fixReturnState` — as transport metadata for logging, rate limiting, and test keying. It is never part of the agent's message; only the prompt reaches the model, and the adapter has already decided the stage before the transport is called.

`OpenCodeCliTransport` runs the real CLI with these properties, all of them load-bearing:

- arguments are passed as an array with `shell: false`, so no feature title, user request, or artifact content is ever interpreted by a shell;
- the environment is inherited only because a provider credential is required, and it is never echoed into a result, a log line, or an error message;
- a prompt that starts with `-` is refused rather than parsed as an option;
- stdout and stderr are captured separately with a byte cap that stops a runaway run;
- a timeout, an abort, a non-zero exit, an unstartable binary, or an oversized stream becomes a refusal, never an empty success;
- a failing run reports the exit code and a bounded stderr excerpt, and never echoes the command line, which contains the stage prompt.

`opencode run --format json` is supported as well: `extractEventStreamText` is the only place that knows the raw event stream's shape, and an unrecognized stream is returned unchanged so parsing fails closed.

## Generated project files

```text
.opencode/agents/
  griller.md            planner.md             plan-reviewer.md
  implementer.md        code-reviewer.md        scope-reviewer.md
  verifier.md           fixer.md                security-reviewer.md
  final-gate-reviewer.md summarizer.md
opencode.json
```

`renderOpenCodeProjectFiles()` returns these as `{ path, contents }` values and is byte-for-byte deterministic. `writeOpenCodeProjectFiles(root, { force })` writes them with the same symlink guards the persistence adapter uses, leaves identical files untouched, and reports a human-edited file as a `conflict` instead of silently reverting it. `opencode.json` is deliberately minimal — a schema reference and `share: "disabled"` — because the capability model lives in the agent files and model, temperature, and prompt defaults belong to the repository and the user.

## Public API

```ts
import { createWorkflowOrchestrator } from "@agent-workflow-kit/orchestration";
import { createFeatureSessionStore } from "@agent-workflow-kit/persistence";
import {
  createOpenCodeCliTransport,
  createOpenCodeStageExecutor,
  writeOpenCodeProjectFiles,
} from "@agent-workflow-kit/opencode";

// Thin, version-controlled configuration; no framework code is copied into the project.
await writeOpenCodeProjectFiles("/path/to/repository");

const store = createFeatureSessionStore("/path/to/repository");

const executor = createOpenCodeStageExecutor({
  transport: createOpenCodeCliTransport({ model: "anthropic/claude-sonnet-4-5" }),
  workingDirectory: "/path/to/repository",
});

const orchestrator = createWorkflowOrchestrator({ store, executor });

await orchestrator.createFeature({ featureId: "F-001", title: "Google OAuth / API", request });
await orchestrator.runNext("F-001");
```

In tests, `createFakeOpenCodeTransport` from the repository's `fixtures/opencode-transport.ts` replaces the CLI transport and never spawns a process or calls a model.

`OpenCodeStageExecutorOptions`:

| Option | Meaning |
| --- | --- |
| `transport` | Required. The port the executor runs through. |
| `workingDirectory` | Required. The repository the agent runs in, and the only project the adapter knows. |
| `model` | Optional model override; otherwise the executor sends `null` and OpenCode decides. |
| `timeoutMs` | Per-run budget; defaults to `DEFAULT_TIMEOUT_MS`. |
| `signal` | Cancels an in-flight run. |
| `projectInstructions` | Explicit guidance; overrides the file lookup. |
| `loadProjectInstructionsFromDisk` | Set `false` to ignore `AGENTS.md` entirely. |
| `projectInstructionsOptions` | `relativePath` and `maxChars` for the lookup. |

## Installer policy

Installing the kit into a repository must not vendor the framework. The implementation stays in the installed package; the repository receives thin configuration, and only the configuration is version controlled. That decision and the data a future installer needs are recorded in `install-policy.ts`:

- **version controlled**: `AGENTS.md`, `.agentflow/config.*`, deliberate local policy overrides, `skills.lock` once external skills exist, and `.opencode/agents/*.md` with `opencode.json`;
- **runtime generated, ignored**: everything under `.agentflow/features/`, `cache/`, `recordings/`, `tmp/`, `locks/`, and `*.lock`;
- **never vendored**: the framework implementation itself, including `core/`, `orchestration/`, `adapters/`, and `templates/`.

No installer, scaffolding command, or framework copy exists in this milestone. `ARTIFACT_TRACKING_MODES` records the three tracking options a future installer may choose between; choosing one must never change what the orchestrator verifies.

## Testing

No test in this repository calls a real model, a real agent runtime, or the network. The transport tests spawn `process.execPath` as a stand-in binary, so the process boundary is exercised for real — arguments, environment, exit codes, streams, timeouts, and cancellation are all genuine — while nothing is sent anywhere. The integration tests drive a complete feature from request to the plan approval gate, and on to the final summarizer with a real fix history, through `FakeOpenCodeTransport`.

The adapter has not been exercised against a live OpenCode installation; the binary on the development machine is not resolvable. Treat the CLI's flags and event-stream shape as the part most likely to need adjustment when it is first run for real, and keep that surface confined to `cli-transport.ts`.

## What this milestone does not do

- No project command execution. No agent may run tests, linters, type checkers, or builds, and no agent may claim that one ran. Verification assesses the evidence it was given and reports `inconclusive` otherwise.
- No Git. No commit, no push, no branch manipulation. The two human approval gates are still human.
- No third-party agent integrations, no external skill downloads, and no final installer.
