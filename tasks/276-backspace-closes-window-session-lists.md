# Task 276: Backspace closes the Window and Session lists and the palette

Status: implemented, awaiting browser check (2026-11-15).

## Request

Pressing Backspace while the Window List or Session List is open should
dismiss it, as Escape does.

## Scope

- `web/window-list-view.mjs` and `web/session-list-view.mjs`: plain Backspace
  (no modifiers) closes the list like Escape. Neither list has a text field, so
  Backspace has no other meaning there. During a window-list drag, Backspace is
  swallowed as before (only Escape cancels the drag).
- Follow-up (same day, user request): in the command palette, plain Backspace
  closes the palette only when the search field is already empty. A held
  (repeating) Backspace that has just emptied the field does not close it, and
  IME composition is ignored as before.
- Update `docs/workspace.md` and `CHANGELOG.md`.
- Approval: the user asked for exactly these changes, the lists first and the
  palette as a follow-up, and directed them (2026-11-15).

## Acceptance criteria

- [x] Backspace closes the open Window List and Session List.
- [x] Modified Backspace (Ctrl/Alt/Meta/Shift) does not close them.
- [x] Escape still closes both.
- [x] Backspace in the command palette's empty search field closes the palette;
      with text, it edits the text; repeated or modified Backspace does not close it.

## Verification

- `node --test web/session-list.test.mjs web/window-order.test.mjs web/window-list-drag.test.mjs`:
  19 pass. The existing keyboard tests for both lists now also check that plain
  Backspace closes the list (and is prevented) and that Ctrl/Meta/Alt/Shift+Backspace
  do not.
- `node --test web/command-palette.test.mjs`: 4 pass, including the new
  empty-field Backspace test (text present, repeat, modifiers, composition).
- `node --test web/*.test.mjs`: 1071 pass, 0 fail (after the palette follow-up).
- Mocked handler tests only; not checked in a real browser or on the iPad.

## Implementation notes

- `handleWindowListKeyboard` and `handleSessionListKeyboard` treat plain Backspace
  like Escape. The window-list drag branch still runs first, so Backspace during a
  drag stays swallowed.
- `handlePaletteKeyboard` (`web/command-palette.mjs`) closes the palette on
  plain, non-repeating Backspace with an empty input.
- Docs: `docs/workspace.md`, `CHANGELOG.md`.
