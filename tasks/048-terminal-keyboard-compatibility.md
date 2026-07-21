# Task 048: Complete terminal keyboard compatibility

Status: complete

Complete Tessera's terminal keyboard handling for modified numpad navigation,
VT application-keypad mode, and Shift+Insert paste.

## Requirements

- Handle logical navigation actions from physical numpad keys, including
  standard xterm modifier parameters.
- Leave dedicated navigation keys on ghostty-web's existing input path.
- Honor DEC application-keypad mode 66 for unmodified numpad digits, decimal,
  Enter, operators, equal, and separator keys using standard VT SS3 sequences.
- Make Shift+Insert use the existing terminal clipboard and bracketed-paste
  path.
- Keep existing global application shortcuts unchanged.
- Keep the implementation outside `node_modules` and generated vendor bundles.

## Verification

- Run the focused terminal keyboard tests.
- Run all web tests and the complete Go test suite.
- Run the JavaScript syntax check and `git diff --check`.

## Implementation summary

- Scoped logical navigation translation to physical numpad keys and added
  standard xterm modifier parameters for modified navigation.
- Added complete unmodified VT application-keypad SS3 mappings driven by live
  DEC mode 66 while leaving dedicated keys and normal numpad text unchanged.
- Routed Shift+Insert through the existing terminal clipboard and bracketed
  paste path.
- Kept the implementation in Tessera-owned source modules without changing
  `node_modules` or generated vendor bundles.
- Passed `node --test web/*.test.mjs`, `node --check web/app.js`, `go test ./...`,
  and `git diff --check`.
