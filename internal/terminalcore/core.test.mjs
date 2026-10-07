import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const bytes = await fs.readFile(new URL("./ghostty-vt.wasm", import.meta.url));

function audioEffects(t) {
  const e = t.e, ptr = e.ghostty_wasm_alloc_u8_array(4096), chunks = [];
  try {
    for (let count; (count = e.tessera_audio_read(t.handle, ptr, 4096));) chunks.push(Buffer.from(new Uint8Array(e.memory.buffer, ptr, count)));
  } finally { e.ghostty_wasm_free_u8_array(ptr, 4096); }
  const data = Buffer.concat(chunks), records = [];
  for (let offset = 0; offset < data.length;) {
    const length = data.readUInt32LE(offset); offset += 4;
    records.push(data.subarray(offset, offset+length).toString()); offset += length;
  }
  return records;
}
async function terminal(cols = 20, rows = 6, sharedExports) {
  const e = sharedExports || (await WebAssembly.instantiate(bytes, { env: { log() {} } })).instance.exports;
  let handle = e.ghostty_terminal_new(cols, rows);
  assert.ok(handle);
  e.tessera_sixel_geometry(handle, 2, 6);
  function write(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (!bytes.length) return;
    const p = e.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(e.memory.buffer).set(bytes, p);
    e.ghostty_terminal_write(handle, p, bytes.length);
    e.ghostty_wasm_free_u8_array(p, bytes.length);
  }
  function cursor() {
    e.ghostty_render_state_update(handle);
    return [e.ghostty_render_state_get_cursor_x(handle), e.ghostty_render_state_get_cursor_y(handle)];
  }
  function tiles(viewport = 0) {
    const p = e.ghostty_wasm_alloc_u8_array(28 * 1000);
    const count = e.tessera_sixel_tiles(handle, viewport, p, 1000);
    const data = new Uint32Array(e.memory.buffer, p, count * 7).slice();
    e.ghostty_wasm_free_u8_array(p, 28 * 1000);
    return Array.from({ length: count }, (_, i) => [...data.slice(i * 7, i * 7 + 7)]);
  }
  function snapshot() {
    const length = e.tessera_sixel_snapshot_export(handle);
    assert.ok(length);
    return new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(handle), length).slice();
  }
  function restore(bytes) {
    const p = e.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(e.memory.buffer).set(bytes, p);
    const next = e.tessera_sixel_snapshot_import(p, bytes.length);
    e.ghostty_wasm_free_u8_array(p, bytes.length);
    assert.ok(next, "snapshot imports");
    e.ghostty_terminal_free(handle);
    handle = next;
  }
  function cells() {
    e.ghostty_render_state_update(handle);
    const p = e.ghostty_wasm_alloc_u8_array(cols * rows * 16);
    e.ghostty_render_state_get_viewport(handle, p, cols * rows);
    const value = new Uint8Array(e.memory.buffer, p, cols * rows * 16).slice();
    e.ghostty_wasm_free_u8_array(p, value.length);
    return value;
  }
  function grapheme(row, col, history = false) {
    e.ghostty_render_state_update(handle);
    const p = e.ghostty_wasm_alloc_u8_array(128);
    try {
      const read = history ? e.ghostty_terminal_get_scrollback_grapheme : e.ghostty_render_state_get_grapheme;
      const count = read(handle, row, col, p, 32);
      assert.ok(count >= 0);
      return [...new Uint32Array(e.memory.buffer, p, count)];
    } finally { e.ghostty_wasm_free_u8_array(p, 128); }
  }
  function resize(c, r) { cols = c; rows = r; e.ghostty_terminal_resize(handle, c, r); e.tessera_sixel_geometry(handle, 2, 6); }
  return { e, get handle() { return handle; }, write, cursor, tiles, snapshot, restore, cells, grapheme, resize, dispose() { e.ghostty_terminal_free(handle); } };
}

test("audio effects are transient across snapshots, including partial OSC and split ST", async () => {
  const sequence = "\x1b]777;tessera-audio;1;stop;clip\x1b\\";
  for (let split = 0; split <= sequence.length; split++) {
    const t = await terminal();
    try {
      t.write(sequence.slice(0, split));
      t.restore(t.snapshot());
      assert.deepEqual(audioEffects(t), [], "a snapshot never carries queued effects");
      t.write(sequence.slice(split));
      assert.deepEqual(audioEffects(t), split === sequence.length ? [] : ["stop;clip"], `split ${split}`);
    } finally { t.dispose(); }
  }
});
const sixel = '\x1bPq"1;1;4;12#1;2;100;0;0!4~-!4~\x1b\\';

