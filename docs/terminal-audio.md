# Terminal audio: clips and streams

Terminal programs can send embedded WAV or MP3 clips directly to attached
Tessera browsers, or send progressively encoded Opus streams.
Right-click a terminal and choose **Enable terminal audio**,
or click the compact enable action when a program first sends a clip. Activation
applies to this browser page; earlier clips are dropped. **Disable terminal
audio** stops every terminal sound. **Mute terminal audio** applies to one pane
and is saved in this browser by workspace and pane ID. Unmuting plays future
requests only.

Every enabled attached client listens independently. Minimized and covered
terminals can produce sound even while their text delivery is paused. A hidden
browser tab can continue playing when its browser/OS permits background audio.
Text delivery pauses only for terminals nobody is perceiving. A terminal that
is playing a stream aloud in this browser (enabled and unmuted) when it is
minimized, covered or its tab is hidden keeps receiving text, so revealing it
doesn't reconnect and restart the stream. It still doesn't draw while hidden.
This is decided once, at hiding: a track change while hidden doesn't pause it,
and a stream started after the terminal paused waits for the terminal to be
shown, with one brief gap. Clips don't keep a terminal live.
Disconnecting stops local playback; reconnecting and restoring terminal history
never replay old sound; running streams resume from future packets. Clips need
no encoder. Streaming producers must supply Opus packets as specified below.
The former standalone Audio pane, shared station, process capture, and bundled
LAME encoder have been removed. Terminal playback uses explicit OSC requests;
it does not capture sound from unmodified applications.

## External audio producers

The `tessera-audio` CLI is maintained and released in an independent repository.
Its source, CLI tests, installation instructions and release assets live there.
This repository maintains Tessera's OSC implementation and protocol reference.

Applications send clip bytes or Opus packets through terminal output. Tessera
does not open a host path or URL for playback. This also works from a remote
shell when its terminal connection passes the extension through. Multiplexers
may require explicit escape passthrough configuration. TUI applications should
send capability queries and parse matching replies in their own input loops.

## Streaming behavior

Producers encode audio to 48 kHz Opus with 20 ms packets, for example using
FFmpeg/libopus, and pace file playback in real time. Opus encoding is lossy;
original-format/lossless passthrough is not included. The protocol carries a
100–2000 ms startup/rebuffer target. Smaller targets reduce buffering but tolerate
less jitter; encoder, network, and browser delays add to the target.

### Stream quality

The producer sets stream quality; Tessera relays packets unchanged and
browsers always decode at 48 kHz in the stream's channel count. Opus at
`tessera-audio stream`'s default of 128 kbps suits remote links. On a local
machine or LAN, choose its highest bitrate, 256 kbps, for near-transparent
quality. Run `tessera-audio stream --help` for the option's name. The extra
bandwidth (about 32 KB/s per stream, per listening browser) rarely matters
locally.

The v1 stop commands stop client playback for streams as well as clips. They
do not terminate the external producer; the producer must handle its own
cancellation and send a v2 abort to stop a stream immediately.

Enabling or unmuting audio joins future packets. A reconnect gets current
decoder setup and then new packets, with no historical audio. An ended stream
does not resume. Stream data bypasses text delivery entirely, including terminal
history, retained events, and snapshots. Streaming does not have the clip's
10 second limit. No seek, loop, application gain, or HTTP URL input is added.

## Streaming OSC protocol v2

Use `ESC ] 777;tessera-audio;2;` and ST or BEL. IDs and generation tokens follow
the v1 ID rules; every new start uses a fresh token, preventing late packets or
aborts from stopping a replacement. The commands are:

| Command | Fields after the prefix |
|---|---|
| Start | `start;<id>;<token>;opus;<channels>;<buffer-ms>;<pre-skip>` |
| Data | `data;<id>;<token>;<sequence>;<discard-padding>;<base64-batch>` |
| End | `end;<id>;<token>;<next-sequence>` |
| Abort | `abort;<id>;<token>` |

Channels are 1 or 2; sample rate is fixed at 48 kHz. Buffer target is an integer
from 100–2000 ms. Pre-skip is 0–65535 samples per channel from the Opus header.
Data sequences start at zero and increment once per batch. Each batch contains
1–5 raw 20 ms Opus packets, each preceded by its unsigned little-endian uint16
length (1–1275 bytes). One Opus frame per packet is required. Batches use
canonical base64. Final discard-padding is 0–959 samples per channel, trimmed
from the last batch; other batches use zero. End names the next expected
sequence and drains buffered audio; abort stops immediately. Missing,
duplicate, or out-of-order packets stop the affected generation.

Hosts retain up to four live stream headers per terminal. New subscriptions
receive a `stream-start` event with the current next sequence and zero pre-skip.
An overflow resets client audio, supplies fresh setup, and resumes only future
packets. Inactive setup is excluded from live joins after 30 seconds; browsers
also stop a stream after 30 seconds without data. A new start replaces that ID.

WebSocket events use the existing `terminal-audio` type and `epoch`. Actions are
`stream-start`, `stream-data`, `stream-end`, `stream-abort`; stream messages add
`token` and `sequence`, start adds `format: "opus"`, `channels`, `bufferMs`,
`preSkip`, and data adds `data`, `discard`. Zero-valued fields may be omitted.
The v1 capability query adds `streaming: true`, `streamVersion: 2`,
`streamFormats: ["opus"]`, `minBufferMs: 100`, `maxBufferMs: 2000`. Clip version
and terminal state protocol remain 1 and 2 respectively.

