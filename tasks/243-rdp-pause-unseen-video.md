# Task 243: Pause RDP video nobody can see

Status: built (2026-10-29); Go and web tests. Not yet tried against Remotr.

## Request

Stop a kept RDP session's video while its window can't be seen, the way
terminals stop painting: when the window is minimized, fully covered by
other windows, the Tessera tab is in the background, or the phone view is
showing. The server stops encoding, the host stops relaying and the browser
stops decoding, which matters most on an iPad (battery, heat) and with
several RDP windows open. Suggested after the terminal performance work
(docs/terminal-performance-2026-10-04.md) as the first RDP item.

## Findings (from the code)

- The host already pauses a kept session's display, but only when no viewer
  is attached: `Attach` posts the module's Suppress Output message with
  "allow" and `detach` posts it without (`internal/rdpsession/viewer.go`).
  The module sends Suppress Output to the server, with the whole desktop as
  the rectangle when resuming, so the server sends the screen again
  (patch 0004, `suppress_output`).
- A minimized window or a background tab keeps its viewer attached, so the
  server keeps encoding H.264 at full rate and the browser keeps decoding
  it into a canvas nobody sees.
- Terminals decide this in `updateTerminalRenderState` (`web/app.js`):
  paused when the document is hidden, the pane is minimized or
  `terminalIsCovered`, or, in the phone view, when it isn't the open pane.
  It runs on minimize, on visibility changes, and after moves and raises
  (`scheduleTerminalVisibilityUpdate`).
- The phone view doesn't show RDP windows at all (task 240), so an RDP
  window is never seen there.
- The in-page IronRDP path (no kept sessions) has no Suppress Output call
  in IronRDP's web `Session`; it would need another patch.

## Decisions

1. **Kept sessions only.** The in-page path keeps streaming; it is used
   only when the host doesn't keep sessions.
2. **A new viewer message, `ViewShown [shown u8]`.** The host posts
   Suppress Output when the attached viewer's state changes. A new viewer
   starts shown, as `Attach` already resumes the display; `detach` pauses
   only a display that isn't paused already.
3. **The same rule as terminals.** Hidden when the document is hidden, the
   window is minimized or fully covered, or the phone view is active.
4. **Hide late, show at once.** A minimized or covered window waits 2 s,
   so dragging a window across, or minimizing and restoring, doesn't pause
   the stream and then ask for a whole new screen. A hidden page says so at
   once, since its timers may never run (iPad suspends a background tab).
   Showing is sent right away.
5. **The last picture stays.** The canvas keeps what it showed; when the
   display resumes, the server sends the whole screen.

## Plan

- `internal/rdpsession`: `ViewShown`, `Session.setShown`, `viewerShown`
  reset by `Attach`; tests for pause, resume, repeats, a new viewer and
  detach while paused.
- `web/rdp-viewer-wire.mjs`: `shownMessage`; `web/rdp-viewer.mjs`:
  `session.setShown`.
- `web/app.js`: one `paneUnseen` rule shared with terminals; `syncRDPShown`
  with the hide delay, run wherever terminals' render state is updated and
  when a session is activated.
- docs/vnc-and-rdp.md.

## Built

- `internal/rdpsession`: `ViewShown` (`viewer_protocol.go`,
  `viewer_input.go`), `Session.setShown` and `viewerShown` (`viewer.go`,
  `session.go`). `TestAViewerOutOfSightPausesTheDisplay` covers pause,
  resume, repeats, detaching while paused and a new viewer starting shown;
  `TestViewerMessagesAreValidated` covers malformed messages.
- `web/rdp-viewer-wire.mjs` `shownMessage`; `web/rdp-viewer.mjs`
  `session.setShown`.
- `web/app.js`: `paneUnseen` (now also the terminals' rule),
  `updatePaneRenderState` in place of `updateTerminalRenderState` where
  every pane is updated, and `syncRDPShown`; `rdpHideDelayMs` in
  `web/rdp-pane.mjs`. A test in `web/terminal-hidden-output.test.mjs`
  covers the wait, its cancelling, a hidden page and a replaced session.
- docs/vnc-and-rdp.md, Kept RDP sessions.
- Still to try: a real session against Remotr, checking that the server
  stops sending while paused and resumes with the whole screen (H.264 and
  full color).

## Not covered

- A viewer replaced by another may still send `ViewShown` in the moment
  before its connection closes, as it can input and wiggle; the new viewer's
  next change of state corrects it.
