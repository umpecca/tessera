# Task 134: Terminal selection recovery and macOS Control-click

Status: complete

Fix the selection defects found while investigating a Safari Control-click on
a hyperlink in a full-screen terminal pane.

## Requirements

- Treat macOS Control-primary-click as a contextual gesture before Ghostty can
  start local selection; preserve Command-click link activation and other
  platforms' Control-click activation.
- Prevent native browser selection of the terminal canvas and clear stale
  terminal-owned DOM ranges without touching editor or clipboard-field ranges.
- Request scheduled frames for all local selection changes and clearing.
- End local selection gestures after release, cancellation, context menus,
  focus loss, hidden documents, or movement with no primary button held.
- Preserve selected text for copying when a drag is interrupted and stop
  autoscroll, including zero-length gestures.
- Preserve normal mouse reporting, context-menu copying, and Shift-drag.
- Remove recovery listeners when the terminal is disposed.

## Verification

Add regressions using the pinned upstream selection manager and Tessera's
actual render scheduler, plus mouse-bridge coverage for Control-click.
Run the frontend suites, JavaScript syntax checks, web bundle build, Go tests,
and whitespace checks. Record the remaining live Safari validation limitation.

## Implementation and validation

The bridge recognizes macOS Control-primary-click in both pointer and
compatibility mousedown events, preserving local selections for the context
menu while reserving Command-click for links. Canvas/container CSS and scoped
DOM selection cleanup prevent a native canvas highlight without disturbing
editor or clipboard-field ranges.

The terminal adapter installs a focused selection integration that connects
the pinned upstream invalidation to scheduled frames and recovers captured
releases, cancellation, focus loss, context menus, hidden documents and
zero-button movement. Empty gestures reset, autoscroll stops, interrupted text
selections survive, normal selection copying occurs once, and disposal removes
the recovery listeners.

All 350 frontend tests pass, including 14 new integration regressions using the
installed Ghostty selection manager and the actual render scheduler, plus the
contextual-gesture helper regression. `npm run build:web`, JavaScript syntax
checks and whitespace checks pass. The full Go suite passes with a temporary
test overlay selecting an ephemeral HTTP port for one unrelated test that
otherwise conflicts with the running Tessera instance on port 7331. No server
test source or running instance was changed. Live Safari validation remains
outstanding because this development host is Windows.
