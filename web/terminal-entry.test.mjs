import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { TerminalCursorBlink } from "./terminal-cursor-blink.mjs";
import { installTerminalSelection } from "./terminal-selection.mjs";
import { plainRendererStatistics, setPlainRendererEnabled } from "./terminal-plain-renderer.mjs";
import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";
import { TerminalInputBuffer } from "./terminal-input-buffer.mjs";
import { TerminalScroll, terminalScrollMouseEvent } from "./terminal-scroll.mjs";
import { defaultTerminalRowSpacing, normalizeTerminalRowSpacing } from "./terminal-settings.mjs";
import { TerminalPrediction } from "./terminal-prediction.mjs";
import { TerminalPredictionOverlay } from "./terminal-prediction-overlay.mjs";

function loadTerminalClass(overrides = {}) {
  const source = readFileSync(new URL("./terminal-entry.js", import.meta.url), "utf8");
  const classSource = source.slice(source.indexOf("class Terminal extends"), source.indexOf("\nfunction setTerminalDocumentVisible"));
  return vm.runInNewContext(`${classSource}; Terminal`, {
    TerminalCursorBlink,
    installTerminalSelection,
    plainRendererStatistics,
    setPlainRendererEnabled,
    TerminalInputBuffer,
    TerminalScroll,
    terminalScrollMouseEvent,
    defaultTerminalRowSpacing,
    normalizeTerminalRowSpacing,
    TerminalPrediction,
    TerminalPredictionOverlay,
    TextDecoder,
    setTimeout,
    clearTimeout,
    __TESSERA_CORE_ID__: "test",
    SixelRenderer: class { prune() {} clear() {} },
    ...overrides,
  });
}

test("the browser adapter discards native file effects and query responses", () => {
  class GhosttyTerminal { constructor(options) { this.options = options; } onScroll() {} dispose() {} }
  const Terminal = loadTerminalClass({ GhosttyTerminal, renderScheduler: { unregister() {} } });
  const term = new Terminal();
  let allocated = 0, freed = 0, audio = 2, files = 2, replies = 2;
  const exports = {
    ghostty_wasm_alloc_u8_array() { allocated++; return 4; },
    ghostty_wasm_free_u8_array() { freed++; },
    tessera_audio_read() { return audio-- > 0 ? 1 : 0; },
    tessera_file_read() { return files-- > 0 ? 1 : 0; },
  };
  term.wasmTerm = { exports, handle: 1, readResponse() { return replies-- > 0 ? "query response" : ""; } };
  term.processTerminalResponses();
  assert.equal(files, -1); assert.equal(replies, -1);
  audio = files = replies = 2;
  term.wasmTerm.handle = 2; // A restored snapshot replaces only the core handle.
  term.processTerminalResponses();
  assert.equal(files, -1); assert.equal(replies, -1); assert.equal(allocated, 1);
  term.dispose(); assert.equal(freed, 1);
});

test("the terminal adapter suppresses startup autofocus and explicitly requests output frames", () => {
  let focuses = 0;
  let frames = 0;
  let writes = 0;
  class GhosttyTerminal {
    constructor(options) { this.options = options; }
    onScroll(callback) { this.scroll = callback; }
    open() {
      this.isOpen = true;
      this.element = { focus() { focuses++; } };
      this.focus();
    }
    focus() { assert.fail("library focus would schedule a delayed focus"); }
    write() { writes++; }
    clear() {}
    reset() {}
    dispose() { this.isDisposed = true; }
  }
  const Terminal = loadTerminalClass({
    GhosttyTerminal,
    renderScheduler: { request() { frames++; }, noteOutput() { frames++; }, unregister() {} },
  });
  const term = new Terminal({ cursorBlink: true });
  assert.equal(term.options.cursorBlink, false, "native blink timer is disabled");
  term.open({});
  assert.equal(focuses, 0);
  term.focus();
  assert.equal(focuses, 1);
  term.write("output");
  assert.equal(writes, 1);
  assert.equal(frames, 1);
  term.scroll();
  term.clear();
  term.reset();
  assert.equal(frames, 4, "scroll, clear, and reset request their own frames");
  term.dispose();
  term.focus();
  assert.equal(focuses, 1);
});

