# Task 131: Single-key Settings shortcut

Status: complete

Follow-up: Task 133 replaces the palette delay with explicit Enter/click
activation. The wheel continues to open Settings immediately with S.

Change Settings from ST to S in both the command palette and Command Wheel.
Typing S or clicking Settings in the wheel opens the modal directly; hovering
previews Settings without opening it. Preserve two-key commands, input guards,
and the palette's short delay so users can continue typing search terms.

Validate single-key dispatch, pointer activation, hover behavior, palette code
matching and delayed invocation, and existing wheel navigation.

Implemented S as the shared Settings code. The wheel accepts single-key actions
and opens Settings from its inner wedge without showing a redundant outer key.
Hover remains a preview. Palette matching accepts one or two letters and keeps
the existing 350 ms delay and cancellation when the search changes. Updated
Help, README, and changelog.

Validation: all 15 command-wheel/palette tests and 18 Settings/pane interaction
tests passed, along with `go test ./web`, JavaScript syntax, and whitespace checks.