test("closed terminals leave clean initial cells when WASM page memory is reused", async () => {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  // Browsers share one module across panes. Each former fixture loaded its own
  // module, hiding cells left in the allocator when a terminal's pool closes.
  for (let cycle = 0; cycle < 20; cycle++) {
    const terminals = await Promise.all(Array.from({ length: 8 }, () => terminal(80, 24, e)));
    try {
      for (const t of terminals) {
        t.write("ordinary build output for module\r\n".repeat(248));
        t.cells();
      }
    } finally { for (const t of terminals) t.dispose(); }
  }
  for (let cycle = 0; cycle < 6; cycle++) {
    const t = await terminal(160, 60, e);
    try {
      const initial = t.cells();
      const view = new DataView(initial.buffer, initial.byteOffset, initial.byteLength);
      for (let cell = 0; cell < 160 * 60; cell++) assert.equal(view.getUint32(cell * 16, true), 0, "new cell is blank");
      t.write("\x1b[H" + Array.from({ length: 60 }, (_, row) => `compiling module ${row}: `.repeat(12).slice(0, 159)).join("\r\n"));
      t.write("\x1b[5;3H" + sixel);
      assert.equal(e.tessera_sixel_image_count(t.handle), 1);
      for (let tick = 0; tick < 96; tick++) {
        t.write(`\x1b[60;1Hprogress ${tick.toString().padStart(6, "0")} \x1b[1;31mÅ界é नमस्ते\x1b[0m`);
        t.cells();
        e.ghostty_render_state_mark_clean(t.handle);
      }
      assert.equal(e.tessera_sixel_image_count(t.handle), 1);
      assert.deepEqual(t.grapheme(59, 19), [0x65, 0x301]);
      const cells = t.cells();
      t.restore(t.snapshot());
      assert.deepEqual(t.cells(), cells);
    } finally { t.dispose(); }
  }
});

test("image tracking preserves partial OSC and UTF-8 when switching back to ordinary parsing", async () => {
  const whole = await terminal(), split = await terminal();
  try {
    whole.write(sixel); split.write(sixel);
    const link = "\x1b[4;1H\x1b]8;;https://example.test\x1b\\linked\x1b]8;;\x1b\\";
    whole.write(link);
    split.write(link.slice(0, 24)); split.restore(split.snapshot()); split.write(link.slice(24));
    assert.deepEqual(split.cells(), whole.cells());
    const tail = new TextEncoder().encode("\x1b[H\x1b[2J😀é");
    whole.write(tail);
    split.write(tail.slice(0, 9));
    assert.equal(split.e.tessera_sixel_image_count(split.handle), 0);
    split.restore(split.snapshot()); split.write(tail.slice(9));
    assert.deepEqual(split.cells(), whole.cells());
    assert.deepEqual(split.grapheme(0, 2), [0x65, 0x301]);
    split.write(sixel + "\x1b[H\x1b[2J");
    assert.equal(split.e.tessera_sixel_image_count(split.handle), 0, "placement and erasure in one image-free write");
  } finally { split.dispose(); whole.dispose(); }
});

test("image-free row updates preserve attachments, then mutations reclaim them before any render", async () => {
  for (const erase of ["xxxx", "界界", "\x1b[4X", "\x1b[K", "\x1b[2K", "\x1b[18P", "\x1b[18@", "\x1b[4h" + "x".repeat(20)]) {
    const t = await terminal(20, 6);
    try {
      t.write('\x1b[2;3H\x1bPq"1;1;8;6#1;2;100;0;0!8~\x1b\\');
      const fragments = t.tiles();
      const pixels = t.e.tessera_sixel_image_pixels(t.handle, 1);
      for (let tick = 0; tick < 50; tick++) {
        t.write(`\x1b[6;1H\r\x1b[32mstatus ${tick}\x1b[0m\x1b[K`);
        t.cells(); t.e.ghostty_render_state_mark_clean(t.handle);
      }
      assert.deepEqual(t.tiles(), fragments);
      assert.equal(t.e.tessera_sixel_image_pixels(t.handle, 1), pixels);
      t.write("\x1b[2;3H" + erase);
      assert.equal(t.e.tessera_sixel_image_count(t.handle), 0, JSON.stringify(erase));
      assert.equal(t.e.tessera_sixel_image_pixels(t.handle, 1), 0);
    } finally { t.dispose(); }
  }
});