test("ordinary text and fallback symbols use separate font stacks", () => {
  let frames = 0;
  class GhosttyTerminal {
    constructor(options) { this.options = options; }
    onScroll() {}
  }
  const Terminal = loadTerminalClass({
    GhosttyTerminal,
    renderScheduler: { request() { frames++; }, unregister() {} },
  });
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", monospace',
    symbolFontFamily: '"JetBrains Mono", "Noto Sans Symbols 2", monospace',
  });
  term.renderer = {};

  term.setFontFamilies(
    '"Fira Code", monospace',
    '"Fira Code", "Noto Sans Symbols 2", monospace',
  );

  assert.equal(term.options.fontFamily, '"Fira Code", monospace');
  assert.equal(term.renderer.tesseraSymbolFontFamily, '"Fira Code", "Noto Sans Symbols 2", monospace');
  assert.equal(term.fullRedrawPending, true);
  assert.equal(frames, 1);
});

test("live output preserves history and pending gestures while explicit navigation cancels motion", () => {
  class GhosttyTerminal {
    constructor(options) {
      this.options = options; this.viewportY = 0; this.rows = 24; this.cols = 80;
      this.wasmTerm = { history: 100, isAlternateScreen: () => this.alternate === true };
    }
    onScroll() {}
    getScrollbackLength() { return this.wasmTerm.history; }
    showScrollbar() {}
    write(lines) { this.wasmTerm.history += lines; if (this.viewportY !== 0) this.scrollToBottom(); }
    scrollToBottom() { this.viewportY = 0; }
    scrollToTop() { this.viewportY = this.getScrollbackLength(); }
    scrollToLine(row) { this.viewportY = row; }
    scrollLines(lines) { this.viewportY -= lines; }
    clear() { this.viewportY = 0; }
    reset() { this.viewportY = 0; }
    dispose() {}
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal, performance,
    renderScheduler: { request() {}, noteOutput() {}, setPaused() {}, unregister() {} } });
  const term = new Terminal();
  term.write(3); assert.equal(term.viewportY, 0, "the live view still follows output");
  term.scrollToLine(20); term.write(5);
  assert.equal(term.viewportY, 25, "new history does not pull the reader back to the live view");
  term.scrollWheelLines(-5); term.write(3);
  assert.equal(term.viewportY, 28); assert.equal(term.smoothScroll.target, 33);
  term.scrollToBottom(); assert.equal(term.viewportY, 0); assert.equal(term.smoothScroll.target, null);
  term.write(3); assert.equal(term.viewportY, 0);
  for (const navigate of [() => term.scrollLines(1), () => term.scrollToLine(3),
    () => term.scrollToTop(), () => term.scrollToBottom(), () => term.clear(),
    () => term.reset(), () => term.setRenderPaused(true)]) {
    term.scrollToLine(5); term.scrollWheelLines(-4); navigate();
    assert.equal(term.smoothScroll.target, null);
    term.setRenderPaused(false);
  }
  term.scrollToLine(10); term.scrollWheelLines(-4);
  term.alternate = true; term.write(1);
  assert.equal(term.viewportY, 0); assert.equal(term.smoothScroll.target, null);
  term.alternate = false; term.scrollWheelLines(-5); term.dispose();
  assert.equal(term.smoothScroll.target, null);
});

