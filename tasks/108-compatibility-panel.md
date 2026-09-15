# Task 108: Browser compatibility panel

Status: complete

Add a Settings compatibility panel that reports Tessera's detected clipboard
capabilities, Firefox extension connection, effective terminal rendering scale,
and server connection status. Provide a Copy diagnostics action that uses
Tessera's existing clipboard bridge and fallbacks.

## Requirements

- Show native clipboard API availability and extension connection state.
- Show the selected performance profile, display pixel ratio, and effective
  terminal render ratio.
- Show browser network and Tessera server connection state.
- Refresh live checks without closing Settings.
- Copy a concise troubleshooting report without workspace, session, host, or
  clipboard contents.

## Implementation

- Added a Compatibility section that runs an extension handshake and server
  health probe when Settings opens and on demand.
- Reports native clipboard API availability, extension and terminal-write
  permissions, the active performance profile, effective terminal and display
  scales, browser network state, and Tessera server reachability.
- Added a Copy diagnostics action through the shared clipboard writer, so the
  Firefox bridge and Tessera's existing browser fallbacks remain available.
- Kept the diagnostic report limited to browser/platform capability facts; it
  excludes URLs, workspace/session identifiers, clipboard contents, and auth.

## Verification

- `npm run build:web`
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`
  (231 tests passed)
- `go test ./...`
- `git diff --check`
