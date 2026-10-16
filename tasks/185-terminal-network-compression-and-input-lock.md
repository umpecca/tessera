# Task 185: Compress terminal output and unblock input

Status: complete

## Request

Look for terminal and networking performance improvements; implement websocket
compression and lock-free terminal input.

## Measurements (Apple Silicon, before changes)

- Server terminal core parses about 48 MB/s: roughly 170 µs per 8 KiB PTY
  read, all of it under the session lock.
- Typical output compresses 6.5x (colored `ls`, build logs) to 8x (a full TUI
  redraw) with deflate. `flate.BestSpeed` runs about 160 MB/s, well ahead of
  the parser. An 18-byte keystroke echo grows to 28 bytes when compressed.

## Changes

- **permessage-deflate on the terminal websocket.** The upgrader offers
  compression at `flate.BestSpeed`. It is negotiated per connection but applied
  per message: `writeTerminalBinary` compresses snapshot, replay and output
  frames of 1 KiB or more; smaller frames and JSON control messages go
  uncompressed. Browsers negotiate it natively; no client change.
- **Input no longer waits for the parser.** `ManagedSession.Write` took the
  session lock only to read `s.session`, which is fixed at creation, so
  keystrokes such as Ctrl+C queued behind the chunk being parsed. It now reads
  the field directly, as the read loop already does.

## Validation

- New tests: the real terminal endpoint negotiates `permessage-deflate`; a
  byte-counting connection shows a small frame crossing uncompressed and an
  8.6 KB build-log frame crossing at under a quarter of its size. The test
  fails when compression is disabled.
- `go vet` and `go test -race` pass for `internal/httpapi` and
  `internal/terminal`.
