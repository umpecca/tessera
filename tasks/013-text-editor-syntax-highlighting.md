# Task 013: Text-editor syntax highlighting

Status: complete

When a text-editor pane opens a file, detect its extension and apply a
CodeMirror language extension only when Tessera has bundled support for that
language. Leave unknown or unsupported file types as plain text.

Keep worksheet editing behavior unchanged. Reconfigure highlighting whenever a
text-editor pane opens a different file, and add focused checks for extension
to language selection.
