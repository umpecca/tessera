# Tessera audio capture helper protocol

Tessera file and URL playback has no native dependency. Linking an Audio pane
to a Terminal pane additionally requires a platform helper installed by the
operator. Tessera does not capture the whole desktop as a fallback.

## Discovery and invocation

The helper is resolved in this order:

1. The exact path passed with `-audio-capture-helper`.
2. `tessera-audio-capture-${GOOS}-${GOARCH}` or
   `tessera-audio-capture` beside the Tessera executable.
3. The same names on `PATH`.

Tessera invokes:

```text
tessera-audio-capture capture
  --pid <terminal-shell-pid>
  --include-tree
  --format s16le
  --sample-rate 48000
  --channels 2
```

Unknown arguments should produce a nonzero exit. `--include-tree` means the
root PID and all descendants that exist or appear while capture is active.

## Streams

`stdout` is reserved for interleaved signed 16-bit little-endian PCM: 48,000
samples per second, two channels. No headers, logs, or status bytes may appear
there.

`stderr` is UTF-8 NDJSON. Each line is one object:

```json
{"type":"ready"}
{"type":"warning","message":"Player is not producing capturable audio"}
{"type":"error","message":"Capture permission required"}
```

The helper emits `ready` only after its OS capture graph is operational and its
stdout format is normalized. Tessera allows ten seconds. An `error` before
`ready`, timeout, malformed setup, or process exit fails Play softly. After
`ready`, helper or encoder exit pauses the station and disconnects listeners.

On cancellation Tessera sends an interrupt request, waits two seconds, and then
force-terminates a helper or encoder that remains alive. Helpers should use the
grace period to tear down capture sessions and any child utilities.

## Platform boundary

- Windows helpers use process-loopback activation and include the selected
  shell's process tree. The API boundary begins at Windows 10 build 20348. See
  Microsoft's [Application Loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).
- Linux helpers require PipeWire. They identify clients/nodes using trusted
  process metadata, route only nodes owned by the selected tree into a capture
  stream, and normalize with PipeWire conversion. `target.object` and audio
  format/rate/channel properties form the routing and format boundary. ALSA-only
  systems are unsupported in v1. See [PipeWire audio](https://docs.pipewire.org/page_audio.html).
- macOS helpers use ScreenCaptureKit application audio filters. They must map
  the selected process tree to running applications, request screen/audio
  capture permission through the operating system, and report denial as
  `Capture permission required`. See Apple's
  [ScreenCaptureKit documentation](https://developer.apple.com/documentation/ScreenCaptureKit).
- FreeBSD and OpenBSD do not support Terminal capture in v1.

A CLI that only controls an already-running external player is outside the
Terminal process tree and is expected to produce silence. Protected playback
can also be silent. Helpers and Tessera must not broaden the selected process
scope or attempt DRM circumvention.

## Installation and conformance

Place the helper next to Tessera, install it on `PATH`, or pass its absolute
path with `-audio-capture-helper`. It is intentionally not installed by the
self-updater because native permission, library, signing, and package-manager
requirements differ by platform.

Before distribution, an adapter should be protocol-tested with synthetic audio:

- stdout contains only stereo 48 kHz s16le samples;
- `ready` arrives after setup and within ten seconds;
- permission and unsupported-system failures are NDJSON `error` events;
- a descendant renderer is included and an unrelated renderer is excluded;
- interrupt exits promptly and forced termination leaves no routing objects;
- long-running output remains valid when no browser listener is connected.