test("single native row reads match full viewport bytes and reject out-of-range requests", async () => {
  const t = await terminal(40, 12);
  const p = t.e.ghostty_wasm_alloc_u8_array(40 * 16);
  try {
    t.write("\x1b[31;1mÅ 界 é नमस्ते\x1b[0m\x1b[4;1H\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\");
    const full = t.cells();
    for (let row = 0; row < 12; row++) {
      assert.equal(t.e.tessera_sixel_viewport_row(t.handle, row, p, 40), 40);
      assert.deepEqual(new Uint8Array(t.e.memory.buffer, p, 40 * 16), full.subarray(row * 40 * 16, (row + 1) * 40 * 16));
    }
    assert.equal(t.e.tessera_sixel_viewport_row(t.handle, 12, p, 40), -1);
    assert.equal(t.e.tessera_sixel_viewport_row(t.handle, 0, p, 39), -1);
    assert.equal(t.e.tessera_sixel_viewport_row(t.handle, 0xffffffff, p, 40), -1);
  } finally { t.e.ghostty_wasm_free_u8_array(p, 40 * 16); t.dispose(); }
});

for (const [name, text, first] of [
  ["combining", "é output", [0x65, 0x301]],
  ["Devanagari", "देवनागरी output", [0x926, 0x947]],
  ["mixed Unicode", "ÅÉgyp 界 é देवनागरी output", [0xc5]],
]) test(`${name} survives page growth, history eviction, reflow, and snapshots`, async () => {
  const t = await terminal(80, 24);
  try {
    const chunk = (`\x1b[32m${text}\x1b[0m\r\n`).repeat(128);
    for (let batch = 0; batch < 100; batch++) {
      t.write(chunk);
      // Exercise both deferred render updates and clean-state updates.
      if (batch % 2) { t.cells(); t.e.ghostty_render_state_mark_clean(t.handle); }
    }
    assert.equal(t.e.ghostty_terminal_get_scrollback_length(t.handle), 10000);
    assert.deepEqual(t.grapheme(0, 0), first);
    assert.deepEqual(t.grapheme(0, 0, true), first);
    t.resize(100, 30);
    const cells = t.cells(), cursor = t.cursor();
    assert.deepEqual(t.grapheme(0, 0), first);
    t.restore(t.snapshot());
    assert.deepEqual(t.cells(), cells);
    assert.deepEqual(t.cursor(), cursor);
    assert.deepEqual(t.grapheme(0, 0), first);
    assert.deepEqual(t.grapheme(0, 0, true), first);
    t.write("\x1b[Hé देवनागरी\x1b[K");
    assert.deepEqual(t.grapheme(0, 0), [0x65, 0x301]);
    assert.deepEqual(t.grapheme(0, 2), [0x926, 0x947]);
  } finally { t.dispose(); }
});

test("dense Sixel fits a 16 MiB budget and retains pixels through snapshots", async () => {
  const t = await terminal(80, 24);
  try {
    assert.equal(t.e.tessera_sixel_image_settings(t.handle, 16, 1), 1);
    const stripes = Array.from({ length: 120 }, (_, band) => band % 2 ? "#2!1024~-" : "#1!1024~-").join("");
    const image = '\x1bPq"1;1;1024;720#1;2;100;0;0#2;2;0;100;0' + stripes + "\x1b\\";
    // A snapshot during construction must preserve its growth capacity.
    const midpoint = Math.floor(image.length / 2);
    t.write(image.slice(0, midpoint));
    t.restore(t.snapshot());
    t.write(image.slice(midpoint));
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 1);
    function pixels() {
      const info = t.e.ghostty_wasm_alloc_u8_array(28);
      try {
        assert.equal(t.e.tessera_sixel_image_info(t.handle, 0, info), 1);
        const [, width, height, stride] = new Uint32Array(t.e.memory.buffer, info, 7);
        assert.equal(width, 1024); assert.equal(height, 720); assert.equal(stride, 1024);
        const p = t.e.tessera_sixel_image_pixels(t.handle, 1);
        assert.ok(p, "image pixels are retained rather than evicted");
        const data = new Uint32Array(t.e.memory.buffer, p, stride * height);
        for (let y = 0; y < height; y++) {
          const expected = Math.floor(y / 6) % 2 ? 0xff00ff00 : 0xff0000ff;
          for (let x = 0; x < width; x++) assert.equal(data[y * stride + x], expected);
        }
      } finally { t.e.ghostty_wasm_free_u8_array(info, 28); }
    }
    pixels();
    assert.ok(t.tiles().length > 0);
    t.restore(t.snapshot());
    pixels();
    t.write("ok\x1b[6n");
    assert.deepEqual(t.cursor(), [2, 23]);
  } finally { t.dispose(); }
});

