# Task 277: Reconnect silently after sleep

Status: implemented, awaiting device check (2026-11-15).

## Request

When the iPad app (and the web app) sleeps, waking shows the **Connection Lost**
dialog and then **Connection Restored** with **Refresh Page** / **Reload
Tessera**. The user wants Tessera to reconnect silently instead.

## Findings

- `web/server-connectivity.mjs`: a visibility change or wake runs
  `checkServerConnection({ force: true })`; `force` turns the first failed health
  probe (the network is often still coming up) into the **Connection Lost**
  dialog. The browser `offline` event also opens it immediately.
- When a later probe succeeds, the dialog switches to **Connection Restored** and
  waits for **Reload Tessera** (task 031 chose a manual reload to avoid losing
  unsaved edits). **Reconnect** reloads the page once the server answers.
- A reload is no longer needed. Terminal sockets resume by themselves
  (`resumeTerminalConnections`, task 106), the workspace revision is revalidated
  on recovery (`workspacePersistence.revalidate`, conflict dialog if another
  browser saved), and phone view refreshes. VNC/RDP panes show their own
  Connect action after a drop, and a reload wouldn't reconnect them either.

## Scope

- Wake/foreground grace: for 15 s after the page becomes visible or wakes (and
  after an `offline` event in that window), failed probes don't open
  **Connection Lost**; the compact corner status shows "Reconnecting…" and the
  regular 5 s probe keeps retrying. If the server is still unreachable after the
  grace, the dialog opens as today.
- Recovery without a reload: when the server answers while **Connection Lost**
  is open, the dialog closes by itself and the corner status briefly shows
  "Reconnected". **Reconnect** does the same on success instead of reloading.
  **Refresh Page** still reloads. The **Connection Restored** / **Reload
  Tessera** state goes away.
- Ordinary outages while the page is in use keep the current two-failure rule.
- No server or Swift changes. Update `docs/workspace.md`, `ARCHITECTURE.md` if it
  describes the reload, and `CHANGELOG.md`.
- Approval: user said "go ahead" to this scope and the 15 s grace (2026-11-15).

## Acceptance criteria

- [x] One or more failed probes within 15 s of wake/foreground show only the
      compact status, not the dialog.
- [x] Still unreachable after the grace: **Connection Lost** opens.
- [x] Server back while the dialog is open: it closes, terminals resume, no reload.
- [x] **Reconnect** success closes the dialog without reloading.
- [x] Workspace revalidation still runs on recovery (conflict dialog if newer).
- [x] Self-update restart still suppresses the dialog.

## Verification

- `node --test web/server-connectivity.test.mjs` (new): 5 pass. Covers grace
  failures and an offline event showing only "Reconnecting…", the dialog after the
  grace, recovery closing the dialog with no reload plus workspace revalidation and
  one terminal resume, "Reconnecting…" → "Reconnected", Reconnect success/failure,
  and the update fallback's **Reload Tessera**.
- `web/server-connection.test.mjs`: reducer tests updated (healthy always clears
  the state; a failure after recovery needs the two-failure threshold again).
- `web/native-app.test.mjs`: native `resume` starts the grace before reconnecting.
- `node --test web/*.test.mjs`: 1076 pass, 0 fail. `npm run build:web`: exit 0.
- Self-update suppression is unchanged code (`serverUpdateRestarting` checks);
  covered by existing behavior, not a new test.
- Automated with a fake DOM/clock/fetch only. Not yet performed: sleep/wake on the
  iPad app and a desktop browser.

## Implementation notes

- `web/server-connection.mjs`: `serverConnectionWakeGrace` (15 s); a healthy probe
  now always returns state `""` (no `restored` state).
- `web/server-connectivity.mjs`: `startServerConnectionGrace` on visibility
  return, wake recovery and (from `web/native-app.mjs`) native resume.
  `reportServerConnectionLoss` shows the dialog, or only the compact status while
  in grace and the dialog is closed. `finishServerReconnect` closes the dialog and
  shows "Reconnected" for 2 s when something was showing; wake recovery keeps its
  own status text. Reconnect no longer reloads. The server-update fallback uses a
  new `updated` state (**Server Updated** / **Reload Tessera**), since new assets
  do need a reload.
- `web/compatibility.mjs`: dropped the dead `restored` check.
- Docs: `docs/workspace.md`, `ARCHITECTURE.md`, `CHANGELOG.md`.
