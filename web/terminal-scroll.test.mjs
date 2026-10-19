import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { TerminalScroll, installTerminalScrollRenderer, terminalScrollMouseEvent } from "./terminal-scroll.mjs";
import { wheelDeltaUnits } from "./wheel-sensitivity.mjs";

function fixture() {
  let clock = 0, history = 500, alternate = false;
  const changes = [];
  const term = {
    viewportY: 0, targetViewportY: 0, options: { smoothScrollDuration: 120 },
    wasmTerm: { isAlternateScreen: () => alternate },
    getScrollbackLength: () => history,
    renderer: { getMetrics: () => ({ height: 20 }), devicePixelRatio: 1 },
    scrollEmitter: { fire: value => changes.push(value) },
    noteInteractiveInput() {}, showScrollbar() {}, requestRender() {},
  };
  const scroll = new TerminalScroll(term, () => clock);
  return { term, scroll, changes, tick(ms) { clock += ms; return scroll.advance(); },
    history(value) { history = value; }, alternate() { alternate = true; } };
}

test("rapid gestures retain all distance and fractional trackpad input", () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) f.scroll.by(-0.05);
  assert.ok(Math.abs(f.scroll.target - 2) < 1e-10);
  assert.equal(f.term.viewportY, 0);
  assert.equal(f.tick(16), true);
  assert.ok(f.term.viewportY > 0 && f.term.viewportY < 2);
  f.scroll.by(-3);
  assert.ok(Math.abs(f.scroll.target - 5) < 1e-10);
  f.tick(1000);
  assert.ok(Math.abs(f.term.viewportY - 5) < 1e-10);
  assert.equal(f.scroll.target, null);
});

test("elapsed-time easing behaves identically at 60 and 120 Hz", () => {
  const positions = [60, 120].map(rate => {
    const f = fixture(); f.scroll.by(-30);
    for (let frame = 0; frame < rate / 10; frame++) f.tick(1000 / rate);
    return f.term.viewportY;
  });
  assert.ok(Math.abs(positions[0] - positions[1]) < 1e-10);
  assert.ok(positions[0] > 27 && positions[0] < 30);
});

test("reversal responds immediately and boundaries have no queued overshoot", () => {
  const f = fixture();
  f.scroll.by(-100); f.tick(16);
  const previous = f.term.viewportY;
  f.scroll.by(2); f.tick(16);
  assert.ok(f.term.viewportY < previous);
  f.scroll.by(-10000); assert.equal(f.scroll.target, 500);
  f.history(20); f.tick(1000); assert.equal(f.term.viewportY, 20);
  f.scroll.by(-10); assert.equal(f.scroll.target, 20);
  f.scroll.by(1); assert.equal(f.scroll.target, 19);
  f.scroll.by(1000); f.tick(1000); assert.equal(f.term.viewportY, 0);
});

test("cancel, no-animation, and alternate-screen transitions stop pending motion", () => {
  const f = fixture(); f.scroll.by(-10); f.tick(16);
  const previous = f.term.viewportY;
  f.scroll.cancel(); f.tick(1000); assert.equal(f.term.viewportY, previous);
  f.term.options.smoothScrollDuration = 0;
  f.scroll.by(-2); assert.equal(f.term.viewportY, previous + 2);
  assert.equal(f.scroll.target, null);
  f.term.options.smoothScrollDuration = 120;
  f.scroll.by(-2); f.alternate(); assert.equal(f.tick(16), false);
  assert.equal(f.term.viewportY, 0); assert.equal(f.term.targetViewportY, 0);
  f.scroll.by(NaN); f.scroll.to(Infinity); assert.equal(f.scroll.target, null);
});

test("reduced motion applies the complete gesture immediately", () => {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const f = fixture(); f.scroll.by(-3.5);
    assert.equal(f.term.viewportY, 3.5); assert.equal(f.scroll.target, null);
  } finally {
    if (original) globalThis.matchMedia = original;
    else delete globalThis.matchMedia;
  }
});

function rendererFixture() {
  const calls = [];
  const ctx = { save() { calls.push("save"); }, restore() { calls.push("restore"); },
    translate(...args) { calls.push(["translate", ...args]); } };
  class Renderer {
    constructor() { this.ctx = ctx; this.cursorVisible = true; this.devicePixelRatio = 1.25; }
    getMetrics() { return { width: 10, height: 19 }; }
    render(_buffer, force, y, _provider, opacity) {
      calls.push(["base", force, y, this.cursorVisible]);
      if (this.fail) throw Error("paint failed");
      this.renderScrollbar(y, 100, 24, opacity);
    }
    renderLine(cells, row, cols) { calls.push(["row", cells, row, cols]); }
    renderScrollbar(...args) { calls.push(["bar", ...args]); }
  }
  installTerminalScrollRenderer(Renderer); installTerminalScrollRenderer(Renderer);
  const renderer = new Renderer();
  const buffer = { getDimensions: () => ({ rows: 24, cols: 80 }) };
  const provider = { getScrollbackLength: () => 100, getScrollbackLine(index) { return `history ${index}`; } };
  return { renderer, calls, buffer, provider };
}

