# Task 029 — Platform capture helpers

Status: external dependency

Tessera defines, supervises, and tests the capture-helper protocol, resolution
order, lifecycle, PID/process-tree boundary, normalized PCM format, and failure
reporting. Platform-native helper binaries remain separately installed optional
dependencies: Windows process loopback, PipeWire process-node routing, and macOS
ScreenCaptureKit are not bundled or automatically installed by Tessera.

The host retains file and URL playback when no helper is available. FreeBSD and
OpenBSD explicitly report Terminal capture as unsupported.
