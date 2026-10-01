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
| `unsupported`     | this framework has no adapter for it, such as rust                |
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

`runtime` is `unsupported` with reason `runtime_deferred`, and stays that way whatever the project
contains. A manifest says what a project *has*; it never says how to start it. `dev` exists in most
projects, boots on a port chosen by the day, and is wrong often enough that guessing it would be worse
than not guessing at all, so nothing is inferred from a script name and the capability is reported as
deferred rather than as a command nobody ran.

A project that wants its application verified says so itself, in `verification.runtime`. The stage then
runs exactly that, and with no such section it is recorded as `deferred`: no process started, no port
opened, one skipped check saying `runtime_not_configured`, and a workflow that stays satisfiable
without ever having been proven.

## Command trust model

A command is an executable and an argument array, in a working directory that is either the project
root or a subdirectory of it. There is no third shape:

- `shell: false` unconditionally, so a script name, a feature title, or a task payload can never
  become shell syntax;
- no interpolation, no template strings, and a configured `cwd` that leaves the project root is
  refused;
- a command-string flag aimed at a known shell is refused by name. The shells are `sh`, `bash`,
  `dash`, `zsh`, `ksh`, `ash`, `csh`, `tcsh`, `fish`, `busybox sh`, `cmd`, `command`, `command.com`,
  `powershell`, and `pwsh`, matched case-insensitively and on the basename, so `/bin/sh -c` and
  `C:\\Windows\\System32\\cmd.exe /c` are both refused while `/bin/sh script.sh` is not. A general
  interpreter carrying one of those shells as an argument is refused the same way, which is why
  `python -c`, `node -e`, and `bash scripts/lint.sh` stay legal: they read code this framework did
  not assemble;
- a missing dependency is reported and never repaired, because installing would execute
  repository-defined lifecycle hooks without a human having approved anything about it;
- the package-manager allowlist is exactly one form: `"<manager>" "run" "<script>"`, matched on the
  executable's basename, so an absolute path to the same binary is the same command. Everything else is
  refused, which is what covers the shorthand aliases as well: `npm test` and `pnpm test` dispatch
  exactly what `run test` would, hooks included, so allowing them while refusing `run test` would be a
  hole with a one-word key. `install`, `ci`, `add`, `remove`, `exec`, `dlx`, `view`, `info`, `search`,
  `audit`, `pack`, `publish`, and `dist-tag` are all refused for the same reason, and so are the
  lifecycle script names (`preinstall`, `install`, `postinstall`, `prepare`, `prepublish`, …);
- a flag is refused in the script's position and before the `--` separator, so the only accepted
  arguments after the script are forwarded ones. `npm run --if-present lint` and `npm run --silent
  lint` both run `lint` with a manager flag where the script name belongs; a rule that allowed flags
  there would be deciding the hook question by accident, since a flag can change which script runs or
  whether the `pre` and `post` hooks fire at all. `npm run lint -- --fix` is accepted, because
  everything after `--` belongs to the script and the manager is not reading it;
- `npx` is refused outright rather than held to the subcommand allowlist. It takes a package name where
  a manager takes a subcommand, so `npx run lint` names a package called `run`, and a list that
  happened to contain `run` would permit a download and an execution of the operator's choosing while
  claiming to have applied the allowlist;
- a detected script that declares a `pre<name>` or `post<name>` hook is blocked, not run. Running
  `pnpm run lint` where the manifest also declares `prelint` executes code the stage never offered,
  through whichever manager happens to be installed, and the block says which hook was found and that
  the tool should be declared directly instead. The policy is the same for pnpm, npm, yarn, and bun,
  and it is a block rather than a fallback, because the fallback would be to execute a hook anyway;
- the hook policy reads the script name, not the command's origin, so a configured `npm run lint` is
  blocked by a `prelint` script exactly as a detected `pnpm run lint` would be. Being explicit about
  the command in `agent-workflow.config.json` does not grant an exemption from the manifest's own
  lifecycle rules, and the same file is where the escape is meant to be taken: declaring the tool
  itself, `./node_modules/.bin/eslint .`, derives no script, involves no package manager, and runs;
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

