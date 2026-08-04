# Task 075: A terminal copy with nothing selected says so

Status: complete

Task 074 left `Cmd+C` inside a mouse-aware program doing nothing at all: there
is no local selection to copy there, so `applyTerminalMenuAction("copy")` read
an empty string, wrote nothing, and still reported the key handled. The operator
saw a copy key that did not work, with no indication why.

The obvious-looking fix — declining the key so it reaches the application — does
not work. `ghostty-web`'s `handleKeyDown` returns early for `meta+KeyC` at the
same place it was swallowing `Ctrl+V`, so an unclaimed `Cmd+C` produces nothing
either. Delivering it would mean Tessera sending `\x03` itself.

That was rejected. `^C` is an interrupt in most full-screen programs — htop,
Vim with `set mouse=a`, less, and tmux all enable mouse tracking *and* treat
`^C` as interrupt or quit — so gating on mouse tracking does not make it safe.
Fresh binding `^C` to Copy is the exception. Every macOS terminal (Terminal.app,
iTerm2, Ghostty, WezTerm, Alacritty) treats `Cmd+C` as copy-the-selection or
nothing, and never sends it to the PTY. Tessera keeps that behaviour.

The real gap is that the copy fails silently and the way to make a selection
inside a mouse-aware program is invisible: the `Shift`/`Ctrl`/`Cmd` drag
override in `terminalShouldReportMouse()` appears in no documentation and no
part of the interface. A program's *own* selection is not the terminal's to
read in any case; that text reaches the clipboard when the program copies it
itself over OSC 52, which task 072 already handles.

## Requirements

- Report a copy that found no selection instead of consuming it silently.
- Inside a mouse-aware program, name both ways to copy there: the drag override
  for the terminal's own layer, and the program's own copy key.
- Outside one, do not mention the override, where ordinary dragging selects.
- Leave a copy that does find a selection unchanged and silent.
- Do not send anything to the PTY for `Cmd+C`.
- Document the drag override.

## Implementation

- `emptyTerminalCopyGuidance(mouseTracking)` returns the wording for each case.
- `setWorkspaceStatus()` takes an `autoHideMs`, generalizing the hide timer that
  was hard-coded to the `saved` state. Nothing is broken when a copy finds no
  selection and nothing needs answering, so that status clears itself after four
  seconds rather than sitting in the corner. A status that reports a real
  failure — "Clipboard blocked" — still stays up until something replaces it.
- `reportEmptyTerminalCopy()` reads `hasMouseTracking()` defensively — renderer
  versions without it, and disposed terminals, fall back to the plain wording —
  and raises it through `setWorkspaceStatus()` as "Nothing to copy".
- `applyTerminalMenuAction("copy")` calls it on the empty branch only.
- README documents the drag override, that the terminal's clipboard keys are
  separate from the running program's, and the macOS key behaviour from task
  074.

## Verification

- `node --test web/*.test.mjs` (104 tests passed)
- `node --check web/app.js`, `node --check web/terminal-input.mjs`
- `go test ./...`
- Real-browser check on macOS (Chrome 150, Fresh 0.2.22 in a Terminal pane):
  - Shell prompt, nothing selected, `Cmd+C`: "Nothing to copy" / "Drag across
    the terminal to select text first."
  - Shell prompt, dragged selection, `Cmd+C`: no status, selection on the
    system clipboard.
  - Inside Fresh, nothing selected, `Cmd+C` and `Ctrl+Shift+C`: "Nothing to
    copy" / "Hold Shift while dragging … or use that program's own copy key.",
    clipboard untouched, buffer untouched.
  - Inside Fresh, `Shift`+drag then `Cmd+C`: no status, selected row on the
    clipboard.
  - "Nothing to copy" is still up at 2.5 s and gone by 5 s; pressing the key
    again re-arms the countdown; "Clipboard blocked" is still visible after
    8.5 s; "Saved" still clears after its own three seconds.
  - Unchanged: a plain drag inside Fresh still forwards its mouse frames to the
    program, and `Ctrl+C` still reaches it as `\x03` with Fresh's OSC 52 copy
    landing on the system clipboard.
