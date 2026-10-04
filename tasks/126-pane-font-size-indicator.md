# Task 126: Pane font-size shortcut indicator

Status: complete

Show a brief indicator in the active terminal, worksheet, or text-editor pane
when Ctrl/Cmd+Plus or Ctrl/Cmd+Minus adjusts its text size. Display the current
size as a rounded percentage of the configured default pane font size, with
the default representing 100%. Ctrl/Cmd+0 should show the reset percentage too.

Repeated presses update the same indicator and restart its dismissal timer.
The indicator must leave keyboard focus, mouse input, and pane layout intact,
respect reduced-motion and Older Mac preferences, and disappear automatically.
Support the shifted Ctrl/Cmd+Plus key as well as the existing unshifted and
numpad shortcuts. Clear pending timers when panes close or sessions change.

Validation:

- JavaScript syntax check and all 276 frontend tests passed.
- Browser smoke testing confirmed Plus, shifted Plus, Minus, and reset in
  terminal, worksheet, and text-editor panes without changing keyboard focus.
- Repeated presses reused one indicator, refreshed its percentage, and kept
  it visible until 1.2 seconds after the last press before the brief fade.
- Verified the 10px and 24px bounds, a custom 16px default, isolation between
  panes, automatic dismissal, and disabled transitions in Older Mac mode.

Implemented a theme-aware, mouse-transparent overlay in the pane body. Its
timer is cleared when the pane closes or the workspace is replaced. Shifted
Plus is accepted while Ctrl+Shift+Minus continues through to the application.
