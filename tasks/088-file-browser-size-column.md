# Task 088: File browser size column

Status: complete

Add file sizes to the pane File Browser so operators can compare files without
opening them or leaving Tessera.

## Requirements

- Extend `/api/directories?files=1` entries with the byte size reported by the
  filesystem for regular file entries.
- Do not fail the entire directory listing when metadata for one entry cannot
  be read; represent that file's size as unavailable.
- Add a right-aligned **Size** column after **Type** in the existing file list.
- Display file sizes in compact IEC units (`B`, `KiB`, `MiB`, `GiB`, and
  larger as needed), preserving `0 B` for empty files.
- Leave directory size cells blank rather than showing the filesystem's
  directory-entry byte count.
- Show an em dash for a file whose size metadata is unavailable.
- Keep the existing directory-first/name ordering and selection, keyboard,
  opening, upload, and file-operation behavior unchanged.
- Keep long names truncated and make the numeric size column stable with
  tabular, right-aligned digits.

## Verification

- Add Go coverage for file, empty-file, directory, and unavailable metadata.
- Add browser-unit coverage for byte formatting, unit boundaries, invalid
  values, and directory display.
- Run `node --check web/app.js`, `node --test web/*.test.mjs`, `go test ./...`,
  and `git diff --check`.

## Implementation

- Directory entries now carry a nullable byte size. Per-entry `Info` failures
  leave that value unavailable without failing the surrounding directory.
- The browser uses a tested IEC formatter and renders a fixed, right-aligned
  Size column while preserving the existing row behavior and ordering.
- Exact bytes remain available as the size cell's tooltip.

Verification completed: all 149 browser tests passed, all Go tests passed, the
app syntax and embedded-module checks passed, and `git diff --check` reported no
whitespace errors.
