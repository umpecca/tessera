# Read the terminal viewport once per paint

Status: complete.

## Request

Implement terminal performance improvement #1: avoid rereading and decoding the
entire viewport for each row painted.

## Requirements

- Reuse one lazy viewport read across a complete synchronous paint, including
  Sixel neighbor rows, selection, cursor, and hover rendering.
- Preserve row copies, scrollback reads, and the pinned reader's behavior.
- Restore the original reader after successful and failed paints. Each later
  frame, output change, resize, screen switch, reset, or snapshot must see fresh
  state. Keep terminals independent and avoid persistent stale cell caches.
- Verify both renderers with real browser comparisons and measure full and
  partial paints for ordinary output and visible images.

## Validation

- All 475 JavaScript/core/clipboard extension tests passed. Seven new regressions
  use the pinned Ghostty reader and real WASM to verify one live viewport read,
  independent row/cell copies, fresh output/geometry/screens/reset/snapshot
  handles, history scratch-buffer reuse, native memory growth, lazy idle and
  history-only frames, failure recovery, independent nested terminal paints,
  own/inherited reader restoration, and idempotent installation.
- Headless Chrome compared 81 states in each Stable/Experimental mode at 1x,
  2x, 1.25x, and 1.5x resolution. All 1,296 initial and forced-full canvas hashes
  matched the previous bundle. Coverage includes ordinary full/dirty output,
  ANSI/graphemes, hyperlinks and hover scans, selection, cursor shapes/blink/hide,
  image transparency/overlap/eviction/placeholders, mixed history/live viewports,
  resizing/screens, native memory growth, snapshot replacement, and reset.
- Fifteen paired, frame-paced Chrome measurements used equally visible
  160-column x 60-row canvases at 2x resolution, alternated before/after order,
  and measured 40 updates after five warmups in each terminal. Full paints kept
  all 60 text rows but reduced native viewport transfers from 60 to 1 and cell
  decodes from 576,000 to 9,600. Ordinary partial paints reduced reads from 2 to 1;
  visible-image partial paints reduced them from 3 to 1. Final canvases matched
  in all pairs.

  Median of the three measured medians, in milliseconds:

  | Paint | Before | After |
  | --- | ---: | ---: |
  | Stable full text | 28.5 | 15.0 |
  | Experimental full text | 21.3 | 7.6 |
  | Experimental full image | 21.2 | 7.8 |
  | Experimental partial text | 2.8 | 1.9 |
  | Experimental partial image | 3.0 | 1.8 |

  Experimental full-text 95th-percentile times were 22.8->9.1, 22.5->9.2, and
  23.4->10.0 ms. Stable and image full-paint tails also improved in these runs.
  These measurements cover synchronous viewport reading and painting, excluding
  output parsing, network, and total frame presentation latency. They do not
  predict build speed or gains for a terminal that already reads only one row.
  The initial burst harness had overlapping canvases with unequal compositor
  visibility and large timing stalls, so the final measurements use equally
  visible canvases and one update pair per animation frame. Both raw sets and
  the harness are retained under the ignored
  `.cache/review/terminal-viewport-read-148/` directory.
- `go test ./...`, `go vet ./...`, the web/host builds, JavaScript syntax checks,
  and diff checks passed. The native artifact, compatibility hash, and snapshot
  schema are unchanged.

## Implementation

Install a small render wrapper outside the Sixel renderer so a complete paint,
including its neighbor-row pass, lazily shares the existing decoded JS cell pool.
Keep Ghostty's normal per-row copies and separate history reader. Cache no WASM
views, retain no cache across frames, and restore the original reader in `finally`
so selection/link reads outside painting remain fresh and errors can retry.

The browser bundle and `bin/tessera.exe` are rebuilt. Restart the updated host
and refresh the browser to use the change.
