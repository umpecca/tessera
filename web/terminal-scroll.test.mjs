import assert from "node:assert/strict";
import test from "node:test";

import { featureFixture } from "./application.test-support.mjs";

import { TerminalScroll, installTerminalScrollRenderer, terminalScrollMouseEvent } from "./terminal-scroll.mjs";
import { wheelDeltaUnits } from "./wheel-sensitivity.mjs";
import { TerminalTouchScroll } from "./terminal-touch-scroll.mjs";

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

function cachedRendererFixture() {
  const rows = [], bars = [], blits = [], made = [], reads = [];
  let graphemes = false;
  let graphemeIndex = null;
  const metrics = { width: 9, height: 20, baseline: 15 };
  const dimensions = { cols: 80, rows: 24 };
  const context = name => ({
    save() {}, restore() {}, setTransform() {}, translate() {},
    fillRect() {}, beginPath() {}, rect() {}, clip() {},
    drawImage(...args) { blits.push([name, ...args.slice(1)]); },
  });
  const output = context("output");
  class Renderer {
    constructor() {
      this.ctx = output;
      this.canvas = { width: 1440, height: 960, ownerDocument: {} };
      this.devicePixelRatio = 2;
      this.theme = { background: "#000" };
      this.cursorVisible = true;
      this.fontSize = 14;
      this.fontFamily = "monospace";
    }
    getMetrics() { return metrics; }
    render(buffer, _force, whole, provider, opacity) {
      if (this.fail) throw Error("cache paint failed");
      for (let row = 0; row < dimensions.rows; row++) {
        const cells = row < whole ? provider.getScrollbackLine(provider.history - whole + row) : buffer.getLine(row - whole);
        if (cells) this.renderLine(cells, row, dimensions.cols);
      }
      this.renderScrollbar(whole, provider.history, dimensions.rows, opacity);
      buffer.dirty = false;
    }
    renderLine(cells, row) { rows.push([cells, row]); }
    renderScrollbar(...args) { bars.push(args); }
  }
  installTerminalScrollRenderer(Renderer, { createCanvas: () => {
    const canvas = { width: 0, height: 0, getContext: () => context("cache") };
    made.push(canvas);
    return canvas;
  } });
  const renderer = new Renderer();
  const cells = index => { reads.push(index); return [{ codepoint: 65, grapheme_len: graphemes || index === graphemeIndex ? 1 : 0 }]; };
  const buffer = { handle: 1, dirty: true, getDimensions: () => dimensions, isDirty() { return this.dirty; }, getLine: cells };
  const provider = { history: 500, getScrollbackLength() { return this.history; }, getScrollbackLine: cells };
  return { renderer, output, buffer, provider, rows, bars, blits, made, reads, metrics, dimensions,
    graphemes() { graphemes = true; buffer.dirty = true; },
    graphemeAt(index) { graphemeIndex = index; },
    paint(y, force = false, opacity = 1) { rows.length = bars.length = blits.length = reads.length = 0; renderer.render(buffer, force, y, provider, opacity); } };
}

test("fractional text frames reuse a bounded backing viewport and preserve exact scrollbar coordinates", () => {
  const f = cachedRendererFixture();
  f.paint(2.123);
  assert.equal(f.rows.length, 26);
  assert.equal(f.made.length, 1);
  assert.equal(f.made[0].height, 1000, "only one extra physical row is retained");
  assert.equal(f.renderer.ctx, f.output);
  assert.equal(f.renderer.cursorVisible, true);
  assert.equal(Object.hasOwn(f.renderer, "renderLine"), false);
  f.paint(2.456);
  assert.equal(f.rows.length, 1, "only the bottom clip-edge row needs fresh rasterization");
  assert.equal(f.reads.length, 0, "the cached boundary row needs no native cell read");
  assert.deepEqual(f.bars, [[2.456, 500, 24, 1]]);
  assert.deepEqual(f.blits, [["output", 0, 22, 1440, 960, 0, 0, 1440, 960]]);
  assert.equal(f.made.length, 1);
});

