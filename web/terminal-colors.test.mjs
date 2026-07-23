import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultTerminalColorMode,
  normalizeTerminalColorMode,
  recreateOpenTerminalViews,
  terminalColorTheme,
  xtermPalette,
} from "./terminal-colors.mjs";

test("normalizes terminal color modes to the dark default", () => {
  assert.equal(normalizeTerminalColorMode("light"), "light");
  assert.equal(normalizeTerminalColorMode("dark"), "dark");
  for (const value of ["", "system", "Dark", null]) {
    assert.equal(normalizeTerminalColorMode(value), defaultTerminalColorMode);
  }
});

test("uses the conventional xterm base palette", () => {
  assert.deepEqual(xtermPalette, {
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
});

test("light and dark modes share indexed colors and invert neutral dynamic colors", () => {
  const dark = terminalColorTheme("dark");
  const light = terminalColorTheme("light");
  for (const key of Object.keys(xtermPalette)) {
    assert.equal(light[key], dark[key], key);
  }
  assert.deepEqual(
    {
      background: dark.background,
      foreground: dark.foreground,
      cursor: dark.cursor,
      selectionBackground: dark.selectionBackground,
    },
    {
      background: "#000000",
      foreground: "#e5e5e5",
      cursor: "#e5e5e5",
      selectionBackground: "#e5e5e5",
    },
  );
  assert.deepEqual(
    {
      background: light.background,
      foreground: light.foreground,
      cursor: light.cursor,
      selectionBackground: light.selectionBackground,
    },
    {
      background: "#ffffff",
      foreground: "#000000",
      cursor: "#000000",
      selectionBackground: "#000000",
    },
  );
});

test("recreates browser terminal views without requesting PTY closure", async () => {
  const terminal = { kind: "terminal", terminal: { term: {} } };
  const unopened = { kind: "terminal", terminal: null };
  const worksheet = { kind: "worksheet", terminal: { term: {} } };
  const disposed = [];
  const started = [];

  await recreateOpenTerminalViews(
    [terminal, unopened, worksheet],
    (rect, options) => {
      disposed.push({ rect, options });
      rect.terminal = null;
    },
    async (rect) => {
      started.push(rect);
    },
  );

  assert.deepEqual(disposed, [{ rect: terminal, options: undefined }]);
  assert.deepEqual(started, [terminal]);
});
