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
- `appendEvent` and `readEvents` for the event log.
- `featureDirectoryPath(featureId, slug)` for deterministic feature paths.

`restoreWorkflowStateMachine(session)` rebuilds the core state machine from a loaded session, including a pending fix return state.

Failures throw `PersistenceError` with a `code`. Missing, malformed, mismatched, duplicate, and unsupported persisted data fails explicitly instead of being repaired or silently reset to a draft session.
