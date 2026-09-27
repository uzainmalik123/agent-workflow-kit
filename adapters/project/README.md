# Project adapter

The project adapter is the one place in this repository that is allowed to run a command in a
project. It answers one question for the orchestrator: for this workflow stage, what did the
project's own commands actually do?

It depends on `@agent-workflow-kit/core` and `@agent-workflow-kit/orchestration` for contracts, and
on nothing else. It does not import an agent adapter, and the orchestrator never imports it: the
connection between them is the `VerificationProvider` port.

## The path, in order

```
discovery (reads files, executes nothing)
  -> configuration (validated, never written)
  -> command plan (framework-selected commands only)
  -> run (shell: false, one executable and an argument array)
  -> evidence (exit status is authoritative)
```

A model never appears in it. Nothing here reads a stage response, and a stage response cannot add,
remove, or reorder a command: the plan is a function of the repository and the configuration file.

## Discovery

`discoverProject(root)` is a pure function of the files it reads. It resolves no symbolic links, reads
only well-known filenames, refuses a manifest that will not parse rather than reporting a project with
no commands, and refuses a manifest larger than `MAX_MANIFEST_BYTES` instead of buffering it. A
repository that puts a symlink where a manifest belongs gets an explicit refusal, not the contents of
wherever the link points.

Ecosystem precedence is `node`, then `python`, then `rust`, then `java`, then `unknown`. Anything that
is not Node is reported as `unsupported` for every capability, with a note saying why, and gets no
command: there is no Rust or Python adapter in this milestone, and inventing a command for an ecosystem
the framework cannot verify would be worse than saying so.

Language is separate from ecosystem. `tsconfig.json`, a `tsconfig.build.json`, or a `typescript`
dependency makes a project TypeScript; `jsconfig.json` does not, because it configures a JavaScript
project. That distinction is the difference between a `not_applicable` typecheck and a real one.

### Package managers

The lockfile decides, in the order `pnpm`, `bun`, `yarn`, `npm`. The manifest's `packageManager` or
`devEngines.packageManager` is a fallback used only when no lockfile exists, and a conflict between
them is recorded in the profile rather than resolved quietly. When no manager can be determined, no
command is built and every capability is `blocked` with `package_manager_unknown`, because a script
invocation without a manager is a guess about what the project installed.

### Capabilities

Each capability is classified, and the classification is what the evidence report is built from:

| status            | meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `applicable`      | a command exists and can be run                                      |
| `not_applicable`  | the ecosystem cannot have the check, such as typecheck in plain JS   |
| `unavailable`     | the project could have it and provides no command                    |
| `unsupported`     | this framework has no adapter for it, such as rust or runtime        |
| `blocked`         | something outside the project stopped it, such as missing packages   |

The reasons are stable codes (`detected`, `script_absent`, `language_without_typecheck`,
`ecosystem_unsupported`, `not_configured`, `dependency_missing`, `package_manager_unknown`,
`runtime_deferred`), so a report is machine-readable and a test can assert on the reason rather than
on prose.

### Script selection

| capability | scripts, first match wins                     |
| ---------- | --------------------------------------------- |
| `lint`     | `lint`                                        |
| `typecheck`| `typecheck`, `types`, `check-types`, `check:types` |
| `build`    | `build`                                       |
| `test`     | `test`, otherwise `test:unit` **and** `test:integration` when both exist |

A bare `test` is the whole suite and is run once. The split is two half-suites and is run as two
checks, because a project that has them is asserting that they are separable and a single run would
hide which half broke.

`runtime` is always `unsupported` with reason `runtime_deferred`. Reticle owns runtime verification
in a later milestone, and the stage is recorded as `deferred` rather than as a pass, so the workflow
stays satisfiable while it is deferred.

## Command trust model

A command is an executable and an argument array, in a working directory that is either the project
root or a subdirectory of it. There is no third shape:

- `shell: false` unconditionally, so a script name, a feature title, or a task payload can never
  become shell syntax;
- no interpolation, no template strings, no `sh -c`, and a configured `cwd` that leaves the project
  root is refused;
- a missing dependency is reported and never repaired, because installing would execute
  repository-defined lifecycle hooks without a human having approved anything about it;
- `add`, `install`, `remove`, `exec`, `dlx`, and lifecycle script names (`preinstall`, `install`,
  `postinstall`, `prepare`, `prepublish`, …) are refused by the command policy itself, so a project
  configuration cannot ask for them either;