test("row spacing can be selected before opening and refits metrics without clearing terminal content", () => {
  const calls = [];
  class GhosttyTerminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; }
    onScroll() {}
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal, renderScheduler: { request() { calls.push("redraw"); } } });
  const term = new Terminal();
  assert.equal(term.rowSpacing, "tight");
  assert.equal(term.options.rowSpacing, undefined, "Tessera owns this option");
  term.setRowSpacing("comfortable");
  assert.deepEqual(calls, []);
  term.wasmTerm = { transcript: "retained text" };
  term.renderer = {
    remeasureFont() { calls.push(this.tesseraRowSpacing); },
    resize(cols, rows) { calls.push([cols, rows]); },
  };
  term.setRowSpacing("comfortable");
  assert.deepEqual(calls, ["comfortable", [80, 24], "redraw"]);
  assert.equal(term.fullRedrawPending, true);
  term.setRowSpacing("invalid");
  assert.equal(term.renderer.tesseraRowSpacing, "tight");
  assert.equal(term.wasmTerm.transcript, "retained text");
});

test("canvas context loss retains output and redraws text and images on restoration", () => {
  const canvas = new EventTarget(), paints = [], requests = [], resizes = [];
  let lost = false, painted = 0, writes = 0, clearImages = 0, loseDuringPaint = false;
  class GhosttyTerminal {
    constructor(options) {
      this.options = options; this.cols = 80; this.rows = 24;
      this.viewportY = 0; this.scrollbarOpacity = 0; this.lastCursorY = 0;
      this.cursorMoveEmitter = { fire() {} };
      this.wasmTerm = { getCursor: () => ({ y: 0 }) };
    }
    onScroll() {}
    open() {
      this.isOpen = true;
      this.renderer = { canvas, ctx: { isContextLost: () => lost }, devicePixelRatio: 1,
        resize(...args) { resizes.push(args); },
        render(_buffer, force) { paints.push(force); if (loseDuringPaint) lost = true; } };
    }
    write() { writes++; }
    dispose() { this.isDisposed = true; }
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal, installTerminalSelection: () => null,
    SixelRenderer: class { prune() {} clear() { clearImages++; } },
    renderScheduler: { request() { requests.push(true); }, noteOutput() {}, unregister() {} } });
  const term = new Terminal({ cursorBlinkEnabled: false });
  term.open({}); term.outputTiming = { painted() { painted++; } };
  term.renderScheduledFrame(); assert.equal(painted, 1);
  lost = true; // The context can become lost before the event is dispatched.
  term.write("output while graphics unavailable"); term.renderScheduledFrame();
  assert.equal(writes, 1); assert.equal(paints.length, 1); assert.equal(painted, 1);
  const event = new Event("contextlost", { cancelable: true });
  canvas.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, "2D automatic restoration remains enabled");
  assert.equal(term.fullRedrawPending, true);
  const requestsBeforeRestore = requests.length;
  lost = false; canvas.dispatchEvent(new Event("contextrestored"));
  assert.deepEqual(resizes, [[80, 24]]); assert.equal(clearImages, 1);
  assert.equal(requests.length, requestsBeforeRestore + 1, "restoration schedules a paint even without new output");
  term.renderScheduledFrame(); assert.equal(paints.at(-1), true); assert.equal(painted, 2);
  term.renderScheduledFrame(); assert.equal(paints.at(-1), false);
  const paintedBeforeLoss = painted;
  loseDuringPaint = true; term.renderScheduledFrame();
  assert.equal(painted, paintedBeforeLoss, "a context lost during painting does not acknowledge output");
  assert.equal(term.fullRedrawPending, true);
  term.dispose(); const resizeCount = resizes.length, requestCount = requests.length;
  canvas.dispatchEvent(new Event("contextrestored")); canvas.dispatchEvent(new Event("contextlost"));
  assert.equal(resizes.length, resizeCount); assert.equal(requests.length, requestCount);
  assert.equal(term.canvasContextRecovery, null, "disposed terminals release their recovery listeners");
});

