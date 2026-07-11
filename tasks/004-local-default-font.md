# Task 004: Local default font

Status: complete

Use the local font files in `web/assets` as Tessera's default UI font.

`Swiss721Bold.ttf` is registered as the normal app face and
`Swiss721Black.ttf` is registered as the bold face. CSS, CodeMirror, and
terminal setup all use the same `Tessera Swiss` family, and the external
Cascadia Code Google Fonts request was removed from `web/index.html`.
