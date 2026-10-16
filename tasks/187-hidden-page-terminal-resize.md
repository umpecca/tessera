# Task 187: Hidden pages do not resize the shell

Status: complete

## Request

On iPadOS, running a Homebrew install in a Tessera terminal (Safari home-screen
web app over HTTPS), briefly switching to another app and back left the
install log misaligned.

## Cause

iPadOS resizes a backgrounded web app's view while it renders the app
switcher. Tessera kept reacting to layout while hidden: the board's
ResizeObserver refit maximized panes, the fit addon resized the terminal, and
`term.onResize` scheduled `TerminalFitScheduler.sendGridSize`, which sent the
switcher's grid to the server because the socket stays open while output is
paused. The shell received SIGWINCH at the wrong width, so Homebrew printed
and reflowed its output for that width. Returning refit to the real size, but
lines already written at the wrong width stayed misaligned.

The socket-open path already sent its size only when `browserInUse()`; the
resize path had no such check.

## Change

`TerminalFitScheduler.sendGridSize` does not send while the document is hidden
(injectable `isHidden`, defaulting to `document.hidden`). The local canvas may
still fit. `sentCols`/`sentRows` keep the last size the shell actually has, so
the refit on `visibilitychange` sends the real grid only if it differs, and a
genuine change made while hidden (such as a rotation) is sent once visible.

## Validation

- New test covers a hidden resize that never reaches the shell, return at the
  original size (nothing sent), and a real hidden change sent once visible. It
  fails without the fix.
- Full JavaScript suite: 562 tests pass. Go tests pass.
- Not reproduced on a physical iPad. Lines already misaligned before this fix
  stay so; clear the screen or rerun the command.
