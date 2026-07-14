# Task 021: Command palette window cycling

Status: complete

Make **Next Window** and **Previous Window** permanent command-palette entries.
They must call the same `focusAdjacentPane(1)` and `focusAdjacentPane(-1)` path
used by the `Ctrl+]` and `Ctrl+[` keyboard shortcuts, including the existing
visible-pane filtering and wraparound behavior.

- Keep the existing `NX` and `PW` command-palette codes.
- Do not hide the commands based on the current number of visible panes; the
  keyboard shortcuts are always registered, so palette availability should
  match them.
- Bump the SPA asset cache key and verify the rendered palette in the browser.

Implemented by registering both commands unconditionally in
`buildPaletteCommands()`. Browser verification covered the empty workspace and
confirmed that the commands cycle and wrap focus across two worksheet windows.

Verification:

- `node --check web/app.js`
- `go test ./...`
- `git diff --check -- web/app.js web/index.html tasks/021-command-palette-window-cycling.md`
