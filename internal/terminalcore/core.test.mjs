import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const bytes = await fs.readFile(new URL("./ghostty-vt.wasm", import.meta.url));
async function terminal(cols = 20, rows = 6) {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
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
  function resize(c, r) { cols = c; rows = r; e.ghostty_terminal_resize(handle, c, r); e.tessera_sixel_geometry(handle, 2, 6); }
  return { e, get handle() { return handle; }, write, cursor, tiles, snapshot, restore, cells, resize, dispose() { e.ghostty_terminal_free(handle); } };
}
const sixel = '\x1bPq"1;1;4;12#1;2;100;0;0!4~-!4~\x1b\\';

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
