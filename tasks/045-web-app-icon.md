# Task 045: Web app and tray icon

Status: complete

Use `C:\Users\Administrator\Downloads\tessera.png` as Tessera's web
application icon and installed home-screen icon.

## Requirements

- Generate optimized 180px, 192px, and 512px PNG variants from the supplied
  source image.
- Use the new artwork for the browser favicon and Apple touch icon.
- Use the new artwork for the standard and maskable icons in the web app
  manifest so installed/home-screen launches display it.
- Preserve the source artwork's proportions and transparency while resizing.
- Ensure icon URLs invalidate previously cached icon artwork.
- Use the supplied artwork for the Windows and macOS tray/menu-bar icon.
- Package multiple Windows ICO resolutions so the tray can select a crisp size
  for the current display scale.
- Add or update focused checks for icon dimensions and manifest/HTML wiring.

## Verification

- Inspect the generated icon variants visually and verify their pixel sizes.
- Validate the manifest and HTML icon references.
- Verify the Windows ICO directory contains the expected resolutions.
- Run the relevant Go/web tests and `git diff --check`.

## Implementation summary

- Generated optimized 180px, 192px, and 512px RGB PNG variants from the
  supplied 1254px source using high-quality Lanczos resampling.
- Added a dedicated 512px maskable manifest variant using the same artwork.
- Updated the browser favicon, Apple touch icon, and web app manifest to use
  new `tessera-app-icon-*` filenames, invalidating cached legacy artwork.
- Added a multi-resolution Windows ICO and pointed the macOS tray at the new
  192px PNG artwork.
- Added embedded-asset tests covering PNG decoding and dimensions, HTML icon
  references, manifest JSON parsing, and standard/maskable icon declarations.
- Visually inspected the generated 192px icon, verified all nine ICO
  resolutions, and passed focused desktop/web/API tests, `go test ./...`, and
  `git diff --check`.
