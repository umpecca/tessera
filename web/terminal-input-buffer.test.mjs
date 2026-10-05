import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { GhosttyTerminal } from "ghostty-web";
import { TerminalInputBuffer } from "./terminal-input-buffer.mjs";

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const allocations = [], frees = [], writes = [];
  let next = 256;
  const e = { memory,
    ghostty_wasm_alloc_u8_array(size) { allocations.push(size); const ptr = next; next += size; return ptr; },
    ghostty_wasm_free_u8_array(ptr, size) { frees.push([ptr, size]); },
    ghostty_terminal_write(handle, ptr, size) { writes.push([handle, new Uint8Array(memory.buffer, ptr, size).slice()]); },
  };
  class Buffer { constructor(handle = 1) { this.handle = handle; this.exports = e; } write() { throw new Error("original"); } }
  const buffer = new Buffer(), input = new TerminalInputBuffer(); input.attach(buffer);
  return { input, buffer, e, allocations, frees, writes };
}

test("reuses a lazy allocation, grows geometrically, and bounds retained input", () => {
  const { input, buffer, allocations, frees, writes } = fixture();
  buffer.write(""); assert.deepEqual(allocations, []);
  buffer.write("hello"); const ptr = input.ptr;
  buffer.write(new Uint8Array([1, 2, 3])); assert.equal(input.ptr, ptr);
  buffer.write(new Uint8Array(9000)); assert.equal(input.capacity, 16384);
  buffer.write(new Uint8Array(65536)); assert.equal(input.capacity, 65536);
  const retained = input.ptr;
  buffer.write(new Uint8Array(70000)); assert.equal(input.ptr, retained);
  assert.deepEqual(allocations, [8192, 16384, 65536, 70000]);
  assert.equal(frees.length, 3); assert.equal(writes.length, 5);
  assert.equal(new TextDecoder().decode(writes[0][1]), "hello");
  input.dispose(); input.dispose(); assert.equal(frees.length, 4);
  assert.equal(Object.hasOwn(buffer, "write"), false);
  assert.equal(input.capacity, 0); assert.throws(() => buffer.write("x"), /original/);
});

test("retains the allocation across new handles and resets, restores own methods, and frees on module changes", () => {
  const first = fixture(), second = fixture(); second.input.dispose();
  first.buffer.write("before"); const ptr = first.input.ptr;
  first.buffer.handle = 2; first.buffer.write("snapshot");
  assert.equal(first.writes.at(-1)[0], 2);
  const reset = { handle: 3, exports: first.e, write() {} }, original = reset.write;
  first.input.attach(reset); reset.write("reset");
  assert.equal(first.input.ptr, ptr); assert.equal(first.allocations.length, 1);
  assert.equal(Object.hasOwn(first.buffer, "write"), false);
  first.input.attach(second.buffer); assert.equal(reset.write, original);
  assert.deepEqual(first.frees, [[ptr, 8192]]);
  second.buffer.write("new module"); first.input.dispose();
  assert.equal(second.frees.length, 1);
});

test("reentrant writes use temporary memory without overwriting the outer input", () => {
  const { input, buffer, e, allocations, frees, writes } = fixture();
  const write = e.ghostty_terminal_write;
  let nested = false;
  e.ghostty_terminal_write = (handle, ptr, size) => {
    if (!nested) { nested = true; buffer.write("inner"); }
    write(handle, ptr, size);
  };
  buffer.write("outer");
  assert.deepEqual(writes.map(([, bytes]) => new TextDecoder().decode(bytes)), ["inner", "outer"]);
  assert.deepEqual(allocations, [8192, 5]); assert.equal(frees.length, 1);
  assert.equal(input.inUse, false); input.dispose();
});

test("memory growth preserves borrowed inputs and creates fresh views for subsequent writes", () => {
  const { input, buffer, e, writes } = fixture();
  new Uint8Array(e.memory.buffer).set([9, 8, 7], 32);
  const borrowed = new Uint8Array(e.memory.buffer, 32, 3);
  const allocate = e.ghostty_wasm_alloc_u8_array;
  e.ghostty_wasm_alloc_u8_array = size => { e.memory.grow(1); return allocate(size); };
  buffer.write(borrowed); assert.deepEqual([...writes[0][1]], [9, 8, 7]);
  e.memory.grow(1); buffer.write("fresh");
  assert.equal(new TextDecoder().decode(writes[1][1]), "fresh"); input.dispose();
});