Browsers decode with the bundled `opus-decoder` WASM in dedicated workers and
schedule PCM on the same Web Audio context/gain nodes used by clips. This
avoids dependence on browser-native streaming codec APIs. Streams share the
four-per-terminal/sixteen-per-page voice limits and two active decode slots.
Encoded waiting data shares a 2 MiB budget with clips; each stream permits up
to 40 waiting batches. Decoded/scheduled PCM shares the 32 MiB budget and is
bounded to at most four seconds ahead (4.2 seconds at a 2000 ms target).
Overflow or decoder failure stops the affected client stream with a pane error.
Evicted streams remain stopped until a new start or live resubscription.

## Private OSC protocol v1

This is a Tessera-specific, namespaced extension; OSC 777 is not an allocated
cross-terminal audio standard. Applications should discover support before
depending on it. Sequences start with `ESC ] 777;tessera-audio;1;` and end with
ST (`ESC \\`) or BEL. Send these commands:

| Command | Fields after the prefix | Behavior |
|---|---|---|
| Play | `play;<id>;<wav\|mp3>;<base64-bytes>` | Decode and play a new clip; the same ID replaces its previous instance in this terminal |
| Stop | `stop;<id>` | Cancel that ID, including pending decoding |
| Stop all | `stop;*` | Cancel all of this terminal's clips |
| Query | `query;<nonce>` | Ask the host for protocol capabilities |

IDs and nonces contain 1–64 ASCII letters, digits, underscores, hyphens, or
periods. Base64 uses the standard alphabet with canonical padding and no
whitespace. Malformed, oversized, unsupported, and cancelled sequences produce
no sound. Neither playback errors nor blocked browser activation inject text
into the application's stdin. Only explicit capability queries get replies:

```text
ESC ] 777;tessera-audio;1;capabilities;<nonce>;<base64-JSON> ST
```

The JSON contains:

```json
{"version":1,"formats":["wav","mp3"],"maxClipBytes":524288,"maxDurationSeconds":10,"mixing":true,"maxClipsPerTerminal":4,"maxClipsPerPage":16,"streaming":true,"streamVersion":2,"streamFormats":["opus"],"minBufferMs":100,"maxBufferMs":2000}
```

These are protocol capabilities, not an acknowledgement that a client is
connected, unmuted, enabled, or has played a particular clip. Playback completion
and per-clip acknowledgements are not part of v1. The host sends query replies
once, independent of the number or visibility of attached browsers.

## Limits and playback behavior

- Clips contain at most **512 KiB of file bytes** and **10 seconds** of audio.
  WAV must be PCM16, mono/stereo, at 8–48 kHz. MP3 must decode to mono/stereo.
  Browsers validate decoding, channels, and duration; unsupported MP3 data
  reports a compact pane error. Encoded size and duration limits both apply.
- Four clips can mix per terminal and sixteen per page. A new clip evicts the
  oldest playing clip at the applicable limit. Stop, mute, reset, disconnect,
  pane disposal, and page teardown also cancel pending decodes.
- Each page permits two concurrent decodes, up to 2 MiB of waiting encoded
  clips (also capped at 32 waiting requests), and 32 MiB of retained decoded
  buffers. Waiting/playing clips are evicted oldest first at their limits.
- Native effect storage and each listener's live queue are bounded to eight
  events and 2 MiB. Listener overflow clears queued effects and stops its audio;
  subsequent requests start fresh. Text delivery and the running shell continue.
- Native audio effect queues are transient and excluded from snapshots. Raw
  terminal output may still contain the OSC bytes in retained history, but
  replay and browser snapshot parsing drain and discard their effects.
- URLs, host file references, loops, seeking, and application gain commands
  remain outside the terminal protocols. Streaming uses the separate v2 OSC.

## Transport and source builds

The frontend opts into live effects using an `audio-events` WebSocket control
message with `enabled: true`; the server acknowledges the subscription with
the same type and enabled value. `enabled: false` clears that attachment's audio
queue. Text JSON messages of type `terminal-audio` carry `epoch`, `action`, and
optional `id`, `format`, and base64 `data`. Actions are `play`, `stop`, and
`reset` (the latter is a server effect for shell reset/overflow). Audio has its
own queue and never advances the terminal state sequence or participates in
catch-up replay. The existing protocol remains version 2; rebuilt native cores
use the existing compatibility hash so stale clients reload.

The shared core exports `tessera_audio_read` for draining length-prefixed
transient requests. Go validates them and publishes live effects; browser
cores discard them. Rebuild/verify using the commands in
[terminal-core.md](terminal-core.md).

For an isolated end-to-end check, run:

```sh
node scripts/terminal-audio-smoke.mjs --helper=/absolute/path/to/tessera-audio --playwright=/absolute/path/to/playwright/index.mjs --chrome=/absolute/path/to/chrome
```

The smoke runner requires Go, ffmpeg with MP3 encoding, and Playwright's Firefox
test browser and an externally built `tessera-audio` binary supplied with
`--helper`. It builds a temporary Tessera binary, starts a private host/database,
generates its own WAV/MP3 tones, measures rendered audio, and exercises the real
helper, activation, mixing, mute, hidden playback, and reconnect behavior. It
does not attach to the operator's Tessera host or existing browser. Artifacts
are saved under `.cache/review/terminal-audio-162` by default.
Use `--browsers=chrome` or `--browsers=firefox` to run one available browser.
Add `--stream=true` to verify an 18-second FLAC-to-Opus stream, live unmute,
hidden playback, reconnect joining, and EOF cleanup. Decoder and embedded Opus
license notices ship in `vendor/terminal-opus-LICENSE.txt`.

## Retired Audio pane

The standalone Audio pane, shared file/URL transport, process capture, and
bundled LAME encoder have been retired. On upgrade, migration 044 removes saved
Audio panes and station state, preserving all other panes and workspace settings.
Old capture/encoder flags are no longer accepted. Previously installed encoder
files are left alone.
