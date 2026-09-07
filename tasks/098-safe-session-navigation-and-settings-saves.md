# Task 098: Safe session navigation and settings saves

Status: complete

- Keep the current session open when saving fails or is paused.
- Drain pending workspace edits before navigation proceeds.
- Fetch and validate a target workspace before changing session identity,
  URL, or displayed panes; restore the current URL on failed Back/Forward.
- Serialize settings saves, wait for pending requests when flushing, and
  protect final refresh saves from older in-flight requests.

Verification:
- All 192 frontend tests passed, including failed saves, failed target loads,
  queued edits during navigation, serialized settings saves, and exit flushing.
- `npm run build:web` passed.
- `go test ./...` passed, including settings revision ordering and migration
  compatibility coverage.
- `node --check web/app.js` and `git diff --check` passed.
