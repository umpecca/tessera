# Task 259: Add five application fonts

Status: implementation and automated verification complete (2026-11-11);
physical-device review remains deferred.

## Request

Add Hack, Cascadia Code, Iosevka, Victor Mono and Inconsolata to the application's
font list. Inconsolata was explicitly added by the user during this task.

## Scope

- Bundle official font assets and upstream licenses for local/offline use,
  supporting regular and bold weights like the existing application fonts.
- Add stable font IDs and CSS font faces to the existing Settings font registry;
  preserve the default, saved preferences, symbol fallback and refit behavior.
- Use the standard Iosevka family, not a separately named variant.
- Add regression coverage for selection, loading, assets and preferences; verify
  actual browser font loading and terminal metrics where available.
- Update font documentation and CHANGELOG. Existing test-server static files
  expose frontend changes, but backend normalization needs an update too. Defer
  any test-server restart until approved rather than interrupt active sessions.
- Approval: the user explicitly requested the original four fonts and then
  directed adding Inconsolata to the same list.

## Acceptance criteria

- [x] All five fonts appear with correct labels and stable IDs in Settings.
- [x] Local regular/bold faces load with licenses/provenance; no CDN dependency.
- [x] Font selection persists and uses existing interface/terminal loading and
  refit paths, preserving the current default and symbol fallback.
- [x] Relevant tests, build and browser checks pass; manual/device limits recorded.
- [x] Product documentation and changelog describe the additions.

## Verification

- `node --test web/terminal-font.test.mjs web/terminal-font-coverage.test.mjs
  web/settings-font.test.mjs`: 38 passed.
- Full web test suite: passed (recorded alongside task 260).
- `go test ./internal/store ./web`, `go test ./...`, `go vet ./...`,
  `npm run build:web` and whitespace checks: passed.
- Actual Chromium 158.0.8127.18 / WebKit 27.2 smoke: all five Settings options
  dispatch the correct IDs; normal/bold load as distinct real 400/700 faces,
  with matching monospace advances. Production terminal instances render ASCII,
  bold and representative Unicode/symbol text with valid metrics. No external
  font request occurred. This is automated desktop-browser evidence, not a
  visual acceptance claim for every glyph or a physical iPad test.
- The complete Chromium `scripts/frontend-smoke.mjs` passed against an isolated
  latest-code binary/database. All five font choices save successfully, update
  visible interface text and the terminal canvas, preserve size behavior and
  survive existing theme/save/reload checks. Desktop/phone storage tests guard
  backend normalization/persistence; default font remains JetBrains Mono.

## Implementation notes

- Task created before implementation. Added five registry IDs, ten local normal
  regular/bold faces, CSS registrations and five original upstream license files.
- Pinned upstreams: Hack v3.003; Cascadia Code v2407.24 (Code, not Mono/PL/NF);
  Iosevka v34.9.1 standard family; Victor Mono v1.5.6; Inconsolata v3.000 standard
  width. All font bytes are unmodified. No subsetting/conversion/CDN dependency.
- Cascadia and Iosevka WOFF2 files were extracted from their official release ZIPs
  using HTTP ranges with ZIP CRC validation, avoiding downloads of all variants.
  Other assets and licenses come directly from the tagged upstream repositories.
- `docs/development.md` records exact archive paths, versions and licenses.
  Hack retains both MIT and Bitstream Vera notices; the other four use OFL-1.1.
- Updated `internal/store/session.go`'s font allowlist as well as the frontend:
  otherwise the server would silently normalize new saved IDs to the default.
  Added desktop/phone persistence and embedded-font/license asset coverage.
- Existing loaders/refit, preferences and symbol fallback are reused. As with
  other normal-only bundled faces, italic styling uses browser synthesis; this
  task does not add ligature shaping to the cell-by-cell terminal renderer.
- Updated `docs/terminal.md`, `docs/development.md` and `CHANGELOG.md`.
- After the user explicitly approved restarting, replaced only the port-7333
  test process with the verified final binary, retaining its database, web path,
  auth configuration and allowed host. Its login page returns HTTP 200; the main
  port-7331 process is unchanged. No authenticated user settings were changed by
  the restart check.

## Remaining manual checks

- Physical iPad Safari/native WKWebView font switching, sizing and subjective
  appearance; check your usual Unicode/symbol workload and preferred font sizes.
- Reload the app before reviewing font persistence on the restarted test backend.
  No commits or pushes were made.
