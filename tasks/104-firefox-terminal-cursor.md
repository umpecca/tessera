# Task 104: Remove the duplicate Firefox terminal cursor

Status: complete

Firefox 115 ESR can show a blinking insertion caret at the top-left of a
Terminal pane while Ghostty's canvas cursor is elsewhere.

## Cause

Ghostty makes the terminal container contenteditable and Tessera focuses that
container for keyboard input. Firefox paints its native insertion caret at the
first DOM insertion point, which is independent of the cursor drawn inside the
terminal canvas.

Tessera also disables Ghostty's own blink timer and supplies an on-demand timer.
The timer updates canvas cursor visibility and schedules a frame, but the
renderer needs its cursor-blink invalidation flag to repaint a clean cursor row.

## Requirements

- Hide the native insertion caret only inside Terminal panes.
- Preserve focus, keyboard input, selection, clipboard, IME, and accessibility
  behavior.
- Make each Tessera-managed blink frame repaint the actual canvas cursor row.
- Do not restore Ghostty's permanent animation loop or a second blink timer.
- Verify Firefox 115 ESR and a current Chromium browser.
- Run the frontend and Go test suites and rebuild the web bundle.

## Implementation

- Set `caret-color: transparent` on Terminal containers. The focused
  contenteditable element, keyboard path, selection, hidden textarea, and ARIA
  attributes remain unchanged.
- Set the pinned CanvasRenderer's cursor invalidation flag during each shared
  scheduled frame. Tessera remains the only blink timer; Ghostty now repaints
  the clean cursor row when that timer changes cursor visibility.
- Extended the terminal adapter regression test to require cursor-row
  invalidation while retaining the one-frame geometry redraw behavior.

## Verification

- `npm run build:web`
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`
  (224 tests passed)
- `go test ./...`
- `git diff --check`
- Firefox 115.37.0 ESR: the focused terminal retained `contenteditable` and
  computed a transparent native caret. Ten screenshots showed changes only in
  the 9×16 canvas cursor cell at row 9, column 30; the top-left stayed stable.
- Current Chromium: the focused terminal computed a transparent native caret,
  and the real canvas cursor cell changed between consecutive blink states.
