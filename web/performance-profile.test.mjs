import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { normalizeTerminalBacklogLimit } from "./terminal-replica.mjs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function loadBrowserPerformanceSettings(localStorage) {
  const start = source.indexOf("const olderMacModeStorageKey =");
  const end = source.indexOf("\nlet audioStationState =", start);
  assert.ok(start >= 0 && end > start);
  return { ...vm.runInNewContext(`${source.slice(start, end)}
    ({ olderMacMode, experimentalTerminalRenderer, terminalPaintCoalescing, terminalOutputCoalescing })`, {
    window: { localStorage }, normalizeTerminalBacklogLimit,
  }) };
}

test("new browsers default to Standard, Experimental, paint coalescing on, and server coalescing off", () => {
  const stored = new Map();
  const settings = loadBrowserPerformanceSettings({
    getItem: key => stored.get(key) ?? null,
    setItem() { assert.fail("loading defaults must not write browser preferences"); },
  });
  assert.deepEqual(settings, {
    olderMacMode: false, experimentalTerminalRenderer: true,
    terminalPaintCoalescing: true, terminalOutputCoalescing: false,
  });
});

test("saved browser performance choices override the defaults, including Stable", () => {
  const stored = new Map([
    ["tessera.older-mac-mode.v1", "true"],
    ["tessera.experimental-terminal-renderer.v1", "false"],
    ["tessera.terminal-paint-coalescing.v1", "false"],
    ["tessera.terminal-output-coalescing.v1", "true"],
  ]);
  const settings = loadBrowserPerformanceSettings({
    getItem: key => stored.get(key) ?? null,
    setItem() { assert.fail("loading settings must not overwrite browser preferences"); },
  });
  assert.deepEqual(settings, {
    olderMacMode: true, experimentalTerminalRenderer: false,
    terminalPaintCoalescing: false, terminalOutputCoalescing: true,
  });
});

test("unavailable browser storage retains the standard performance defaults", () => {
  const settings = loadBrowserPerformanceSettings({
    getItem() { throw new Error("Storage unavailable"); },
  });
  assert.deepEqual(settings, {
    olderMacMode: false, experimentalTerminalRenderer: true,
    terminalPaintCoalescing: true, terminalOutputCoalescing: false,
  });
});

function loadFunction(name, globals) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start) + 2;
  const context = vm.createContext(globals);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("Older Mac mode updates open terminals and persists only in this browser", () => {
  const calls = [];
  let saves = 0;
  const stored = new Map();
  const terminal = {
    options: { smoothScrollDuration: 100 },
    setRenderPixelRatioCap(value) { calls.push(["ratio", value]); },
    setPaintFPSLimit(value) { calls.push(["fps", value]); },
    setCursorBlinkEnabled(value) { calls.push(["blink", value]); },
  };
  const ctx = loadFunction("setOlderMacMode", {
    olderMacMode: false,
    olderMacModeStorageKey: "tessera.older-mac-mode.v1",
    window: { localStorage: { setItem(key, value) { stored.set(key, value); } } },
    document: { documentElement: { dataset: {} } },
    rectangles: [{ kind: "terminal", terminal: { term: terminal } }, { kind: "worksheet" }],
    updateTerminalRenderState(rect) { calls.push(["render", rect.kind]); },
    scheduleUserSettingsSave() { saves++; },
  });

  ctx.setOlderMacMode(true);
  assert.equal(ctx.olderMacMode, true);
  assert.equal(ctx.document.documentElement.dataset.performanceProfile, "older-mac");
  assert.equal(terminal.options.smoothScrollDuration, 0);
  assert.deepEqual(calls, [["ratio", 1], ["fps", 30], ["blink", false], ["render", "terminal"]]);
  assert.equal(stored.get("tessera.older-mac-mode.v1"), "true");
  assert.equal(saves, 0, "device performance must not schedule an account settings save");

  ctx.setOlderMacMode(false, { save: false });
  assert.equal(ctx.document.documentElement.dataset.performanceProfile, "standard");
  assert.equal(terminal.options.smoothScrollDuration, 100);
  assert.deepEqual(calls.slice(4), [["ratio", 0], ["fps", 0], ["blink", true], ["render", "terminal"]]);
  assert.equal(stored.get("tessera.older-mac-mode.v1"), "true", "loading must not overwrite browser storage");
  assert.equal(saves, 0);
});
