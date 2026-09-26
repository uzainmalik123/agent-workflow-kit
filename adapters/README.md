# Adapters

This boundary contains project adapters and is reserved for agent adapters. The `persistence/` project adapter depends on the workflow core and owns repository-local sessions, artifacts, and event logs; the workflow core must never depend on an adapter. Agent adapters and external integrations remain deferred.

## persistence

`@agent-workflow-kit/persistence` stores every feature under `<repository>/.agentflow/features/F-NNN-slug/`:

- `session.json` is the authoritative session document.
- `events.jsonl` is the append-only workflow event log.
- `request.md`, `grill.json`, `spec.json`, `plan.json`, `plan-review.json`, `implementation.json`, `code-review.json`, `scope-review.json`, `verification.json`, `fixes.json`, `security-review.json`, and `final-summary.md` are the controlled feature artifacts.

A session document references artifacts by filename and status; artifact contents stay in their own files.

```json
{
  "schemaVersion": 2,
  "featureId": "F-001",
  "slug": "google-oauth-api",
  "title": "Google OAuth / API",
  "createdAt": "2026-01-02T03:04:05.000Z",
  "updatedAt": "2026-01-02T03:04:05.000Z",
  "revision": 3,
  "machine": { "state": "draft" },
  "approvals": { "plan": null },
  "artifacts": {
    "request": { "filename": "request.md", "status": "missing" },
    "plan": { "filename": "plan.json", "status": "missing" }
  }
}
```

`revision` starts at `0` and increases by exactly one per successful mutation. `approvals.plan` holds the frozen plan approval checkpoint, or `null` before a plan is approved:

```json
{
  "approvals": {
    "plan": {
      "approvedAt": "2026-01-02T03:04:05.000Z",
      "approvedRevision": 9,
      "specSha256": "…",
      "planSha256": "…",
      "planReviewSha256": "…"
    }
  }
}
```

The digests cover the exact persisted bytes of `spec.json`, `plan.json`, and `plan-review.json`. The store owns storage and hashing mechanics only: it does not decide when an approval is required or what a valid approval means.

### Public API

`new FeatureSessionStore(repositoryRoot, { clock })` and `createFeatureSessionStore(repositoryRoot, { clock })` expose:

- `create`, `load`, `save`, `update`, `list`, and `exists` for sessions.
- `mutate(featureId, { expectedRevision, prepare })`, the single authoritative mutation path: it re-checks the revision under the lock, hands `prepare` a read-only view of the state it is about to replace, and commits artifacts, session, then event log.
- `transition(featureId, event)` to apply a workflow event through the same mutation path.
- `writeArtifact` and `readArtifact` for the controlled artifact set, and `readArtifactText` for the exact persisted bytes.
- `readContext(featureId)` for a consistent read of a session and its artifacts.
- `readEvents` for the event log.
- `featureDirectoryPath(featureId, slug)` for deterministic feature paths.

`mutate` returns the committed session, the appended event, whether the event was applied, and the artifact references it wrote. A `prepare` that returns an event the state machine refuses produces a refused event record and no revision change.

### Concurrency

A mutation holds a per-feature lock for its critical section only. The lock is a `.lock/` directory created with an exclusive `mkdir` plus an `owner.json` record, so a lock left behind by a dead process can be taken over, and it is released before any executor, AI, or external call runs. A `prepare` must stay short and must never call out to anything slow.

`expectedRevision` is optional, and coordination-sensitive callers must always pass it. A mismatch throws `REVISION_CONFLICT` **before** `prepare` runs, so a losing writer never reads or writes anything. This is optimistic concurrency, not blocking: the caller decides whether to re-read and retry. In-process contention is serialized through a promise chain, and different features never wait on each other. This is deliberately not a distributed lock.

`save` refuses to write a revision that does not exactly continue the persisted one, and `update` re-reads the session under the lock so it can never move the revision backwards. `update` also refuses a patch that carries a `machine` key: workflow state changes only through a revision-guarded event.

`restoreWorkflowStateMachine(session)` rebuilds the core state machine from a loaded session, including a pending fix return state.

Failures throw `PersistenceError` with a `code`. Missing, malformed, mismatched, duplicate, and unsupported persisted data fails explicitly instead of being repaired or silently reset to a draft session.

### Event-log integrity

A mutation is the only writer of `events.jsonl`. There is no public API for appending a raw record, so transition history cannot be fabricated through the store; every logged event is produced by the core state machine. Each record carries the revision it was written with. The log stays append-only and non-authoritative: `load` reconstructs workflow state from `session.json`, so a record written out of band never changes a session.

### Path and symlink safety

Every storage component is inspected with `lstat` before use, so reads and writes share the same guard: `.agentflow`, `.agentflow/features`, the feature directory, and each session, artifact, and event file. A symbolic link at any level, or a non-regular file where a file is expected, fails with `UNSAFE_PATH`; checks never rely on the final path component alone, and storage paths are never implicitly created below an unverified parent. `list()`, `exists()`, `load()`, `readArtifact()`, and `readEvents()` are protected exactly like the write paths.

### Consistency and cleanup

- One mutation writes artifacts first, then `session.json` with the next revision, then appends the event. If the session update fails, a newly created artifact is removed and a replaced artifact is restored to its previous contents, so authoritative metadata never claims an update that did not complete. A failed rollback is reported as `IO_ERROR` instead of being swallowed.
- Because the session is written before the event, a failure can happen after the authoritative state already moved. A caller must be able to tell the two apart, which is why every mutation reports its outcome and why the session revision is part of that outcome.
- If the initial `session.json` write of `create` fails, the feature directory that was just created is removed so the feature ID stays reusable.
- Session and artifact files are written to a temporary file in the same directory and then renamed, so a failed write never leaves a partially written document.
