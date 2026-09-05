# Task 094: VNC connector window

Status: complete

Add a persistent VNC pane using a bundled noVNC client and a Tessera-owned
WebSocket-to-TCP bridge.

## Requirements

- Add VNC to the window menu, workspace menu, command palette, Deskbar, focus,
  persistence, and pane cleanup flows.
- Persist the target, view-only choice, and fit/one-to-one scale mode without
  persisting credentials.
- Require an explicit Connect action and keep credentials only in page memory.
- Support pointer and keyboard control, Ctrl+Alt+Del, explicit clipboard send
  and receive, server verification, disconnect, and useful status messages.
- Accept any DNS, IPv4, or IPv6 target reachable from the Tessera host, using
  port 5900 when no port is supplied.
- Create short-lived, one-use capability paths and require same-origin binary
  WebSocket connections.
- Keep the application deployable as one Go binary.

## Verification

- Cover target parsing, capability expiry and consumption, origin and protocol
  rejection, TCP relay, persistence, pane helpers, credentials, and clipboard
  behavior with focused tests.
- Run the web build, Node tests, JavaScript syntax check, Go tests, Go vet, and
  whitespace validation.

## Completion

Implemented the persistent VNC pane, bundled noVNC 1.7.0 with its upstream
license notices, the one-use same-origin WebSocket-to-TCP capability bridge,
VNC settings migration and persistence, explicit credential/verification and
clipboard flows, and the documented security model. Automated backend, store,
and frontend coverage passes, as do the web build, JavaScript syntax check, Go
tests, Go vet, and whitespace validation. A browser smoke test also verified
pane creation, validation feedback, preference persistence, and disconnected
restoration.
