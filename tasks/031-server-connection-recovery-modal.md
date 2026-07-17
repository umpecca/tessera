# Task 031 — Server connection recovery modal

Status: complete

Add a single global recovery modal when the loaded Tessera web client can no
longer reach its server. The modal should replace scattered uncertainty with a
clear retry/refresh path without interpreting the closure of one pane resource
as proof that the entire server is unavailable.

## Detection

- Start a lightweight `/api/health` monitor after the workspace finishes its
  initial load.
- Poll at a conservative interval that stays well below the default rate limit
  and use a short per-request timeout with `cache: "no-store"`.
- Show the modal after two consecutive health failures to avoid flashing it for
  one transient request failure.
- Show it immediately for the browser `offline` event and retry immediately for
  the `online` event.
- Clear the consecutive-failure count after every successful health response.
- Do not open the connection modal during the intentional shutdown/restart
  phase of the built-in self-update flow, which already owns its own modal and
  health polling.

## Modal behavior

- Render one non-duplicating, accessible `alertdialog` above all workspace UI.
- Explain whether the browser is offline or the Tessera server is unreachable.
- Provide **Reconnect** and **Refresh Page** actions.
- **Reconnect** performs an immediate health check. While checking, disable the
  action and show progress. If the server responds successfully, reload the SPA
  so Terminal WebSockets, audio events, command streams, sessions, and workspace
  state all reconnect through their normal startup paths.
- If reconnect fails, keep the modal open and show the failure state.
- **Refresh Page** calls `window.location.reload()` immediately.
- Do not close the modal via backdrop click or Escape while the server remains
  unavailable.
- When background polling detects recovery, change the modal to a restored
  state and offer a **Reload Tessera** action rather than reloading
  automatically, avoiding surprise loss of unsaved browser-side edits.

## Presentation

- Reuse Tessera's existing settings-modal visual language and theme variables.
- Keep the dialog usable on touch devices and narrow iPad layouts.
- Use live status text and restore focus predictably when modal actions change.

## Verification

- Confirm a single failed health check does not show the modal.
- Confirm two failures, browser offline, retry failure, and background recovery
  produce the expected states without duplicate dialogs or polling loops.
- Confirm reconnect/reload uses the current URL, including named-session routes.
- Confirm self-update restart polling suppresses the connection modal.
- Run `node --check web/app.js`, the frontend Node tests, `go test ./...`, and
  `go vet ./...`.

## Documentation

Update `README.md`, `ARCHITECTURE.md`, and `CHANGELOG.md` with the client-side
connection monitor and recovery behavior.

## Implementation summary

- Added a five-second `/api/health` monitor with a two-failure threshold,
  immediate browser offline/online handling, and self-update suppression.
- Added a global accessible connection dialog with reconnect, refresh, restored,
  focus-trap, and responsive presentation states.
- Added a pure connection-state reducer and Node tests covering transient
  failure, forced offline, recovery, and subsequent disconnection behavior.
- Verified the lost/restored states against a live local Tessera server, and ran
  the frontend tests, `go test ./...`, `go vet ./...`, and `git diff --check`.
