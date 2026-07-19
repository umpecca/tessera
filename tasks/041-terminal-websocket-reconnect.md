# Task 041 — Terminal WebSocket reconnect

Status: complete

Reconnect an existing Terminal pane when its browser WebSocket closes
unexpectedly, independently of the HTTP server-health monitor.

## Implementation summary

- Added terminal-scoped retry delay and tests; the renderer will retain its
  session state while the socket reconnects.
