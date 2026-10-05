import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { GhosttyTerminal } from "ghostty-web";
import { installTerminalViewportReader } from "./terminal-viewport.mjs";

async function nativeBuffer(cols = 20, rows = 6) {
  const bytes = await fs.readFile(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  return new GhosttyTerminal(instance.exports, instance.exports.memory, cols, rows);
}

test("real row reads share one decoded viewport and preserve independent cell copies", async () => {
  const buffer = await nativeBuffer();
  let reads = 0;
  const getViewport = buffer.getViewport;
  buffer.getViewport = function() { reads++; return getViewport.call(this); };
  const reader = buffer.getViewport;
  class Renderer {
    render(buffer) {
      const result = Array.from({ length: buffer.rows }, (_, row) => buffer.getLine(row));
      const copy = buffer.getLine(1);
      copy[0].codepoint = 0;
      assert.notEqual(buffer.getLine(1)[0].codepoint, 0);
      assert.notEqual(result[1][0], copy[0]);
      return result;
    }
  }
  installTerminalViewportReader(Renderer);
  try {
    buffer.write("\x1b[Hplain text\x1b[2;1H\x1b[1;31mÅÉgyp\x1b[0m\x1b[3;1H界é");
    const expected = Array.from({ length: buffer.rows }, (_, row) => buffer.getLine(row));
    reads = 0;
    assert.deepEqual(new Renderer().render(buffer), expected);
    assert.equal(reads, 1);
    assert.equal(buffer.getViewport, reader);
    buffer.getLine(0); buffer.getLine(1);
    assert.equal(reads, 3, "reads outside painting retain their ordinary fresh behavior");
  } finally { buffer.free(); }
});

test("every frame sees new native output, geometry, alternate screens, reset, and snapshot handles", async () => {
  const buffer = await nativeBuffer();
  class Renderer {
    render(buffer) { return Array.from({ length: buffer.rows }, (_, row) => buffer.getLine(row)); }
  }
  installTerminalViewportReader(Renderer);
  const renderer = new Renderer();
  const compare = () => {
    const expected = Array.from({ length: buffer.rows }, (_, row) => buffer.getLine(row));
    assert.deepEqual(renderer.render(buffer), expected);
    return expected;
  };
  try {
    buffer.write("first"); const first = compare();
    buffer.write("\x1b[Hlater"); const later = compare();
    assert.notDeepEqual(first, later);
    buffer.resize(12, 4); assert.equal(compare()[0].length, 12);
    buffer.write("\x1b[?1049h\x1b[Halternate"); const alternate = compare();
    buffer.write("\x1b[?1049l"); assert.notDeepEqual(compare(), alternate);
    const e = buffer.exports, length = e.tessera_sixel_snapshot_export(buffer.handle);
    const snapshot = new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(buffer.handle), length).slice();
    const saved = compare();
    buffer.write("\x1bc"); assert.notDeepEqual(compare(), saved);
    const ptr = e.ghostty_wasm_alloc_u8_array(length);
    let handle;
    try {
      new Uint8Array(e.memory.buffer).set(snapshot, ptr);
      handle = e.tessera_sixel_snapshot_import(ptr, length);
    } finally { e.ghostty_wasm_free_u8_array(ptr, length); }
    assert.ok(handle);
    buffer.free(); buffer.handle = handle; buffer.initCellPool();
    assert.deepEqual(compare(), saved);
  } finally { buffer.free(); }
});

