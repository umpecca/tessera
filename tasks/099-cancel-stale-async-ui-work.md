# Task 099: Cancel stale async UI work

Status: complete

- Commit user identity only after that user's sessions, settings, workspace,
  and activation have loaded; ignore superseded user-selection responses.
- Make Browser pane navigation latest-request-wins and delete proxy sessions
  created by stale or removed pane requests.
- Ignore file-open responses after their source pane or workspace is gone.
- Bind background operations to the workspace where they started and prevent
  their completion from changing a subsequently displayed workspace.

Verification:

- `node --test web/*.test.mjs` (200 tests passed)
- `go test ./...`
- `npm run build:web`
- `node --check web/app.js`
- `git diff --check`
- Loaded a fresh Tessera session in the in-app browser and confirmed the same
  workspace route remained usable after a full page refresh.