A configured command may only cover the capability its own section exists for: `static` covers `lint`,
`typecheck`, and `build`; `test` covers `test`; `runtime` covers `runtime`. Anything else is refused
with the section named, so a `test` section cannot quietly acquire the build command and have the
static stage report a pass it never measured. A configured command replaces the detected one for the
same capability rather than running alongside it, so a capability is never checked twice under two
different interpretations.

### Runtime verification

The other section is an object, because starting an application is not a command: it is a command, a
condition for being ready, and a set of criteria to judge.

```json
{
  "schemaVersion": 1,
  "verification": {
    "runtime": {
      "command": { "executable": "pnpm", "args": ["dev"] },
      "readiness": { "url": "http://127.0.0.1:3000", "timeoutMs": 30000 },
      "checks": [
        { "id": "health", "path": "/health", "expectedStatus": 200, "expectedBodyFragment": "ok" },
        { "id": "home", "path": "/", "expectedStatus": 200, "expectedBodyFragment": "Dashboard" }
      ],
      "timeoutMs": 60000
    }
  }
}
```

`command` is the same executable-and-arguments shape as everywhere else, and the same trust model
applies to it: no shell, no interpolation, and a `sh -c` style invocation is refused. `readiness` is a
URL the framework polls until it answers or `timeoutMs` is spent, and it is the one URL the checks are
resolved against. Each check declares `id`, `path`, and an optional `method` (default `GET`),
`expectedStatus`, and `expectedBodyFragment`; the absolute URL is resolved once, when the file is
parsed, and recorded as the `url` of every probe, so an evidence record names what was actually asked.

Resolution is deliberately narrow: the path is joined to the readiness URL, a path that begins with
`//` or carries its own host is refused, and a check that would leave the declared host is refused with
that host named. A verification that follows a redirect to another origin is verifying something the
project did not declare. `https:` is not supported, which is a refusal rather than a silent downgrade.

The stage is a sequence, and each step is honest about what it knows. The process starts; readiness is
polled until the URL answers with any status, so a 503 that means "booting" is not mistaken for a
healthy service and a 404 that means "up" is not mistaken for a broken one; the checks run in declared
order; the process is stopped whatever happened. A process that exits during the wait ends the wait
immediately with its exit code and its bounded output, rather than being polled against a port it will
never bind. The whole run shares one deadline, `timeoutMs` from the start of the process, so a
criterion that never answers is `deadline_exceeded` and the checks after it are not attempted.

Failure is determined by what came back, never by what was printed. A status that is not the expected
one is `status_mismatch` with both statuses in the detail, a body without the fragment is
`body_absent`, an unreachable port is `request_failed`, and a refusal, timeout, or abort keeps the
reason the client reported rather than the consequence of resetting the socket. Only `http:` is
attempted, redirects are not followed, responses are read under a 256 KiB ceiling, and the connection
is closed after each one: this is a check, not a client library.

`fixtures/runtime-app/` is the whole thing in miniature — a server, a manifest, and a committed
configuration — and `tests/runtime-verification.test.ts` drives it end to end: once passing, once
failing a criterion the same server cannot satisfy, and once with its port confirmed free afterwards.

The file is project configuration, not agent output. It is readable, because a fixer repairing a
failing check has a legitimate reason to know which command produced it, and it is not writable by
any role: the generated OpenCode permissions deny `edit` on it for every role, including the
implementer and the fixer.

## Process execution

`runChildProcess` is the single deterministic runner in the repository, the OpenCode transport uses it
too, and the runtime stage uses a supervised form of it, so there is no weaker second path. It never rejects and never throws: every outcome is a
result, because a failing lint run is exactly the evidence a verification stage must be able to
record. Turning a result into a refusal is a caller's decision, and the transport's refusal is one.

It reports `exited`, `signalled`, `timed_out`, `cancelled`, `spawn_failed`, or `output_truncated`,
with the exit code, the signal, the duration, a bounded head-and-tail capture of each stream, and a
stable reason code for anything that was not an exit. A timeout or an abort terminates the child and
escalates to `SIGKILL` after the grace period, and the first forced termination wins, so a command
that is aborted and then overruns is reported as cancelled. Output that exceeds the byte ceiling stops
the run rather than growing the process's memory.

