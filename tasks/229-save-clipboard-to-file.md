# Task 229: Save clipboard to file

Status: complete (iPad check pending)

## Request

A command palette command that takes what is on the clipboard (text, or one
or more files) and shows a save dialog for a folder on the host, with preset
buttons for Home, the temporary folder and the current folder. Then a second
command that deletes the files the last save wrote.

## Findings

- `navigator.clipboard.read()` returns only text, HTML and images; no browser
  exposes files copied in Finder or the Files app through it. A paste event or
  a drop does carry files, so the dialog accepts both.
- `uploadFile` (`internal/httpapi/file_transfers.go`, kept from the retired
  File Browser for terminal transfers) already stages beside the destination,
  refuses symlinks and non-regular targets, and replaces only on request.
  The File Browser's `/api/files/*` routes were retired with that pane, not
  for security; a signed-in browser can write anywhere through a terminal.
- `/api/directories` lists folders and Home/Desktop/Documents/Downloads; the
  active terminal's folder is `rect.cwd`, which OSC 7 keeps current.

## Changes

- `internal/httpapi/host_files.go`: `POST /api/host/files` (raw body;
  `directory`, `name`, `overwrite=1`) runs `uploadFile` and remembers each
  saved file's `os.FileInfo` (256 at most, in memory). `POST
  /api/host/files/delete` with `{"paths": [...]}` deletes only remembered
  files that are still the same file with the same size and modification
  time; others come back in `kept` with a reason.
- `internal/httpapi/directories.go`: a Temp location (`os.TempDir()`).
- `web/save-clipboard.mjs`: entries from clipboard items and from paste or
  drop, unique names, the save loop with replace confirmation, delete, the
  last save (localStorage, falling back to memory), and the dialog.
- `web/app.js`: palette commands Save Clipboard to File... and, after a save,
  Delete Last Clipboard Save... (confirms with the paths); the dialog blocks
  window shortcuts and closes with the other overlays.
- `web/styles.css`, `web/embed.go`, README, CHANGELOG. Palette tests that run
  `buildPaletteCommands` and `paneShortcutAction` get the two new globals.

## Verification

- Go: save, conflict, overwrite, bad names, missing folder, symlink target;
  delete removes an unchanged saved file and keeps an edited one and one it
  did not write, and does not delete twice.
- Node: names, clipboard parsing, paste and drop, URL, replace and skip,
  failure, delete, last-save persistence, palette visibility.
- Headless Chrome over CDP against a local server: palette opens the dialog
  with the clipboard's text, Home by default, presets with paths; a pasted
  PNG and PDF are added; Save wrote all three; a declined replace saved
  nothing; Delete Last Clipboard Save removed all three; no page errors.
  Current took the terminal's folder (following a `cd` was not exercised:
  the headless terminal did not take typed input).
- Not yet: iPadOS Safari (clipboard read prompt, pasting from Files).
