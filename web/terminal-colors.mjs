export const defaultTerminalColorMode = "dark";

// ANSI assigns meanings to color indices but does not assign RGB values.
// These are xterm's conventional first 16 palette entries. Both appearance
// modes deliberately share them so applications see one stable palette.
export const xtermPalette = Object.freeze({
  black: "#000000",
  red: "#cd0000",
  green: "#00cd00",
  yellow: "#cdcd00",
  blue: "#0000ee",
  magenta: "#cd00cd",
  cyan: "#00cdcd",
  white: "#e5e5e5",
  brightBlack: "#7f7f7f",
  brightRed: "#ff0000",
  brightGreen: "#00ff00",
  brightYellow: "#ffff00",
  brightBlue: "#5c5cff",
  brightMagenta: "#ff00ff",
  brightCyan: "#00ffff",
  brightWhite: "#ffffff",
});

export const terminalColorModes = Object.freeze({
  dark: Object.freeze({
    label: "Dark",
    background: "#000000",
    foreground: "#e5e5e5",
    cursor: "#e5e5e5",
    cursorAccent: "#000000",
    selectionBackground: "#e5e5e5",
    selectionForeground: "#000000",
  }),
  light: Object.freeze({
    label: "Light",
    background: "#ffffff",
    foreground: "#000000",
    cursor: "#000000",
    cursorAccent: "#ffffff",
    selectionBackground: "#000000",
    selectionForeground: "#ffffff",
  }),
});

export function normalizeTerminalColorMode(value) {
  return Object.hasOwn(terminalColorModes, value) ? value : defaultTerminalColorMode;
}

export function terminalColorTheme(value) {
  return {
    ...xtermPalette,
    ...terminalColorModes[normalizeTerminalColorMode(value)],
  };
}

function programColor(value) {
  return value ? `#${(value & 0xffffff).toString(16).padStart(6, "0")}` : null;
}

// OSC 10-19: the colours a program set, as the core reports them (foreground,
// background, cursor, selection background, selection foreground; 0x1RRGGBB
// each, 0 for none), over the pane's theme. Colours the program left alone
// follow the ones it changed as the pane's own do: the cursor and selection
// are the foreground, text on them the background.
export function terminalThemeWithProgramColors(base, values = []) {
  const [foreground, background, cursor, selectionBackground, selectionForeground] = values.map(programColor);
  const theme = { ...base };
  if (foreground) Object.assign(theme, { foreground, cursor: foreground, selectionBackground: foreground });
  if (background) Object.assign(theme, { background, cursorAccent: background, selectionForeground: background });
  if (cursor) theme.cursor = cursor;
  if (selectionBackground) theme.selectionBackground = selectionBackground;
  if (selectionForeground) theme.selectionForeground = selectionForeground;
  return theme;
}

export async function recreateOpenTerminalViews(rectangles, disposeTerminal, startTerminal) {
  const openTerminals = rectangles.filter((rect) => rect.kind === "terminal" && rect.terminal);
  for (const rect of openTerminals) {
    // Omitting closeServer keeps the managed PTY alive; the new browser view
    // reconnects to it and receives its bounded scrollback.
    disposeTerminal(rect);
  }
  await Promise.all(openTerminals.map((rect) => startTerminal(rect)));
}
