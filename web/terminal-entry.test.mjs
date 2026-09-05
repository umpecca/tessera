import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { TerminalCursorBlink } from "./terminal-cursor-blink.mjs";

test("the terminal adapter suppresses startup autofocus and explicitly requests output frames", () => {
  const source = readFileSync(new URL("./terminal-entry.js", import.meta.url), "utf8");
  const classSource = source.slice(source.indexOf("class Terminal extends"), source.indexOf("\nfunction setTerminalDocumentVisible"));
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
  const Terminal = vm.runInNewContext(`${classSource}; Terminal`, {
    GhosttyTerminal, TerminalCursorBlink, __TESSERA_CORE_ID__: "test",
    SixelRenderer: class { prune() {} clear() {} },
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
