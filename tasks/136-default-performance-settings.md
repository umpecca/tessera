# Task 136: Default performance settings

Status: complete

Make the browser's initial performance settings match the requested screenshot:
Standard profile, Experimental terminal renderer, Paint coalescing On, and
Server output coalescing Off.

Preserve explicit browser-local preferences, including Stable renderer, and
use the same defaults when browser storage is unavailable. Keep the settings
controls and documentation consistent with the defaults.

Validation: cover initial settings, saved overrides, and unavailable storage;
run the frontend tests, JavaScript syntax check, and embedded web asset tests.

Implemented Experimental as the initial and storage-unavailable renderer;
explicit saved false still selects Stable. The other three requested defaults
were already in place. Updated the renderer's help text, README, and changelog.

Validation:

- All 362 frontend tests passed, including three startup preference regressions.
- `node --check web/app.js` passed.
- `go test ./web` passed, including embedded asset checks.
- `git diff --check` passed.
