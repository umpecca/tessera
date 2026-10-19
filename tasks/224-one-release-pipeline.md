# Task 224: One pipeline builds everything for every platform

Status: complete (first tagged run pending)

## Request

One pipeline that builds everything needed for every supported platform,
so there's no doubt that a release contains what the source says. The user
chose the current four server platforms (Linux amd64 and arm64, macOS
Apple silicon, Windows amd64) and to keep running only on tags (task 183).

## Findings

- The release binaries embedded the committed generated files. CI rebuilt
  the terminal core and compared it, and rebuilt the browser bundles but
  compared only `terminal.js` and `terminal-opus.js`; `vnc.js`, the noVNC
  licences and the clipboard extension package (`web/extensions/`) were
  rebuilt and never compared, so a stale committed copy would have shipped.
- The JavaScript tests ran from a fixed list of folders; a test elsewhere
  would have been skipped.
- The release job downloads every artifact into `dist/`, which would now
  include the generated files.
- The native Apple app isn't one of the chosen platforms and stays a manual
  build (`apple/build-ipa.sh`).

## Changes

- `.github/workflows/release.yml`:
  - `assets` (replacing `terminal-core`): builds the core
    (`npm run build:terminal-core`) and everything `npm run build:web`
    generates, fails if the tree then differs from the commit in any way
    (`git diff --exit-code`, and nothing untracked), runs every
    `*.test.mjs` outside `node_modules` and `.cache`, and uploads the core,
    `web/vendor/` and `web/extensions/` as `generated-assets`.
  - `build`: downloads `generated-assets` over the checkout before testing
    and building, so each binary embeds what `assets` built.
  - `release`: downloads only `tessera-*` artifacts.
- `README.md` (releases), `docs/terminal-core.md`, `CHANGELOG.md`.

## Validation

- The workflow parses (Ruby's YAML): jobs `assets`, `build` (needs
  `assets`), `installer-test` (needs `assets`), `release` (needs both).
- Locally, rebuilding the core and running `npm run build:web` left every
  file in `internal/terminalcore/ghostty-vt.wasm`, `web/vendor/` and
  `web/extensions/` byte-identical, so the new check passes on the current
  files.
- The full JavaScript suite (the same `find`) passes: 739. `go test ./...`
  passes.
- Not yet run on GitHub: the first `v*` tag after this commit is its first
  run. The core build there is on Ubuntu, here on macOS; earlier tagged
  runs compared the two successfully.
