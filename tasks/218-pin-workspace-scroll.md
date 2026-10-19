# Task 218: Windows shifting up after switching full-screen terminals

Status: fix in place, waiting on the iPad check

## Report

In the Home Screen web app on the iPad with a Magic Keyboard, switching
between full-screen terminal windows with the keyboard shortcut sometimes
shifts everything up. A button shows at the bottom left; tapping it puts
everything back.

## Findings

- Not reproduced in headless Chrome, desktop or iPad emulation: switching
  three maximized terminals with Ctrl+] and from the window list left the
  page, body, board and visual viewport unscrolled, and the window-list
  button hidden.
- A terminal takes input through a `contenteditable` element. With a
  hardware keyboard, iPadOS shows its shortcut bar while an editable element
  has focus, and Safari scrolls the page to keep the caret clear of it (or of
  the on-screen keyboard), even though the workspace is not scrollable.
  Full-screen windows reach the bottom of the screen, which is why they
  shift. Tapping the bar (most likely the button at the bottom left: nothing
  of Tessera's sits there, and the window-list button is bottom right and
  hidden while a full-screen window is active) moves focus off the terminal,
  and Safari scrolls back.
- Tessera already undid one such scroll, of the board, but only when
  maximizing and only in the Operator theme.

## Changes

- `web/app.js`: `pinWorkspaceScroll` puts the page and the board back at
  their origin whenever either scrolls, or the visual viewport scrolls or
  resizes. Maximizing uses it in every theme.

The bottom rows of a full-screen terminal can now sit under the shortcut
bar or on-screen keyboard instead of the whole workspace moving up. Sizing
the workspace to the visible area would avoid that but resize the terminal
whenever the bar comes and goes.

## Validation

- `web/operator-theme.test.mjs`: maximizing resets a scrolled board in
  Operator and Studio; the pin resets the page and the board, and does
  nothing when neither is scrolled.
- Headless Chrome, a built binary: the page scrolled 80px and the board 50px
  from script were both back at 0 within one event.
- Full JavaScript suite passes.
- Not yet tried on the iPad, where the bug happens.