test("decoded storage evicts the oldest image deterministically", async () => {
  const t = await terminal(80, 24);
  try {
    const blank = '\x1bPq"1;1;4000;2000\x1b\\';
    t.write(blank); t.write("\x1b[H" + blank);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 2);
    t.write("\x1b[H" + blank);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 3, "evicted image keeps a lightweight descriptor");
    assert.equal(t.e.tessera_sixel_image_pixels(t.handle, 1), 0);
    assert.ok(t.e.tessera_sixel_image_pixels(t.handle, 2));
    assert.ok(t.e.tessera_sixel_image_pixels(t.handle, 3));
  } finally { t.dispose(); }
});

test("image settings evict immediately, survive snapshots, and reset preserves preferences", async () => {
  const t = await terminal(80, 24);
  try {
    t.write('\x1bPq"1;1;2000;3000\x1b\\');
    assert.ok(t.e.tessera_sixel_image_pixels(t.handle, 1));
    assert.equal(t.e.tessera_sixel_image_settings(t.handle, 16, 0), 1);
    assert.equal(t.e.tessera_sixel_image_pixels(t.handle, 1), 0);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 1, "placeholder metadata survives eviction");
    const state = t.snapshot();
    t.restore(state);
    assert.equal(t.e.tessera_sixel_image_settings_read(t.handle), 16);
    assert.equal(t.e.tessera_sixel_image_pixels(t.handle, 1), 0);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 1);
    assert.equal(t.e.tessera_sixel_image_settings(t.handle, 32, 1), 1);
    assert.equal(t.e.tessera_sixel_image_pixels(t.handle, 1), 0, "raising budget does not recreate pixels");
    t.write("\x1bc");
    assert.equal(t.e.tessera_sixel_image_settings_read(t.handle), 32 | 256);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
    assert.equal(t.e.tessera_sixel_image_settings(t.handle, 128, 1), 0);
    assert.equal(t.e.tessera_sixel_image_settings_read(t.handle), 32 | 256);
  } finally { t.dispose(); }
});

test("clear images preserves both screens' text and cursor, and consumes an unfinished image", async () => {
  const t = await terminal();
  try {
    t.write("primary\r\n" + sixel + "\x1b[?1049hALT\r\n" + sixel);
    const cells = t.cells(), cursor = t.cursor();
    t.write(sixel.slice(0, -2));
    t.e.tessera_sixel_clear_images(t.handle);
    assert.deepEqual(t.cells(), cells);
    assert.deepEqual(t.cursor(), cursor);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
    t.restore(t.snapshot());
    t.write("\x1b\\");
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0, "in-flight image stays discarded after reconnect");
    assert.deepEqual(t.cursor(), cursor);
    t.write("\x1b[?1049l");
    assert.equal(t.tiles().length, 0);
    t.write(sixel);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 1, "new images still work");
  } finally { t.dispose(); }
});

test("lowering the budget discards a too-large image under construction", async () => {
  const t = await terminal();
  try {
    // Level-one raster grows beyond 16 MiB before the terminator arrives.
    t.write('\x1bPq' + ('!2000~-').repeat(500));
    t.e.tessera_sixel_image_settings(t.handle, 16, 1);
    t.write("\x1b\\ok");
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
    assert.deepEqual(t.cursor(), [2, 0]);
  } finally { t.dispose(); }
});

test("overlong encoded input and repaint work are rejected through termination", async () => {
  const t = await terminal();
  try {
    t.write("\x1bPq");
    const ignored = " ".repeat(8192);
    for (let i = 0; i < 4097; i++) t.write(ignored);
    t.write("#1;2;100;0;0~\x1b\\ok");
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
    assert.deepEqual(t.cursor(), [2, 0]);
    t.write("\x1bPq!1000000~\x1b\\Z");
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
    assert.deepEqual(t.cursor(), [3, 0]);
  } finally { t.dispose(); }
});

