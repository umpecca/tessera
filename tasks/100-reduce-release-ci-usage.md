# Task 100: Reduce release CI usage

Status: complete

The user approved consolidating duplicated release-tag CI while retaining the
terminal core's reproducibility guarantee.

## Requirements

- Run the pinned Zig/Ghostty WASM reproducibility check before release work.
- Keep the generated web-bundle comparison and Node terminal/frontend tests.
- Remove the separate Windows/macOS terminal integration matrix because the
  release build matrix already covers those operating systems.
- Build and verify the committed browser bundle once instead of reinstalling
  Node and regenerating the same bundle in every native binary job.
- Run the full Go suite on Linux amd64, Windows amd64, and macOS arm64.
- Compile Linux arm64 without repeating the architecture-independent Go suite.
- Do not publish a release or start costly build jobs when terminal-core
  verification fails.
- Keep the installer test and artifact cleanup.
- Do not reuse LAME binaries across releases without a cache key that captures
  the source, patches, build flags, toolchain, OS, and architecture.

## Implementation

Terminal-core verification now runs as the first job in `release.yml`. Every
build, encoder, source, and installer job depends on it, and release publication
continues to depend on all artifacts and tests. The duplicate
`terminal-core.yml` workflow was removed. The release matrix carries an explicit
test flag so Linux arm64 compiles without rerunning the full Go suite. Native
binary jobs consume the browser artifacts already checked and committed by the
terminal-core gate, so they no longer install Node or rebuild those files.

The existing LAME builds remain unchanged. GitHub Actions caches are scoped in
ways that make reuse between independent tag refs unreliable, and reusing a
previous release asset without a complete build fingerprint could silently ship
a stale encoder.

## Verification

- Parse all workflow YAML files.
- Confirm every release-producing job is gated by terminal-core verification.
- Run the local frontend/terminal and Go test commands affected by the workflow.
