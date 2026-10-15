# Terminal application window titles

Status: complete

## Request

Observe titles emitted by terminal applications and automatically use them as
the name of their Tessera terminal window.

## Behavior

- Follow OSC 0 and OSC 2 title requests terminated by BEL or ST. Ignore OSC 1,
  which changes only the icon label.
- Update the terminal pane's title bar, Deskbar, and window switcher together.
- Keep the existing window name when an application does not emit a title or
  emits an empty title. Display titles as plain text.
- Manual renaming remains available. A subsequent nonempty application title
  replaces that name while automatic title following is active.
- Preserve the latest title through refresh, reconnect, hidden-pane recovery,
  and terminal view recreation. Handle sequences split across output chunks.
- Avoid unnecessary workspace saves and UI updates for repeated titles, and
  do not interrupt an active title edit.

## Implementation notes

The shared Ghostty parser retains UTF-8 titles up to 4096 bytes and a revision
counter. The browser adapter reads revisions after writes and snapshot imports
and emits onTitleChange for the pane UI. This replaces the library's regex,
which handles only complete string writes. Repeated application requests can
replace manual names, while unchanged displayed titles cause no saves.

TSS3 snapshots carry the retained title alongside existing parser continuation.
Full terminal reset clears the core's retained title. The existing pane title
and debounced workspace save paths persist displayed names. The title listener
is disposed with its terminal view. Both inline and modal title editors are
protected from incoming title updates.

## Validation

- All 590 JavaScript/core tests pass. New tests cover OSC 0/2 with BEL and ST,
  snapshots at every byte split, Unicode, ignored OSC 1, empty/oversized/invalid
  UTF-8 titles, repeated requests, reset, literal text, and both title editors.
- Real WASM adapter tests cover byte writes, snapshot handle replacement,
  memory growth, and repeated requests after manual renaming.
- Headless Edge with a real Windows PTY verifies automatic titles, manual
  renaming, active-edit protection, refresh with a stale persisted fallback,
  color-driven view recreation, and hidden-pane recovery with the same shell
  epoch. No browser errors. Script and screenshot: `.cache/review/title-180`.
- Generated core and web assets rebuilt. Go vet and syntax/diff checks pass.
- Go tests pass with TestStartUsesPersistedLocalHTTPSConfiguration skipped.
  The unfiltered suite's sole failure is that existing server test's fixed
  port 7331, occupied by a local instance; other packages pass unfiltered.
