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
import { TerminalLinkHover } from "./terminal-link-hover.mjs";
import { defaultTerminalPointerShape, terminalPointerShape } from "./terminal-pointer-shape.mjs";
import { adjacentPrompt, commandOutput, lastCommandOutput, promptStarts } from "./terminal-prompts.mjs";
import { terminalColorTheme, terminalThemeWithProgramColors } from "./terminal-colors.mjs";
import { terminalKittyKeyEvent } from "./terminal-kitty-keyboard.mjs";

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
    TerminalLinkHover,
    defaultTerminalPointerShape,
    terminalPointerShape,
    adjacentPrompt,
    commandOutput,
    lastCommandOutput,
    promptStarts,
    terminalThemeWithProgramColors,
    OSC8LinkProvider: class {},
    UrlRegexProvider: class {},
    HyperlinkProvider: class {},
    RoutedLinkProvider: class {},
    replaceLinkProvider() {},
    TextDecoder,
    setTimeout,
    clearTimeout,
    synchronizedOutputTimeoutMs: 1000,
    searchUpdateDelayMs: 150,
    searchMatchLimit: 10000,
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
    assert.deepEqual(titles.slice(4), [""], "a reset says the program's title is gone, once");
    term.write("\x1bc");
    assert.equal(titles.length, 5);
    term.write(data);
    assert.equal(titles.length, 6, "titles resume after a full reset");
    term.write("\x1b[22;0t\x1b]2;nested\x07");
    term.write("\x1b[23;0t");
    assert.deepEqual(titles.slice(6), ["nested", "vim — 界"], "a popped title comes back");
    term.write("\x1b]2;x\x07");
    term.write("\x1bc");
    term.write("\x1bc");
    assert.deepEqual(titles.slice(8), ["x", ""], "a title cleared by RIS, once");
  } finally { term.dispose(); }
});

test("real WASM working directory and pointer shape reports reach the pane", async () => {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  class GhosttyTerminal {
    constructor(options) { this.options = options; this.titleChangeEmitter = { fire() {} }; }
    onScroll() {}
    clearSelection() {}
    write(data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const ptr = e.ghostty_wasm_alloc_u8_array(bytes.length);
      try {
        new Uint8Array(e.memory.buffer).set(bytes, ptr);
        e.ghostty_terminal_write(this.wasmTerm.handle, ptr, bytes.length);
      } finally { e.ghostty_wasm_free_u8_array(ptr, bytes.length); }
    }
    reset() { this.write("\x1bc"); }
    dispose() { if (!this.isDisposed) { this.wasmTerm.free(); this.isDisposed = true; } }
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal,
    renderScheduler: { noteOutput() {}, request() {}, unregister() {} } });
  const term = new Terminal({ cursorBlinkEnabled: false });
  term.wasmTerm = { handle: e.ghostty_terminal_new(20, 6), exports: e, initCellPool() {}, free() { e.ghostty_terminal_free(this.handle); } };
  term.renderer = { resize() {} };
  term.element = { style: { cursor: "text" } };
  const reports = [];
  const listener = term.onWorkingDirectoryChange(report => reports.push(report));
  try {
    term.write("\x1b]7;file://studio/Users/me\x1b\\");
    term.write("plain output");
    term.write("\x1b]7;file://studio/Users/me\x07\x1b]7;file://studio/tmp\x07");
    assert.deepEqual(reports, ["file://studio/Users/me", "file://studio/tmp"],
      "one report per write, the last one, even when it repeats the directory");

    term.write("\x1b]22;crosshair\x07");
    assert.equal(term.element.style.cursor, "crosshair");
    term.currentHoveredLink = {};
    term.element.style.cursor = "pointer"; // ghostty-web over a link
    term.write("\x1b]22;grab\x07");
    assert.equal(term.element.style.cursor, "pointer", "a link under the pointer keeps the hand");
    term.currentHoveredLink = undefined;
    term.element.style.cursor = "text"; // ghostty-web leaving the link
    term.applyPointerShape();
    assert.equal(term.element.style.cursor, "grab");

    const length = e.tessera_sixel_snapshot_export(term.wasmTerm.handle);
    const snapshot = new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(term.wasmTerm.handle), length).slice();
    term.write("\x1b]22;default\x07");
    term.restoreSnapshot(snapshot, { cols: 20, rows: 6 });
    assert.equal(term.element.style.cursor, "grab", "the shape comes back with the snapshot");
    term.write("output");
    assert.equal(reports.length, 2, "a restored snapshot reports no directory of its own");

    term.reset();
    assert.equal(term.element.style.cursor, "text");
    listener.dispose();
    term.write("\x1b]7;file://studio/var\x07");
    assert.equal(reports.length, 2);
  } finally { term.dispose(); }
});

