# Task 122: Make the performance profile device-local

Status: complete

The Claude Code shimmer redraws every 50 ms while requesting and every 100 ms
in other active modes. A reproduction of its mixed Unicode, dim-text, and true
color row painted every update in both Tessera renderers; average paint cost was
1.79 ms in Stable and 1.06 ms in Experimental. Rendering cost is not the source
of the visible cadence problem.

Older Mac mode currently persists in account settings. Enabling it on the High
Sierra Mac therefore applies its 30 FPS paint cap to an M4 Mac using the same
Tessera user. The cap can turn 20 Hz application updates into uneven frame
spacing even on fast hardware.

Persist the profile in browser local storage, like the experimental renderer.
Ignore and clear the legacy account-wide value. Existing browsers begin in
Standard after this update; Older Mac must be selected once again on the old
Mac. Keep applying profile changes immediately to open terminals.

Implemented browser-local persistence and stopped loading the legacy database
value. The next account settings save clears that old value. Settings and the
README now identify the profile as applying only to the current browser.

Validation:

- Stress-tested the reproduced Claude Code row at 50 ms updates; Stable painted
  all 80 updates at 1.79 ms average and Experimental at 1.06 ms average
- 249 frontend tests passed
- `go test ./...` passed, including embedded web assets
- Production web bundle rebuilt
- `git diff --check`