test("history scratch reads and native memory growth cannot corrupt decoded viewport cells", async () => {
  const buffer = await nativeBuffer();
  let reads = 0;
  const getViewport = buffer.getViewport;
  buffer.getViewport = function() { reads++; return getViewport.call(this); };
  class Renderer {
    render(buffer) {
      const first = buffer.getLine(0);
      const history = buffer.getScrollbackLine(0);
      buffer.memory.grow(1);
      const last = buffer.getLine(buffer.rows - 1);
      return { first, history, last, repeated: buffer.getLine(0) };
    }
  }
  installTerminalViewportReader(Renderer);
  try {
    buffer.write(Array.from({ length: 20 }, (_, row) => `build ${row}`).join("\r\n"));
    const expected = { first: buffer.getLine(0), history: buffer.getScrollbackLine(0), last: buffer.getLine(buffer.rows - 1) };
    reads = 0;
    const result = new Renderer().render(buffer);
    assert.deepEqual(result, { ...expected, repeated: expected.first });
    assert.equal(reads, 1);
    assert.equal(Object.hasOwn(buffer, "getViewport"), true, "the caller's instrumentation is preserved");
  } finally { buffer.free(); }
});

test("idle, invalid-row, and history-only frames do not eagerly read the viewport", async () => {
  const buffer = await nativeBuffer();
  const reader = buffer.getViewport;
  buffer.getViewport = () => assert.fail("a frame without visible-screen row reads must remain lazy");
  class Renderer {
    render(buffer, mode) {
      assert.equal(buffer.getLine(-1), null);
      assert.equal(buffer.getLine(buffer.rows), null);
      if (mode === "history") return buffer.getScrollbackLine(0);
      return "idle";
    }
  }
  installTerminalViewportReader(Renderer);
  try {
    buffer.write("history\r\n".repeat(15));
    assert.equal(new Renderer().render(buffer), "idle");
    assert.ok(new Renderer().render(buffer, "history"));
  } finally { buffer.getViewport = reader; buffer.free(); }
});

test("paint and reader failures restore inherited methods and allow a fresh retry", () => {
  for (const failure of ["reader", "paint"]) {
    let failing = true, reads = 0;
    class Buffer {
      getViewport() {
        reads++;
        if (failing && failure === "reader") throw new Error("reader failed");
        return [{ codepoint: reads }];
      }
    }
    class Renderer {
      render(buffer) {
        const result = buffer.getViewport();
        if (failing) throw new Error("paint failed");
        assert.equal(buffer.getViewport(), result);
        return result;
      }
    }
    installTerminalViewportReader(Renderer);
    const buffer = new Buffer(), renderer = new Renderer(), reader = buffer.getViewport;
    assert.throws(() => renderer.render(buffer), /failed/);
    assert.equal(buffer.getViewport, reader); assert.equal(Object.hasOwn(buffer, "getViewport"), false);
    failing = false;
    assert.deepEqual(renderer.render(buffer), [{ codepoint: 2 }]);
    assert.equal(reads, 2);
    assert.equal(buffer.getViewport, reader); assert.equal(Object.hasOwn(buffer, "getViewport"), false);
  }
});

test("interleaved terminal paints retain separate viewport pools and restore own methods", () => {
  const reads = [0, 0], pools = [[{ codepoint: 65 }], [{ codepoint: 66 }]];
  const buffers = pools.map((pool, id) => ({ getViewport() { reads[id]++; return pool; } }));
  const readers = buffers.map(buffer => buffer.getViewport);
  class Renderer {
    render(buffer, nested) {
      const first = buffer.getViewport();
      if (nested) new Renderer().render(buffers[1]);
      assert.equal(buffer.getViewport(), first);
      return first;
    }
  }
  installTerminalViewportReader(Renderer);
  assert.equal(new Renderer().render(buffers[0], true), pools[0]);
  assert.deepEqual(reads, [1, 1]);
  buffers.forEach((buffer, id) => assert.equal(buffer.getViewport, readers[id]));
});

test("installation is idempotent and buffers without viewport readers retain original arguments", () => {
  const calls = [];
  class Renderer { render(...args) { calls.push([this, ...args]); return "painted"; } }
  installTerminalViewportReader(Renderer);
  const patched = Renderer.prototype.render;
  installTerminalViewportReader(Renderer);
  assert.equal(Renderer.prototype.render, patched);
  const renderer = new Renderer(), buffer = {}, provider = {};
  assert.equal(renderer.render(buffer, false, 2.5, provider, 0.5), "painted");
  assert.deepEqual(calls, [[renderer, buffer, false, 2.5, provider, 0.5]]);
});

