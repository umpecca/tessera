# Task 037 — Terminal clickable links

Status: complete

Make web addresses printed in Terminal panes directly usable for browser-based
login and authorization flows on the computer running the Tessera client.

## Behavior

- Detect plain-text `http://` and `https://` URLs in Terminal output.
- Visually identify a detected link on hover and open it in a new browser tab
  on the client system when the user Ctrl-clicks it (Cmd-click on macOS).
- Preserve normal terminal selection and mouse-input behavior when the modifier
  is not held.
- Treat a URL soft-wrapped by the terminal renderer as one continuous link,
  without inserting display-padding spaces or line breaks into the opened URL.
- Continue a wrapped URL only across terminal rows marked as soft-wrapped; do
  not join URLs across explicit newlines.
- Exclude trailing sentence punctuation from detected URLs while retaining URL
  punctuation that is part of the address.
- Open links with opener isolation and accept only browser-safe HTTP(S) targets
  from plain-text detection.

## Verification

- Test a one-line authorization URL and confirm Ctrl/Cmd-click opens the exact
  address in a new client-side browser tab.
- Test a URL wrapped across two or more terminal rows and confirm every segment
  activates the complete address with no inserted whitespace.
- Confirm an explicit newline does not merge adjacent text into a URL.
- Confirm trailing punctuation is excluded and non-HTTP(S) text is not opened.
- Build the web bundle and run the repository test suite.

## Implementation summary

- Added a terminal link provider that detects browser-safe HTTP(S) addresses,
  validates them without rewriting the displayed address, and opens them in a
  new client-side tab only on Ctrl-click or Cmd-click.
- Reconstructs logical terminal lines from rows marked as soft-wrapped and
  gives each visible row segment an activation range for the complete URL. No
  newline or display-padding separator is inserted into the target.
- Keeps explicit newlines as URL boundaries, excludes trailing sentence
  punctuation, and preserves balanced parentheses used inside addresses.
- Reserves Ctrl/Cmd-modified clicks from terminal mouse-reporting mode so TUI
  applications cannot consume the link gesture; unmodified terminal mouse
  input remains unchanged.
- Added focused tests for modifiers, exact target preservation, multi-row
  wrapping, hard-newline boundaries, punctuation, and protocol filtering.
- Rebuilt the committed terminal bundle and confirmed the provider export.
- Passed `node --test web/*.test.mjs`, `go test ./...`, and `go vet ./...`.