test("real WASM prompt marks drive prompt jumps and command output selection", async () => {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  const rowText = [];
  class GhosttyTerminal {
    constructor(options) { this.options = options; this.titleChangeEmitter = { fire() {} }; this.viewportY = 0; this.cols = 20; this.rows = 4; }
    onScroll() {}
    write(data) {
      const bytes = new TextEncoder().encode(data);
      const ptr = e.ghostty_wasm_alloc_u8_array(bytes.length);
      try {
        new Uint8Array(e.memory.buffer).set(bytes, ptr);
        e.ghostty_terminal_write(this.wasmTerm.handle, ptr, bytes.length);
      } finally { e.ghostty_wasm_free_u8_array(ptr, bytes.length); }
    }
    getScrollbackLength() { return e.ghostty_terminal_get_scrollback_length(this.wasmTerm.handle); }
    getSelection() {
      const { selectionStart: start, selectionEnd: end } = this.selectionManager;
      return rowText.slice(start.absoluteRow, end.absoluteRow + 1).join("\n");
    }
    dispose() { if (!this.isDisposed) { this.wasmTerm.free(); this.isDisposed = true; } }
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal,
    renderScheduler: { noteOutput() {}, request() {}, unregister() {} } });
  const term = new Terminal({ cursorBlinkEnabled: false });
  term.wasmTerm = { handle: e.ghostty_terminal_new(20, 4), exports: e, free() { e.ghostty_terminal_free(this.handle); } };
  term.renderer = { resize() {} };
  const scrolls = [];
  term.smoothScrollTo = (position) => scrolls.push(position);
  const events = [];
  term.selectionManager = {
    clearSelection() { events.push("clear"); },
    markCurrentSelectionDirty() { events.push("dirty"); },
    selectionChangedEmitter: { fire() { events.push("changed"); } },
  };
  term.buffer = { active: {
    get length() { return term.getScrollbackLength() + 4; },
    getLine: (row) => ({ translateToString: () => rowText[row] ?? "" }),
  } };
  try {
    const command = (name, output) => `\x1b]133;A\x07$ \x1b]133;B\x07${name}\r\n\x1b]133;C\x07${output}\x1b]133;D;0\x07`;
    term.write(command("ls", "a\r\nb\r\n") + command("pwd", "/tmp\r\n") + "\x1b]133;A\x07$ \x1b]133;B\x07");
    rowText.push("$ ls", "a", "b", "$ pwd", "/tmp", "$ ");
    assert.deepEqual([...term.semanticMarks()], [1, 4, 0, 1, 4, 1]);

    // Two rows are in scrollback; the view is at the bottom (top row 2).
    assert.equal(term.scrollToPrompt(-1), true);
    assert.deepEqual(scrolls, [2], "the first prompt at the top");
    term.viewportY = 2;
    assert.equal(term.scrollToPrompt(-1), false, "nothing above the first prompt");
    assert.equal(term.scrollToPrompt(1), true);
    assert.deepEqual(scrolls, [2, 0], "the next prompt is on screen, so back to the bottom");

    assert.equal(term.selectCommandOutput(), "/tmp");
    assert.deepEqual({ ...term.selectionManager.selectionStart }, { col: 0, absoluteRow: 4 });
    assert.deepEqual({ ...term.selectionManager.selectionEnd }, { col: 19, absoluteRow: 4 });
    assert.deepEqual(events, ["clear", "dirty", "changed"]);
    assert.equal(term.selectCommandOutput(2), "a\nb", "the command at or above a row");
    assert.equal(term.selectCommandOutput(5), "", "the waiting prompt has no output yet");
  } finally { term.dispose(); }
});

