import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { installTerminalSelection } from "./terminal-selection.mjs";
import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";
import {
  TerminalContextMenuFallback, TerminalMousePress,
  clearTerminalSelectionStartedDuringGesture, isTerminalContextMenuGesture,
} from "./terminal-input.mjs";

const upstream = readFileSync(new URL("../node_modules/ghostty-web/dist/ghostty-web.js", import.meta.url), "utf8");
const first = upstream.indexOf("const L = class Y {");
const last = upstream.indexOf("let AA = L;", first) + "let AA = L;".length;
assert.ok(first >= 0 && last > first, "test the pinned upstream selection manager");
const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function event(type, target, fields = {}) {
  return {
    type, target, button: 0, buttons: 1, pointerId: 3,
    ctrlKey: false, metaKey: false, shiftKey: false,
    offsetX: 10, offsetY: 100, clientX: 10, clientY: 100, timeStamp: 1000,
    defaultPrevented: false, propagationStopped: false, immediateStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; this.propagationStopped = true; },
    ...fields,
  };
}

class Surface {
  constructor(parent = null) { this.parentElement = parent; this.handlers = new Map(); }
  addEventListener(type, handler, options = {}) {
    const handlers = this.handlers.get(type) || [];
    handlers.push({ handler, capture: options.capture === true });
    this.handlers.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item.handler !== handler));
  }
  dispatch(e, capture = null) {
    const handlers = (this.handlers.get(e.type) || []).filter(item => capture === null || item.capture === capture);
    handlers.sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const { handler } of handlers) {
      handler(e);
      if (e.immediateStopped) break;
    }
  }
  contains(node) {
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === this) return true;
    }
    return false;
  }
  focus() {}
}

function fixture() {
  const doc = new Surface();
  const view = new Surface();
  doc.defaultView = view;
  doc.hidden = false;
  const container = new Surface(doc);
  const canvas = new Surface(container);
  canvas.ownerDocument = doc;
  canvas.clientHeight = 240;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 240, width: 800, height: 240 });
  const textarea = new Surface(container);
  textarea.style = {};
  textarea.select = () => {};
  textarea.setSelectionRange = () => {};
  doc.activeElement = container;
  let nativeRange = null;
  const nativeSelection = {
    get isCollapsed() { return !nativeRange; },
    get rangeCount() { return nativeRange ? 1 : 0; },
    getRangeAt() { return nativeRange; },
    removeRange(range) { if (range === nativeRange) nativeRange = null; },
  };
  doc.getSelection = () => nativeSelection;
  const timers = new Map();
  const copied = [];
  const SelectionManager = vm.runInNewContext(`${upstream.slice(first, last)}; AA`, {
    document: doc, window: view,
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    J: class { fire() {} dispose() {} },
    setInterval(callback) { const id = Symbol(); timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }, setTimeout() {}, console,
  });
  const line = Array.from({ length: 80 }, () => ({ codepoint: 65, grapheme_len: 0 }));
  const core = {
    getDimensions: () => ({ cols: 80, rows: 24 }),
    getScrollbackLength: () => 0, getLine: () => line,
  };
  const term = {
    element: container, cols: 80, rows: 24, viewportY: 0, scrollLines() {}, focus() {},
    renderer: { getCanvas: () => canvas, getMetrics: () => ({ width: 10, height: 10 }) },
    hasMouseTracking: () => true,
  };
  const manager = new SelectionManager(term, term.renderer, core, textarea);
  term.selectionManager = manager;
  term.hasSelection = () => manager.hasSelection();
  term.clearSelection = () => manager.clearSelection();
  const frames = [];
  let painted = false;
  const scheduler = new TerminalRenderScheduler({
    requestFrame(callback) { frames.push(callback); return 1; }, cancelFrame() {},
  });
  const drain = () => { while (frames.length) frames.shift()(0); };
  term.requestRender = () => scheduler.request(term);
  scheduler.register(term, () => { painted = manager.hasSelection(); });
  drain();
  const originalClear = manager.clearSelection;
  const integration = installTerminalSelection(term);
  const emit = (type, fields = {}) => {
    const e = event(type, canvas, fields);
    for (const [surface, capture] of [[doc, true], [container, true], [canvas, true], [canvas, false], [container, false], [doc, false]]) {
      surface.dispatch(e, capture);
      if (e.propagationStopped) break;
    }
    return e;
  };
  return {
    doc, view, container, canvas, textarea, manager, term, timers, copied, frames,
    integration, originalClear, emit, drain,
    painted: () => painted,
    selectNative(start = container, end = container, intersects = true) {
      nativeRange = { startContainer: start, endContainer: end, intersectsNode: () => intersects };
    },
    nativeSelected: () => nativeSelection.rangeCount === 1,
  };
}