test("partial paints read only requested rows, keep independent copies, and survive scratch growth", async () => {
  const buffer = await nativeBuffer(160, 60), reads = [], e = buffer.exports;
  buffer.exports = { ...e,
    tessera_sixel_viewport_row(...args) { reads.push(args[1]); return e.tessera_sixel_viewport_row(...args); },
    ghostty_render_state_get_viewport() { assert.fail("partial paints must not decode the full viewport"); },
  };
  class Renderer {
    render(buffer) {
      const first = buffer.getLine(10);
      first[0].codepoint = 0;
      buffer.getScrollbackLine(0);
      buffer.memory.grow(1);
      const second = buffer.getLine(11), repeated = buffer.getLine(10);
      return { second, repeated };
    }
  }
  installTerminalViewportReader(Renderer);
  try {
    buffer.write("history\r\n".repeat(100)); buffer.update(); buffer.markClean();
    buffer.write("\x1b[11;1H\x1b[1;31mÅ界é\x1b[0m\x1b[12;1Hnext");
    buffer.exports = e;
    const expected = { second: buffer.getLine(11), repeated: buffer.getLine(10) };
    buffer.exports = { ...e,
      tessera_sixel_viewport_row(...args) { reads.push(args[1]); return e.tessera_sixel_viewport_row(...args); },
      ghostty_render_state_get_viewport() { assert.fail("partial paints must not decode the full viewport"); },
    };
    assert.deepEqual(new Renderer().render(buffer), expected);
    assert.deepEqual(reads, [10, 11]);
    assert.equal(Object.hasOwn(buffer, "getLine"), false);
  } finally { buffer.exports = e; buffer.free(); }
});

test("many dirty rows and explicit full paints retain one bulk viewport read", async () => {
  const buffer = await nativeBuffer(160, 60), e = buffer.exports;
  let bulk = 0;
  buffer.exports = { ...e,
    tessera_sixel_viewport_row() { assert.fail("full paints must keep the bulk reader"); },
    ghostty_render_state_get_viewport(...args) { bulk++; return e.ghostty_render_state_get_viewport(...args); },
  };
  class Renderer {
    render(buffer) { for (let row = 0; row < buffer.rows; row++) buffer.getLine(row); }
  }
  installTerminalViewportReader(Renderer);
  try {
    buffer.write("initial"); buffer.update(); buffer.markClean();
    buffer.write(Array.from({ length: 10 }, (_, row) => `\x1b[${row + 1};1Hchanged`).join(""));
    new Renderer().render(buffer);
    assert.equal(bulk, 1);
    buffer.markClean(); new Renderer().render(buffer, true);
    assert.equal(bulk, 2);
  } finally { buffer.exports = e; buffer.free(); }
});

test("native row failures restore readers and a full retry sees correct styled and Unicode cells", async () => {
  const buffer = await nativeBuffer(40, 20), e = buffer.exports;
  class Renderer { render(buffer) { return buffer.getLine(0); } }
  installTerminalViewportReader(Renderer);
  const renderer = new Renderer();
  try {
    buffer.write("\x1b[31;1m界 é नमस्ते\x1b[0m"); buffer.update(); buffer.markClean();
    const expected = buffer.getLine(0), line = buffer.getLine, viewport = buffer.getViewport;
    buffer.exports = { ...e, tessera_sixel_viewport_row: () => -1 };
    assert.throws(() => renderer.render(buffer), /row read failed/);
    assert.equal(buffer.getLine, line); assert.equal(buffer.getViewport, viewport);
    assert.equal(Object.hasOwn(buffer, "getLine"), false);
    buffer.exports = e;
    assert.deepEqual(renderer.render(buffer, true), expected);
  } finally { buffer.exports = e; buffer.free(); }
});
