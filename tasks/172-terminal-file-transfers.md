# Terminal file transfers and File Browser retirement

Status: implemented and verified (Mac manual verification pending)

Implement the approved terminal file protocol v1, host-local batch transfers,
controlling-terminal Go helper, live browser claims and streaming HTTP delivery.
Retire File Browser panes by converting them to terminals, preserving layout
and directories. Keep Worksheet/Text Editor host file pickers.

Validation: protocol fragmentation/cancellation and snapshot safety; transfer
claims, cancellation, timeouts, uploads and ZIP downloads; helper console
restoration; migration/import compatibility; Go/JS suites, shared-core rebuild
and reproducibility, supported helper builds and available browser smoke tests.


Implemented:
- Private OSC v1 with bounded native file effects and host-only replies; browser
  effects/responses are discarded, including snapshots and split ST restoration.
- Host-local Go helper, controlling-console IO, JSON results and console cleanup.
- Epoch-scoped live invitations, one browser claim, bounded listener queues,
  temporary uploads, progress/cancellation, original or streamed ZIP downloads.
- Inert same-origin download target preserves origin validation, main app frame
  restrictions and credential redaction. Native macOS navigation policy recognizes
  the new target and ticket form while denying opaque-origin API access.
- Migration 045 converts saved/imported File Browser panes to terminals and
  invalidates affected stale saves. Pane IDs, directories and layout remain;
  Worksheet/Text Editor host file pickers and APIs remain.
- Four release helper assets, protocol/install documentation and smoke harness.

Verification:
- Full Go suite and go vet pass; JavaScript suite passes (556 tests).
- Shared WASM rebuild and reproducibility check pass; browser bundle rebuilt.
- Helper cross-builds pass: Linux amd64/arm64, macOS arm64, Windows amd64.
- Real app + PTY/helper + two-browser smoke passes in Chrome 154, Edge 154,
  Firefox 153: capability exchange, redirected stdout, batch upload, original/ZIP
  download, hidden invitations, visibility handoff and independent decline.
- Parser splits/cancellation, malformed/oversized metadata, snapshots, claims,
  deadlines/limits, upload conflicts/partial bodies/cancellation, native policies
  and migration/import preservation have automated coverage.
- Safari and the native macOS preview cannot be run on this Windows host and
  remain explicit manual verification items. Native Objective-C compilation
  requires the existing macOS build environment.

Existing uncommitted task 171 release-compatibility changes are preserved.
No release, commit or push was performed; CI publishes helpers on the next tag.
