import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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