test("fractional paints reveal the top row and keep scrollbar coordinates fixed", () => {
  const f = rendererFixture(); f.renderer.render(f.buffer, false, 2.5, f.provider, 1);
  assert.deepEqual(f.calls, ["save", ["translate", 0, 9.6], ["base", true, 2, false],
    ["row", "history 97", -1, 80], "restore", ["bar", 2.5, 100, 24, 1]]);
  assert.equal(f.renderer.cursorVisible, true);
  assert.equal(Object.hasOwn(f.renderer, "renderScrollbar"), false);
  f.calls.length = 0; f.renderer.render(f.buffer, false, 0, f.provider, 0);
  assert.deepEqual(f.calls[0], ["base", true, 0, true]);
  f.calls.length = 0; f.renderer.render(f.buffer, false, 0, f.provider, 0);
  assert.deepEqual(f.calls[0], ["base", false, 0, true]);
});

test("failed fractional paints restore canvas state and renderer methods", () => {
  const f = rendererFixture(); f.renderer.fail = true;
  assert.throws(() => f.renderer.render(f.buffer, false, 0.5, f.provider, 1), /paint failed/);
  assert.equal(f.calls.at(-1), "restore");
  assert.equal(f.renderer.cursorVisible, true);
  assert.equal(Object.hasOwn(f.renderer, "renderScrollbar"), false);
});

test("link hit testing tracks physical scroll pixels and preserves native event methods", () => {
  let prevented = false;
  const event = { clientY: 100, get ctrlKey() { assert.equal(this, event); return true; },
    preventDefault() { assert.equal(this, event); prevented = true; } };
  const term = { viewportY: 2.5, renderer: { devicePixelRatio: 1.25, getMetrics: () => ({ height: 19 }) } };
  const mapped = terminalScrollMouseEvent(term, event);
  assert.equal(mapped.clientY, 90.4); assert.equal(mapped.ctrlKey, true);
  mapped.preventDefault(); assert.equal(prevented, true);
  term.viewportY = 2; assert.equal(terminalScrollMouseEvent(term, event), event);
});

function wheelBridge(speed = 1.5) {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const start = source.indexOf("function attachTerminalMouseBridge(");
  const end = source.indexOf("\nfunction terminalShouldReportMouse", start);
  let wheel, reporting = false, alternate = false;
  const movements = [], inputs = [], reports = [];
  const term = { rows: 24, wasmTerm: { isAlternateScreen: () => alternate },
    renderer: { getMetrics: () => ({ height: 20 }) }, scrollWheelLines(value) { movements.push(value); },
    input(value) { inputs.push(value); }, attachCustomWheelEventHandler(handler) { wheel = handler; } };
  const bridge = vm.runInNewContext(`(${source.slice(start, end)})`, {
    TerminalMousePress: class {}, TerminalMouseHover: class {}, TerminalContextMenuFallback: class {},
    terminalWheelSensitivity: speed, wheelDeltaUnits,
    terminalShouldReportMouse: () => reporting, terminalMousePosition: () => ({ col: 1, row: 1 }),
    terminalMouseEventCode: code => code, sendTerminalMouseSequence(_socket, code) { reports.push(code); },
  })({ terminalContainer: { addEventListener() {}, removeEventListener() {} } }, term, {});
  return { movements, inputs, reports, wheel(deltaY, deltaMode = 0) { return wheel({ deltaY, deltaMode }); },
    reporting() { reporting = true; }, alternate() { alternate = true; }, bridge };
}

test("every wheel speed uses smooth scrollback for pixels, lines, and pages", () => {
  for (const speed of [0.25, 1, 1.5, 4]) {
    const f = wheelBridge(speed);
    assert.equal(f.wheel(-10), true); f.wheel(-3, 1); f.wheel(1, 2);
    assert.deepEqual(f.movements, [-0.5 * speed, -3 * speed, 24 * speed]);
    assert.equal(f.wheel(0), false);
  }
});

test("TUI wheel input accumulates tiny deltas instead of flooding or dropping gestures", () => {
  const f = wheelBridge(1); f.reporting();
  for (let i = 0; i < 40; i++) f.wheel(-1);
  assert.deepEqual(f.reports, [64]);
  f.wheel(3, 1); assert.deepEqual(f.reports, [64, 65, 65, 65]);
  const a = wheelBridge(1); a.alternate();
  for (let i = 0; i < 34; i++) a.wheel(-1);
  assert.deepEqual(a.inputs, ["\x1B[A"]);
  assert.deepEqual(a.movements, []);
});
