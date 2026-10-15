import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  defaultTerminalColorMode,
  normalizeTerminalColorMode,
  recreateOpenTerminalViews,
  terminalColorTheme,
  terminalColorModes,
  xtermPalette,
} from "./terminal-colors.mjs";

test("normalizes terminal color modes to the dark default", () => {
  assert.equal(normalizeTerminalColorMode("light"), "light");
  assert.equal(normalizeTerminalColorMode("dark"), "dark");
  for (const value of ["", "system", "Dark", "constructor", "toString", null]) {
    assert.equal(normalizeTerminalColorMode(value), defaultTerminalColorMode);
  }
});

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function appFunction(name, context) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `missing app function ${name}`);
  const end = source.indexOf("\n}\n", match.index) + 2;
  return vm.runInNewContext(`(${source.slice(match.index, end)})`, context);
}

test("per-pane colors restart only that browser view and allow returning to the default", async () => {
  const pane = { kind: "terminal", terminalColorMode: "", terminal: {} };
  const other = { kind: "terminal", terminalColorMode: "dark", terminal: {} };
  const disposed = [];
  const started = [];
  let saves = 0;
  const setMode = appFunction("setPaneTerminalColorMode", {
    terminalColorModes, recreateOpenTerminalViews,
    scheduleWorkspaceSave: () => saves++,
    disposeTerminal: (rect, options) => {
      assert.equal(options, undefined, "the shell must stay alive");
      disposed.push(rect);
      rect.terminal = null;
    },
    startTerminal: async (rect) => { started.push(rect); rect.terminal = {}; },
  });
  await setMode(pane, "light");
  assert.equal(pane.terminalColorMode, "light");
  assert.deepEqual(disposed, [pane]);
  assert.deepEqual(started, [pane]);
  assert.equal(other.terminalColorMode, "dark");
  await setMode(pane, "light");
  assert.equal(saves, 1, "the same choice needs no save/restart");
  await setMode(pane, "");
  assert.equal(pane.terminalColorMode, "");
  assert.equal(saves, 2);
  await setMode(pane, "constructor");
  await setMode({ kind: "browser" }, "light");
  assert.equal(saves, 2, "invalid values normalize to inheritance; other pane kinds are ignored");
});

test("changing the user color default leaves explicitly themed terminals connected", async () => {
  const inherited = { kind: "terminal", terminalColorMode: "", terminal: {} };
  const explicit = { kind: "terminal", terminalColorMode: "dark", terminal: {} };
  const oldView = explicit.terminal;
  const disposed = [];
  let saves = 0;
  const setMode = appFunction("setTerminalColorMode", {
    terminalColorMode: "dark", normalizeTerminalColorMode,
    rectangles: [inherited, explicit], recreateOpenTerminalViews,
    scheduleUserSettingsSave: () => saves++,
    disposeTerminal: (rect) => { disposed.push(rect); rect.terminal = null; },
    startTerminal: async (rect) => { rect.terminal = {}; },
  });
  await setMode("light");
  assert.deepEqual(disposed, [inherited]);
  assert.equal(explicit.terminal, oldView);
  assert.equal(saves, 1);
});

test("terminal attachment sends the effective color mode before workspace persistence", () => {
  const url = appFunction("terminalWebSocketURL", {
    window: { location: { protocol: "http:", host: "localhost:7331" } },
    workspaceID: "session", URLSearchParams,
  });
  const pane = { id: "pane", terminal: { term: { coreID: "core" } } };
  assert.equal(new URL(url(pane, 80, 24, "light")).searchParams.get("colorMode"), "light");
  assert.equal(new URL(url(pane, 80, 24, "dark")).searchParams.get("colorMode"), "dark");
  assert.equal(new URL(url(pane, 80, 24, "invalid")).searchParams.has("colorMode"), false);
});

test("terminal menu offers inheritance, dark and light and applies the chosen pane", () => {
  const document = {
    createElement: (tag) => ({
      tag, children: [], listeners: {}, attributes: {},
      appendChild(child) { this.children.push(child); },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(event, callback) { this.listeners[event] = callback; },
    }),
  };
  const menu = document.createElement("div");
  const pane = { terminalColorMode: "light" };
  const calls = [];
  appFunction("appendTerminalColorSetting", {
    document, terminalColorModes, terminalColorMode: "dark",
    setPaneTerminalColorMode: (rect, value) => calls.push([rect, value]),
  })(menu, pane, () => calls.push("hide"));
  const select = menu.children[0].children[0];
  assert.equal(select.attributes["aria-label"], "Terminal colors");
  assert.deepEqual(select.children.map((option) => [option.value, option.textContent, option.selected]), [
    ["", "Use default (Dark)", false], ["dark", "Dark", false], ["light", "Light", true],
  ]);
  select.value = "";
  select.listeners.change();
  assert.deepEqual(calls, ["hide", [pane, ""]]);
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
