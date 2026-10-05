# Disable browser writing assistance on terminals

Status: complete.

## Request

Remove the blue writing-assistance marker that Edge shows when hovering near
the top-left corner of an Operator terminal window.

## Implementation

- Mark the terminal input container with `spellcheck="false"`,
  `writingsuggestions="false"`, `autocorrect="off"`, and
  `autocapitalize="off"` before Ghostty makes it editable.
- The hidden clipboard/input textarea already disables spellchecking and
  inherits the terminal container's writing-suggestions setting.
- Disable writing suggestions on window title fields as well. Preserve title
  renaming, terminal keyboard input, and clipboard handling.

## Validation

- Real Microsoft Edge browser check: the editable terminal container and its
  hidden textarea both report writing suggestions disabled and spellchecking
  disabled. Window title renaming and terminal command entry still work; an
  `echo` command produced its expected output. Hovering the corner left the
  rendered window clear of the marker in the review screenshot.
- All 20 Operator and terminal-selection regression tests pass.
- `node --check web/app.js`, `go test ./web`, and `git diff --check` pass.
- Review used a fresh automated Edge profile; the user's existing browser
  profile should be checked after loading the updated frontend.