test("same-grid geometry forces a full redraw after clearing the canvas", () => {
  let bitmap = "content";
  const forcedRenders = [];
  const cursorInvalidations = [];
  class GhosttyTerminal {
    constructor(options) {
      this.options = options;
      this.cols = options.cols;
      this.rows = options.rows;
      this.viewportY = 0;
      this.scrollbarOpacity = 0;
      this.lastCursorY = 0;
      this.cursorMoveEmitter = { fire() {} };
    }
    onScroll() {}
  }
  const Terminal = loadTerminalClass({
    GhosttyTerminal,
    renderScheduler: { request() {}, setActive() {}, unregister() {} },
  });
  const term = new Terminal({ cols: 80, rows: 24 });
  term.isOpen = true;
  term.renderer = {
    cursorVisible: false,
    devicePixelRatio: 1,
    resize() { bitmap = "blank"; },
    render(_terminal, forceFullRedraw) {
      forcedRenders.push(forceFullRedraw);
      cursorInvalidations.push(this.cursorBlink);
      if (forceFullRedraw) bitmap = "content";
    },
  };
  term.wasmTerm = {
    handle: 1,
    resize() {}, // Ghostty does not dirty rows when the grid is unchanged.
    exports: { tessera_sixel_geometry() {} },
    getCursor() { return { y: 0 }; },
  };

  term.setCursorActive(true);
  term.applyGeometry(80, 24, 9, 16);
  assert.equal(bitmap, "blank", "resizing clears the canvas before its scheduled frame");
  term.renderScheduledFrame();
  assert.equal(bitmap, "content");
  assert.equal(cursorInvalidations[0], true, "a managed blink frame invalidates the cursor row");
  assert.equal(term.renderer.cursorBlink, false, "cursor invalidation is cleared after that frame");
  assert.deepEqual(forcedRenders, [true]);

  term.renderScheduledFrame();
  assert.deepEqual(forcedRenders, [true, false], "later idle frames retain dirty-row rendering");
  assert.equal(cursorInvalidations[1], false, "ordinary output frames do not repaint a clean cursor row");

  term.requestFullRedraw();
  term.renderScheduledFrame();
  assert.deepEqual(forcedRenders, [true, false, true], "wake recovery can explicitly repaint the canvas");
  term.setCursorActive(false);
});

test("a render ratio cap lowers Retina canvas resolution and can be removed", () => {
  const resized = [];
  class GhosttyTerminal {
    constructor(options) {
      this.options = options;
      this.cols = 80; this.rows = 24; this.viewportY = 0; this.scrollbarOpacity = 0;
      this.lastCursorY = 0; this.cursorMoveEmitter = { fire() {} };
    }
    onScroll() {}
  }
  const Terminal = loadTerminalClass({
    GhosttyTerminal,
    devicePixelRatio: 2,
    renderScheduler: { request() {}, unregister() {} },
  });
  const term = new Terminal({ renderPixelRatioCap: 1 });
  term.isOpen = true;
  term.renderer = {
    cursorVisible: false, devicePixelRatio: 2,
    resize() { resized.push(this.devicePixelRatio); }, render() {},
  };
  term.wasmTerm = { getCursor() { return { y: 0 }; } };

  term.renderScheduledFrame();
  assert.deepEqual(resized, [1]);
  term.setRenderPixelRatioCap(0);
  term.renderScheduledFrame();
  assert.deepEqual(resized, [1, 2]);
});

test("terminal activation and visibility transfer real scheduler painting priority", () => {
  let frame;
  const scheduler = new TerminalRenderScheduler({ now: () => 0,
    requestFrame(callback) { frame = callback; return 1; }, cancelFrame() { frame = null; } });
  class GhosttyTerminal {
    constructor(options) { this.options = options; }
    onScroll() {}
    dispose() {}
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal, renderScheduler: scheduler });
  const a = new Terminal({ cursorBlinkEnabled: false }), b = new Terminal({ cursorBlinkEnabled: false });
  const paints = [];
  a.renderScheduledFrame = () => paints.push("A"); b.renderScheduledFrame = () => paints.push("B");
  a.startRenderLoop(); b.startRenderLoop();
  b.setCursorActive(true); frame(0);
  assert.deepEqual(paints, ["B", "A"]);
  assert.equal(scheduler.activeTerminal, b, "a steady cursor still has painting priority");
  b.setCursorActive(false); a.setCursorActive(true);
  assert.equal(scheduler.activeTerminal, a);
  a.setRenderPaused(true);
  assert.equal(scheduler.activeTerminal, null);
  a.setRenderPaused(false); a.setCursorActive(true);
  assert.equal(scheduler.activeTerminal, a);
  a.dispose(); b.dispose();
  assert.equal(scheduler.activeTerminal, null);
  assert.equal(scheduler.entries.size, 0);
});

