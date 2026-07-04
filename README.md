# Tessera

Tessera is being built in small steps toward a local, text-first computer workspace. The current first screen is a blank browser workspace where rectangles can be drawn, moved, and resized with the mouse.

## Run

```powershell
npm install
npm run build:web
go run ./cmd/tessera
```

Then open:

```text
http://127.0.0.1:7331
```

Useful flags:

```powershell
go run ./cmd/tessera -addr 127.0.0.1:7331 -db .\tessera.sqlite3 -web .\web
```

## MVP

- Blank full-window workspace.
- Drag empty space to draw a rectangle.
- Drag a rectangle to move it.
- Drag a selected rectangle's corner handles to resize it.
- Hold `Shift` while drawing or resizing to constrain to a square.
- Each rectangle has an attached BeOS-like top tab with a transparent editable title field.
- Type directly inside a rectangle to use it as a CodeMirror-backed text workspace.
- Click or arrow into empty editor space to materialize free-cursor whitespace.
- Press `Ctrl+Enter`/`Cmd+Enter`, or right-click the editor and choose Run, to run the selected text or current line through the Go shell and insert output below it.
- Transcript insertion is plain text: commands remain editable, stdout and stderr insert below at the command's indentation with no prompt prefix, and `[exit N]` appears only when there is no command output or the exit code is nonzero.
- Each pane has a small `cwd` status field; click it to browse for a directory, and commands such as `cd ..` update it after execution.
- Right-click inside a rectangle's editor to copy, cut, or paste selected text.
- Clicking a rectangle brings it above overlapping rectangles.
- The active pane is explicit, saves to SQLite, restores on refresh, and can be cycled with `F6` or `Alt+\``.
- Right-click the top-left tab grip to dock, restore, or destroy a rectangle.
- Pane geometry, z-order, title, and text save to SQLite and reload on refresh.
