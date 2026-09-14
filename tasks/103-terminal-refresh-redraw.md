# Task 103: Restore idle terminal rendering after refresh

Status: complete

An idle terminal can remain blank after refreshing Tessera in Firefox 115 ESR.
Typing or scrolling makes it reappear.

## Cause

The browser applies host geometry by resizing the terminal canvas. Canvas
resize clears every pixel, but Ghostty does not dirty terminal rows when the
grid still has the same column and row count. Tessera then requests an
ordinary dirty-row render, which has no rows to paint. Input dirties rows and
scrolling changes the viewport, explaining both reported recovery paths.

## Requirements

- Force one complete terminal redraw after applying host geometry.
- Preserve the pending redraw while rendering is paused or coalesced.
- Also make snapshot canvas replacement explicitly request a complete redraw.
- Return to normal dirty-row rendering after the complete frame.
- Cover the same-grid geometry sequence with a regression test.
- Verify the browser bundle and frontend and Go tests.

## Implementation

- Added a pending full-redraw bit to the terminal adapter. Applying host
  geometry or replacing the terminal from a snapshot sets the bit before
  requesting a shared animation frame.
- The next scheduled frame forces every terminal row to paint and clears the
  bit only after rendering. Later frames retain Ghostty's dirty-row behavior.
- Added a regression test that models Ghostty's same-grid resize no-op and
  verifies content returns on the scheduled frame without terminal input.

## Verification

- `npm run build:web`
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`
  (224 tests passed)
- `go test ./...`
- `git diff --check`
- Firefox 115.37.0 ESR: the deterministic same-grid geometry reproduction
  changed from remaining blank after three frames to restoring 1,995 content
  pixels on the next frame. A 12-refresh live Terminal run restored the idle
  terminal every time without typing or scrolling.
