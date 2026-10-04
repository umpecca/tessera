# Replay small terminal visibility gaps

Status: complete

## Request

Implement the next terminal performance improvement: catch up through a small
ordered replay after brief coverage instead of importing a complete snapshot
for every output change.

## Implementation

- Allow at most 64 KiB and 128 events in a browser resume replay. Count all
  transmitted event headers and payloads, replacing old clipboard effects with
  empty events. Use a fresh snapshot for larger or unavailable gaps.
- Resume from the last fully applied cursor after dropping queued output.
  Preserve snapshot recovery for interrupted imports and backlog overflow.
- Apply the same bound to connection retries so an interrupted replay cannot
  restart with a large unbounded gap.
- Keep hidden sockets paused and shells/exit notices live. Preserve event
  ordering, parser continuation, clipboard suppression, and old-client behavior.
- Continue sending the existing snapshot-on-change option on visibility
  resumes so older hosts fall back to their current safe snapshot behavior.

## Validation

- Five new native regressions cover small ordered gaps with geometry/color/image
  controls, clipboard sanitization and host-only query replies, replay/live
  ordering, both exact replay limits and one-unit-over fallbacks, actual sanitized
  wire size, cursor mismatches and retention eviction, idle views, and the prior
  client's snapshot-on-change policy. Query-option coverage was updated.
- Four new JavaScript regressions cover dropped queued output and ordered replay,
  interruption after partial application and bounded retries from that cutoff,
  a fully received snapshot canceled before import even at the same sequence,
  and real-WASM replay of retained history/images plus fragmented Sixel, UTF-8,
  alternate-screen, OSC, and CSI continuation. The real-core comparisons include
  viewport cells, image tiles, image count, cursor, and retained history. Existing
  large-gap snapshot, backlog, pause, exit, and stale-socket checks still pass.
- A real local PowerShell PTY/WebSocket regression replayed about 1.3-1.5 KiB of
  output from its applied cursor, avoiding a 593,272-byte retained-state snapshot.
  Five repeated runs remained below the replay limits and preserved continuous
  event sequences and byte offsets. The hidden connection received zero output
  after acknowledgement and retained its shell-exit notice. The test also has a
  POSIX shell path; this host validated the Windows path.
- `BenchmarkVisibilityCatchUp` compared the previous snapshot-on-change policy
  with bounded replay on the same core and a retained 2,000-line build. Five
  1,000-iteration samples on this Windows amd64 / Intel i7-8850H host used
  2,363,623 snapshot bytes versus 49 replay bytes for one short progress update.
  Median host preparation was about 506 microseconds for snapshot versus
  56 nanoseconds for the cached small replay; transient Go memory was about
  2.37 MB versus 64 bytes per attachment. This isolates preparation under the
  session lock, excluding socket setup/transfer, browser parsing/import, and
  canvas painting. It does not measure total reveal latency or build speed.
  Raw measurements remain in the ignored
  `.cache/review/terminal-visibility-replay-146/benchmark.txt` file.
- All 448 JavaScript/core tests, `go test ./...`, `go vet ./...`, web and host
  builds, syntax checks, formatting, and diff checks passed. The native artifact,
  compatibility hash, and snapshot schema are unchanged.

Replay bounds apply to resumed browser connections and their retries, while
backlog overflow and selected-but-unimported snapshots still force a snapshot.
The preceding host build honors `snapshotIfChanged=1` on visibility resumes;
older clients retain their previous host policy. Changed panes use normal
output/scrolling behavior, while idle panes keep selection and scroll position.
Restart the updated host and refresh the browser to use the new policy.
