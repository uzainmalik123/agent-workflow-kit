# Adapters

This boundary contains project adapters and is reserved for agent adapters. The `persistence/` project adapter depends on the workflow core and owns repository-local sessions, artifacts, and event logs; the workflow core must never depend on an adapter. Agent adapters and external integrations remain deferred.

## persistence

`@agent-workflow-kit/persistence` stores every feature under `<repository>/.agentflow/features/F-NNN-slug/`:

- `session.json` is the authoritative session document.
- `events.jsonl` is the append-only workflow event log.
- `request.md`, `grill.json`, `spec.json`, `plan.json`, `plan-review.json`, `implementation.json`, `code-review.json`, `scope-review.json`, `verification.json`, `security-review.json`, and `final-summary.md` are the controlled feature artifacts.

A session document references artifacts by filename and status; artifact contents stay in their own files.

```json
{
  "schemaVersion": 1,
  "featureId": "F-001",
  "slug": "google-oauth-api",
  "title": "Google OAuth / API",
  "createdAt": "2026-01-02T03:04:05.000Z",
  "updatedAt": "2026-01-02T03:04:05.000Z",
  "machine": { "state": "draft" },
  "artifacts": {
    "request": { "filename": "request.md", "status": "missing" },
    "plan": { "filename": "plan.json", "status": "missing" }
  }
}
```

### Public API

`new FeatureSessionStore(repositoryRoot, { clock })` and `createFeatureSessionStore(repositoryRoot, { clock })` expose:

- `create`, `load`, `save`, `update`, `list`, and `exists` for sessions.
- `transition(featureId, event)` to apply a workflow event, persist the authoritative session, and then append the event.
- `writeArtifact` and `readArtifact` for the controlled artifact set.
- `readEvents` for the event log.
- `featureDirectoryPath(featureId, slug)` for deterministic feature paths.

`restoreWorkflowStateMachine(session)` rebuilds the core state machine from a loaded session, including a pending fix return state.

Failures throw `PersistenceError` with a `code`. Missing, malformed, mismatched, duplicate, and unsupported persisted data fails explicitly instead of being repaired or silently reset to a draft session.

### Event-log integrity

`transition` is the only writer of `events.jsonl`. There is no public API for appending a raw record, so transition history cannot be fabricated through the store; every logged event is produced by the core state machine. The log stays append-only and non-authoritative: `load` reconstructs workflow state from `session.json`, so a record written out of band never changes a session.

### Path and symlink safety

Every storage component is inspected with `lstat` before use, so reads and writes share the same guard: `.agentflow`, `.agentflow/features`, the feature directory, and each session, artifact, and event file. A symbolic link at any level, or a non-regular file where a file is expected, fails with `UNSAFE_PATH`; checks never rely on the final path component alone, and storage paths are never implicitly created below an unverified parent. `list()`, `exists()`, `load()`, `readArtifact()`, and `readEvents()` are protected exactly like the write paths.

### Consistency and cleanup

- `writeArtifact` reads the previous artifact first, writes the new file atomically, then updates `session.json`. If the session update fails, a newly created artifact is removed and a replaced artifact is restored to its previous contents, so authoritative metadata never claims an update that did not complete. A failed rollback is reported as `IO_ERROR` instead of being swallowed.
- If the initial `session.json` write of `create` fails, the feature directory that was just created is removed so the feature ID stays reusable.
- Session and artifact files are written to a temporary file in the same directory and then renamed, so a failed write never leaves a partially written document.
