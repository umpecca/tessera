# Task 203: Keep terminals playing a stream live while hidden

Status: complete

## Request

When Trinity streams music and another terminal is focused and then Trinity is
focused again, the music pauses briefly. Find out why, and fix it.

## Findings

The pause happened only when Trinity's pane was fully covered (for example by
a maximized terminal), minimized, or in a hidden tab:

1. A hidden terminal pauses text delivery (`updateTerminalRenderState`). Audio
   keeps flowing on the same socket, so playback continued while hidden.
2. Revealing it resumes on a new socket by design (`setTerminalOutputPaused`;
   the server's `pause-output` handler says "visibility resumes on a new
   socket").
3. The new socket's live join sends `stream-start`. The browser handles it by
   stopping the stream it is playing (`terminal-audio-stream.mjs`), dropping
   the queued audio.
4. The gap is the new socket's handshake, a new decoder, and refilling the
   stream's buffer target (Trinity's default `--buffer-ms` is 500).

Alternatives considered and rejected:

- Continue a stream across the live join. Packets sent while the new socket
  opens are lost, and since producers pace in real time the buffer would
  shrink on every reveal until it underran, unless the gap was filled with
  silence. It also relaxes "missing packets stop a stream".
- Resume on the same socket. It would fix this system-wide but means
  redesigning reveal-and-replay on server and client.
- Lower `--buffer-ms`. Shortens the gap without removing it.

The user dislikes exceptions to the system. The chosen rule restates what
pausing is for rather than adding an exception: text delivery pauses for
terminals nobody is perceiving, and a terminal playing a stream aloud is being
perceived. Browsers make the same call for audible background tabs.

## Changes

- `web/terminal-audio.mjs`: `TerminalAudioPlayer.streaming(key)` reports
  whether one of the terminal's streams is playing in this browser, with audio
  enabled and the pane unmuted. Clips don't count; they're too short to justify
  keeping a hidden pane live, and counting them would make panes flip between
  paused and live.
- `web/app.js` `updateTerminalRenderState`: when a terminal is hidden while
  streaming, it sets `liveWhileHidden` and doesn't pause output. Drawing still
  pauses. The decision is made once, at hiding, so the gap between tracks
  (end, then a new start) can't pause it. A stream started after the pane
  paused waits for reveal, with one gap. Revealing clears the flag.
- `docs/terminal-audio.md`: describes the rule.

## Validation

- `web/terminal-audio-stream.test.mjs`: `streaming()` is false while disabled,
  with setup alone, when muted, and after the stream ends; true while
  buffering and playing.
- `web/terminal-audio.test.mjs`: a playing clip doesn't count as streaming.
- `web/terminal-hidden-output.test.mjs`: a streaming pane stays live when
  minimized, covered, or in a hidden tab, still pauses drawing, sends no
  `pause-output`, and resumes on the same socket. The decision is made once:
  silence while hidden keeps it live, a silent pane still pauses, and a stream
  started while paused waits for reveal.
- Both hidden-output tests fail with the `liveWhileHidden` condition removed.
- `node --test web/*.test.mjs`: 612 pass.
- Not yet checked by ear in Safari with Trinity.