test("allocation and parser failures preserve the retained buffer and release temporary input", () => {
  const { input, buffer, e, frees } = fixture();
  buffer.write("ok"); const ptr = input.ptr;
  const allocate = e.ghostty_wasm_alloc_u8_array;
  e.ghostty_wasm_alloc_u8_array = () => 0;
  assert.throws(() => buffer.write(new Uint8Array(9000)), /allocation failed/);
  assert.equal(input.ptr, ptr); assert.equal(frees.length, 0);
  e.ghostty_wasm_alloc_u8_array = allocate;
  e.ghostty_terminal_write = () => { throw new Error("parser failed"); };
  assert.throws(() => buffer.write("x"), /parser failed/); assert.equal(input.inUse, false);
  assert.throws(() => buffer.write(new Uint8Array(70000)), /parser failed/); assert.equal(frees.length, 1);
  input.dispose(); assert.equal(frees.length, 2);
});

test("two terminals never share input allocations or lifecycle", () => {
  const { input, buffer, e, allocations, frees } = fixture();
  const other = { handle: 2, exports: e, write() {} }, otherInput = new TerminalInputBuffer(); otherInput.attach(other);
  buffer.write("first"); other.write("second"); assert.notEqual(input.ptr, otherInput.ptr);
  input.dispose(); other.write("still alive"); assert.equal(allocations.length, 2);
  otherInput.dispose(); assert.equal(frees.length, 2);
});

test("real WASM preserves split UTF-8, parser replies, images, snapshots, and reset output", async () => {
  const bytes = await fs.readFile(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports, baseline = new GhosttyTerminal(e, e.memory, 40, 12);
  let current = new GhosttyTerminal(e, e.memory, 40, 12);
  let baselineFreed = false;
  const input = new TerminalInputBuffer(); input.attach(current);
  const compare = () => {
    const view = buffer => Array.from({ length: buffer.rows }, (_, row) => buffer.getLine(row));
    assert.deepEqual(view(current), view(baseline));
    assert.deepEqual(current.getCursor(), baseline.getCursor());
    assert.equal(e.tessera_sixel_image_count(current.handle), e.tessera_sixel_image_count(baseline.handle));
    assert.deepEqual(current.readResponse(), baseline.readResponse());
  };
  try {
    const utf8 = new TextEncoder().encode("Å界é🙂");
    const chunks = ["\x1b[31mANSI \x1b[0m", utf8.subarray(0, 4), utf8.subarray(4),
      "\x1b[6n\x1b[c", "\x1b]52;c;Y2xpcGJvYXJk\x07", "\x1b[?1049hother\x1b[?1049l",
      '\x1bPq"1;1;16;6#1;2;100;0;0!16~\x1b\\', "\r\noutput\r\n".repeat(9000)];
    for (const chunk of chunks) { baseline.write(chunk); current.write(chunk); compare(); }
    const ptr = input.ptr;
    const length = e.tessera_sixel_snapshot_export(current.handle);
    const snapshot = new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(current.handle), length).slice();
    const scratch = e.ghostty_wasm_alloc_u8_array(length);
    new Uint8Array(e.memory.buffer).set(snapshot, scratch);
    const handle = e.tessera_sixel_snapshot_import(scratch, length);
    e.ghostty_wasm_free_u8_array(scratch, length); assert.ok(handle);
    current.free(); current.handle = handle; current.initCellPool();
    baseline.write("snapshot output"); current.write("snapshot output"); compare(); assert.equal(input.ptr, ptr);
    current.free(); baseline.free(); baselineFreed = true;
    current = new GhosttyTerminal(e, e.memory, 40, 12); input.attach(current);
    const fresh = new GhosttyTerminal(e, e.memory, 40, 12);
    try {
      const output = Array.from({ length: 12 }, (_, row) => `reset output ${row}`.padEnd(40, ".")).join("\r\n");
      current.write(output); fresh.write(output);
      for (let row = 0; row < 12; row++) assert.deepEqual(current.getLine(row), fresh.getLine(row));
      assert.equal(current.getCursor().x, fresh.getCursor().x);
    }
    finally { fresh.free(); }
    assert.equal(input.ptr, ptr);
  } finally { input.dispose(); current.free(); if (!baselineFreed) baseline.free(); }
});
