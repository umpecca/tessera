# Task 005: Named user sessions

Status: complete

Add multiple named desktop sessions per configured user. Each session owns its
workspace panes, layout, background, command runs, and terminal processes.
Users can create, rename, switch, and destroy sessions from a keyboard-accessible
centered manager and the command palette. Session routes use stable opaque IDs.

## Acceptance criteria

- Existing workspaces migrate to a `Default` session without data loss.
- Theme and default font settings are shared by a user's sessions in SQLite.
- Switching sessions preserves server-side processes and supports browser history.
- Destroying a non-final session confirms, stops its processes, and deletes its data.
- Session names are trimmed, required, and unique per user without regard to case.
- Direct `/users/{user}/sessions/{id}` routes load the addressed session.
- `node --check web/app.js` and `go test ./...` pass.

## Implementation notes

- Existing workspace rows now act as session desktops and migrate with an owner.
- User-wide appearance settings are stored separately from session backgrounds.
- Worksheet runs and PTY terminals are isolated and stoppable by session.
- The Sessions manager, stable routes, and browser-history switching are implemented.