The runtime stage needs more than a finished result, because a process that is still running has no
result yet. `startChildProcess` therefore returns a handle whose outcome can be asked for without
awaiting it (`peekOutcome`, which returns `null` while the process is alive and is honest about a
process that had already exited), whose output can be read at any moment, and which can be stopped and
then awaited. On POSIX the child is placed in its own process group and the group is signalled, so a
grandchild that inherited the pipes is stopped too. A stop the framework requested is recorded in the
stage diagnostics, and stopping is attempted on every path out of the stage — pass, fail, timeout,
cancellation — because a port left bound is a failure the next attempt would blame on something else.

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

Every check also carries a `detail`: one sentence saying what actually happened, in the terms of the
run rather than of a status. A failure reports the command and its exit code, a timeout says what was
killed, and a blocked script names the hook that caused it. It is bounded, and it exists because a
`blocked` check with no explanation is indistinguishable from a broken machine, which is a thing a
verifier should not have to guess about.

## Workspace integrity

The run is bracketed. The tree is fingerprinted before the first command and again after the last, and
both digests are kept as `workspace: { before, after, changed }`. The bundle and every check carry the
`before` digest, so a check always describes the tree as it was when the command started, and the pair
says whether that assumption survived the run.

A command that rewrites the implementation it is verifying is a real failure mode: a formatter, a
code generator, a snapshot updater, or a build step that writes into `src` produces green exit codes
about code that no longer exists. So a changed workspace forces the stage to `failed` on its own, with
no failed check to explain it, and adds a finding naming both digests. The check statuses stay exactly
as the processes reported them, because the finding is the framework's judgment and the statuses are
the run's record. A stage whose outcome would otherwise be `passed` or `deferred` is refused the same
way, since neither is true of a tree that moved.

The digest itself is a SHA-256 over each file's project-relative path, size, and content digest, in
sorted path order, excluding generated and dependency directories. It is a fingerprint and not a
cache: nothing is stored or looked up, and a mismatch only ever means "collect again". It exists so
evidence from before a fix cannot prove the code that fix produced, which is why it is measured twice
per run rather than once per session: a session-long digest could be correct when it was taken and
stale by the time the commands finished. A project that could not be measured at all records an
all-zero fingerprint, which is visibly not a real digest. The `maxFiles` and `maxFileBytes` bounds cap
what is reported and hashed; they are not a defense against a hostile tree.

## Control plane integrity

The workspace measurement above is the implementation, and it deliberately excludes `.agentflow/` and
`.opencode/`. That exclusion is right for judging the code and wrong for judging the framework: neither
directory is implementation, so neither belongs in a digest that answers "is this the code the checks
ran against".

The same bracketing is therefore applied a second time to those two directories, and the bundle carries
`controlPlane: { before, after, changed }` beside the workspace pair. It is a detection and not a lock:
nothing stops the write, and the after-digest turns it into a stage that cannot pass.

What it catches is specific. A verification command is repository-defined code, and it can write to the
session it is running inside. A revision bump is already refused, because finalization is a
revision-guarded mutation, but a rewrite that leaves the revision alone is not: the state machine reads
the file on disk, so a session moved from `static_verification` to `test_verification` during the static
run turns that commit into a test-to-runtime advance and the test stage never runs. Both digests being
equal is the only statement that nothing did that, and a project with neither directory hashes an empty
selection, so the common case is a real digest rather than a missing one.

A changed control plane forces the stage to `failed` with a finding naming both digests, on the same
terms as a changed workspace, and a bundle claiming `passed` or `deferred` over one is refused during
validation. The recorded evidence carries the pair to the verifier, and the prompt renders it as its own
section, because a model shown only passing exit codes has no way to know that a command rewrote the
rules it is being asked to apply. The OpenCode adapter's configuration integrity check is the second
layer and the tighter one: this one fails the stage, that one refuses to load the file.

## Orchestration contract

The orchestrator collects evidence for a verification stage after the plan-approval freeze has been
re-verified and before the stage executor is involved, which is the only point at which project code
runs, and running it is a consequence of a human having approved work in this repository. It then:

- refuses a stage reached with no provider at all, with `verification_not_configured`, before the
  stage executor is called and before anything is written, so there is no opinion left to believe;
