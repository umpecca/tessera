# Task 216: Ship the screensaver module

Status: complete

## Request

Fix the two Go test failures about `screensaver.mjs`, which had been left
since task 200.

## Findings

- `web/app.js` imports `./screensaver.mjs` (task 200), but `web/embed.go`
  did not list it, so built binaries didn't contain it.
- `TestAppModuleImportsAreEmbedded` and
  `TestEveryShippedModuleImportIsVersionedAndResolves` caught this and had
  failed ever since, hiding any other failure in those packages.
- It broke more than the screensaver. A binary serving its embedded files
  answers `/screensaver.mjs` with `index.html` as `text/html` with `nosniff`,
  so the import fails and `app.js` never runs: the page doesn't start. Serving
  from disk with `-web ./web`, as in development and the live checks of tasks
  204–215, hides it. Checked with binaries built with and without the fix:
  `text/html` and the index page before, `text/javascript` and the module
  after.

## Changes

- `web/embed.go`: embeds `screensaver.mjs`.

## Validation

- `go test ./...` passes, with no failures left.
- A binary built without `-web` serves `/screensaver.mjs` as JavaScript.
