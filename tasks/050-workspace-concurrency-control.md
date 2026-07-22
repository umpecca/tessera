# Task 050: Workspace concurrency control

Status: complete

Prevent a stale browser from overwriting workspace changes saved by another
computer or tab after reconnecting.

## Requirements

- Expose an opaque server-generated revision with every loaded workspace.
- Require clients to submit the revision they loaded with each workspace save.
- Perform the revision comparison and workspace replacement atomically in the
  SQLite transaction.
- Reject stale saves with HTTP `409 Conflict` without changing workspace or
  pane data.
- Return the new revision after every successful save so one browser can
  continue autosaving normally.
- Keep revision tracking scoped to each workspace/session.
- When the web client receives a conflict, suspend workspace autosaves and show
  a persistent conflict prompt that offers to reload the latest server state.
- Revalidate the workspace revision when Tessera connectivity is restored
  before permitting the disconnected browser to save again.
- Do not attempt automatic cross-device layout or editor-content merging.
- Preserve existing active-run pane-buffer protection and user-settings saves.

## Verification

- Cover a successful conditional save and revision advancement.
- Cover two clients loading the same revision, with the second stale save
  rejected and the first client’s workspace left intact.
- Cover independent workspace revisions.
- Cover client revision/conflict-state behavior with focused frontend tests.
- Run all frontend tests, `node --check web/app.js`, `go test ./...`, and
  `git diff --check`.

## Completion

- Added per-workspace opaque revisions and atomic compare-and-replace saves in
  SQLite, with `409 Conflict` responses that leave workspace and pane data
  untouched.
- Added serialized client autosaves, reconnect-time revision revalidation, and
  a persistent reload prompt that prevents a stale browser from saving again.
- Preserved active-run buffer protection and independent user-settings saves.
- Added store, HTTP API, migration, embedded-asset, and frontend concurrency
  coverage.
- Verified all frontend tests, `node --check web/app.js`, `go test ./...`, and
  `git diff --check`.
