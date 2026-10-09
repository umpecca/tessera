# Terminal file transfers v1

`tessera-file` transfers files between a browser device and the machine running
Tessera. File contents stream over HTTP; the terminal carries bounded control
messages and replies. This is a private Tessera extension, not a standard OSC.

```sh
go build -o tessera-file ./cmd/tessera-file
tessera-file capabilities
tessera-file upload                  # browser selects files; destination is cwd
tessera-file upload --to ./incoming
tessera-file download ./report.pdf
tessera-file download ./report.pdf ./notes.txt
tessera-file upload > result.json
tessera-file cancel REQUEST_ID
```

Install the helper on the Tessera host and put it on PATH. Releases include
`tessera-file-linux-amd64`, `tessera-file-linux-arm64`,
`tessera-file-darwin-arm64`, and `tessera-file-windows-amd64.exe` assets. On
Unix, rename the matching asset to `tessera-file`, run `chmod +x tessera-file`,
and place it in a PATH directory. On Windows rename it to `tessera-file.exe`.
No encoder or other executable dependency is required.

The helper opens `/dev/tty` or `CONIN$`/`CONOUT$`, temporarily enables raw input,
and restores console settings on every exit path. Results are JSON on stdout;
progress, the request ID, and diagnostics go to stderr. Capability discovery
waits one second. Ctrl+C cancels the request. Upload success requires every
selected file to have been uploaded; skipped/failed files produce a partial
result and a nonzero exit status. Already uploaded files remain after cancellation.

The helper resolves paths against its own working directory and checks the
host identity/OS returned by Tessera. It rejects detected SSH sessions. Identity
checks are a diagnostic guard, not authentication: protocol paths always refer
to the Tessera host. Remote shells, directories, pipes carrying file contents,
resuming transfers, and automatic multiplexer passthrough are outside v1.

## Browser behavior

Each request offers an explicit Choose files or Download action. One currently
attached browser claims it; other invitations disappear. Reconnecting does not
replay invitations. Hidden terminals remain subscribed; the window list shows
pending transfers. Uploads run sequentially and ask before replacing each
existing regular file. Cancelling an unfinished upload removes its staging file.

Single downloads preserve the file. Batch downloads stream a ZIP with stored,
uncompressed basename entries; duplicate basenames are rejected. The filename
is `tessera-files-REQUEST_ID.zip`. `sent` means the server sent the response,
not that the browser confirmed saving to disk. Cancellation cannot recall data
already handed to the browser.

Requests expire after five minutes awaiting approval, and active IO after two
minutes without progress. Shell reset/exit, disposal, workspace changes, page
closure, and unexpected disconnection cancel requests. A deliberate hide/reveal
socket replacement can hand a claim to the replacement within five seconds.

## OSC protocol

Prefix: `ESC ] 777;tessera-file;1;`. Terminate with ST (`ESC \\`) or BEL.
The helper emits ST. IDs/nonces contain 1–64 ASCII letters, digits, `_`, `-`, `.`.
Metadata is canonical base64 of UTF-8 JSON, at most 64 KiB decoded.

| Command | Fields after prefix | Metadata |
|---|---|---|
| Upload | `upload;<id>;<base64-JSON>` | `{"directory":"/absolute/directory"}` |
| Download | `download;<id>;<base64-JSON>` | `{"paths":["/absolute/file", "/absolute/other"]}` |
| Cancel | `cancel;<id>` | None |
| Query | `query;<nonce>` | None |

Duplicate active IDs are rejected. Requests accept at most 64 files, four per
terminal, and 32 per server. Uploads use `-max-upload-size`, default 1 GiB per
file. Directories, unsafe upload names, symlink upload targets, nonregular files,
invalid metadata, and unsupported versions are rejected or consumed safely.

Replies use the same prefix and terminator:

- `capabilities;<nonce>;<base64-JSON>` reports `version`, `host`, `os`,
  `scope: "host-local"`, `batch`, `zip`, metadata/file/upload limits, and deadlines.
  Protocol support does not imply a browser is listening.
- `reply;<id>;<base64-JSON>` carries `state`, optional `error`, `bytes`, and
  per-file `files` with name/path/bytes/status/error. Nonterminal states are
  `pending`, `claimed`, `transferring`; final states are `complete`, `partial`,
  `sent`, `cancelled`, `failed`. Upload results also include the destination
  `directory`. Replies are bounded to 512 KiB; unusually long repeated paths
  are omitted with `pathsOmitted: true`, retaining filenames and all statuses.

TUI applications send commands and consume matching replies in their own input
loops. Only the host answers: browser parsing of snapshots/output discards native
file effects. Effects are transient and excluded from snapshots, and historical
requests never perform filesystem work or display transfer prompts.

## Browser transport

Subscribe on the terminal WebSocket using
`{"type":"file-events","enabled":true,"clientId":"RANDOM_PAGE_PANE_ID"}`.
The acknowledgement includes the shell `epoch`. Live `terminal-file` events
have `epoch`, `id`, `action` (`request`, `claimed`, `progress`, `finished`,
`reset`), and operation metadata. They use a separate eight-event/256 KiB queue.
Overflow resets file UI and removes eligibility without affecting terminal text.
`file-decline` carries `id` and `epoch`. `file-handoff` precedes a deliberate
socket replacement; the replacement subscribes with the same page/pane client ID.

The inert GET `/api/terminal-files/frame` provides a same-origin download target
with no executable content; it preserves origin checking for native forms.
Transfer routes are POST-only under `/api/terminal-files/`: `claim`, `upload`,
`download`, `result`, `finish`, `cancel`. Claims identify workspace/pane/epoch,
request and browser; uploads additionally announce selected names and sizes.
Opaque tickets authorize only that request's fixed paths and operation. Uploads
carry tickets in `X-Tessera-Transfer`, download forms in their body, and JSON
control requests in their body. Credentials never appear in URL paths/queries
or audit logs. Native attachment delivery avoids buffering files in browser Blobs.

The retired `/api/files`, `/api/files/upload`, `/api/files/download` routes are
removed. Migration 045 converts File Browser panes to terminals while preserving
identity, layout and directory; imported legacy panes receive the same conversion.
Worksheet and Text Editor panes are also retired by migration 046; their saved
documents remain archived in workspace data. The terminal directory picker remains.
The retired raw `/api/file` read/write and worksheet `/api/run`/`/api/runs`
endpoints are removed.

## Verification

The automated smoke harness is `scripts/terminal-files-smoke.mjs`, accepting
`--playwright=<module>` and `--browsers=chrome,edge,firefox`. It launches an
isolated host/database and two browser clients, runs the real helper through a
PTY, and checks batch uploads, original/ZIP downloads, hidden invitations,
hide/reveal handoff, decline, and redirected stdout. Go/JS tests cover parser
splits, snapshots, claims, limits, cancellation, temporary files and migrations.
Safari and the native macOS preview require final verification on a Mac.
