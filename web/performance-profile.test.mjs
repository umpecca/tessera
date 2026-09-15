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

test("Older Mac mode updates open terminals immediately and persists once", () => {
  const calls = [];
  let saves = 0;
  const terminal = {
    options: { smoothScrollDuration: 100 },
    setRenderPixelRatioCap(value) { calls.push(["ratio", value]); },
    setCursorBlinkEnabled(value) { calls.push(["blink", value]); },
  };
  const ctx = loadFunction("setOlderMacMode", {
    olderMacMode: false,
    document: { documentElement: { dataset: {} } },
    rectangles: [{ kind: "terminal", terminal: { term: terminal } }, { kind: "worksheet" }],
    updateTerminalRenderState(rect) { calls.push(["render", rect.kind]); },
    scheduleUserSettingsSave() { saves++; },
  });

  ctx.setOlderMacMode(true);
  assert.equal(ctx.olderMacMode, true);
  assert.equal(ctx.document.documentElement.dataset.performanceProfile, "older-mac");
  assert.equal(terminal.options.smoothScrollDuration, 0);
  assert.deepEqual(calls, [["ratio", 1], ["blink", false], ["render", "terminal"]]);
  assert.equal(saves, 1);

  ctx.setOlderMacMode(false, { save: false });
  assert.equal(ctx.document.documentElement.dataset.performanceProfile, "standard");
  assert.equal(terminal.options.smoothScrollDuration, 100);
  assert.deepEqual(calls.slice(3), [["ratio", 0], ["blink", true], ["render", "terminal"]]);
  assert.equal(saves, 1);
});
