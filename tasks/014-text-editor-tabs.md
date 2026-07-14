# Task 014: Text-editor file tabs

Status: complete

Allow one text-editor pane to keep multiple files open as tabs.

- Opening a file from a text editor adds or activates its tab instead of
  replacing the current document.
- Each tab retains its path, text, selection, and syntax language state.
- Selecting a tab swaps the visible CodeMirror document; closing a tab does
  not delete the underlying file.
- Save applies to the active tab, and opening an already-open path activates
  its existing tab.
- Persist tab state with the text-editor pane while leaving worksheet behavior
  and file-browser panes unchanged.