test("local selection dragging and clearing paint without output or cursor blinking", () => {
  const f = fixture();
  f.emit("mousedown");
  f.emit("mousemove", { offsetX: 400 });
  assert.equal(f.frames.length, 1, "dragging schedules a coalesced frame");
  f.drain();
  assert.equal(f.painted(), true);
  f.term.clearSelection();
  assert.equal(f.frames.length, 1, "clearing schedules a frame");
  f.drain();
  assert.equal(f.painted(), false);
});

test("programmatic selection also requests a frame", () => {
  const f = fixture();
  f.manager.selectAll();
  assert.equal(f.frames.length, 1);
  f.drain();
  assert.equal(f.painted(), true);
});

test("clearing an empty drag resets its endpoints and stops autoscroll", () => {
  const f = fixture();
  f.emit("mousedown", { offsetY: 5 });
  f.manager.startAutoScroll(-1);
  assert.equal(f.manager.isSelecting, true);
  f.term.clearSelection();
  assert.equal(f.manager.isSelecting, false);
  assert.equal(f.manager.selectionStart, null);
  assert.equal(f.manager.selectionEnd, null);
  assert.equal(f.timers.size, 0);
});

test("captured pointer release copies a real selection exactly once even without bubbling mouseup", () => {
  const f = fixture();
  f.emit("pointerdown");
  f.emit("mousedown");
  f.emit("mousemove", { offsetX: 40 });
  f.doc.dispatch(event("pointerup", f.canvas), true);
  assert.equal(f.manager.isSelecting, false);
  assert.deepEqual(f.copied, ["AAAA"]);
  f.emit("mouseup");
  assert.deepEqual(f.copied, ["AAAA"]);
});

test("an ordinary click does not copy a zero-length selection", () => {
  const f = fixture();
  f.emit("mousedown");
  f.emit("mouseup");
  assert.equal(f.manager.isSelecting, false);
  assert.deepEqual(f.copied, []);
});

test("cancellation, context menu, focus loss and visibility preserve text but stop the drag", () => {
  for (const type of ["pointercancel", "lostpointercapture", "contextmenu", "blur", "visibilitychange"]) {
    const f = fixture();
    f.emit("pointerdown");
    f.emit("mousedown");
    f.emit("mousemove", { offsetX: 400, offsetY: 239 });
    assert.equal(f.timers.size, 1);
    if (type === "blur") f.view.dispatch(event(type, f.view));
    else if (type === "visibilitychange") {
      f.doc.hidden = true;
      f.doc.dispatch(event(type, f.doc));
    } else f.emit(type);
    assert.equal(f.manager.isSelecting, false, type);
    assert.equal(f.term.hasSelection(), true, type);
    assert.equal(f.timers.size, 0, type);
    assert.deepEqual(f.copied, [], type);
  }
});

test("a different pointer cannot end the local drag", () => {
  const f = fixture();
  f.emit("pointerdown");
  f.emit("mousedown");
  f.emit("pointercancel", { pointerId: 4 });
  assert.equal(f.manager.isSelecting, true);
  f.emit("pointercancel");
  assert.equal(f.manager.isSelecting, false);
});

test("zero-button movement recovers a lost release without moving the selection endpoint", () => {
  const f = fixture();
  f.emit("mousedown");
  f.emit("mousemove", { offsetX: 40 });
  const end = f.manager.selectionEnd;
  f.emit("mousemove", { buttons: 0, offsetX: 799, offsetY: 239 });
  assert.equal(f.manager.isSelecting, false);
  assert.equal(f.manager.selectionEnd, end);
  assert.deepEqual(f.copied, []);
});

test("native canvas selection is suppressed and cleared without clearing local selected text", () => {
  const f = fixture();
  f.manager.selectAll();
  assert.equal(f.emit("selectstart").defaultPrevented, true);
  f.selectNative();
  f.doc.dispatch(event("selectionchange", f.doc));
  assert.equal(f.nativeSelected(), false);
  f.selectNative();
  f.emit("contextmenu");
  assert.equal(f.nativeSelected(), false);
  assert.equal(f.term.hasSelection(), true);
});

