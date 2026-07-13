# Tessera

Tessera is being built in small steps toward a local, text-first computer workspace. The current first screen is a blank browser workspace where rectangles can be drawn, moved, and resized with the mouse.

## Run (web server)

```powershell
go run ./cmd/tessera
go run ./cmd/tessera -addr 0.0.0.0:7331
```

Then open:

```text
http://127.0.0.1:7331
```

The SPA is embedded in the binary, so the server runs from any directory.
`npm install` and `npm run build:web` are only needed when the frontend
dependencies change (the bundles in `web/vendor/` are committed).

### Install on an iPad (home screen)

Tessera ships a web app manifest and icons, so it installs as a standalone
app. Start the server bound to your LAN (`-addr 0.0.0.0:7331`), open the
machine's address (e.g. `http://192.168.1.20:7331`) in **Safari** on the iPad,
then **Share → Add to Home Screen**. Launching from the home screen opens it
full-screen with no browser chrome. The bottom-right command button replaces
right-click on touch, and the compact bottom-right window button opens the
Deskbar; drag to draw panes, tap the tab grip for pane actions, and double-tap
a title tab to minimize it.

Useful flags:

```powershell
go run ./cmd/tessera -addr 127.0.0.1:7331 -db .\tessera.sqlite3 -web .\web
```

`-web .\web` serves the SPA from disk instead of the embedded copy, so
frontend edits show up on reload during development (run from the repo root).

### Multi-user mode

Pass `-users` with a comma-separated roster to turn on a user selection screen,
where each user gets a separate set of named desktop sessions:

```powershell
go run ./cmd/tessera -users alice,bob,carol
```

The first screen then lists the users; picking one loads that user's most recent
session. **Sessions** in the command palette, deskbar, or workspace menu opens a
keyboard-accessible manager for creating, renaming, switching, and destroying
desktops. Each session has its own windows, background, and running processes;
theme and default font settings are shared by the user. Session URLs are stable
and browser Back/Forward switches between them. The user choice is remembered per
browser. Without the flag, Tessera uses the same session model for one `default`
user.
Authentication is intentionally out of scope — this is workspace separation, not
access control.

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
- Terminal, worksheet, and text-editor panes each have `A−` / `A+` controls in their status strip; their font size saves with the pane and restores on reload.
- Right-click inside a rectangle's editor to copy, cut, or paste selected text.
- Clicking a rectangle brings it above overlapping rectangles.
- The active pane is explicit, saves to SQLite, restores on refresh, and can be cycled with `Ctrl+]` / `Ctrl+[`.
- Minimize removes a pane from the canvas without stopping it; the compact bottom-right Deskbar lists every open pane and restores minimized panes in place. Double-click a title tab to minimize it.
- Right-click the top-left tab grip to dock, restore, or destroy a rectangle.
- Pane geometry, z-order, title, and text save to SQLite and reload on refresh.
- Right-click empty space to switch themes or set a custom background image; the image is stored in SQLite per workspace (per user in multi-user mode) and reloads on refresh.
- The bottom-right window button opens a BeOS Deskbar-style live window list; minimized panes are dimmed there and restore on selection.
- The Deskbar's `Settings...` panel separates default font/theme choices from the current pane font and currently applied theme.
- Tessera uses the local Swiss721 font files in `web/assets` as the default UI, editor, and terminal font.
- `Ctrl+K`/`Cmd+K` (or "Command Palette" in any workspace menu) opens a fuzzy-searchable palette over every action — new panes, themes, background, user switching, and jump-to-window.
