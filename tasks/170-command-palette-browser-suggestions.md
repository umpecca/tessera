# Disable browser suggestions in the command palette

Status: completed

Opt the command palette input out of browser autocomplete, autocorrection,
and writing suggestions to suppress Edge's personal-info/writing popups.
Keep Tessera's command filtering and keyboard selection intact.

Use explicit input attributes, following the existing writing-suggestion opt-out
on window titles and terminal input. Validate JavaScript syntax and the existing
command palette tests.

Implemented `autocomplete="off"`, `autocorrect="off"`, and
`writingsuggestions="false"` on the existing input. JavaScript syntax,
all 21 command wheel/palette tests, and diff whitespace checks pass.
Edge's popup against the user's saved personal information was not reproduced
in an isolated browser profile.
