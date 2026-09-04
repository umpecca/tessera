# Task 092: Sixel memory controls

Status: complete

The user approved addition #4: per-terminal image-memory budgets, clearing
retained images without changing text/cursor state, and optional eviction
placeholders. This approval satisfies the develop-code confirmation step.

- Add 16/32/64 MiB choices and a placeholder toggle to the terminal menu.
- Default to 64 MiB and visible eviction placeholders.
- Apply changes on the host in the ordered event stream and replicate them to
  all browsers. Preserve settings and placeholder attachments in snapshots.
- Clear images on both screens and in history, including an image being
  received. Keep text, cursor, palette, shell input, and subsequent images intact.
- Lowering the budget evicts oldest decoded images immediately. Placeholder
  metadata remains bounded by the existing cell-fragment limit.
- Settings belong to the running shell and do not require a database migration.
- Verify native behavior, snapshots/replay, browser rendering, and menu actions;
  rebuild matching WASM/JavaScript artifacts and document the controls.

Validation: all 186 native/frontend JavaScript tests and `go test ./...` pass.
Added shared-event/replay coverage and renderer eviction/marker/cache checks.
Verified menu settings across two browser replicas, fresh-browser restoration,
and clearing visible images in both replicas while retaining surrounding text.
Windows and Linux amd64 builds pass. A fresh pinned source checkout rebuilt
the bundled WASM byte-for-byte with Zig 0.15.2. Snapshot schema is now TSS2;
clients must reload the matching build.
