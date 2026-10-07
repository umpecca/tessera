import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { TerminalCursorBlink } from "./terminal-cursor-blink.mjs";
import { installTerminalSelection } from "./terminal-selection.mjs";
import { plainRendererStatistics, setPlainRendererEnabled } from "./terminal-plain-renderer.mjs";
import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";
import { TerminalInputBuffer } from "./terminal-input-buffer.mjs";
import { defaultTerminalRowSpacing, normalizeTerminalRowSpacing } from "./terminal-settings.mjs";

function loadTerminalClass(overrides = {}) {
  const source = readFileSync(new URL("./terminal-entry.js", import.meta.url), "utf8");
  const classSource = source.slice(source.indexOf("class Terminal extends"), source.indexOf("\nfunction setTerminalDocumentVisible"));
  return vm.runInNewContext(`${classSource}; Terminal`, {
    TerminalCursorBlink,
    installTerminalSelection,
    plainRendererStatistics,
    setPlainRendererEnabled,
    TerminalInputBuffer,
    defaultTerminalRowSpacing,
    normalizeTerminalRowSpacing,
    __TESSERA_CORE_ID__: "test",
    SixelRenderer: class { prune() {} clear() {} },
    ...overrides,
  });
}

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
