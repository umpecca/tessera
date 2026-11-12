// Local outline paths, on a common 24px grid. Icons are presentation only:
// command labels/IDs remain the source of search and shortcut behavior.
const paths = {
  help: "M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  network: "M5 5l7 7 7-7m-7 7v7 M3 3h4v4H3z M17 3h4v4h-4z M10 17h4v4h-4z",
  windows: "M3 7h14v14H3z M7 7V3h14v14h-4 M3 11h14",
  sessions: "M3 4h7l2 3h9v13H3z M3 11h18",
  add: "M12 5v14 M5 12h14",
  trash: "M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7",
  switch: "M3 7h17m-4-4 4 4-4 4 M21 17H4m4-4-4 4 4 4",
  desktop: "M3 3h18v13H3z M8 21h8 M12 16v5",
  phone: "M7 2h10v20H7z M10 5h4 M12 19h.01",
  screensaver: "M3 3h18v18H3z M3 9h18 M3 15h18 M9 3v18 M15 3v18",
  deskbar: "M3 3h18v18H3z M16 3v18 M16 8h5 M16 13h5",
  clipboard: "M8 5H5v17h14V5h-3 M8 2h8v6H8z M8 12h8 M8 16h5",
  settings: "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  keyboard: "M2 5h20v14H2z M6 9h.01 M10 9h.01 M14 9h.01 M18 9h.01 M6 13h.01 M10 13h.01 M14 13h.01 M18 13h.01 M7 16h10",
  terminal: "M3 4h18v16H3z M7 8l4 4-4 4 M13 16h4",
  browser: "M3 3h18v18H3z M3 8h18 M6 5.5h.01 M9 5.5h.01 M12 5.5h6 M8 12l-3 3 3 3 M16 12l3 3-3 3",
  remote: "M2 3h20v14H2z M8 21h8 M12 17v4 M6 10h12m-3-3 3 3-3 3",
  next: "M4 12h16m-6-6 6 6-6 6",
  previous: "M20 12H4m6-6-6 6 6 6",
  cascade: "M3 11h10v10H3z M7 11V7h10v10h-4 M11 7V3h10v10h-4",
  resize: "M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6 M3 3l6 6 M21 3l-6 6 M21 21l-6-6 M3 21l6-6",
  search: "M15 9a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M14 14l7 7",
  copy: "M8 8h13v13H8z M16 8V3H3v13h5",
  repair: "M14 4a6 6 0 0 0-7 7L2 16l6 6 5-5a6 6 0 0 0 7-7l-4 4-6-6z",
  rename: "M4 16 16 4l4 4L8 20H4z M13 7l4 4 M12 20h9",
  maximize: "M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6",
  restore: "M3 8h13v13H3z M8 8V3h13v13h-5",
  minimize: "M4 19h16",
  top: "M3 3h18v18H3z M3 9h18 M7 6h10",
  left: "M3 3h18v18H3z M9 3v18 M6 7v10",
  right: "M3 3h18v18H3z M15 3v18 M18 7v10",
  bottom: "M3 3h18v18H3z M3 15h18 M7 18h10",
  lock: "M5 10h14v12H5z M8 10V6a4 4 0 0 1 8 0v4 M12 15v3",
  update: "M4 9a8 8 0 0 1 14-4l3 3 M21 3v5h-5 M20 15a8 8 0 0 1-14 4l-3-3 M3 21v-5h5",
  signout: "M10 3H3v18h7 M9 12h12m-5-5 5 5-5 5",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-3a8 5 0 0 1 16 0v3",
  window: "M3 3h18v18H3z M3 8h18",
};

const commandIcons = {
  help: "help", "browse-local-port-help": "network", "window-list": "windows",
  "session-list": "sessions", sessions: "sessions", "new-session": "add",
  "destroy-session": "trash", "desktop-view": "desktop", "phone-view": "phone",
  screensaver: "screensaver", "deskbar-button-toggle": "deskbar",
  "save-clipboard": "clipboard", "delete-clipboard-save": "trash", settings: "settings",
  "manage-shortcuts": "keyboard", "new-terminal": "terminal", "new-browser": "browser",
  "new-vnc": "remote", "new-rdp": "remote", "next-window": "next", "previous-window": "previous",
  "arrange-out": "cascade", "refresh-terminal-size": "resize", "find-in-terminal": "search",
  "copy-last-output": "copy", "repair-terminal-view": "repair", "rename-window": "rename",
  "maximize-toggle": "maximize", "minimize-toggle": "minimize", "dock-top": "top",
  "dock-left": "left", "dock-right": "right", "dock-bottom": "bottom", "destroy-window": "trash",
  "local-https": "lock", "update-server": "update", "sign-out": "signout",
};

export function createPaletteIcon(command, document) {
  const name = command.icon || commandIcons[command.id] || "window";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "command-palette-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("data-icon", name);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name] || paths.window);
  svg.appendChild(path);
  return svg;
}
