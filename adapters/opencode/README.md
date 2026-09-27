# OpenCode adapter

`@agent-workflow-kit/opencode` is the first real agent adapter in the kit. It implements the orchestration `StageExecutor` port on top of [OpenCode](https://opencode.ai), so the workflow drives a coding agent without the core or the orchestrator ever importing an agent-specific API.

This adapter targets **OpenCode V2** natively. The V1 configuration syntax is not emitted, not parsed, and not relied on: there is no `permission:` object, no `tools:` boolean block, and no `bash` or `task` action name anywhere in the generated configuration. The official npm package for the CLI is `@opencode/cli`, and the kit never installs it.

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
| `permissions.ts` | The V2 `permissions` rulesets: ordered `{ action, resource, effect }` rules and the wildcard evaluator. |
| `process.ts` | The one `spawn` call: no shell, a timeout, cancellation, output caps, and a bounded stderr excerpt. |
| `hard-rules.ts` | Framework rules that are re-sent to every run, and the `AGENTS.md` precedence statement. |
| `agents.ts` | Deterministic `.opencode/agents/*.md` and `opencode.json` generation, plus a guarded writer. |
| `project-instructions.ts` | Reads `AGENTS.md` from the project, truncated and marked when it is too long. |
| `prompts.ts` | Builds the per-stage prompt from the request and nothing else. |
| `response-protocol.ts` | Extracts and validates the structured payload. |
| `transport.ts` | The `OpenCodeTransport` port every executor depends on. |
| `cli-transport.ts` | The real transport: `opencode run` as a child process, with no shell, and the V2 event-stream reader. |
| `capabilities.ts` | A safe local probe of the installed binary. No model, no network. |
| `smoke-test.ts` | Optional generated-configuration validation against a real binary. Skips when there is none. |
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

Permissions are generated, not requested in prose. A generated agent file carries a V2 `permissions` list: an ordered array of `{ action, resource, effect }` rules. Two properties of V2 evaluation make the order part of the policy:

- the **last matching rule wins**, so a broad rule must come before the exception that narrows it;
- an action that matches **no** rule resolves to `ask`, and a non-interactive `opencode run` auto-rejects a `permission.asked` request, which would break the stage run.

Every ruleset therefore opens with `{"*", "*", "deny"}` and re-allows only the actions a role needs. That makes an `ask` outcome unreachable, and it denies any action a plugin might introduce, because nothing is allowed that was not asked for by name.

| Action | Read-only roles | `implementer`, `fixer` |
| --- | --- | --- |
| `read`, `glob`, `grep` on a project file | `allow` | `allow` |
| `edit` on a project file | `deny` | `allow` |
| `edit` on `.agentflow`, `*.agentflow`, `*.agentflow.*`, `.git`, `*.git` | `deny` | `deny` |
| `read` on workflow state, Git state, or `*.env` | `deny` | `deny` |
| `shell` | `deny` | `deny` |
| `subagent` | `deny` | `deny` |
| `skill` | `deny` | `deny` |
| `webfetch`, `websearch` | `deny` | `deny` |
| `external_directory` | `deny` | `deny` |
| `question`, `plan_enter`, `plan_exit`, `execute` | `deny` | `deny` |

V2 renamed several actions, and the generated files use the current names: `bash` is `shell`, `task` is `subagent`, and the `edit` action covers the edit, write, and patch tools. A secret file is denied outright rather than left to an `ask` that nobody could answer.

`shell: deny` is what makes "no agent receives commit or push authority" structural rather than a promise: with no shell there is no `git commit` and no `git push`, and no project command execution either. Project commands are not deferred, they are simply not the agent's to run: the project adapter executes them outside the session and hands the recorded result to the verifier, so an agent's route to a command result is the evidence, not the command. `agent-workflow.config.json` is also denied to `edit` for every role, because that file decides which commands the framework will run and an agent that could change it could redefine what "verified" means for the rest of the run. It stays readable, since a fixer repairing a failing check has a reason to know which command produced it. `subagent: deny` keeps the roles separate, because a reviewer cannot delegate to an implementer and no role can collapse the workflow into one generalist agent. `skill: deny` holds the line until skill integration exists, so no role can pull instructions in from outside the repository. A project's own `.gitignore` is deliberately editable: only version-control state is protected.

`matchesResourcePattern` is a faithful port of OpenCode's own wildcard matcher, so a decision made in a test is the decision the CLI makes at run time. Backslashes normalize to `/`, `*` stands for any run of characters including `/`, `?` stands for exactly one, a pattern ending in a space and a star also matches the bare value, and matching is anchored and case-insensitive only on Windows.

The `permissions` list is emitted as YAML in the agent frontmatter, and it has to be a real YAML
block sequence: every rule is its own list item, with its own `action`, `resource`, and `effect`. The
emitter once wrote the `- ` marker only before the first rule, which folded every later rule's keys
into that first mapping as repeats. YAML answers duplicate keys in a mapping with an error, OpenCode
rejected the whole frontmatter, and every role silently fell back to its untouched default
capability set - a malformed emitter that handed every stage full access. The regression tests parse
the emitted frontmatter as YAML and count list items, so a folded rule fails a unit test instead of
appearing as eleven unrestricted agents in a live smoke test.

`mode: primary` is set for every agent. A plugin is arbitrary code that can rewrite a system
prompt, replace a tool, or register a new one, so a plugin is a way to change what a verifier,
reviewer, or implementer is allowed to do, and therefore what it reports. Plugin isolation is
therefore two independent layers, because they defend against different things.

**Preflight: refuse repository plugin code, before OpenCode starts.** `assertNoProjectLocalPlugins`
runs at the top of every stage execution, before the transport is touched and before anything is read
out of the repository. If an auto-discovered plugin location holds loadable code, the stage is
refused with a structured `project_plugin_detected` error listing the offending paths, and the
transport is never invoked. Nothing is deleted, renamed, or ignored, because the repository is not
the framework's to modify.

**Configuration: disable the plugins OpenCode would otherwise load.** V2 removed `--pure`, so the
generated `opencode.json` sets `plugins: ["-*", "opencode.*"]`: `-*` disables every plugin and the
later entry re-enables the `opencode.` namespace. That is what stops a third-party integration
arriving through `node_modules`, a global config, or an explicit `plugins` entry in a config file.
The re-enable is load-bearing rather than cosmetic, because `opencode.config.agent`, which loads the
generated agents, and the permission machinery are themselves plugins under `opencode.`, so disabling
the namespace would not harden a run, it would break it and produce an empty agent list.

**Why the preflight does not lean on the configuration.** The namespace re-enable really does match a
repository-chosen id. Against OpenCode 2.0.18, a repository plugin at `.opencode/plugin/evil.ts`
declaring `id: "opencode.evil"` is listed by `opencode plugin list` under `plugins: ["opencode.*"]`,
so `opencode.evil` is a repository-controlled string that the trusted namespace admits. What closes
*this particular* vector today is the ordering: with the generated `["-*", "opencode.*"]` the earlier
`-*` wins and the plugin is not enabled, while with `["-*"]` alone it is also not enabled. So on
2.0.18 the configuration alone blocks this path.

That is not a property to depend on. It is undocumented behaviour, it was established by probing one
patch release rather than from a specification, and the outcome flips if the directives are reordered
or a version resolves them differently. A control whose safety rests on the ordering of two strings
in a config file a future CLI version owns is not a control. The preflight does not read plugin
directives at all: it refuses repository plugin code from the filesystem, before OpenCode runs, so it
holds regardless of how any version filters ids, and regardless of paths that never reach the filter
at all, such as a plugin pulled in by an ancestor configuration. The configuration stays because it
does the job the preflight cannot: disabling non-framework integrations that arrive from
`node_modules` or a global config, in a repository that contains no plugin of its own.

The fixture at `fixtures/opencode-plugin-repo/` is exactly the repository described above, and
`tests/opencode-plugin-preflight.test.ts` proves the executor refuses it with zero transport calls.

**Paths checked.** For the project and each ancestor up to the workspace boundary, the four
auto-discovered locations: `.opencode/plugin/`, `.opencode/plugins/`, `plugin/`, and `plugins/`.
These are not guesses; in a real 2.0.18 bundle the plugin source directory scan is a literal
`["plugin", "plugins"]` list applied to the project and to every applicable ancestor, and `.opencode/`
is itself one of those configuration directories, which is where the two dotted forms come from.

**The workspace boundary.** The ancestor walk stops at the repository root, found by looking for
`.git` upward. That is what keeps this from becoming a filesystem scan, and it is a correctness
boundary rather than only a work bound: a developer's global `~/.opencode` is an ancestor of a
checkout but is not repository-controlled, so refusing on it would make a workflow stage depend on
machine-level state. A monorepo project in a subdirectory is covered without configuration, because
the repository root is above it. Pass `pluginPreflightOptions.stopAt` when the workspace is wider
than the repository.

**Symlinks.** Checks use `lstat` and never follow a link that leaves the repository boundary. A plugin
directory that is a symlink out of the tree, or an executable entry inside one, is reported as
`escaping_symlink` and the link is not read. A link that stays inside the repository is followed and
inspected, since that code is the repository's own. A dangling link loads nothing and is ignored.

**What is deliberately allowed.** `.opencode/agents/` and `.opencode/commands/` are the framework's
own generated output and are never reported; a correctly generated project has to pass. An empty
plugin directory, or one holding only text such as a README or a licence, is also allowed: the
preflight refuses executable plugin code, not the existence of a directory, and a path that cannot
load is not a risk. Only `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`, and a
`package.json` entry count as executable.

## The prompt boundary

A prompt is built from the request and nothing else. It contains the role instructions, the feature identity, the current stage, the artifacts the orchestrator routed to that stage, the output slots that stage may fill, the response protocol, the optional `AGENTS.md`, and the framework hard rules. It never contains the rest of the feature history, the stored session, the event log, or a file the orchestrator did not route. The same request always produces the same prompt.

A verification stage's prompt carries one addition, and only when the orchestrator collected it: the deterministic evidence, rendered in full. Every check appears with its capability and classification, its exact executable and argument array, its working directory, its exit code or signal, its duration, and its bounded captured output, alongside the recorded stage outcome, the collection time, the session revision, and the implementation fingerprint. The section states as framework fact that the evidence was collected before the stage was invoked and that the outcome is already recorded, because the verifier's authority comes entirely from those records and a verdict that is not traceable to one of them is not a verdict this framework can act on.

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
- `--auto` is never passed unless a caller explicitly asks for it, because it approves anything that is not explicitly denied;
- a prompt that starts with `-` is refused rather than parsed as an option;
- stdout and stderr are captured separately with a byte cap that stops a runaway run;
- a timeout, an abort, a non-zero exit, an unstartable binary, or an oversized stream becomes a refusal, never an empty success;
- a failing run reports the exit code and a bounded stderr excerpt, and never echoes the command line, which contains the stage prompt.

The invocation is exactly this, and nothing else:

```text
opencode run --standalone --agent <agent> --format <default|json> [--model <id>] [prompt]
```

No session continuation, no `--attach`, no shared server. One stage run is one fresh session, and nothing about the previous stage's session is reused. The adapter's own name for the formatted output, `text`, maps to the CLI's `default`; the CLI has never accepted `text` as a format value.

`--format json` returns an NDJSON event stream: one JSON object per line, each carrying `type`, `timestamp`, `sessionID`, and a payload. `parseEventStream` is the only place that knows this shape. It reads completed `text` parts — the current runner emits one only once the part is complete, and an answer can span several, so the parts are joined rather than the last one taken — and it reports an `error` event. An event type it does not recognize contributes nothing and is never read as output, and a stream that yields no text part is a failure rather than a raw-output fallback. Nothing in the pipeline reads an unfamiliar stream as a stage result.

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

### Checking the installed binary

```ts
import {
  describeCapabilities,
  describeSmokeTest,
  probeOpenCodeCapabilities,
  runOpenCodeConfigSmokeTest,
} from "@agent-workflow-kit/opencode";

console.log(describeCapabilities(await probeOpenCodeCapabilities()));
console.log(describeSmokeTest(await runOpenCodeConfigSmokeTest()));
```

`probeOpenCodeCapabilities` runs only `opencode --version`, `opencode --help`, `opencode run --help`, `opencode debug --help`, and `opencode debug agents --help`. No model, no network, no writes. The `debug agents` probe is deliberately given `--help`: the real listing makes V2 start a background service, and a capability probe has no business starting one. Every flag field is deliberately three-valued: `true` when the flag appears in the help, `false` when the help was read and the flag is absent, and `null` when the probe could not read the help at all. `missingRunCapabilities` reports only the `false` values, because "we could not check" is a reason to look again rather than a decision to change the invocation.

The probe reads the real CLIs, not an idealised one, and the two differ in ways that matter here:

- **The version string is tagged.** V1 prints `1.18.18`; V2 prints `opencode v2.0.18`. A reader that only accepts a leading digit reports every real V2 binary as having no version at all, which is the one answer that cannot be acted on.
- **The agent listing is the plural `debug agents`.** V1 has `agent list` and a singular `debug agent <name>`; V2 has neither, and its `debug --help` lists `agents`, `config`, and `paths`. A probe that matched the substring `agent` would accept the V1 command and then send V2 an argument list it rejects.
- **Two V1 flags are gone, and the invocation no longer sends either.** V2 has no `--dir` and no `--pure`; the working directory comes from the child process's own `cwd`, and plugin isolation is generated configuration. V2 adds `--standalone`, and the invocation always passes it, so `standaloneFlagAvailable` is a required capability rather than an optional one. `REQUIRED_RUN_FLAGS` is exactly the flags `buildOpenCodeInvocation` sends unconditionally, so the probe and the transport cannot drift: a binary missing one of them is reported by `missingRunCapabilities` instead of being driven with an argument it rejects. A run never silently falls back to the shared background service.

Flags alone cannot tell V1 from V2. A real OpenCode 1.18.18 binary advertises `--agent`, `--format`, `--model`, and `--auto` just as V2 does. What a V1 binary does instead is silently ignore a `permissions:` list and leave every role with the default capability set, which is exactly the failure this milestone exists to prevent. The probe therefore reads the version separately and reports `versionSupportsV2`; the smoke test skips on a binary that predates V2 instead of reporting the ignored rules as a failure.

`runOpenCodeConfigSmokeTest` writes the generated files to a temporary directory, asks the binary to report the agents it discovered there with `opencode debug agents`, and replays the policy against the rulesets it reported. V2 answers that command from a background service and prints a JSON array of agent objects sorted by id, each carrying `id`, `name`, `mode`, `hidden`, and the `permissions` array it resolved. `parseAgentListing` reads exactly that shape and returns `null` for anything else — a payload it cannot recognise is never treated as an empty listing, because "the binary found nothing" and "the payload was not readable" are different facts.

The listing is polled rather than taken once, because on a real 2.0.18 binary the first answer is not authoritative. When no service is running yet, the CLI starts one, reports it healthy, and asks it for the agent list before that service has finished loading the directory: the first call returned an empty array and an immediate second call returned only the seven built-in agents, with the generated ones appearing about two seconds later. Believing the first answer reports all eleven roles as missing, which is a fact about start-up rather than about the generated files. So the test keeps asking until the listing accounts for every generated agent, within `DEFAULT_AGENT_LISTING_READY_TIMEOUT_MS`. That condition is one a correctly generated project satisfies and a genuinely wrong one never does, so the wait cannot turn a defect into a pass — the loop simply runs out of time and the last real answer is reported as the failure it is.

The report fails closed at every step. A generated role the binary did not list fails. A role whose listing carries no readable `permissions` array is left unverified (`null`), never passed. A listing that could not be produced at all is a failure rather than an empty discovery. And a binary that reports every role with OpenCode's untouched base ruleset — `{action: "*", resource: "*", effect: "allow"}` plus the `external_directory` and `.env` entries — is reported as a failure for all eleven roles, because that is the exact shape of a generated policy the binary did not read.

The smoke test is the one place the standing isolation is not available. `run` is always invoked
`--standalone`, but `opencode debug agents --standalone` is rejected: a real 2.0.18 binary advertises
`--standalone` on `run` and on the root command, and not on `debug agents`, where it prints its usage
and exits 1. The listing is therefore answered by the shared background service, which is why this
one call is polled and why the poll is bounded and fail-closed. The alternative, inventing a flag the
binary does not support, would have turned a working listing into a hard error.

The smoke test runs no `run` command, forces `OPENCODE_DISABLE_MODELS_FETCH` and `OPENCODE_DISABLE_AUTOUPDATE` on every child after the caller's own environment so they cannot be switched off, and reports `skipped` with a reason when the binary is missing, of an unknown version, older than V2, or has no `debug agents` — so an environment without a V2 OpenCode never fails a build. It is a diagnostic, not a gate. The listing call gets `DEFAULT_AGENT_LISTING_TIMEOUT_MS` per attempt rather than the 30-second default used for help output, because it is the one command that may have to start a background service first.

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

The capability and smoke tests run the same code against a stand-in binary, so the probe logic, the tri-state reporting, the version gate, and the generated-file checks are all exercised for real.

The adapter has **not** been exercised against a live OpenCode V2 installation, and the probe says so rather than guessing. On the development machine `opencode` on `PATH` is a V1-era shim that exits 127 with `Could not resolve npm bin for opencode-ai / opencode`, which the probe reports as `executableFound: false`. A second binary, `/usr/bin/opencode`, is a working OpenCode 1.18.18: the probe identifies it, reports `versionSupportsV2: false` with every flag present, and the smoke test skips with a reason instead of pretending to validate a configuration that binary would ignore.

Treat the CLI's flags and event-stream shape as the part most likely to need adjustment when a real V2 binary is first run, and keep that surface confined to `cli-transport.ts`.

## What this milestone does not do

- No project command execution by an agent. No agent may run tests, linters, type checkers, or builds, and no agent may claim that one ran. Verification is not deferred and not unavailable: the project adapter runs the project's own commands outside the session, the orchestrator records the results, and the verifier assesses exactly those records, reporting `inconclusive` for anything they do not cover.
- No Git. No commit, no push, no branch manipulation. The two human approval gates are still human.
- No third-party agent integrations, no external skill downloads, and no final installer.