function responseTerminal(exports, readResponse = () => null) {
  class GhosttyTerminal {
    constructor(options) { this.options = options; }
    onScroll() {}
    write() { if (!this.isDisposed) this.processTerminalResponses(); }
    dispose() { this.isDisposed = true; }
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal,
    renderScheduler: { noteOutput() {}, request() {}, unregister() {} } });
  const term = new Terminal({ cursorBlinkEnabled: false });
  term.wasmTerm = { handle: 1, exports, readResponse };
  return term;
}

test("terminal writes reuse clipboard scratch space while draining every response and clipboard chunk", () => {
  const allocations = [], frees = [], reads = [], replies = ["reply one", "reply two", null];
  let pending = 9000;
  const exports = {
    ghostty_wasm_alloc_u8_array(size) { allocations.push(size); return 256; },
    ghostty_wasm_free_u8_array(ptr, size) { frees.push([ptr, size]); },
    tessera_sixel_clipboard_read(handle, ptr, size) {
      reads.push([handle, ptr, size]);
      const count = Math.min(size, pending); pending -= count; return count;
    },
  };
  const term = responseTerminal(exports, () => replies.shift() ?? null);
  assert.deepEqual(allocations, [], "unused terminals do not allocate scratch space");
  term.write("output");
  assert.deepEqual(replies, [], "all query responses are discarded before clipboard cleanup");
  assert.equal(pending, 0, "clipboard data larger than the scratch buffer is fully drained");
  assert.equal(reads.length, 4, "three nonempty chunks and one empty read");
  for (let i = 0; i < 100; i++) term.write("small output");
  assert.deepEqual(allocations, [4096]);
  assert.deepEqual(frees, [], "scratch space stays allocated between writes");
  assert.ok(reads.every(read => read[0] === 1 && read[1] === 256 && read[2] === 4096));
  term.dispose(); term.dispose();
  assert.deepEqual(frees, [[256, 4096]], "repeated disposal releases scratch space only once");
});

test("terminals that never drain clipboard data allocate no scratch buffer", () => {
  const unused = responseTerminal({ ghostty_wasm_alloc_u8_array() { assert.fail("unused terminal allocated"); } });
  unused.dispose(); unused.dispose();
  let responseReads = 0;
  const unsupported = responseTerminal({ ghostty_wasm_alloc_u8_array() { assert.fail("unsupported clipboard allocated"); } },
    () => ++responseReads === 1 ? "response" : null);
  unsupported.write("output");
  assert.equal(responseReads, 2, "query responses still drain without the clipboard extension");
  unsupported.dispose();
});

test("clipboard scratch allocation survives failed reads and is freed before native cleanup", () => {
  let allocations = 0, failing = true;
  const calls = [], exports = {
    ghostty_wasm_alloc_u8_array() { allocations++; return 128; },
    ghostty_wasm_free_u8_array(ptr, size) { calls.push(["scratch free", ptr, size]); },
    tessera_sixel_clipboard_read() { if (failing) throw new Error("clipboard read failed"); return 0; },
  };
  const term = responseTerminal(exports);
  assert.throws(() => term.write("output"), /clipboard read failed/);
  failing = false; term.write("next output");
  assert.equal(allocations, 1, "a retry reuses the already allocated buffer");
  const base = Object.getPrototypeOf(Object.getPrototypeOf(term));
  base.dispose = function() { calls.push(["native cleanup"]); this.isDisposed = true; };
  term.dispose();
  assert.deepEqual(calls, [["scratch free", 128, 4096], ["native cleanup"]]);
  assert.equal(term.clipboardReadBuffer, null);
});

