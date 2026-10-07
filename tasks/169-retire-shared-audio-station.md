# Retire the shared Audio station

Status: completed

Remove the standalone Audio pane, shared transport API/state, process capture,
LAME companion, installer options, and release/updater encoder integration.
Preserve terminal WAV/MP3 clips, Opus streaming, local playback controls, and
the FFmpeg producer helper. Retire persisted Audio panes and station state
without changing other pane contents or workspace settings. Reject stale saves
and discard legacy Audio panes in imported documents.

Validate schema upgrades, executable-only updates with rollback, removed API
routes, installer behavior, Go/JavaScript suites, generated assets, and live
terminal clip/stream playback.

## Implemented

- Removed Audio pane menus, palette entries, file selection, HTML playback,
  styles, shared API/manager/storage, capture PID hooks, and CLI overrides.
- Removed LAME builds/license assets, the MinGW patch, installer options and
  prompts, companion downloads, repair hooks, and paired updates. Executable
  replacement still rolls back on failure and retains service restart support.
- Migration 044 drops station state, removes Audio panes and their layout IDs,
  selects a surviving active pane, and rotates affected workspace revisions.
  Other documents, settings, backgrounds, runs, and revisions are preserved.
  Legacy imported panes are discarded in both the browser and store.
- Kept the terminal clip/Opus player, protocol, local controls, worker decoder,
  FFmpeg helper, and separate helper release assets. Updated current docs and
  documented one-time manual/installer upgrades from LAME-dependent updaters.

## Validation

- Full uncached Go suite and `go vet ./...` passed. Added migration/reopen,
  stale-save, import, removed-route, executable-only update, and rollback tests.
- All 544 JavaScript tests passed, including legacy workspace loading and the
  terminal clip/stream suites. Ubuntu installer syntax and behavior tests pass.
- Web assets rebuilt; the shared core reproducibility check passed with hash
  `d6df7f944f8828abcef7b285cb6d295863c037c1a7d787d26d90cfba44a3f9bd`.
- Chrome 154.0.8037.98 real-app smoke passed overlapping WAV/MP3 clips and an
  18-second FLAC-to-Opus stream, activation, local/persisted mute, hidden clips
  and streams, live reconnect, stop, EOF, and page cleanup, without page errors.
  Results: `.cache/review/terminal-audio-169/results.json`.
- Linux amd64/arm64 app/helper builds and Darwin arm64 helper build passed.
  The native Darwin app cannot cross-build without macOS CGO/tray support.
  Firefox, Safari, native macOS preview, and physical listening remain
  unverified in this Windows environment, as recorded in task 168.
