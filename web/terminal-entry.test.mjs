import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { TerminalCursorBlink } from "./terminal-cursor-blink.mjs";
import { plainRendererStatistics, setPlainRendererEnabled } from "./terminal-plain-renderer.mjs";

function loadTerminalClass(overrides = {}) {
  const source = readFileSync(new URL("./terminal-entry.js", import.meta.url), "utf8");
  const classSource = source.slice(source.indexOf("class Terminal extends"), source.indexOf("\nfunction setTerminalDocumentVisible"));
  return vm.runInNewContext(`${classSource}; Terminal`, {
    TerminalCursorBlink,
    plainRendererStatistics,
    setPlainRendererEnabled,
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
    renderScheduler: { request() { frames++; }, unregister() {} },
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
    renderScheduler: { request() {}, unregister() {} },
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
