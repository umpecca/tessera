# Workspace

Tessera presents a full-window desktop where panes can overlap and retain
their geometry, z-order, title, working directory, font size, and content.

Draw a new window by left-dragging empty desktop space, or hold the middle
mouse button and drag over any pane, including Browser content. Release to
choose the window type. A simple middle click creates nothing; Escape cancels
the outline. Left clicks inside existing panes keep their normal behavior.

## Pane types

Current pane types:

- **Terminal:** a persistent PTY terminal using ConPTY on Windows and a Unix
  PTY on macOS/Linux. Terminal sessions retain bounded scrollback while the
  server process remains alive.
- **Browser:** a sandboxed view of an HTTP(S) development server on the Tessera
  host. Enter a loopback address such as `localhost:5000`; Tessera forwards the
  page, assets, forms, fetches, redirects, and hot-reload WebSockets through its
  existing listener without exposing the development-server port. Service
  workers, strict origin assumptions, and complex authentication may require
  project-specific configuration. Open **Browse Local Port Help** from the
  command palette (`BL`) or use the network icon in a Browser pane for an
  interactive guide and launcher.
- **VNC:** an interactive remote desktop powered by the bundled noVNC client.
  Enter a DNS name, IPv4 address, or bracketed IPv6 address with an optional
  port, then choose **Connect**. The target and display preferences persist,
  but credentials remain only in the current browser page and connections are
  never restored automatically.
- **RDP:** a Windows-style remote desktop powered by the bundled IronRDP
  client. Enter a host with an optional port (3389 by default) and choose
  **Connect**. Tessera shows the server's certificate for you to trust before
  asking for a user name, optional domain and password. The target, user
  name, domain and trusted certificate persist; Tessera never saves the
  password. Your browser's password manager can, if you let it: the sign-in
  form is marked up for it, and Chrome and Edge are offered the login once it
  works, named with its server, since browsers keep logins per website rather
  than per RDP server.

## Windows and commands

- Drag empty space to create a pane; move and resize panes directly.
- Hold `Shift` while drawing or resizing to constrain to a square.
- Minimize, maximize, restore, dock, rename, and destroy panes.
- Use the Deskbar to list, focus, and restore open panes.
- Use `Ctrl+K`/`Cmd+K` to search commands, pane types, sessions, themes, and
  open windows. Exact shortcut codes appear first. Use ↑/↓ to select a result
  and Enter to run it; typing never runs a palette command automatically.
  Search aliases include `preferences` for Settings, `rename` for Set Window
  Title, and `close` for Destroy Window.
- Open the experimental **Command Wheel** with `Ctrl+;`/`Cmd+;`, or from the
  workspace menu. Hover or type a first key to reveal valid second keys, then type or
  click the next key to run its command (for example, `N` → `N` creates a
  terminal). Settings opens directly with `S` in the wheel and `S` then Enter
  in the palette.
  **Tessera Sessions** uses `T` → `S` in the wheel and `TS` in the palette.
  Backspace goes back, Escape closes, and **Search all commands**
  opens the existing palette. Clicking or typing a group keeps it selected.
  Dark radial wedges surround a context hub, with next keys in an outer arc.
- Run **Screensaver** from the command palette to fill the screen with a
  slowly shifting mosaic, Matrix-style digital rain and a tile clock. Any
  key, click, tap or mouse movement returns to the workspace. It doesn't
  lock anything.
- Cycle active panes with `Ctrl+]` and `Ctrl+[`.
- Move the active window earlier/later with `Ctrl+Shift+Up`/`Ctrl+Shift+Down`
  (`Cmd+Shift+Up/Down` on macOS). Open **Window List** with `Ctrl+L`/`Cmd+L`
  and drag a row by its grip or name to a new position, or use its ↑/↓ buttons.
  You can also select a row with arrow keys and use
  `Ctrl+Up/Down`/`Cmd+Up/Down` to reorder it. Shift also works inside the list.
  Enter opens the highlighted window; Escape closes the list.
- Choose a theme, default pane font size, per-session background image, and
  Terminal wheel-scroll speed.
- Persist the active pane and complete workspace document to SQLite.
- Reject stale whole-workspace saves from older tabs or reconnecting computers;
  autosave pauses and offers to reload when a newer revision already exists.
- Detect loss of the server connection and present Reconnect and Refresh Page
  actions. Recovery is confirmed before the current session route is reloaded.
- Reconnect an unexpectedly closed Terminal WebSocket automatically without
  treating that pane transport failure as a server outage.

Window order saves with each session and is shared by keyboard cycling, the
window switcher, Window List, Deskbar, and window menus. Focusing a window keeps
this order. Reordering preserves window positions, stacking, and contents;
minimized windows keep their place and can be moved in the list. Cycling skips
minimized windows. New windows append, and reorder controls stop at the ends.

## Themes

Choose **Operator** under **Settings → Theme → Current** for charcoal surfaces,
mint accents, a softly lit active pane, and dotted title-bar grips. Windows stay
movable and resizable, with 32px desktop title bars (48px for touch), ordinary
titles for new panes, and minimize, maximize/restore, and close controls. The
title bar, border, and shadow disappear when maximized, matching OLED Terminal;
use **Alt+F10** or **Maximize / restore** in the command palette to restore it.
Double-left-click a window title bar to toggle maximize/restore.
Closing a live terminal confirms ending its shell. Existing titles and terminal
color preferences are preserved.
**Wobbly windows** in the same section adds gentle whole-window tilt and stretch
while dragging. It is saved per browser, does not change window or terminal
dimensions, and is disabled by reduced motion or **Older Mac** mode.

## Users and named sessions

Without `-users`, Tessera creates named sessions for a synthetic `default`
user. With `-users`, the first screen presents the configured roster:

```powershell
go run ./cmd/tessera -users alice,bob,carol
```

Each user can create, rename, switch, and delete named desktop sessions.
Sessions have stable routes of the form:

```text
/users/{user}/sessions/{session}
```

Browser Back/Forward switches session routes. Each session owns its panes,
background, running commands, and terminals; theme, default font, terminal
color mode, and terminal `TERM` settings are shared at the user level. The
`TERM` value applies when a new terminal process is created; existing
terminals keep their original environment. Destroying a session stops only
that session's running commands and terminals, and the final session cannot be
deleted.

The selected user is remembered in browser storage. This is convenience and
state separation only, not authentication or authorization.