test("crossing history rows shifts cached pixels and repaints boundary bands in either direction", () => {
  const f = cachedRendererFixture();
  f.paint(10.25);
  for (const y of [11.25, 10.75, 12.125, 11.875]) {
    f.paint(y);
    assert.ok(f.rows.length > 0 && f.rows.length < 24);
    assert.equal(f.blits[0][0], "cache");
    assert.equal(f.blits.at(-1)[0], "output");
    assert.equal(f.rows.at(-2)[1], -1, "the partial top row is last within the backing paint");
    assert.equal(f.rows.at(-1)[1], 23, "the actual canvas clip-edge row is repaired afterwards");
    assert.ok(f.reads.length < 24, "unchanged middle rows are not read from the core");
    assert.equal(f.made.length, 1);
  }
  f.paint(100.5);
  assert.equal(f.rows.length, 26, "large jumps use a complete cache repaint");
});

test("multi-codepoint graphemes reuse fractional frames but repaint at row crossings", () => {
  const f = cachedRendererFixture();
  f.graphemes();
  f.paint(2.25); f.paint(2.5);
  assert.equal(f.rows.length, 1);
  f.paint(3.25);
  assert.equal(f.rows.length, 26, "row-relative grapheme lookups cannot be shifted");
  assert.equal(f.blits.filter(([name]) => name === "cache").length, 0);
});

test("newly exposed graphemes abandon edge reuse before showing incomplete pixels", () => {
  const f = cachedRendererFixture();
  f.graphemeAt(496);
  f.paint(2.25);
  assert.equal(f.renderer.tesseraScrollCache.shiftSafe, true);
  f.paint(3.25);
  assert.equal(f.renderer.tesseraScrollCache.shiftSafe, false);
  assert.ok(f.rows.length >= 26, "a complete repaint replaces the provisional edge paint");
  f.paint(3.5);
  assert.equal(f.rows.length, 1);
});

test("native damage, history, handles, fonts, themes and forced paints invalidate cached rows", () => {
  const f = cachedRendererFixture();
  f.paint(2.25);
  const changes = [
    () => { f.buffer.dirty = true; },
    () => { f.provider.history++; },
    () => { f.buffer.handle++; },
    () => { f.renderer.fontFamily = "other monospace"; },
    () => { f.renderer.theme.background = "#fff"; },
    () => { f.metrics.baseline++; },
  ];
  for (const change of changes) {
    change(); f.paint(2.5);
    assert.equal(f.rows.length, 26);
    f.paint(2.75);
    assert.equal(f.rows.length, 1);
  }
  f.paint(2.5, true);
  assert.equal(f.rows.length, 26);
});

test("decorations, images, unsupported grids and leaving fractional history release the cache", () => {
  const changes = [
    f => { f.renderer.selectionManager = { hasSelection: () => true }; },
    f => { f.renderer.currentSelectionCoords = {}; },
    f => { f.renderer.hoveredHyperlinkId = 1; },
    f => { f.renderer.hoveredLinkRange = {}; },
    f => { f.provider.searchNeedle = "found"; },
    f => { f.renderer.tesseraSearchRows = new Map([[0, []]]); },
    f => { f.buffer.exports = { tessera_sixel_image_count: () => 1 }; },
    f => { f.provider.sixelRenderer = { needsFullRender: true }; },
    f => { f.buffer.isAlternateScreen = () => true; },
    f => { f.metrics.width = 9.25; },
    f => { f.metrics.height = 20.25; },
  ];
  for (const change of changes) {
    const f = cachedRendererFixture();
    f.paint(2.25); change(f); f.paint(2.5);
    assert.equal(f.renderer.tesseraScrollCache, null);
    assert.equal(f.made[0].width, 0);
    assert.ok(f.rows.length >= 24, "the full renderer handles unsupported states");
  }
  for (const y of [0, 2]) {
    const f = cachedRendererFixture(); f.paint(2.25); f.paint(y);
    assert.equal(f.renderer.tesseraScrollCache, null);
    assert.equal(f.made[0].height, 0);
  }
  const large = cachedRendererFixture();
  large.dimensions.cols = 1000; large.dimensions.rows = 200;
  large.renderer.canvas.width = 18000; large.renderer.canvas.height = 8000;
  large.paint(2.25);
  assert.equal(large.made.length, 0, "oversized backings are never allocated");
});