test("cell and line insertion/deletion preserve surviving fragments", async () => {
  const t = await terminal();
  try {
    t.write("\x1b[2;3H" + sixel + "\x1b[2;3H\x1b[@");
    assert.deepEqual(t.tiles().map(x => x.slice(1, 3)), [[3, 1], [4, 1], [2, 2], [3, 2]]);
    t.write("\x1b[P");
    assert.deepEqual(t.tiles().map(x => x.slice(1, 3)), [[2, 1], [3, 1], [2, 2], [3, 2]]);
    t.write("\x1b[L");
    assert.deepEqual(t.tiles().map(x => x.slice(1, 3)), [[2, 2], [3, 2], [2, 3], [3, 3]]);
    t.write("\x1b[M");
    assert.equal(t.tiles().length, 4);
    t.write("\x1b[2;3H\x1b[X");
    assert.equal(t.tiles().length, 3);
    t.write("\x1b[K");
    assert.equal(t.tiles().length, 2);
  } finally { t.dispose(); }
});

test("images survive line copies across multiple pages and are reclaimed on erasure", async () => {
  const t = await terminal(256, 128);
  try {
    for (const row of [1, 30, 60, 90, 120]) t.write(`\x1b[${row};3H` + sixel);
    const before = t.tiles();
    assert.equal(before.length, 20);
    t.write("\x1b[H\x1b[L");
    assert.deepEqual(t.tiles(), before.map(tile => tile.map((value, index) => index === 2 ? value + 1 : value)));
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 5);
    t.write("\x1b[H\x1b[M");
    assert.deepEqual(t.tiles(), before);
    t.restore(t.snapshot());
    t.write("\x1b[128;1Hstatus");
    assert.deepEqual(t.tiles(), before);
    t.write("\x1b[2J");
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
    assert.equal(t.tiles().length, 0);
  } finally { t.dispose(); }
});

test("image pages remain live through large-history reflow, snapshots, and history clearing", async () => {
  const t = await terminal(80, 24);
  try {
    t.write(sixel);
    t.write("\r\n" + ("x".repeat(79) + "\r\n").repeat(600));
    const historyTiles = () => t.tiles(t.e.ghostty_terminal_get_scrollback_length(t.handle));
    const before = historyTiles();
    assert.equal(before.length, 4);
    t.resize(40, 24);
    assert.deepEqual(historyTiles(), before);
    t.restore(t.snapshot());
    t.write("\x1b[Hstatus");
    assert.deepEqual(historyTiles(), before);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 1);
    t.write("\x1b[3J");
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
    assert.equal(historyTiles().length, 0);
  } finally { t.dispose(); }
});

test("bottom scrolling, scrolling region, and DECSDM placement", async () => {
  const t = await terminal();
  try {
    t.write("\x1b[2;5r\x1b[5;3H" + sixel);
    assert.deepEqual(t.cursor(), [2, 4]);
    assert.deepEqual(t.tiles().map(x => x.slice(1, 3)), [[2, 3], [3, 3], [2, 4], [3, 4]]);
    t.write("\x1b[2J\x1b[?80h\x1b[3;8H" + sixel);
    assert.deepEqual(t.cursor(), [7, 2]);
    assert.deepEqual(t.tiles().map(x => x.slice(1, 3)), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  } finally { t.dispose(); }
});

test("image cursor placement is absolute inside origin-mode margins", async () => {
  const t = await terminal();
  try {
    t.write("\x1b[2;5r\x1b[?6h\x1b[1;3H" + sixel);
    assert.deepEqual(t.cursor(), [2, 2]);
    t.write("X");
    assert.equal(t.tiles().length, 3);
  } finally { t.dispose(); }
});

test("reflow, font geometry, and snapshot preserve image coverage", async () => {
  const t = await terminal();
  try {
    t.write("abcdefghijklmnopqr" + sixel);
    t.resize(10, 6);
    assert.equal(t.tiles().length, 4);
    const before = t.tiles();
    t.e.tessera_sixel_geometry(t.handle, 4, 12);
    assert.deepEqual(t.tiles(), before);
    t.restore(t.snapshot());
    assert.deepEqual(t.tiles(), before);
  } finally { t.dispose(); }
});

test("image survives output outside replay budget and expires with history", async () => {
  const t = await terminal();
  try {
    t.write(sixel);
    const output = "\x1b[0m".repeat(2048);
    for (let i = 0; i < 513; i++) t.write(output);
    t.restore(t.snapshot());
    assert.equal(t.tiles().length, 4);
    t.write("\r\n".repeat(12000));
    assert.equal(t.e.ghostty_terminal_get_scrollback_length(t.handle), 10000);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
  } finally { t.dispose(); }
});

test("oversize input is consumed and transparent layering survives erasure", async () => {
  const t = await terminal();
  try {
    t.write('\x1bPq"1;1;99999;99999!999999999~\x1b\\ok');
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
    assert.deepEqual(t.cursor(), [2, 0]);
    t.write("\x1b[H" + sixel + "\x1b[H\x1bP0;1q#2;2;0;100;0@\x1b\\");
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 2);
    assert.equal(t.tiles().length, 5);
    t.write("\x1b[2J");
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
  } finally { t.dispose(); }
});