test("real WASM colour changes recolour the renderer theme and padding", async () => {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  class GhosttyTerminal {
    constructor(options) { this.options = options; this.titleChangeEmitter = { fire() {} }; }
    onScroll() {}
    clearSelection() {}
    write(data) {
      const bytes = new TextEncoder().encode(data);
      const ptr = e.ghostty_wasm_alloc_u8_array(bytes.length);
      try {
        new Uint8Array(e.memory.buffer).set(bytes, ptr);
        e.ghostty_terminal_write(this.wasmTerm.handle, ptr, bytes.length);
      } finally { e.ghostty_wasm_free_u8_array(ptr, bytes.length); }
    }
    reset() { this.write("\x1bc"); }
    dispose() { if (!this.isDisposed) { this.wasmTerm.free(); this.isDisposed = true; } }
  }
  let frames = 0;
  const Terminal = loadTerminalClass({ GhosttyTerminal,
    renderScheduler: { noteOutput() {}, request() { frames++; }, unregister() {} } });
  const term = new Terminal({ cursorBlinkEnabled: false });
  term.wasmTerm = { handle: e.ghostty_terminal_new(20, 4), exports: e, initCellPool() {}, free() { e.ghostty_terminal_free(this.handle); } };
  e.tessera_sixel_configure(term.wasmTerm.handle, 0);
  const base = terminalColorTheme("dark");
  term.renderer = { resize() {}, theme: { ...base } };
  term.element = { style: { background: base.background } };
  try {
    term.write("plain output");
    assert.deepEqual({ ...term.renderer.theme }, base, "nothing set, nothing changed");
    term.write("\x1b]11;#202428\x07\x1b]12;#ff8800\x07");
    assert.equal(term.renderer.theme.background, "#202428");
    assert.equal(term.renderer.theme.cursor, "#ff8800");
    assert.equal(term.renderer.theme.selectionForeground, "#202428");
    assert.equal(term.element.style.background, "#202428", "the padding around the grid too");
    assert.equal(term.fullRedrawPending, true);

    const length = e.tessera_sixel_snapshot_export(term.wasmTerm.handle);
    const snapshot = new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(term.wasmTerm.handle), length).slice();
    term.write("\x1b]111\x07\x1b]112\x07");
    assert.deepEqual({ ...term.renderer.theme }, base, "reset gives back the pane's colours");
    term.restoreSnapshot(snapshot, { cols: 20, rows: 4 });
    assert.equal(term.renderer.theme.background, "#202428", "a restored snapshot brings them back");
    term.reset();
    assert.deepEqual({ ...term.renderer.theme }, base);
    assert.ok(frames > 0);
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

test("real WASM synchronized output holds painting until the redraw ends, at most a second", async () => {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  const handle = e.ghostty_terminal_new(20, 4);
  const timers = new Map();
  let nextTimer = 0, requests = 0;
  const Terminal = loadTerminalClass({
    GhosttyTerminal: class {},
    setTimeout: (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  const term = Object.create(Terminal.prototype);
  Object.assign(term, { synchronizedOutputTimer: null, synchronizedOutputTimedOut: false, requestRender() { requests++; } });
  term.wasmTerm = { getMode: (mode, ansi) => e.ghostty_terminal_get_mode(handle, mode, ansi) !== 0 };
  const write = (text) => {
    const data = new TextEncoder().encode(text), ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    new Uint8Array(e.memory.buffer).set(data, ptr);
    e.ghostty_terminal_write(handle, ptr, data.length);
    e.ghostty_wasm_free_u8_array(ptr, data.length);
  };
  const fire = () => { const [id, timer] = [...timers][0]; timers.delete(id); timer.callback(); };
  try {
    assert.equal(term.holdingSynchronizedOutput(), false, "painting as usual");
    write("\x1b[?2026h\x1b[2Jhalf a redraw");
    assert.equal(term.holdingSynchronizedOutput(), true, "held mid-redraw");
    assert.equal(term.holdingSynchronizedOutput(), true);
    assert.equal(timers.size, 1, "one timer however many frames are held");
    assert.equal([...timers.values()][0].ms, 1000);
    write(" and the rest\x1b[?2026l");
    assert.equal(term.holdingSynchronizedOutput(), false, "the end of the redraw paints it");
    assert.equal(timers.size, 0);

    write("\x1b[?2026h");
    assert.equal(term.holdingSynchronizedOutput(), true);
    fire();
    assert.equal(requests, 1, "the timeout asks for a paint");
    assert.equal(term.holdingSynchronizedOutput(), false, "a program that never ends it is painted after a second");
    write("more output");
    assert.equal(term.holdingSynchronizedOutput(), false, "and stays painted while the mode stays on");
    write("\x1b[?2026l\x1b[?2026h");
    assert.equal(term.holdingSynchronizedOutput(), false, "not held again until a paint finds the mode off");
    write("\x1b[?2026l");
    assert.equal(term.holdingSynchronizedOutput(), false);
    write("\x1b[?2026h");
    assert.equal(term.holdingSynchronizedOutput(), true, "then the next redraw is held");
    write("\x1b[?2026l\x1b[?2026h");
    assert.equal(term.holdingSynchronizedOutput(), true, "one redraw ending and the next starting in one write");
    assert.equal(timers.size, 1, "keeps the first one's timer, so a stream of redraws is still painted each second");

    e.ghostty_terminal_resize(handle, 30, 4);
    assert.equal(term.holdingSynchronizedOutput(), false, "a resize ends it");
    assert.equal(timers.size, 0);

    term.wasmTerm.exports = e; term.wasmTerm.handle = handle;
    write("\x1b[?2026hleft open");
    assert.equal(term.holdingSynchronizedOutput(), true);
    const before = requests;
    term.endSynchronizedOutput();
    assert.equal(requests, before + 1, "the host's end asks for a paint");
    assert.equal(term.holdingSynchronizedOutput(), false, "and ends the hold");
    assert.equal(e.ghostty_terminal_get_mode(handle, 2026, false), 0, "in the browser's core too");
  } finally { e.ghostty_terminal_free(handle); }
});

test("a held synchronized-output frame paints nothing and the next frame paints it", () => {
  const paints = [];
  let holding = true, painted = 0;
  class GhosttyTerminal {
    constructor() {
      this.cols = 80; this.rows = 24; this.viewportY = 0; this.scrollbarOpacity = 0; this.lastCursorY = 0;
      this.cursorMoveEmitter = { fire() {} };
      this.wasmTerm = { getCursor: () => ({ y: 0 }), getMode: (mode) => mode === 2026 && holding };
    }
    onScroll() {}
    open() {
      this.isOpen = true;
      this.renderer = { canvas: new EventTarget(), ctx: {}, devicePixelRatio: 1, resize() {}, render(_buffer, force) { paints.push(force); } };
    }
    write() {}
    dispose() { this.isDisposed = true; }
  }
  const Terminal = loadTerminalClass({ GhosttyTerminal, installTerminalSelection: () => null,
    renderScheduler: { request() {}, noteOutput() {}, unregister() {} } });
  const term = new Terminal({ cursorBlinkEnabled: false });
  term.open({}); term.outputTiming = { painted() { painted++; } };
  term.fullRedrawPending = true;
  term.renderScheduledFrame();
  assert.deepEqual(paints, [], "nothing is drawn mid-redraw");
  assert.equal(painted, 0, "and the output is not counted as shown");
  holding = false;
  term.renderScheduledFrame();
  assert.deepEqual(paints, [true], "a full redraw asked for meanwhile still happens");
  assert.equal(painted, 1);
  term.dispose();
});

test("real WASM scrollback search: matches, selection, scrolling, highlights and live output", async () => {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  const handle = e.ghostty_terminal_new(20, 5);
  const timers = new Map();
  let nextTimer = 0, redraws = 0;
  const Terminal = loadTerminalClass({
    GhosttyTerminal: class {}, TextEncoder,
    setTimeout: (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  const term = Object.create(Terminal.prototype);
  Object.assign(term, {
    searchNeedle: "", searchCount: 0, searchResults: null, searchTimer: null, searchRevision: 0, searchRowsCache: null,
    searchListeners: new Set(), cols: 20, rows: 5, viewportY: 0, smoothScroll: { target: null }, scrolledTo: [],
    wasmTerm: { exports: e, handle },
    getScrollbackLength: () => e.ghostty_terminal_get_scrollback_length(handle),
    smoothScrollTo(y) { this.scrolledTo.push(y); this.viewportY = y; },
    requestFullRedraw() { redraws++; },
  });
  const write = (text) => {
    const data = new TextEncoder().encode(text), ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    new Uint8Array(e.memory.buffer).set(data, ptr);
    e.ghostty_terminal_write(handle, ptr, data.length);
    e.ghostty_wasm_free_u8_array(ptr, data.length);
  };
  // Values made in the sandbox compare by content only once copied.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const heard = [];
  const subscription = term.onSearchChange(results => heard.push(results && { count: results.count, selected: results.selected }));
  try {
    write("old needle\r\n");
    for (let i = 0; i < 20; i++) write(`line ${i}\r\n`);
    write("new needle");
    const results = term.search("Needle");
    assert.equal(results.count, 2);
    assert.equal(results.selected, 0);
    assert.deepEqual(plain(results.matches), [[21, 4, 21, 9], [0, 4, 0, 9]], "newest first, rows from the top of history");
    assert.deepEqual(plain(term.scrolledTo), [], "the newest already shows");
    assert.equal(redraws, 1);
    assert.deepEqual(plain([...term.searchRowsInView()]), [[4, [[4, 9, true]]]], "highlighted on the last row, selected");

    assert.equal(term.searchSelect(true), true);
    assert.deepEqual(plain(term.scrolledTo), [17], "the older match is scrolled into view, at the top of history");
    assert.deepEqual(plain([...term.searchRowsInView()]), [[0, [[4, 9, true]]]]);
    assert.equal(term.searchSelect(true), false, "no older one");
    assert.equal(term.searchSelect(false), true);

    write("\r\nneedle again\r\n");
    term.scheduleSearchUpdate();
    term.scheduleSearchUpdate();
    assert.equal(timers.size, 1, "one update for a burst of output");
    const [[id, timer]] = timers; timers.delete(id);
    assert.equal(timer.ms, 150);
    timer.callback();
    assert.equal(term.searchResults.count, 3, "new output is searched");
    assert.deepEqual(heard.at(-1), { count: 3, selected: 1 }, "the selection stays on its match");

    term.search("");
    assert.equal(term.searchResults, null);
    assert.equal(term.searchRowsInView(), null);
    assert.deepEqual(heard.at(-1), null);
    term.scheduleSearchUpdate();
    assert.equal(timers.size, 0, "no updates without a search");

    term.search("needle");
    term.searchNeedle = "needle";
    e.tessera_search_end(handle);
    term.restartSearch();
    assert.equal(term.searchResults.count, 3, "a new core searches again");
  } finally { subscription.dispose(); e.ghostty_terminal_free(handle); }
});

test("real WASM Kitty keyboard encoding, from browser key events", async () => {
  const bytes = readFileSync(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  const Terminal = loadTerminalClass({ GhosttyTerminal: class {}, TextEncoder });
  const handle = e.ghostty_terminal_new(20, 4);
  const term = Object.create(Terminal.prototype);
  term.wasmTerm = { exports: e, handle };
  term.getMode = (mode) => mode === 1036;
  const write = (text) => {
    const data = new TextEncoder().encode(text), ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    new Uint8Array(e.memory.buffer).set(data, ptr);
    e.ghostty_terminal_write(handle, ptr, data.length);
    e.ghostty_wasm_free_u8_array(ptr, data.length);
  };
  const k = (fields) => ({ key: "", code: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...fields });
  const send = (event, { apple = false, action = "press" } = {}) => {
    const fields = terminalKittyKeyEvent(event, { appleKeyboard: apple, action });
    return fields && term.encodeKeyEvent(fields, term.kittyKeyboardFlags());
  };
  try {
    assert.equal(term.kittyKeyboardFlags(), 0);
    write("\x1b[>1u");
    assert.equal(term.kittyKeyboardFlags(), 1, "read from the core");
    const disambiguate = [
      [k({ key: "a", code: "KeyA" }), "a"],
      [k({ key: "A", code: "KeyA", shiftKey: true }), "A"],
      [k({ key: "!", code: "Digit1", shiftKey: true }), "!"],
      [k({ key: "Escape", code: "Escape" }), "\x1b[27u"],
      [k({ key: "i", code: "KeyI", ctrlKey: true }), "\x1b[105;5u"],
      [k({ key: "Tab", code: "Tab" }), "\t"],
      [k({ key: "Tab", code: "Tab", shiftKey: true }), "\x1b[9;2u"],
      [k({ key: "Enter", code: "Enter" }), "\r"],
      [k({ key: "Enter", code: "Enter", shiftKey: true }), "\x1b[13;2u"],
      [k({ key: "Backspace", code: "Backspace" }), "\x7f"],
      [k({ key: "Backspace", code: "Backspace", ctrlKey: true }), "\x1b[127;5u"],
      [k({ key: "a", code: "KeyA", altKey: true }), "\x1b[97;3u"],
      [k({ key: "c", code: "KeyC", ctrlKey: true }), "\x1b[99;5u"],
      [k({ key: "ArrowUp", code: "ArrowUp" }), "\x1b[A"],
      [k({ key: "F5", code: "F5" }), "\x1b[15~"],
      [k({ key: "Home", code: "Numpad7" }), "\x1b[57423u"],
      [k({ key: "é", code: "" }), "é"],
    ];
    for (const [event, expected] of disambiguate) assert.equal(send(event), expected, JSON.stringify(event));
    assert.equal(send(k({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }), { apple: true }), "\x1b[H", "Command+Left is Home");
    assert.equal(send(k({ key: "s", code: "KeyS", metaKey: true }), { apple: true }), null, "Command+S is not sent");
    assert.equal(send(k({ key: "Dead", code: "KeyE", altKey: true }), { apple: true }), "", "a dead key waits for its composition");
    assert.equal(send(k({ key: "a", code: "KeyA" }), { action: "release" }), "", "no releases without flag 2");

    write("\x1b[=3u");
    assert.equal(send(k({ key: "a", code: "KeyA" }), { action: "release" }), "\x1b[97;1:3u");
    assert.equal(send(k({ key: "a", code: "KeyA" }), { action: "repeat" }), "a");
    assert.equal(send(k({ key: "Escape", code: "Escape" }), { action: "release" }), "\x1b[27;1:3u");
    assert.equal(send(k({ key: "Enter", code: "Enter" }), { action: "release" }), "", "Enter's release only with flag 8");

    write("\x1b[=9u");
    assert.equal(send(k({ key: "a", code: "KeyA" })), "\x1b[97u");
    assert.equal(send(k({ key: "A", code: "KeyA", shiftKey: true })), "\x1b[97;2u");
    assert.equal(send(k({ key: "Enter", code: "Enter" })), "\x1b[13u");
    assert.equal(send(k({ key: "Shift", code: "ShiftLeft", shiftKey: true })), "\x1b[57441;2u");
    write("\x1b[=13u");
    assert.equal(send(k({ key: "A", code: "KeyA", shiftKey: true })), "\x1b[97:65;2u", "the shifted key as an alternate");
    write("\x1b[=25u");
    assert.equal(send(k({ key: "a", code: "KeyA" })), "\x1b[97;;97u", "with its text");

    write("\x1b[<u");
    assert.equal(term.kittyKeyboardFlags(), 0, "popped back to ordinary encoding");
  } finally {
    term.keyEncoder && e.ghostty_key_encoder_free(term.keyEncoder.handle);
    e.ghostty_terminal_free(handle);
  }
});
