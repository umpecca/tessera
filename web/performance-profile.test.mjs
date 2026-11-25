import assert from "node:assert/strict";
import test from "node:test";
import { createPreferences } from "./preferences.mjs";
import { featureFixture } from "./application.test-support.mjs";

function loadBrowserPerformanceSettings(localStorage) {
  const preferences = createPreferences({}, { window: { localStorage } });
  preferences.initializeFallbackPaneFontSize();
  const { olderMacMode, experimentalTerminalRenderer, terminalPaintCoalescing, terminalOutputCoalescing } = preferences;
  return { olderMacMode, experimentalTerminalRenderer, terminalPaintCoalescing, terminalOutputCoalescing };
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
  return featureFixture([name], globals);
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

test("the Blinking cursor setting defaults on, persists, and Older Mac mode still wins", () => {
  const stored = new Map();
  const load = () => createPreferences({}, { window: { localStorage: {
    getItem: key => stored.get(key) ?? null, setItem(key, value) { stored.set(key, value); },
  } } });
  let preferences = load();
  preferences.initializeSystemNotificationsStorageKey();
  assert.equal(preferences.cursorBlink, true);
  assert.equal(preferences.terminalCursorBlinks(), true);

  const blinks = [];
  const term = { options: {}, setRenderPixelRatioCap() {}, setPaintFPSLimit() {}, setCursorBlinkEnabled(value) { blinks.push(value); } };
  const ctx = loadFunction("setCursorBlink", {
    cursorBlink: true, olderMacMode: false, cursorBlinkStorageKey: "tessera.cursor-blink.v1",
    window: { localStorage: { setItem(key, value) { stored.set(key, value); } } },
    document: { documentElement: { dataset: {} } },
    rectangles: [{ kind: "terminal", terminal: { term } }, { kind: "worksheet" }],
    updateTerminalRenderState() {}, scheduleUserSettingsSave() { assert.fail("a browser setting"); },
  });
  ctx.setCursorBlink(false);
  assert.deepEqual(blinks, [false], "open terminals stop blinking at once");
  assert.equal(stored.get("tessera.cursor-blink.v1"), "false");
  ctx.setOlderMacMode(true);
  ctx.setOlderMacMode(false, { save: false });
  assert.deepEqual(blinks, [false, false, false], "leaving Older Mac mode keeps the setting's steady cursor");
  ctx.setCursorBlink(true);
  assert.deepEqual(blinks.at(-1), true);
  ctx.setOlderMacMode(true, { save: false });
  assert.equal(blinks.at(-1), false, "Older Mac mode keeps the cursor steady whatever the setting");
  ctx.setOlderMacMode(false, { save: false });
  assert.equal(blinks.at(-1), true);

  stored.set("tessera.cursor-blink.v1", "false");
  preferences = load();
  preferences.initializeSystemNotificationsStorageKey();
  assert.equal(preferences.cursorBlink, false);
  assert.equal(preferences.terminalCursorBlinks(), false);
});