test("terminals sharing a WASM module own and release separate clipboard scratch buffers", () => {
  let nextPtr = 128;
  const live = new Set(), reads = [], exports = {
    ghostty_wasm_alloc_u8_array() { const ptr = nextPtr; nextPtr += 4096; live.add(ptr); return ptr; },
    ghostty_wasm_free_u8_array(ptr) { assert.ok(live.delete(ptr), "buffer released once"); },
    tessera_sixel_clipboard_read(handle, ptr) { assert.ok(live.has(ptr)); reads.push([handle, ptr]); return 0; },
  };
  const a = responseTerminal(exports), b = responseTerminal(exports);
  b.wasmTerm.handle = 2;
  a.write("a"); b.write("b");
  assert.notEqual(reads[0][1], reads[1][1]);
  a.dispose(); b.write("b again");
  assert.equal(live.size, 1);
  assert.equal(reads[2][1], reads[1][1], "disposing a sibling preserves this terminal's scratch space");
  b.dispose(); assert.equal(live.size, 0);
});

test("real WASM titles reach the browser callback from bytes, snapshots, and repeated application requests", async () => {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports, titles = [];
  class GhosttyTerminal {
    constructor(options) { this.options = options; this.titleChangeEmitter = { fire: title => titles.push(title) }; }
    onScroll() {}
    clearSelection() {}
    write(data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const ptr = e.ghostty_wasm_alloc_u8_array(bytes.length);
      try {
        new Uint8Array(e.memory.buffer).set(bytes, ptr);
        e.ghostty_terminal_write(this.wasmTerm.handle, ptr, bytes.length);
      } finally { e.ghostty_wasm_free_u8_array(ptr, bytes.length); }
      this.checkForTitleChange(data);
    }
    reset() { this.write("\x1bc"); }
    dispose() { if (!this.isDisposed) { this.wasmTerm.free(); this.isDisposed = true; } }
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal,
    renderScheduler: { noteOutput() {}, request() {}, unregister() {} } });
  const term = new Terminal({ cursorBlinkEnabled: false });
  term.wasmTerm = { handle: e.ghostty_terminal_new(20, 6), exports: e, initCellPool() {}, free() { e.ghostty_terminal_free(this.handle); } };
  term.renderer = { resize() {} };
  try {
    const data = new TextEncoder().encode("\x1b]2;vim — 界\x07");
    term.write(data.subarray(0, 12));
    assert.deepEqual(titles, []);
    term.write(data.subarray(12));
    assert.deepEqual(titles, ["vim — 界"]);
    term.write("ordinary output");
    assert.equal(titles.length, 1);
    const length = e.tessera_sixel_snapshot_export(term.wasmTerm.handle);
    const snapshot = new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(term.wasmTerm.handle), length).slice();
    e.memory.grow(1);
    term.write("\x1b]0;other app\x1b\\");
    term.restoreSnapshot(snapshot, { cols: 20, rows: 6 });
    assert.deepEqual(titles, ["vim — 界", "other app", "vim — 界"]);
    term.write(data);
    assert.equal(titles.at(-1), "vim — 界");
    assert.equal(titles.length, 4, "a later identical request can replace a manual pane title");
    term.reset();
    term.write(data);
    assert.equal(titles.length, 5, "titles resume after a full reset");
  } finally { term.dispose(); }
});