- no error message, evidence record, or excerpt contains an argument list or an environment value.

## Project configuration

`agent-workflow.config.json` is the only way to state a command detection did not find. It is the
minimum needed to keep deterministic detection small: a project that uses a tool this adapter has
never heard of declares the command, and the framework still runs it as an executable plus arguments,
still refuses the forbidden invocations, and still records the exit status.

```json
{
  "schemaVersion": 1,
  "verification": {
    "static": [{ "id": "ruff", "capability": "lint", "executable": "ruff", "args": ["check"] }],
    "test": [{ "id": "pytest", "capability": "test", "executable": "pytest", "args": ["-q"], "cwd": "backend" }]
  }
}
```

A command entry accepts exactly `id`, `capability`, `executable`, `args`, and an optional `cwd`. Any
other field is refused, including `command` and `shell`, so a shell line has nowhere to go. A file
that exists and does not validate is a refusal, not a fallback to detection: silently ignoring a
misconfigured command would report a project as verified when its own configuration says otherwise.

The file is project configuration, not agent output. It is readable, because a fixer repairing a
failing check has a legitimate reason to know which command produced it, and it is not writable by
any role: the generated OpenCode permissions deny `edit` on it for every role, including the
implementer and the fixer.

## Process execution

`runChildProcess` is the single deterministic runner in the repository, and the OpenCode transport
uses it too, so there is no weaker second path. It never rejects and never throws: every outcome is a
result, because a failing lint run is exactly the evidence a verification stage must be able to
record. Turning a result into a refusal is a caller's decision, and the transport's refusal is one.

It reports `exited`, `signalled`, `timed_out`, `cancelled`, `spawn_failed`, or `output_truncated`,
with the exit code, the signal, the duration, a bounded head-and-tail capture of each stream, and a
stable reason code for anything that was not an exit. A timeout or an abort terminates the child and
escalates to `SIGKILL` after the grace period, and the first forced termination wins, so a command
that is aborted and then overruns is reported as cancelled. Output that exceeds the byte ceiling stops
the run rather than growing the process's memory.

## Evidence

Every check records the command that ran, the working directory, the script or the fact that the
command was declared rather than discovered, the exit code, the signal, the duration, a bounded
capture of both streams, the session revision, and the implementation fingerprint. The status comes
from the termination and the exit code alone. A command that prints `0 failing` and exits 3 is a
failure, and a command that prints `error: build failed` and exits 0 is a pass, because the exit
status is the fact and the prose is a comment about it.

The stage outcome is a function of the checks and nothing else. Any check that did not pass fails the
stage, a check that could not start blocks it, and a stage whose checks were all skipped is deferred.
A check that never ran is not a pass.

The `implementationFingerprint` is a SHA-256 digest over each file's project-relative path, size, and
content digest, in sorted path order, excluding generated and dependency directories. It is a
fingerprint and not a cache: nothing is stored or looked up, and a mismatch only ever means "collect
again". It exists so evidence from before a fix cannot prove the code that fix produced. A project
that could not be measured at all records an all-zero fingerprint, which is visibly not a real digest.

## Orchestration contract

The orchestrator collects evidence for a verification stage after the plan-approval freeze has been
re-verified and before the stage executor is involved, which is the only point at which project code
runs, and running it is a consequence of a human having approved work in this repository. It then:

- refuses a provider that throws, a bundle that fails validation, and a bundle that contradicts
  itself, writing nothing in all three cases;
- passes the bundle to the verifier in the prompt, rendered in full, so the verdict is traceable to a
  recorded result;
- coerces a reported `success` to `needs_fix` when the evidence is `failed` or `blocked`, and adds a
  finding naming the command and its exit code, independently of what the model said;
- accepts a verifier failure on evidence that passed, because a reader can see more than an exit code;
- appends every attempt under `deterministic_evidence` in `verification.json`, beside the model's own
  section and never over it.

`deferred` does not block. Runtime verification has no deterministic command yet, and treating a
deferred check as a failure would make the workflow unsatisfiable.

## Not in this milestone

No dependency installation, no lifecycle scripts, no Git, no Reticle, no free-form command templates,
and no third-party skill integration. A Rust, Go, or Python command has to be declared in
`agent-workflow.config.json` and is run exactly as strictly as a detected Node command, or the
capability is reported as unsupported.
