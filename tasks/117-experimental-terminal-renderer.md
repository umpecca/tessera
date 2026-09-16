# Task 117: Make the plain-row renderer experimental

Status: complete

Restore Ghostty's renderer as the default terminal rendering path. Add a
per-browser Performance setting that can enable the uniform plain-ASCII row
fast path for comparison and further development. Apply changes to open and
new terminal panes immediately, expose the selected renderer in Compatibility
diagnostics, and retain the setting only in that browser so different devices
can use different renderers.

Validate the default and opt-in renderer paths, runtime switching, the frontend
suite, the production web build, Go tests, and embedded asset checks.

Implemented a browser-local Stable/Experimental selector under Settings →
Performance. Stable terminals inherit Ghostty's original `renderLine` method
without a wrapper on the paint path. Experimental terminals opt into the
plain-row method per instance, and open terminals switch immediately with a
full redraw. Compatibility diagnostics report the active renderer.

Validation:

- `node --test web/*.test.mjs`
- `npm run build:web`
- `go test ./...`
- Live browser check of the default, both selector values, diagnostics, and
  restoring Stable mode
- `git diff --check`