test("real WASM clipboard draining reuses scratch space through reset, memory growth, and snapshot restoration", async () => {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports, handle = e.ghostty_terminal_new(20, 6);
  const counts = [], allocations = [], frees = [];
  const exports = { ...e,
    ghostty_wasm_alloc_u8_array(size) { const ptr = e.ghostty_wasm_alloc_u8_array(size); allocations.push([ptr, size]); return ptr; },
    ghostty_wasm_free_u8_array(ptr, size) { frees.push([ptr, size]); e.ghostty_wasm_free_u8_array(ptr, size); },
    tessera_sixel_clipboard_read(...args) { const count = e.tessera_sixel_clipboard_read(...args); counts.push(count); return count; },
  };
  class GhosttyTerminal {
    constructor(options) { this.options = options; }
    onScroll() {}
    clearSelection() {}
    write(text) {
      const data = new TextEncoder().encode(text), ptr = e.ghostty_wasm_alloc_u8_array(data.length);
      try {
        new Uint8Array(e.memory.buffer).set(data, ptr);
        e.ghostty_terminal_write(this.wasmTerm.handle, ptr, data.length);
      } finally { e.ghostty_wasm_free_u8_array(ptr, data.length); }
      this.processTerminalResponses();
    }
    reset() { this.write("\x1bc"); }
    dispose() { if (!this.isDisposed) { this.wasmTerm.free(); this.isDisposed = true; } }
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal,
    renderScheduler: { noteOutput() {}, request() {}, unregister() {} } });
  const term = new Terminal({ cursorBlinkEnabled: false });
  term.wasmTerm = { handle, exports, readResponse: () => null, initCellPool() {}, free() { e.ghostty_terminal_free(this.handle); } };
  term.renderer = { resize() {} };
  const clipboard = `\x1b]52;c;${Buffer.from("clipboard text ".repeat(800)).toString("base64")}\x07`;
  try {
    term.write(clipboard.slice(0, 100));
    const scratch = term.clipboardReadBuffer;
    assert.deepEqual(counts, [0], "incomplete clipboard sequences remain in the native parser");
    term.write(clipboard.slice(100));
    assert.ok(counts.filter(count => count > 0).length >= 3, "a completed large sequence drains in several reads");
    assert.equal(counts.at(-1), 0);
    e.memory.grow(1);
    term.reset(); term.write(clipboard);
    const length = e.tessera_sixel_snapshot_export(term.wasmTerm.handle);
    const snapshot = new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(term.wasmTerm.handle), length).slice();
    term.restoreSnapshot(snapshot, { cols: 20, rows: 6 });
    assert.notEqual(term.wasmTerm.handle, handle, "restoration replaces the native terminal handle");
    term.write(clipboard);
    assert.equal(term.clipboardReadBuffer, scratch);
    assert.equal(counts.at(-1), 0, "clipboard data is fully drained after handle replacement");
    assert.deepEqual(allocations.filter(([ptr]) => ptr === scratch.ptr), [[scratch.ptr, 4096]]);
    assert.equal(frees.some(([ptr]) => ptr === scratch.ptr), false);
    term.dispose(); term.dispose();
    assert.deepEqual(frees.filter(([ptr]) => ptr === scratch.ptr), [[scratch.ptr, 4096]]);
  } finally { term.dispose(); }
});