test("native cleanup leaves editor, clipboard-field and cross-pane selections alone", () => {
  const f = fixture();
  const editor = new Surface(f.doc);
  for (const [start, end, intersects] of [[editor, editor, false], [f.textarea, f.textarea, false], [editor, f.container, true]]) {
    f.selectNative(start, end, intersects);
    f.doc.dispatch(event("selectionchange", f.doc));
    assert.equal(f.nativeSelected(), true);
    f.term.clearSelection();
    assert.equal(f.nativeSelected(), true);
  }
  const e = event("selectstart", f.textarea);
  f.container.dispatch(e);
  assert.equal(e.defaultPrevented, false);
});

test("disposing the integration removes document listeners and restores upstream methods", () => {
  const f = fixture();
  f.emit("mousedown");
  f.emit("mousemove", { offsetX: 40, offsetY: 239 });
  f.integration.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.manager.clearSelection, f.originalClear);
  f.selectNative();
  f.doc.dispatch(event("selectionchange", f.doc));
  assert.equal(f.nativeSelected(), true);
  f.emit("mousedown");
  f.emit("pointercancel");
  assert.equal(f.manager.isSelecting, true, "the disposed recovery handler is gone");
  f.manager.dispose();
});

function appFunction(name, globals = {}) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf("\n}\n", start) + 2;
  return vm.runInNewContext(`(${appSource.slice(start, end)})`, globals);
}

function attachBridge(f, appleKeyboardLayout) {
  let menus = 0;
  const sent = [];
  const bridge = appFunction("attachTerminalMouseBridge", {
    appleKeyboardLayout, isTerminalContextMenuGesture,
    TerminalContextMenuFallback, TerminalMousePress, clearTerminalSelectionStartedDuringGesture,
    terminalShouldReportMouse: appFunction("terminalShouldReportMouse"),
    terminalMouseButtonCode: appFunction("terminalMouseButtonCode"),
    terminalMousePosition: () => ({ col: 1, row: 1 }),
    terminalMouseEventCode: appFunction("terminalMouseEventCode"),
    stopTerminalMouseEvent: appFunction("stopTerminalMouseEvent"),
    sendTerminalMouseSequence(_socket, code, position, final) { sent.push({ code, position, final }); },
    hideFloatingMenus() {}, setActivePane() {},
    openTerminalMenu(e) { menus++; e.preventDefault(); e.stopPropagation(); },
  })({ terminalContainer: f.container }, f.term, {});
  return { bridge, sent, menus: () => menus };
}

test("Safari Control-primary-click cannot start selection or activate a hyperlink", () => {
  for (const withPointerEvent of [true, false]) {
    const f = fixture();
    const b = attachBridge(f, true);
    f.manager.selectAll();
    if (withPointerEvent) assert.equal(f.emit("pointerdown", { ctrlKey: true }).defaultPrevented, true);
    assert.equal(f.emit("mousedown", { ctrlKey: true }).defaultPrevented, true);
    assert.equal(f.manager.isSelecting, false);
    assert.equal(f.term.hasSelection(), true, "existing text remains available to Copy");
    f.selectNative();
    f.emit("contextmenu", { ctrlKey: true });
    assert.equal(b.menus(), 1);
    assert.equal(f.nativeSelected(), false);
    assert.equal(f.emit("click", { ctrlKey: true }).propagationStopped, true);
    assert.deepEqual(b.sent, []);
  }
});

test("Command-click, other-platform Control-click and Shift-drag retain their local paths", () => {
  for (const [apple, modifier] of [[true, { metaKey: true }], [false, { ctrlKey: true }], [true, { shiftKey: true }]]) {
    const f = fixture();
    const b = attachBridge(f, apple);
    assert.equal(f.emit("pointerdown", modifier).defaultPrevented, false);
    assert.equal(f.emit("mousedown", modifier).defaultPrevented, false);
    assert.equal(f.manager.isSelecting, true);
    assert.equal(f.emit("click", modifier).propagationStopped, false);
    assert.deepEqual(b.sent, []);
  }
});

test("unmodified TUI clicks still report a press and release without starting local selection", () => {
  const f = fixture();
  const b = attachBridge(f, true);
  f.emit("pointerdown");
  assert.equal(f.manager.isSelecting, false);
  f.emit("pointerup");
  assert.deepEqual(b.sent.map(item => item.final), ["M", "m"]);
  b.bridge.dispose();
  assert.equal(f.emit("click", { ctrlKey: true }).propagationStopped, false);
});
