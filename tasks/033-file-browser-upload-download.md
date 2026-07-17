# Task 033 — File Browser upload and download

Status: complete

Add streamed host-file upload and download actions to File Browser panes while
retaining Tessera's existing localhost, intranet, origin, rate-limit, and audit
behavior.

## Server API

- Add `GET /api/files/download?path=...` for regular files. Stream through
  `http.ServeContent` so large files and byte-range requests do not load into
  memory, and send a safe attachment filename through `Content-Disposition`.
- Add `POST /api/files/upload?directory=...&name=...&overwrite=0|1`. Treat the
  request body as the raw file stream so the browser can report upload progress
  without multipart buffering.
- Require a single base filename: reject empty names, `.`, `..`, separators,
  absolute paths, directories, symlinks at the destination, and missing/non-
  directory destination folders.
- Stage each upload in a temporary file inside the destination directory, close
  it successfully, and only then move it into place. Clean temporary files on
  cancellation, size rejection, or any other failure.
- Return `409 Conflict` when the destination exists and overwrite was not
  approved. When approved, replace a regular file while preserving the old file
  if final placement fails.
- Add `-max-upload-size` as a byte count, defaulting to 1 GiB. Reject oversized
  declared bodies before copying and enforce the same limit while streaming.
- Keep upload/download paths subject to the existing security middleware.
  Persistent audit records may include the endpoint path and result but never
  query parameters, filenames, or file contents.

## File Browser UI

- Add **Upload** and **Download** toolbar buttons.
- Let Upload select multiple local files and upload them sequentially into the
  current folder with per-file progress shown in the pane.
- Support dropping browser files onto the folder-content area using the same
  upload flow.
- On a `409`, ask for overwrite confirmation for that file and retry only that
  file with explicit overwrite approval.
- Enable Download only for a selected regular file and initiate a native browser
  attachment download without reading the file into JavaScript memory.
- Refresh the folder after successful uploads and show failures through the
  existing workspace/pane status language.

## Verification

- Test download bytes, attachment headers, range handling, and rejection of
  missing paths/directories.
- Test upload streaming, size limits, invalid names, conflict handling,
  overwrite replacement, and temporary-file cleanup.
- Test the new CLI/default option wiring.
- Run `node --check web/app.js`, `go test ./...`, `go vet ./...`, and
  `git diff --check`.

## Documentation

Update `README.md`, `ARCHITECTURE.md`, and `CHANGELOG.md` with the transfer
behavior and upload-size setting.

## Implementation summary

- Added streamed raw-body uploads with a configurable 1 GiB default limit,
  filename validation, staged same-directory placement, conflict responses,
  rollback-aware overwrite replacement, and temporary-file cleanup.
- Added attachment downloads through `http.ServeContent`, including byte-range
  support and safe `Content-Disposition` filenames.
- Added File Browser Upload and Download controls, multi-file sequential
  progress, drag-and-drop, overwrite confirmation, selection-aware button
  state, and folder refresh after successful transfers.
- Added endpoint and server-wiring tests covering bytes, ranges, headers,
  invalid targets, limits, conflicts, replacement, and cleanup.
- Verified the rendered File Browser controls in a live browser and ran the
  frontend checks, `go test ./...`, `go vet ./...`, and `git diff --check`.