test("typing prediction draws at once and is erased in the paint that shows the echo", () => {
  const cells = new Map();
  const cursor = { x: 2, y: 0, visible: true };
  const drawn = [];
  const requested = [];
  class GhosttyTerminal {
    constructor(options) {
      this.options = options; this.cols = 80; this.rows = 24; this.viewportY = 0;
      this.scrollbarOpacity = 0; this.lastCursorY = 0; this.cursorMoveEmitter = { fire() {} };
    }
    onScroll() {}
    write(data) { for (const ch of data) { cells.set(`${cursor.x},${cursor.y}`, ch.charCodeAt(0)); cursor.x += 1; } }
  }
  class Overlay {
    constructor() { this.drawn = false; }
    draw(visible) { drawn.push(visible.cells.map(c => c.char).join("")); this.drawn = visible.cells.length > 0; }
    dispose() {}
  }
  const Terminal = loadTerminalClass({
    GhosttyTerminal, TerminalPredictionOverlay: Overlay,
    renderScheduler: { request: term => requested.push(term), noteOutput() {}, setActive() {}, unregister() {} },
  });
  const term = new Terminal({ cols: 80, rows: 24, predictionMode: "always" });
  term.isOpen = true;
  term.getScrollbackLength = () => 0;
  term.syncWindowTitle = () => {};
  term.renderer = { cursorVisible: false, devicePixelRatio: 1, render() {} };
  term.wasmTerm = {
    getCursor: () => ({ ...cursor }), isAlternateScreen: () => false,
    getGrapheme: (row, col) => [cells.get(`${col},${row}`) ?? 0],
  };
  globalThis.devicePixelRatio = 1;
  // The first character starts an unconfirmed epoch: nothing is drawn.
  term.predictInput("l");
  term.write("l");
  assert.equal(term.prediction.epochConfirmed, true);
  term.predictInput("s");
  assert.deepEqual(drawn, ["s"], "drawn immediately, before any paint");
  term.write("s");
  assert.deepEqual(drawn, ["s"], "kept until the paint that shows the echo");
  term.renderScheduledFrame();
  assert.deepEqual(drawn, ["s", ""], "erased together with that paint");
  // Enter ends the run; the next character waits for a fresh confirmation.
  term.predictInput("\r");
  term.predictInput("x");
  assert.deepEqual(drawn, ["s", ""]);
  term.resetPredictions();
});

test("the predicted cursor blinks with the real one and typing keeps both solid", () => {
  const cells = new Map();
  const cursor = { x: 2, y: 0, visible: true };
  const drawn = [];
  class GhosttyTerminal {
    constructor(options) {
      this.options = options; this.cols = 80; this.rows = 24; this.viewportY = 0;
      this.scrollbarOpacity = 0; this.lastCursorY = 0; this.cursorMoveEmitter = { fire() {} };
    }
    onScroll() {}
    write(data) { for (const ch of data) { cells.set(`${cursor.x},${cursor.y}`, ch.charCodeAt(0)); cursor.x += 1; } }
  }
  class Overlay {
    constructor() { this.drawn = false; }
    draw(visible) { drawn.push(visible.cursor ? "cursor" : "none"); this.drawn = visible.cells.length > 0; }
    dispose() {}
  }
  const Terminal = loadTerminalClass({
    GhosttyTerminal, TerminalPredictionOverlay: Overlay,
    renderScheduler: { request() {}, noteOutput() {}, setActive() {}, unregister() {} },
  });
  const term = new Terminal({ cols: 80, rows: 24, predictionMode: "always" });
  const timers = new Map();
  let id = 0;
  term.cursorBlink.timers = { setInterval(callback) { timers.set(++id, callback); return id; }, clearInterval(id) { timers.delete(id); } };
  term.isOpen = true;
  term.getScrollbackLength = () => 0;
  term.syncWindowTitle = () => {};
  term.renderer = { cursorVisible: false, devicePixelRatio: 1, render() {} };
  term.wasmTerm = {
    getCursor: () => ({ ...cursor }), isAlternateScreen: () => false,
    getGrapheme: (row, col) => [cells.get(`${col},${row}`) ?? 0],
  };
  globalThis.devicePixelRatio = 1;
  term.setCursorActive(true);
  const tick = () => [...timers.values()][0]();
  term.predictInput("l");
  term.write("l");
  term.predictInput("s");
  assert.deepEqual(drawn, ["cursor"]);
  tick();
  assert.equal(term.renderer.cursorVisible, false);
  term.renderScheduledFrame();
  assert.deepEqual(drawn, ["cursor", "none"], "the predicted cursor hides with the real one");
  tick();
  term.predictInput("x");
  assert.equal(term.cursorBlink.cursorVisible, true);
  tick();
  assert.equal(term.cursorBlink.cursorVisible, false, "it blinks again once typing stops");
  term.predictInput("y");
  assert.equal(term.cursorBlink.cursorVisible, true, "a key shows a hidden cursor at once");
  assert.equal(drawn.at(-1), "cursor");
  term.resetPredictions();
  term.cursorBlink.dispose();
});
