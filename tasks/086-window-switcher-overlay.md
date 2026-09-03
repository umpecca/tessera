# Task 086: Window switcher overlay

Status: complete

Show a centered, transient window switcher while the user cycles windows with
`Ctrl+[` and `Ctrl+]`, similar to the visual feedback provided by an operating
system Alt+Tab switcher.

## Requirements

- Open the switcher when either keyboard shortcut cycles to another visible
  window.
- List every non-pending, non-minimized window in the same order used by the
  existing cycling behavior.
- Show each window's persisted title, falling back to its generated window
  name, and make the position in the cycle clear.
- Visually highlight the window that currently owns focus.
- Update the highlight immediately as the shortcut is repeated, including when
  the order wraps from the last window to the first.
- Center the switcher over the workspace without taking keyboard focus or
  blocking pointer input.
- Hide it when Control is released, with a short inactivity timeout as a
  fallback for forwarded browser-pane shortcuts or a lost keyup event.
- Preserve the existing filtering, focus, raising, and workspace-save behavior
  of `focusAdjacentPane()`.
- Keep command-palette **Next Window** and **Previous Window** behavior
  unchanged; the visual switcher belongs to the direct keyboard gesture.

## Verification

- Add focused tests for switcher ordering, fallback names, active selection,
  minimized/pending filtering, and wraparound-compatible ordering.
- Run `node --check web/app.js`.
- Run `node --test web/*.test.mjs`.
- Run `go test ./...`.

## Implementation

- The shortcut-only path asks `focusAdjacentPane()` to render a focus-neutral
  switcher; command-palette Next/Previous actions retain their prior behavior.
- The full-screen switcher layer uses the same theme-aware dark backdrop as the
  command palette while remaining pointer-transparent.
- A small pure model keeps filtering, fallback names, ordering, active state,
  and wraparound selection covered independently of the DOM.
- Releasing Control or Command hides the switcher immediately. A 1.2-second
  inactivity timer covers relayed browser-pane shortcuts and lost keyup events.

Verification completed: JavaScript syntax passed, all 146 browser tests passed,
all Go tests passed, and `git diff --check` reported no whitespace errors.