- refuses a provider that throws, a bundle that fails validation, a bundle that contradicts itself,
  and a bundle that belongs to another request, writing nothing in all four cases;
- binds a bundle to the request that asked for it. The verification stage, the session revision, the
  resolved project root, and every check's kind, revision, and fingerprint must match, so an old
  revision, a future revision, another feature's tree, and a single stale check are each refused with
  `verification_evidence_mismatch`;
- passes the bundle to the verifier in the prompt, rendered in full, so the verdict is traceable to a
  recorded result;
- coerces a reported `success` to `needs_fix` when the evidence is `failed` or `blocked`, and adds a
  finding naming the command and its exit code, independently of what the model said;
- accepts a verifier failure on evidence that passed, because a reader can see more than an exit code;
- appends every attempt under `deterministic_evidence` in `verification.json`, beside the model's own
  section and never over it.

`deferred` does not block. Treating a deferred check as a failure would make the workflow
unsatisfiable. A deferred runtime stage is also not a pass: the orchestrator overrules a reported
`success` on evidence that is deferred to `inconclusive` with `override:
"deterministic_inconclusive"`, so nobody can skip the last stage by leaving it unconfigured. A
`failed` or `blocked` runtime stage needs no overrule: it is a real failure and it goes back to the
fixer.

## Security review

`createProjectSecurityReviewProvider` implements the orchestration layer's `SecurityReviewProvider`
port, and answers with a record rather than a verdict. It is the same shape of contract as the
verification provider, and for the same reason: the orchestrator has to be able to check what came
back, so nothing here is trusted on the strength of having produced it.

```ts
const security = createProjectSecurityReviewProvider({ projectRoot });
const orchestrator = createWorkflowOrchestrator({ store, executor, workspace, verification, security });
```

The provider scans the changed paths it was given and nothing else. It reads at most 2 MB per file,
refuses to follow a symlink out of the project, and reports `inconclusive` rather than `pass` for
anything it could not read — a link, a file above the ceiling, a path that vanished mid-scan. A
review that could not look at part of the change says so instead of reporting a clean one.

Seven checks are decided here, all path-and-content shaped and all bounded to the change set:

| check | what it finds |
| --- | --- |
| `hardcoded_secret` | credential-shaped literals — provider token prefixes, AWS key ids, GitHub and Slack tokens, private key headers, named secret assignments |
| `credential_file` | a `.env`, `.npmrc`, keystore, or similar, outside the approved scope |
| `unexpected_executable` | an added path that is executable on disk, carries a script suffix, or opens with a shebang |
| `package_manager_hook` | a lifecycle script, a hook payload, or a remote dependency specification in an added manifest |
| `shell_execution` | `eval` of a string, `new Function` from a string, a backtick with interpolation, a pipe into an interpreter |
| `command_restriction_weakened` | `--no-verify`, a negated matcher, or a bypass flag in an added file |
| `permission_broadening` | `write-all`, or a privileged trigger, in an added workflow definition |

Two checks are **not** implemented here, and are the framework's to decide from the change set
alone: `protected_configuration_changed` and `dependency_configuration_out_of_scope`. A provider that
reports either one is refused rather than believed.

Placeholders are not secrets. `YOUR_API_KEY_HERE`, `example`, `changeme`, `<your-token>`, and
`process.env.API_KEY` are all recognised as non-credentials, because a scan that flags the project's
own test fixtures is a scan whose findings get ignored.

Two limits are worth stating. The scanner reads **current contents, not a diff**: a credential-shaped
string in a modified file may predate the feature, and the reason on a failed check says so for
exactly the paths that were modified rather than added. And a pass means no known shape was found —
the checks are regular expressions over plausible patterns, so they will miss a secret that does not
look like one, and they are a floor rather than a certification.

See [`docs/security-review.md`](../../docs/security-review.md) for the gate's full contract,
including who decides each check and what happens when it fails.

## Not in this milestone

No dependency installation, no lifecycle scripts, no Git, no free-form command templates, no
third-party skill integration, and no inference about how a project starts: an application is verified
only when the project has declared the command, and a capability nobody declared is never run. A Rust, Go, or Python command has to be declared in
`agent-workflow.config.json` and is run exactly as strictly as a detected Node command, or the
capability is reported as unsupported.
