# Task 133: Predictable palette search and selection

Status: complete

Require Enter or a click to run commands in the palette; keep wheel dispatch
immediate. Exact shortcut codes rank first, even when they don't match command
labels. Enter runs the current highlighted result after keyboard or pointer
navigation. Add preferences → Settings, rename → Set Window Title, and close
→ Destroy Window aliases while preserving visible names and available commands.

Validate paused typing, exact code ranking and dispatch, keyboard/pointer
selection overrides, alias matching, unavailable commands, and wheel shortcuts.
Update the palette prompt, Help, README, and changelog with Enter behavior.

Removed the palette invocation timer. Exact available codes rank above label
and alias matches, including codes such as OO with no label match. Enter uses
the current selection, matching the visible highlight after arrows or pointer
movement. Aliases are attached to the existing commands and do not duplicate
results or expose unavailable pane actions. Composition retains ownership of
Enter. Updated the input prompt, Help, README, and changelog.

Validation: all 39 command-wheel/palette, Settings, and pane-interaction tests
passed. Regressions cover paused typing, exact-code highlights, navigation
overrides, aliases, unavailable commands, empty results, and immediate wheel
dispatch. `go test ./web`, JavaScript syntax, and whitespace checks passed.
