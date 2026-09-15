# Task 105: Prompt Firefox users to install the clipboard extension

Status: complete

When Tessera runs in Firefox without its clipboard bridge, guide users who need
the extension to the embedded installer and instructions.

## Requirements

- Recommend the extension for Firefox 115 ESR and older.
- Also recommend it in newer Firefox when the current connection lacks the
  native Clipboard API.
- Do not show the prompt in non-Firefox browsers, when the bridge is connected,
  or in newer Firefox with working native clipboard features.
- Open Settings at the Clipboard section from the prompt.
- Allow the user to snooze the reminder for one day.

## Implementation

- Added a tested browser and capability recommendation helper.
- Added a compact, responsive setup prompt that appears after bridge discovery.
- Bridge checks on page startup and window focus hide the prompt as soon as the
  extension is installed and authorized.
- Added direct navigation and focus to Settings → Clipboard.

## Verification

- `npm run build:web`
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`
  (225 tests passed)
- `go test ./...`
- `git diff --check`
