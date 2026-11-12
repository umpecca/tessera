# Task 260: Sidebar-based Settings

Status: implementation and automated verification complete (2026-11-11).
Physical-device review remains deferred.

## Request

Overhaul the Settings panel into a macOS-inspired categorized screen with a
sidebar, rather than one long list. The user requested this during task 259 and
then explicitly directed continuing.

## Scope

- A wider two-pane Settings dialog: category sidebar and a focused content page,
  using Tessera's existing themes/fonts rather than introducing a separate skin.
- Organize existing controls into Appearance, Fonts, Terminal, Input & Shortcuts,
  Clipboard, Performance, Sign-in & Devices, Advanced and Diagnostics.
- Compact category navigation on narrow screens; no horizontal page overflow.
- Keep every existing setting, action, persistence scope, clipboard deep-link,
  modal focus trapping/return, keyboard behavior and account/sign-in protections.
- Preserve category, focus and scroll across preference rerenders. Diagnostics
  checks/metrics must stop on category changes and closing.
- Add DOM/regression and actual-browser responsive/keyboard checks. No unrelated
  setting changes, native-app redesign, new authentication behavior or unapproved
  server restart.
- Approval: the user requested a sidebar/category/macOS-like Settings overhaul
  and explicitly asked to continue; this task implements that layout-only scope.

## Acceptance criteria

- [x] Categories show only their relevant existing controls and a clear active state.
- [x] Desktop/iPad use a sidebar; narrow screens retain accessible category selection
  and usable controls without clipping or horizontal overflow.
- [x] Keyboard/focus, clipboard entry, edits and per-page scroll remain correct.
- [x] Diagnostics and async sign-in/device content have safe page/close lifetimes.
- [x] Relevant tests/build/browser checks pass and documentation/changelog updated.

## Verification

- `node --test web/*.test.mjs`: **1,017 passed**, including category reachability,
  active state, compact picker, keyboard navigation, focus wrapping/return,
  clipboard deep-link, per-page scroll and rerender behavior.
- Regression check: late rerenders/stale navigation after close cannot remount
  Diagnostics or restart timers/terminal metrics behind a hidden modal.
- `npm run build:web`, `go test ./...`, `go vet ./...` and whitespace checks: passed.
- `scripts/frontend-smoke.mjs` passed against an isolated latest-code binary:
  real Settings/diagnostics/focus, terminal reconnect without focus theft, all five
  new fonts saving and updating interface/canvas, theme changes and UI-size limits,
  persistence/reload, workspace conflicts and existing phone/native bridge flows.
- `scripts/settings-smoke.mjs`: Chromium 158.0.8127.18 and WebKit 27.2 passed all
  nine categories at 1280×900, 834×1112, 390×844, 320×568 and 568×320, using 12px
  and 18px interface sizes with Hack. **20 viewport/font/browser configurations,
  180 category-page checks**, with no horizontal panel/content overflow or uncaught
  browser errors. Checks include sidebar/picker visibility, arrow/Home/End and
  Tab wrapping, keyboard-triggered preference edits retaining focus, category
  restoration after close/reopen, and diagnostics removal when leaving its page.
- Screenshots of desktop/phone Fonts pages were visually reviewed. Tests use
  desktop Chromium/WebKit and an isolated local database, not a physical iPad or
  the user's active test instance. Sign-in setting mutation/account management
  was not exercised live; existing auth behavior is deliberately unchanged.
- Rebuilt after the final closed-modal diagnostics guard; the same responsive
  browser suite passed again against the final binary, all 20 configurations.

## Implementation notes

- Task created before redesign code. Task 259 font assets/registration and backend
  normalization remain separate; do not lose those or earlier uncommitted changes.
- `web/settings-dialog.mjs`: category metadata, lazy focused-page rendering,
  desktop sidebar and narrow-screen native selector. Existing row builders/actions
  are reused, with no preference default, persistence or authorization changes.
- Current category is remembered for the page's lifetime. Per-category scroll
  persists while Settings is open and resets when closed. Control focus is
  restored by stable ID/accessible label; removed/disabled controls fall back safely.
- Clipboard entry selects its page before targeting a control. Keyboard handling
  remains scoped to the active modal; sidebar navigation doesn't capture input keys.
- Diagnostics timers/metrics start on entry and stop on page change/close. Closed
  dialogs ignore late rendering/navigation. Inactive Sign-in & Devices pages do
  not initiate fetches; asynchronous renderers retain only their own page nodes.
- `web/styles.css`: scoped wider rounded panel, independently scrolling sidebar
  and content, themed active state, grouped settings cards and a picker at ≤640px.
  Other modals keep their existing layout. The existing app font applies to all
  new text/icons; no external assets or macOS-only APIs.
- Updated `scripts/frontend-smoke.mjs` to navigate categories and exercise the new
  fonts. Added `scripts/settings-smoke.mjs` for isolated responsive/browser checks.
  Its local server uses a generous test-only rate limit; production defaults are
  unchanged. Harness fixes use fresh settings revisions, reset fixture sizes and
  explicitly focus/activate controls with the keyboard (Safari mouse clicks do
  not necessarily focus buttons). These were test assumptions, not app failures.
- Updated `docs/workspace.md`, `docs/terminal.md` and `CHANGELOG.md`.

## Reproduction and remaining acceptance

Build the app, then run `node scripts/settings-smoke.mjs --binary=<path>
--playwright=<module path> --output=<temporary directory>` with the available
Playwright browser installation in `PLAYWRIGHT_BROWSERS_PATH`. It creates and
stops its own loopback server/database, leaving existing servers untouched.

Local verification artifacts are under
`/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode/tessera-settings-ui-DW6zAb/`.
The full Chromium app smoke is under `frontend-smoke/`; final responsive screenshots
and isolated data are under `verified-final-build/home-ix3Wl8/`, with the complete
final browser output in `verified-final-build.log`.

- Physical iPad Safari/native app: category navigation, touch targets, keyboard,
  font loading and subjective layout review remain manual acceptance.
- The user subsequently explicitly approved restarting the test server. Only the
  port-7333 instance was restarted with the verified final binary and its existing
  database/sign-in configuration. Login responds HTTP 200; main port 7331 is
  untouched. Reload the app to review the redesign and new font persistence.
- No commits, pushes, authentication changes or unrelated work were performed.
