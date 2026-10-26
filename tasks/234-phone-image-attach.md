# Task 234: Phone image attach

Status: complete (iPhone check pending)

## Request

Send images from the phone to a terminal, mainly so a Claude Code prompt
written in the phone view can include a photo or screenshot.

## Findings

- Image paste (task 228) puts an image on the host's clipboard and sends the
  program its paste key. That needs Tessera in the desktop session (a
  background service has no clipboard) and nothing on the phone shows what
  was sent.
- Claude Code also reads images from a path in the prompt, which works
  wherever Tessera runs and stays visible and editable in the compose field.
- `uploadFile` (Save Clipboard to File, task 229) already writes a file into
  a host folder with a size limit, staging beside the destination and no
  following of links; it needs an existing folder and a name.
- The system temporary folder is shared on Linux, where another account
  could create a predictable folder or link there first. The user cache
  folder (where shell integration keeps its scripts) is the account's own.
- With the theme's monospace font (the fix after task 233), a textarea's
  intrinsic width pushed Send off a 390 px screen; found by the browser
  check below.

## Changes

- `internal/httpapi/attachments.go`: `POST /api/host/attachments?name=`
  saves the body under `<user cache>/tessera/attachments` (created 0700,
  refused if not a folder) through `uploadFile`, named
  `YYYYMMDD-HHMMSS-<4 hex>-<stem>.<ext>` from a shell-safe part of the
  phone's name (letters, digits, `.`, `_`, `-`; at most 40), answers
  `{ "path" }`, and removes attachments older than a week on each upload.
  Routed in `api.go`, behind sign-in and the origin check like other routes.
- `web/phone-input.mjs`: **📎** opens the phone's picker (images, several at
  once); an image pasted into the field without text does the same. Each is
  uploaded and its path inserted at the cursor, set apart by spaces
  (`insertAttachmentPath`). A notice above the input says what happened;
  for a single image it offers **Paste as image instead**, which takes the
  path out again (`removeAttachmentPath`) and pastes through the host's
  clipboard. Sending clears the notice.
- `web/app.js`: `uploadPhoneAttachment`, `pastePhoneImage` (the clipboard
  write and paste keys of task 228).
- `web/styles.css`: notice; the compose field takes only the room the
  buttons leave.
- `README.md`, `CHANGELOG.md`, `ARCHITECTURE.md`.

## Validation

- `internal/httpapi/attachments_test.go` (`-race`): names for photos,
  spaces and brackets, a path-like name, a Windows path, nothing, shell
  syntax, a long name, two in one second; the upload is stored byte for
  byte and a week-old one removed; size limit; method; the folder is under
  the account's home and private.
- `web/phone-input.test.mjs`: inserting at the cursor, between words and
  over a selection; removing again; the button opening the picker; a
  picked image's path in the field without sending; Paste as image instead;
  a pasted screenshot, text winning over an image, two images; a refused
  upload; the notice going away.
- Full JavaScript suite: 794 pass. `go test ./...`, `go vet ./...` and
  `git diff --check` pass.
- Real host, built binary, headless Chrome at 390×844 with touch: a PNG
  picked through the file input was stored in
  `~/Library/Caches/tessera/attachments` identical to the original, `file
  <path>` sent from the compose field reported `PNG image data, 64 x 48`,
  and the notice cleared; the compose row fits with Send on screen.
- Not tried: an iPhone (photo library, camera, HEIC conversion, pasting a
  screenshot), and Paste as image instead against the real clipboard,
  which would have replaced this Mac's clipboard.