test("failed cache paints restore renderer methods, discard pixels and repaint fully on retry", () => {
  const f = cachedRendererFixture();
  const historyLine = f.provider.getScrollbackLine, bufferLine = f.buffer.getLine;
  f.paint(2.25);
  f.renderer.fail = true;
  assert.throws(() => f.paint(3.25), /cache paint failed/);
  assert.equal(f.renderer.ctx, f.output);
  assert.equal(f.renderer.cursorVisible, true);
  assert.equal(Object.hasOwn(f.renderer, "renderLine"), false);
  assert.equal(Object.hasOwn(f.renderer, "renderScrollbar"), false);
  assert.equal(f.provider.getScrollbackLine, historyLine);
  assert.equal(f.buffer.getLine, bufferLine);
  assert.equal(f.renderer.tesseraScrollCache, null);
  assert.equal(f.made[0].width, 0);
  f.renderer.fail = false;
  f.paint(3.25);
  assert.equal(f.rows.length, 26);
});

test("cache allocation failure uses the full renderer without changing scroll behavior", () => {
  const f = cachedRendererFixture();
  // The installer uses the instance's ownerDocument only for eligibility; the
  // injected factory is exercised separately here to simulate a denied context.
  class Renderer {
    constructor() { Object.assign(this, f.renderer); }
    getMetrics() { return f.metrics; }
    render() { f.rows.push("full fallback"); }
    renderLine() {}
    renderScrollbar(...args) { f.bars.push(args); }
  }
  installTerminalScrollRenderer(Renderer, { createCanvas: () => { throw Error("allocation denied"); } });
  const renderer = new Renderer();
  renderer.render(f.buffer, false, 2.5, f.provider, 1);
  assert.ok(f.rows.includes("full fallback"));
  assert.equal(renderer.tesseraScrollCache, null);
  assert.deepEqual(f.bars, [[2.5, 500, 24, 1]]);
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
  let wheel, reporting = false, alternate = false;
  const movements = [], inputs = [], reports = [];
  const term = { rows: 24, wasmTerm: { isAlternateScreen: () => alternate },
    renderer: { getMetrics: () => ({ height: 20 }) }, scrollWheelLines(value) { movements.push(value); },
    input(value) { inputs.push(value); }, attachCustomWheelEventHandler(handler) { wheel = handler; } };
  const bridge = featureFixture(["attachTerminalMouseBridge"], {
    TerminalMousePress: class {}, TerminalMouseHover: class {}, TerminalContextMenuFallback: class {},
    TerminalTouchScroll, terminalWheelSensitivity: speed, wheelDeltaUnits,
    terminalShouldReportMouse: () => reporting, terminalMousePosition: () => ({ col: 1, row: 1 }),
    terminalMouseEventCode: code => code, sendTerminalMouseSequence(_socket, code) { reports.push(code); },
  }).attachTerminalMouseBridge({ terminalContainer: { addEventListener() {}, removeEventListener() {} } }, term, {});
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

function touchBridge() {
  let reporting = false, alternate = false, selection = false, pressed = null;
  const movements = [], inputs = [], reports = [], listeners = {};
  const term = { rows: 24, wasmTerm: { isAlternateScreen: () => alternate },
    renderer: { getMetrics: () => ({ height: 20 }) }, scrollWheelLines(value) { movements.push(value); },
    input(value) { inputs.push(value); }, attachCustomWheelEventHandler() {}, focus() {},
    hasSelection: () => selection, clearSelection() { selection = false; } };
  const container = { addEventListener(type, handler) { listeners[type] = handler; }, removeEventListener() {},
    setPointerCapture() {}, hasPointerCapture: () => false };
  featureFixture(["attachTerminalMouseBridge"], {
    TerminalMousePress: class {
      begin(pointerID, buttonCode, position) { pressed = { pointerID, buttonCode, position }; }
      matches(pointerID) { return pressed?.pointerID === pointerID; }
      finish(pointerID) {
        if (!pressed || (pointerID !== null && pointerID !== pressed.pointerID)) return null;
        const release = pressed; pressed = null; return release;
      }
    },
    TerminalMouseHover: class { reset() {} }, TerminalContextMenuFallback: class { notePress() {} },
    TerminalTouchScroll, terminalWheelSensitivity: 1.5, wheelDeltaUnits, appleKeyboardLayout: false,
    isTerminalContextMenuGesture: () => false, terminalMouseButtonCode: button => button,
    terminalShouldReportMouse: () => reporting, terminalMousePosition: () => ({ col: 1, row: 1 }),
    terminalMouseEventCode: code => code,
    sendTerminalMouseSequence(_socket, code, _position, kind) { reports.push(`${code}${kind}`); },
    clearTerminalSelectionStartedDuringGesture(t, had) { if (had === false && t.hasSelection()) t.clearSelection(); },
    stopTerminalMouseEvent() {}, hideFloatingMenus() {}, setActivePane() {},
  }).attachTerminalMouseBridge({ terminalContainer: container }, term, {});
  const event = (pointerId, clientY) => ({ pointerType: "touch", pointerId, clientY, button: 0, buttons: 1 });
  return {
    movements, inputs, reports,
    down(id, y) { listeners.pointerdown(event(id, y)); },
    move(id, y) { listeners.pointermove(event(id, y)); },
    up(id, y) { listeners.pointerup(event(id, y)); },
    reporting() { reporting = true; }, alternate() { alternate = true; },
    select() { selection = true; }, get selection() { return selection; },
  };
}

test("two fingers scroll the scrollback with the content under them", () => {
  const f = touchBridge();
  f.down(1, 200); f.down(2, 200);
  f.move(1, 160); f.move(2, 160);
  assert.deepEqual(f.movements, [1, 1], "fingers moving up show newer lines");
  f.move(1, 240); f.move(2, 240);
  assert.deepEqual(f.movements, [1, 1, -2, -2]);
  f.up(1, 240); f.move(2, 300); f.up(2, 300);
  assert.equal(f.movements.length, 4, "the finger left behind does nothing");
});

test("two fingers send a full-screen program a wheel step or arrow per line", () => {
  const program = touchBridge(); program.reporting();
  program.down(1, 200);
  assert.deepEqual(program.reports, ["0M"], "one finger is a press");
  program.down(2, 200);
  assert.deepEqual(program.reports, ["0M", "0m"], "the second finger releases it");
  program.move(1, 170); program.move(2, 170);
  assert.deepEqual(program.reports, ["0M", "0m", "65M"], "30 pixels is a line and a half");
  program.move(1, 230); program.move(2, 230);
  assert.deepEqual(program.reports.slice(3), ["64M", "64M"]);

  const pager = touchBridge(); pager.alternate();
  pager.down(1, 0); pager.down(2, 0); pager.move(1, -40); pager.move(2, -40);
  assert.deepEqual(pager.inputs, ["\x1B[B", "\x1B[B"]);
  assert.deepEqual(pager.movements, []);
});

test("a selection the first finger began goes when the second lands", () => {
  const f = touchBridge();
  f.down(1, 100); f.select(); f.down(2, 100);
  assert.equal(f.selection, false);
  const kept = touchBridge();
  kept.select(); kept.down(1, 100); kept.down(2, 100);
  assert.equal(kept.selection, true, "one made before the touch stays");
});
