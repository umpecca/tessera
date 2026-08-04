# Task 072: Copy out of a TUI reaches the system clipboard

Status: complete

Copying inside a full-screen terminal program running in a Terminal pane — an
editor such as Fresh, Vim, or Helix — could not reach another application on
the operator's machine. Task 071 fixed the inbound direction; the outbound one
had no path at all.

A TUI has no browser selection to copy, so it asks the terminal to set the
clipboard with OSC 52: `ESC ] 52 ; <targets> ; <base64> BEL` (or `ESC \`).
ghostty-web exposes no clipboard callback — its public surface has `onBell`,
`onTitleChange`, `onData`, and no equivalent for OSC 52 — and its parser
consumes the sequence, so the copy vanished inside the pane. Tessera passed PTY
bytes straight to `term.write()`, so it never saw them either. The only way out
was a mouse selection plus `Ctrl+Shift+C`, which a TUI with mouse reporting
enabled takes for itself.

## Requirements

- Lift OSC 52 clipboard writes out of the terminal stream and put the text on
  the system clipboard.
- Leave every other byte, including other OSC sequences, untouched.
- Recognize a sequence split across WebSocket frames, and both terminators.
- Never answer an OSC 52 read request (`ESC ] 52 ; c ; ? BEL`). Replying would
  let anything running in a Terminal pane exfiltrate the operator's clipboard.
- Say so when the browser refuses the clipboard write, rather than losing the
  copy silently.

## Implementation

- `web/terminal-osc52.mjs` holds `TerminalOSC52Filter`, a streaming parser.
  `write(chunk)` returns the bytes the terminal should see plus the text of
  every complete OSC 52 write in the chunk. It handles string and `Uint8Array`
  chunks, keeps parser state between calls for sequences split across frames,
  replays a candidate that turns out not to be OSC 52 in its original order,
  and caps the payload so an unterminated sequence cannot grow without bound.
- One filter belongs to one connection: `connectTerminalSocket()` creates it
  alongside the socket, so a half-received sequence dies with the connection
  that was sending it.
- Read requests and empty payloads are consumed and produce no clipboard write.
  Every target (`c`, `p`, `s0`, ...) maps to the one system clipboard, since
  Tessera does not model X selections.
- `writeClipboardText()` now returns whether the text actually reached the
  system clipboard instead of always reporting success, and the terminal path
  reports "Clipboard blocked" when it did not. Editor Cut keeps cutting either
  way, since Tessera's own buffer still holds the text.
- `copyTextWithHiddenField()` restores the previously focused element. An
  OSC 52 copy can land while a TUI holds the keyboard, and the hidden textarea
  used by the `execCommand` fallback would otherwise take focus away from it.

## Verification

- `node --test web/*.test.mjs` (97 tests; 15 new in
  `web/terminal-osc52.test.mjs` covering both terminators, split frames, binary
  and string chunks, UTF-8 payloads, unpadded and mangled base64, non-OSC-52
  escapes replayed in order, read requests, oversized payloads, and back-to-back
  sequences)
- `node --check web/app.js`, `npm run build:web`, `go test ./...`
- Real-browser check against a Terminal pane on Windows: a PowerShell command
  emitting OSC 52 through ConPTY had its text intercepted, and Tessera's
  Terminal Paste then produced exactly that text over the terminal socket.
  ConPTY was confirmed to pass OSC 52 through unmodified.

Not verified: the final hop to the OS clipboard. The embedded browser used for
the check denies clipboard permission outright
(`NotAllowedError: Write permission denied`), which exercised the
"Clipboard blocked" path instead. A normal browser tab on a focused window
still needs a look.
