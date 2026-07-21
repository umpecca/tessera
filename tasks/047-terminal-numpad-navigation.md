# Task 047: Terminal numpad navigation

Status: complete

Complete the terminal logical-key fallback for navigation actions produced by
the numeric keypad when Num Lock is off.

## Requirements

- Numpad Insert and Delete send the same terminal input as their dedicated
  navigation keys when Num Lock is off.
- Numpad Up, Down, Left, and Right send the correct cursor sequences, including
  application-cursor mode behavior.
- Numpad Clear/5 sends the standard terminal center/begin sequence when exposed
  as a logical navigation key by the browser.
- Num Lock-on digits and decimal input remain unchanged.
- Modified keys, dedicated navigation keys, application shortcuts, and
  non-terminal panes retain their existing behavior.
- Add focused regression coverage for physical numpad codes paired with their
  logical navigation keys.

## Verification

- Run the focused terminal keyboard tests.
- Run the complete web test suite and relevant repository tests.
- Run `git diff --check`.

## Implementation summary

- Extended the logical-key fallback to cover Insert, Delete, Clear/5, and all
  four cursor keys produced by the keypad when Num Lock is off.
- Preserved normal CSI cursor sequences and application-cursor SS3 sequences by
  reading the live terminal cursor mode.
- Kept Num Lock-on digits and decimal input, modified combinations, application
  shortcuts, and non-terminal panes on their existing paths.
- Added focused regression coverage and passed `node --test web/*.test.mjs`,
  `node --check web/app.js`, `go test ./...`, and `git diff --check`.
