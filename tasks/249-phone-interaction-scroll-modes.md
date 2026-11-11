# Task 249: Phone terminal Interaction / Scroll modes

Status: complete (2026-11-09). Implemented and automatically verified;
physical iOS/Android testing remains outstanding.

## Request

Add an accessible Interaction / Scroll toggle to phone terminals. Scroll mode
should hide keyboard/input UI, use one finger for local history and two fingers
for application mouse-wheel events, without losing drafts or disturbing the
shared shell.

Builds on the touch scrolling in [task 246](246-mobile-improvements.md).
Desktop and existing Interaction-mode touch behavior remain unchanged.

## Implemented behavior

- Default to **Interaction** mode with the existing keyboard/compose bar.
- **Scroll** mode hides the entire input area and moves Back, the mode toggle,
  View and terminal actions into the top header. The toggle stays accessible
  in both modes.
- One finger scrolls local terminal history or the text-reading overlay,
  including when the program enables mouse tracking.
- Two fingers send application mouse-wheel events only when the program
  enables mouse tracking; never fall back to arrow keys or local scrolling.
  After one finger lifts, the gesture remains two-finger-only until all lift.
- Switching preserves drafts and scroll position, dismisses the keyboard
  without reopening it on return, and sends no accidental input or shell resize.
- Cancel pending Send long presses, modifiers, pointer gestures and selection
  autoscroll on a mode change; preserve existing selected text without copying.
- Remember the choice per browser using
  `tessera.phone-interaction-mode.v1`.

## Implementation

- `web/phone-view.mjs` and `web/phone-input.mjs`: mode storage, accessible
  toggle, control placement and suspended input that preserves drafts.
- `web/terminal-input-bridge.mjs` and `web/terminal-touch-scroll.mjs`: gesture
  routing, capture/cancellation and text-overlay listener cleanup.
- `web/phone-workspace.mjs` and `web/terminal-view.mjs`: hold shared-shell
  sizing across layout changes until actual interaction resumes.
- `web/terminal-selection.mjs`: explicit drag cancellation; terminal vendor
  bundle rebuilt.
- `web/styles.css`, `docs/terminal.md` and `CHANGELOG.md`: presentation and
  user-facing documentation.

## Verification

- Full JavaScript suite: **979 passed, 0 failed**, including direct regressions
  for mode persistence, draft preservation, suspended Send, gesture routing,
  mid-gesture switching, selection cancellation, cleanup and sizing holds.
- `go test ./...`, `go vet ./...`, `npm run build:web`, JavaScript syntax checks
  and `git diff --check`: passed.
- `scripts/frontend-smoke.mjs` against the rebuilt binary's embedded assets:
  Chromium desktop/phone checks passed, including real one-/two-finger touch
  gestures against a mouse-tracking PTY, draft preservation, no keyboard focus
  on return, no unintended input/resize and no uncaught browser errors.

## Follow-up validation

- Check physical iOS Safari and Android browsers: keyboard dismissal, gesture
  capture/cancellation, scroll feel and control accessibility.

No commits or pushes were made. Tag-triggered CI/CD is unchanged; account
isolation (task 247) remains **TBD / later**.
