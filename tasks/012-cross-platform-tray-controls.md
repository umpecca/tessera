# Task 012: Cross-platform tray controls

Status: complete

Add a desktop notification-area integration for Tessera using a library that
supports Windows, macOS, and Linux. Menuet was evaluated, but it targets only
macOS's NSStatusBar, so use `github.com/getlantern/systray` instead.

The tray menu must:

- show whether the Tessera server is running;
- start and stop the local server without ending the process;
- open the current Tessera page in the default browser for configuration;
- exit cleanly, including normal server shutdown;
- remain optional so `go run ./cmd/tessera` continues to work in server-only
  environments using a `-tray=false` flag.

Keep lifecycle ownership in the desktop entry point, retain signal and
self-update behavior, and add unit tests for the lifecycle controller.

Task 019 later narrowed native tray support to Windows and macOS so Linux
release binaries can remain CGO-free and portable.