test("native Sixel at a nonzero cursor, followed by text", async () => {
  const t = await terminal();
  try {
    t.write("\x1b[2;3H" + sixel);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 1);
    assert.deepEqual(t.cursor(), [2, 2]);
    assert.equal(t.tiles().length, 4);
    t.write("X");
    assert.equal(t.tiles().length, 3);
    assert.deepEqual(t.cursor(), [3, 2]);
  } finally { t.dispose(); }
});

test("all fragment boundaries preserve pixels and placement", async () => {
  for (let split = 0; split <= sixel.length; split++) {
    const t = await terminal();
    try {
      t.write(sixel.slice(0, split));
      t.write(sixel.slice(split));
      assert.equal(t.tiles().length, 4, `split ${split}`);
      assert.deepEqual(t.cursor(), [0, 1]);
    } finally { t.dispose(); }
  }
});

test("cancelled Sixel never places an image", async () => {
  for (const cancel of ["\x18", "\x1a"]) {
    const t = await terminal();
    try {
      t.write(sixel.slice(0, -2) + cancel + "ok");
      assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
      assert.deepEqual(t.cursor(), [2, 0]);
    } finally { t.dispose(); }
  }
});

test("erasure releases image resources", async () => {
  const t = await terminal();
  try {
    t.write(sixel);
    t.write("\x1b[2J");
    assert.equal(t.tiles().length, 0);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 0);
  } finally { t.dispose(); }
});

test("images follow scrollback and stay separate on alternate screen", async () => {
  const t = await terminal();
  try {
    t.write(sixel);
    t.write("\r\n".repeat(6));
    assert.equal(t.tiles().length, 0);
    assert.equal(t.tiles(6).length, 4);
    t.write("\x1b[?1049h" + sixel);
    assert.equal(t.tiles().length, 4);
    t.write("\x1b[?1049l");
    assert.equal(t.tiles().length, 0);
    assert.equal(t.tiles(6).length, 4);
  } finally { t.dispose(); }
});

test("snapshots preserve both screens, styled text, image cells and continuation", async () => {
  const a = await terminal();
  const b = await terminal();
  try {
    a.write("\x1b[31mhello 😀\r\n" + sixel + "\x1b[?1049h" + "ALT\x1b7" + sixel);
    b.restore(a.snapshot());
    assert.deepEqual(b.cells(), a.cells());
    assert.deepEqual(b.tiles(), a.tiles());
    for (const input of ["\x1b8!", "\x1b[?1049l", "\r\ncontinued", "\x1b[2J"]) {
      a.write(input); b.write(input);
      assert.deepEqual(b.cells(), a.cells());
      assert.deepEqual(b.tiles(), a.tiles());
      assert.deepEqual(b.cursor(), a.cursor());
    }
  } finally { a.dispose(); b.dispose(); }
});

test("snapshots resume partial Sixel, UTF-8, CSI and OSC sequences", async () => {
  for (const text of [sixel, "\x1b[31mRED", "😀", "\x1b]8;;https://example.com\x1b\\link"]) {
    const data = new TextEncoder().encode(text);
    for (let split = 1; split < data.length; split++) {
      const a = await terminal();
      const b = await terminal();
      try {
        a.write(data.subarray(0, split));
        b.restore(a.snapshot());
        a.write(data.subarray(split)); b.write(data.subarray(split));
        assert.deepEqual(b.cells(), a.cells(), `${JSON.stringify(text)} at ${split}`);
        assert.deepEqual(b.tiles(), a.tiles());
        assert.deepEqual(b.cursor(), a.cursor());
      } finally { a.dispose(); b.dispose(); }
    }
  }
});
