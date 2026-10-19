import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { terminalPointerShapes } from "../../web/terminal-pointer-shape.mjs";

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
function fileEffects(t) {
  const e = t.e, ptr = e.ghostty_wasm_alloc_u8_array(4096), chunks = [];
  try {
    for (let count; (count = e.tessera_file_read(t.handle, ptr, 4096));) chunks.push(Buffer.from(new Uint8Array(e.memory.buffer, ptr, count)));
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

function windowTitle(t) {
  const length = t.e.tessera_sixel_title_length(t.handle);
  if (!length) return "";
  return new TextDecoder().decode(new Uint8Array(t.e.memory.buffer, t.e.tessera_sixel_title_data(t.handle), length));
}

function workingDirectory(t) {
  const length = t.e.tessera_pwd_length(t.handle);
  return new TextDecoder().decode(new Uint8Array(t.e.memory.buffer, t.e.tessera_pwd_data(t.handle), length));
}

test("OSC 7 keeps the last working directory report, split anywhere", async () => {
  const sequence = "\x1b]7;file://host.local/Users/me/My%20Project\x1b\\";
  for (let split = 0; split <= sequence.length; split++) {
    const t = await terminal();
    try {
      assert.equal(t.e.tessera_pwd_revision(t.handle), 0);
      t.write(sequence.slice(0, split));
      t.write(sequence.slice(split));
      assert.equal(workingDirectory(t), "file://host.local/Users/me/My%20Project");
    } finally { t.dispose(); }
  }
  const t = await terminal();
  try {
    t.write("\x1b]7;file:///tmp\x07");
    const revision = t.e.tessera_pwd_revision(t.handle);
    for (const ignored of ["\x1b]7;\x07", `\x1b]7;file://${"x".repeat(8193)}\x07`]) {
      t.write(ignored);
      assert.equal(workingDirectory(t), "file:///tmp");
      assert.equal(t.e.tessera_pwd_revision(t.handle), revision);
    }
    t.write("\x1b]7;file:///tmp\x07");
    assert.notEqual(t.e.tessera_pwd_revision(t.handle), revision, "a repeated report still counts");
    t.write("\x1b]2;Title\x07plain text");
    assert.equal(workingDirectory(t), "file:///tmp");
  } finally { t.dispose(); }
});

function semanticRows(t, row, count) {
  const e = t.e, ptr = e.ghostty_wasm_alloc_u8_array(count);
  try {
    const n = e.tessera_semantic_rows(t.handle, row, count, ptr);
    return [...new Uint8Array(e.memory.buffer, ptr, n)];
  } finally { e.ghostty_wasm_free_u8_array(ptr, count); }
}

test("OSC 133 marks are read per row, through scrollback and snapshots", async () => {
  const t = await terminal(20, 4);
  try {
    const command = (name, output) => `\x1b]133;A\x1b\\$ \x1b]133;B\x1b\\${name}\r\n\x1b]133;C\x1b\\${output}\x1b]133;D;0\x1b\\`;
    t.write(command("ls", "a\r\nb\r\n") + command("true", "") + command("pwd", "/tmp\r\n") + "\x1b]133;A\x07$ \x1b]133;B\x07");
    // Each prompt row keeps its prompt mark through OSC 133;B, including the
    // one after a command that printed nothing.
    const expected = [1, 4, 0, 1, 1, 4, 1];
    assert.deepEqual(semanticRows(t, 0, 10), expected, "three rows in scrollback, four on screen");
    assert.deepEqual(semanticRows(t, 4, 2), [1, 4]);
    assert.deepEqual(semanticRows(t, 7, 2), [], "past the last row");
    t.write("\r\n> \x1b]133;B\x07");
    assert.deepEqual(semanticRows(t, 7, 1), [3], "B on a row without a prompt mark marks input");
    t.write("x".repeat(25));
    assert.deepEqual(semanticRows(t, 7, 2), [3, 8 | 3], "a soft-wrapped row is flagged and keeps the input mark");
    t.restore(t.snapshot());
    assert.deepEqual(semanticRows(t, 0, 10), [...expected, 3, 8 | 3], "a snapshot keeps the marks");
    t.write("\x1b[?1049h");
    assert.deepEqual(semanticRows(t, 0, 4), [0, 0, 0, 0], "the alternate screen has none");
  } finally { t.dispose(); }
});

function replies(t) {
  const e = t.e, ptr = e.ghostty_wasm_alloc_u8_array(4096);
  try {
    let text = "";
    for (let n; (n = e.ghostty_terminal_read_response(t.handle, ptr, 4096)) > 0;) text += Buffer.from(new Uint8Array(e.memory.buffer, ptr, n)).toString();
    return text;
  } finally { e.ghostty_wasm_free_u8_array(ptr, 4096); }
}
function dynamicColors(t) {
  const e = t.e, ptr = e.ghostty_wasm_alloc_u8_array(20);
  try {
    e.tessera_dynamic_colors(t.handle, ptr);
    const view = new DataView(e.memory.buffer, ptr, 20);
    return [0, 1, 2, 3, 4].map((index) => view.getUint32(index * 4, true));
  } finally { e.ghostty_wasm_free_u8_array(ptr, 20); }
}
// The first cell's foreground and background as rendered.
function firstCell(t) {
  const cells = t.cells();
  return { fg: [...cells.slice(4, 7)], bg: [...cells.slice(7, 10)] };
}

test("OSC 4/104 set, query and reset the palette, and cells use it", async () => {
  const t = await terminal(20, 4);
  try {
    t.e.tessera_sixel_configure(t.handle, 0);
    replies(t);
    const revision = t.e.tessera_color_revision(t.handle);
    t.write("\x1b]4;1;#102030;200;rgb:ff/80/00\x1b\\\x1b[31;48;5;200mX");
    assert.deepEqual(firstCell(t), { fg: [0x10, 0x20, 0x30], bg: [0xff, 0x80, 0x00] });
    assert.notEqual(t.e.tessera_color_revision(t.handle), revision);
    t.write("\x1b]4;1;?;7;?\x07");
    assert.equal(replies(t), "\x1b]4;1;rgb:1010/2020/3030\x07\x1b]4;7;rgb:e5e5/e5e5/e5e5\x07", "BEL in, BEL out");
    const queried = t.e.tessera_color_revision(t.handle);
    t.write("\x1b]4;1;?\x1b\\");
    assert.equal(replies(t), "\x1b]4;1;rgb:1010/2020/3030\x1b\\");
    assert.equal(t.e.tessera_color_revision(t.handle), queried, "a query changes nothing");
    t.write("\x1b]104;1\x07\r");
    t.write("\x1b[31;48;5;200mX");
    assert.deepEqual(firstCell(t), { fg: [0xcd, 0, 0], bg: [0xff, 0x80, 0x00] }, "one entry reset");
    t.write("\x1b]104\x07\r\x1b[31;48;5;200mX");
    assert.deepEqual(firstCell(t).bg, [0xff, 0x00, 0xd7], "the whole palette reset");
  } finally { t.dispose(); }
});

test("OSC 10-19 and 110-119 set, query and reset the dynamic colours", async () => {
  const t = await terminal(20, 4);
  try {
    t.e.tessera_sixel_configure(t.handle, 0);
    replies(t);
    assert.deepEqual(dynamicColors(t), [0, 0, 0, 0, 0]);
    t.write("\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07\x1b]17;?\x07\x1b]19;?\x07");
    assert.equal(replies(t), ["10;rgb:e5e5/e5e5/e5e5", "11;rgb:0000/0000/0000", "12;rgb:e5e5/e5e5/e5e5",
      "17;rgb:e5e5/e5e5/e5e5", "19;rgb:0000/0000/0000"].map((r) => `\x1b]${r}\x07`).join(""), "the pane's own colours");
    t.write("\x1b]10;#112233\x07\x1b]11;#445566;#778899\x07\x1b]17;#aabbcc\x07\x1b]19;#ddeeff\x07X");
    assert.deepEqual(dynamicColors(t), [0x1112233, 0x1445566, 0x1778899, 0x1aabbcc, 0x1ddeeff], "11 then 12 from one request");
    assert.deepEqual(firstCell(t), { fg: [0x11, 0x22, 0x33], bg: [0x44, 0x55, 0x66] });
    t.write("\x1b]11;?\x1b\\");
    assert.equal(replies(t), "\x1b]11;rgb:4444/5555/6666\x1b\\");
    t.write("\x1b]13;#010101\x07\x1b]14;?\x07");
    assert.equal(replies(t), "", "pointer colours are not supported");

    t.restore(t.snapshot());
    assert.deepEqual(dynamicColors(t), [0x1112233, 0x1445566, 0x1778899, 0x1aabbcc, 0x1ddeeff], "a snapshot keeps them");

    t.e.tessera_sixel_configure(t.handle, 1);
    assert.deepEqual(dynamicColors(t), [0x1112233, 0x1445566, 0x1778899, 0x1aabbcc, 0x1ddeeff], "light mode keeps a program's colours");
    t.write("\x1b]110\x07\x1b]111\x07\x1b]117\x07");
    assert.deepEqual(dynamicColors(t), [0, 0, 0x1778899, 0, 0x1ddeeff]);
    t.write("\x1b]10;?\x07");
    assert.equal(replies(t), "\x1b]10;rgb:0000/0000/0000\x07", "reset follows the pane's current mode");
    t.write("\x1b]4;1;#123456\x07\x1bc");
    assert.deepEqual(dynamicColors(t), [0, 0, 0, 0, 0], "a full reset clears them");
    t.write("\x1b]4;1;?\x07");
    assert.equal(replies(t), "\x1b]4;1;rgb:cdcd/0000/0000\x07");
  } finally { t.dispose(); }
});

test("colour scheme queries and mode 2031 follow the pane's light or dark setting", async () => {
  const t = await terminal(20, 4);
  try {
    t.e.tessera_sixel_configure(t.handle, 0);
    t.write("\x1b[?996n");
    assert.equal(replies(t), "\x1b[?997;1n", "dark");
    t.e.tessera_sixel_configure(t.handle, 1);
    assert.equal(replies(t), "", "no report without mode 2031");
    t.write("\x1b[?996n");
    assert.equal(replies(t), "\x1b[?997;2n", "light");
    t.write("\x1b[?2031h");
    assert.equal(replies(t), "", "enabling the mode reports nothing by itself");
    t.e.tessera_sixel_configure(t.handle, 1);
    assert.equal(replies(t), "", "the same mode again is no change");
    t.e.tessera_sixel_configure(t.handle, 0);
    assert.equal(replies(t), "\x1b[?997;1n");
    t.e.tessera_sixel_configure(t.handle, 1);
    assert.equal(replies(t), "\x1b[?997;2n");
    t.write("\x1b[?2031l");
    t.e.tessera_sixel_configure(t.handle, 0);
    assert.equal(replies(t), "", "off again");
  } finally { t.dispose(); }
});

test("mode 1004 reports focus changes, and the current focus when enabled", async () => {
  const t = await terminal(20, 4);
  try {
    t.e.tessera_focus(t.handle, 0);
    t.e.tessera_focus(t.handle, 1);
    assert.equal(replies(t), "", "nothing until a program asks");
    t.write("\x1b[?1004h");
    assert.equal(replies(t), "\x1b[I", "focused when enabled");
    t.e.tessera_focus(t.handle, 1);
    assert.equal(replies(t), "", "no change");
    t.e.tessera_focus(t.handle, 0);
    t.e.tessera_focus(t.handle, 1);
    t.e.tessera_focus(t.handle, 0);
    assert.equal(replies(t), "\x1b[O\x1b[I\x1b[O");
    t.write("\x1b[?1004l\x1b[?1004h");
    assert.equal(replies(t), "\x1b[O", "unfocused when enabled again");
    t.write("\x1b[?1004l");
    t.e.tessera_focus(t.handle, 1);
    assert.equal(replies(t), "");
  } finally { t.dispose(); }
});

function notifications(t) {
  const e = t.e, ptr = e.ghostty_wasm_alloc_u8_array(4096), chunks = [];
  try {
    for (let count; (count = e.tessera_notification_read(t.handle, ptr, 4096));) chunks.push(Buffer.from(new Uint8Array(e.memory.buffer, ptr, count)));
  } finally { e.ghostty_wasm_free_u8_array(ptr, 4096); }
  const data = Buffer.concat(chunks), records = [];
  for (let offset = 0; offset < data.length;) {
    const length = data.readUInt32LE(offset); offset += 4;
    const record = data.subarray(offset, offset + length); offset += length;
    const split = record.indexOf(0);
    records.push([record.subarray(0, split).toString(), record.subarray(split + 1).toString()]);
  }
  return records;
}

test("bells are counted and OSC 9 and 777 notifications queued, bounded", async () => {
  const t = await terminal(20, 4);
  try {
    assert.equal(t.e.tessera_bell_count(t.handle), 0);
    t.write("a\x07b\x07\x1b]0;title\x07");
    assert.equal(t.e.tessera_bell_count(t.handle), 2, "a BEL ending an OSC is not a bell");
    t.write("\x1b]9;Build done\x1b\\\x1b]777;notify;Tests;All 12 passed\x07\x1b]777;notify;Café;ünï\x07");
    assert.deepEqual(notifications(t), [["", "Build done"], ["Tests", "All 12 passed"], ["Café", "ünï"]]);
    assert.deepEqual(notifications(t), [], "drained");
    t.write("\x1b]9;4;1;50\x07\x1b]9;\x07");
    assert.deepEqual(notifications(t), [], "progress reports and empty notifications are not notifications");
    t.write(`\x1b]9;${"x".repeat(9000)}\x07`);
    assert.deepEqual(notifications(t), [], "oversized (Ghostty's parser holds about 2 KiB)");
    for (let i = 0; i < 60; i += 1) t.write(`\x1b]9;${String(i).padEnd(1500, ".")}\x07`);
    const queued = notifications(t);
    assert.equal(queued.length, 43, "the queue holds 64 KiB");
    assert.equal(queued[0][1].slice(0, 2), "0.");
    t.write("\x07\x1bc\x07");
    assert.equal(t.e.tessera_bell_count(t.handle), 4, "reset keeps counting");
  } finally { t.dispose(); }
});

test("DECRQM answers from the mode table, except modes Tessera does not act on", async () => {
  const t = await terminal(20, 4);
  try {
    t.write("\x1b[?2004$p\x1b[?2004h\x1b[?2004$p\x1b[?7$p\x1b[4$p\x1b[?1004$p");
    assert.equal(replies(t), "\x1b[?2004;2$y\x1b[?2004;1$y\x1b[?7;1$y\x1b[4;2$y\x1b[?1004;2$y");
    t.write("\x1b[?1006h\x1b[?1006$p\x1b[?2031$p\x1b[?2027$p");
    assert.equal(replies(t), "\x1b[?1006;1$y\x1b[?2031;2$y\x1b[?2027;1$y", "grapheme clustering is on");
    t.write("\x1b[?1015$p\x1b[?1016$p\x1b[?1005$p");
    assert.equal(replies(t), "\x1b[?1015;0$y\x1b[?1016;0$y\x1b[?1005;0$y", "not acted on");
    t.write("\x1b[?9999$p\x1b[77$p");
    assert.equal(replies(t), "\x1b[?9999;0$y\x1b[77;0$y", "unknown");
  } finally { t.dispose(); }
});

function setVersion(t, text) {
  const bytes = new TextEncoder().encode(text);
  const p = t.e.ghostty_wasm_alloc_u8_array(Math.max(1, bytes.length));
  new Uint8Array(t.e.memory.buffer).set(bytes, p);
  t.e.tessera_set_version(t.handle, p, bytes.length);
  t.e.ghostty_wasm_free_u8_array(p, Math.max(1, bytes.length));
}

test("XTVERSION names Tessera and the version the host set", async () => {
  const t = await terminal(20, 4);
  try {
    t.write("\x1b[>q");
    assert.equal(replies(t), "\x1bP>|Tessera\x1b\\");
    setVersion(t, "1.9.1");
    t.write("\x1b[>0q");
    assert.equal(replies(t), "\x1bP>|Tessera 1.9.1\x1b\\");
    for (const bad of ["1.9 beta", "1.9\x1b\\", "x".repeat(65)]) {
      setVersion(t, bad);
      t.write("\x1b[>q");
      assert.equal(replies(t), "\x1bP>|Tessera\x1b\\", JSON.stringify(bad));
    }
  } finally { t.dispose(); }
});

const hex = (text) => Buffer.from(text).toString("hex").toUpperCase();
function setTermName(t, text) {
  const bytes = new TextEncoder().encode(text);
  const p = t.e.ghostty_wasm_alloc_u8_array(Math.max(1, bytes.length));
  new Uint8Array(t.e.memory.buffer).set(bytes, p);
  t.e.tessera_set_term_name(t.handle, p, bytes.length);
  t.e.ghostty_wasm_free_u8_array(p, Math.max(1, bytes.length));
}

test("XTGETTCAP answers from Ghostty's terminfo, with TERM as the name", async () => {
  const t = await terminal(20, 4);
  try {
    const query = (...names) => { t.write(`\x1bP+q${names.join(";")}\x1b\\`); return replies(t); };
    assert.equal(query(hex("TN")), `\x1bP0+r${hex("TN")}\x1b\\`, "no name until the host gives one");
    setTermName(t, "xterm-256color");
    assert.equal(query(hex("TN")), `\x1bP1+r${hex("TN")}=${hex("xterm-256color")}\x1b\\`);
    setTermName(t, "bad name");
    assert.equal(query(hex("TN")), `\x1bP0+r${hex("TN")}\x1b\\`, "a name with a space is refused");
    assert.equal(query(hex("Tc"), hex("RGB"), hex("Co"), hex("colors")),
      `\x1bP1+r${hex("Tc")}\x1b\\\x1bP1+r${hex("RGB")}=${hex("8")}\x1b\\\x1bP1+r${hex("Co")}=${hex("256")}\x1b\\\x1bP1+r${hex("colors")}=${hex("256")}\x1b\\`,
      "true colour, in the order asked");
    assert.equal(query(hex("kbs").toLowerCase()), `\x1bP1+r${hex("kbs")}=7F\x1b\\`, "lower-case hex, and keys as escapes");
    assert.equal(query(hex("Ms")), `\x1bP1+r${hex("Ms")}=${hex("\\E]52;%p1%s;%p2%s\\007")}\x1b\\`, "OSC 52 copying");
    assert.equal(query(hex("fullkbd")), `\x1bP1+r${hex("fullkbd")}\x1b\\`, "the Kitty keyboard protocol");
    assert.equal(query(hex("Sync")), `\x1bP1+r${hex("Sync")}=${hex("\\E[?2026%?%p1%{1}%-%tl%eh%;")}\x1b\\`, "synchronized output");
    assert.equal(query(hex("Smulx")), `\x1bP1+r${hex("Smulx")}=${hex("\\E[4:%p1%dm")}\x1b\\`, "styled underlines");
    assert.match(query(hex("Setulc")), /^\x1bP1\+r536574756C63=/, "coloured underlines");
    assert.equal(query(hex("Su")), `\x1bP1+r${hex("Su")}\x1b\\`);
    for (const name of ["nosuchcap"]) {
      assert.equal(query(hex(name)), `\x1bP0+r${hex(name)}\x1b\\`, name);
    }
    t.write(`\x1bP+q${"41".repeat(2100)}\x1b\\ok`);
    assert.equal(replies(t), "", "an oversized query is dropped");
    t.write(`\x1bP+q${hex("Tc")}\x18`);
    assert.equal(replies(t), "", "a cancelled query is not answered");
    t.write(`\x1bP+q${hex("Tc")}\x1b\\\x1bPq#0;2;100;0;0#0~~\x1b\\`);
    assert.equal(replies(t), `\x1bP1+r${hex("Tc")}\x1b\\`);
    assert.equal(t.e.tessera_sixel_image_count(t.handle), 1, "Sixel still draws after a query");
  } finally { t.dispose(); }
});

test("DECRQSS reports SGR, the cursor style and margins, as Ghostty does", async () => {
  const t = await terminal(20, 4);
  try {
    const query = (setting) => { t.write(`\x1bP$q${setting}\x1b\\`); return replies(t); };
    assert.equal(query("m"), "\x1bP1$r0m\x1b\\");
    t.write("\x1b[1;3;31m");
    assert.equal(query("m"), "\x1bP1$r0;1;3;31m\x1b\\");
    t.write("\x1b[0;38;2;1;2;3m");
    assert.equal(query("m"), "\x1bP1$r0;38:2::1:2:3m\x1b\\", "true colour comes back as set");
    t.write("\x1b[0m");
    assert.equal(query("r"), "\x1bP1$r1;4r\x1b\\");
    t.write("\x1b[2;3r");
    assert.equal(query("r"), "\x1bP1$r2;3r\x1b\\");
    t.write("\x1b[5 q");
    assert.equal(query(" q"), "\x1bP1$r5 q\x1b\\");
    assert.equal(query("s"), "\x1bP0$r\x1b\\", "no left and right margins while DECLRMM is off");
    t.write("\x1b[?69h\x1b[2;5s");
    assert.equal(query("s"), "\x1bP1$r2;5s\x1b\\");
    assert.equal(query("\"p"), "\x1bP0$r\x1b\\", "an unknown setting");
  } finally { t.dispose(); }
});

test("synchronized output (mode 2026) is reported, kept by snapshots and ended by a resize", async () => {
  const t = await terminal(20, 4);
  try {
    const query = () => { t.write("\x1b[?2026$p"); return replies(t); };
    assert.equal(query(), "\x1b[?2026;2$y");
    t.write("\x1b[?2026h");
    assert.equal(query(), "\x1b[?2026;1$y");
    t.restore(t.snapshot());
    assert.equal(query(), "\x1b[?2026;1$y", "a snapshot keeps it");
    t.e.ghostty_terminal_resize(t.handle, 20, 4);
    assert.equal(query(), "\x1b[?2026;1$y", "the same size is not a resize");
    t.e.ghostty_terminal_resize(t.handle, 30, 4);
    assert.equal(query(), "\x1b[?2026;2$y", "a resize ends it");
    t.write("\x1b[?2026h\x1b[?2026l");
    assert.equal(query(), "\x1b[?2026;2$y");
  } finally { t.dispose(); }
});

test("the host counts redraw starts and can end one the program left open", async () => {
  const t = await terminal(20, 4);
  try {
    const starts = () => t.e.tessera_synchronized_output_starts(t.handle);
    assert.equal(starts(), 0);
    t.write("\x1b[?2026h\x1b[?2026l\x1b[?2026h\x1b[?2026h");
    assert.equal(starts(), 3, "every start, including one while already on");
    t.write("\x1b[?2026l");
    assert.equal(starts(), 3, "not ends");
    assert.equal(t.e.tessera_end_synchronized_output(t.handle), 0, "nothing open");
    t.write("\x1b[?2026hhalf");
    assert.equal(t.e.tessera_end_synchronized_output(t.handle), 1);
    t.write("\x1b[?2026$p");
    assert.equal(replies(t), "\x1b[?2026;2$y", "ended");
  } finally { t.dispose(); }
});

test("in-band size reports (mode 2048) on enabling and after each resize", async () => {
  const t = await terminal(20, 4);
  try {
    const resize = (cols, rows, width, height) => {
      t.e.ghostty_terminal_resize(t.handle, cols, rows);
      t.e.tessera_sixel_geometry(t.handle, width, height);
    };
    t.write("\x1b[?2048$p");
    assert.equal(replies(t), "\x1b[?2048;2$y");
    resize(30, 5, 2, 6);
    assert.equal(replies(t), "", "not until a program asks");
    t.write("\x1b[?2048h\x1b[?2048$p");
    assert.equal(replies(t), "\x1b[48;5;30;30;60t\x1b[?2048;1$y", "rows, columns, then pixel height and width");
    resize(40, 6, 2, 6);
    assert.equal(replies(t), "\x1b[48;6;40;36;80t");
    resize(40, 6, 2, 6);
    assert.equal(replies(t), "", "an unchanged size is not reported again");
    resize(40, 6, 3, 7);
    assert.equal(replies(t), "\x1b[48;6;40;42;120t", "a new cell size is");
    t.restore(t.snapshot());
    resize(20, 4, 3, 7);
    assert.equal(replies(t), "\x1b[48;4;20;28;60t", "a snapshot keeps the mode");
    t.write("\x1b[?2048l");
    resize(30, 5, 3, 7);
    assert.equal(replies(t), "");
  } finally { t.dispose(); }
});

test("OSC 9;4 progress reports are kept with a revision", async () => {
  const t = await terminal(20, 4);
  try {
    assert.deepEqual([t.e.tessera_progress_revision(t.handle), t.e.tessera_progress(t.handle)], [0, 0]);
    t.write("\x1b]9;4;1;42\x07");
    assert.deepEqual([t.e.tessera_progress_revision(t.handle), t.e.tessera_progress(t.handle)], [1, 1 | (42 << 8)]);
    t.write("\x1b]9;4;3\x07");
    assert.equal(t.e.tessera_progress(t.handle), 3 | (255 << 8), "indeterminate, no percentage");
    t.write("\x1b]9;4;2;250\x1b\\");
    assert.equal(t.e.tessera_progress(t.handle), 2 | (100 << 8), "error, clamped");
    t.write("\x1b]9;4;4;10\x07\x1b]9;4;0\x07");
    assert.deepEqual([t.e.tessera_progress_revision(t.handle), t.e.tessera_progress(t.handle) & 255], [5, 0]);
    t.write("\x1b]9;4;1;50\x07");
    assert.equal(t.e.tessera_progress_revision(t.handle), 6);
  } finally { t.dispose(); }
});

test("CSI 22/23 t push and pop the window title, through snapshots and reset", async () => {
  const t = await terminal(20, 4);
  try {
    const revision = () => t.e.tessera_sixel_title_revision(t.handle);
    t.write("\x1b[22;0t\x1b]2;vim file.txt\x07");
    assert.equal(windowTitle(t), "vim file.txt");
    const before = revision();
    t.write("\x1b[23;0t");
    assert.equal(windowTitle(t), "", "back to no title");
    assert.notEqual(revision(), before);
    t.write("\x1b[23;0t");
    assert.equal(revision(), before + 1, "nothing to pop");

    t.write("\x1b]2;~/src\x07\x1b[22;2t\x1b]2;nested\x07\x1b[22;0t\x1b]2;inner\x07");
    t.restore(t.snapshot());
    assert.equal(windowTitle(t), "inner");
    t.write("\x1b[23;2t");
    assert.equal(windowTitle(t), "nested", "a restored snapshot keeps the stack");
    t.write("\x1b[23;0t");
    assert.equal(windowTitle(t), "~/src");
    t.write("\x1b[22t\x1b]2;bare\x07\x1b[23;0t");
    assert.equal(windowTitle(t), "bare", "CSI 22 t without a target is ignored, as in Ghostty");
    t.write("\x1b[22;1t\x1b]2;icon only\x07\x1b[23;1t");
    assert.equal(windowTitle(t), "icon only", "icon titles are not stacked");

    for (let i = 0; i < 12; i += 1) t.write(`\x1b]2;title ${i}\x07\x1b[22;0t`);
    t.write("\x1b]2;top\x07");
    const popped = [];
    for (let i = 0; i < 11; i += 1) { t.write("\x1b[23;0t"); popped.push(windowTitle(t)); }
    assert.deepEqual(popped, ["title 11", "title 10", "title 9", "title 8", "title 7", "title 6", "title 5", "title 4", "title 3", "title 2", "title 2"], "ten kept");

    t.write("\x1b[22;0t\x1b[22;0t\x1bc\x1b[23;0t");
    assert.equal(windowTitle(t), "", "a full reset empties the stack");
  } finally { t.dispose(); }
});

test("Kitty keyboard flags are answered to CSI ? u and readable, per screen", async () => {
  const t = await terminal(20, 4);
  try {
    const flags = () => t.e.tessera_kitty_keyboard_flags(t.handle);
    t.write("\x1b[?u");
    assert.equal(replies(t), "\x1b[?0u");
    t.write("\x1b[>1u");
    assert.equal(flags(), 1, "pushed");
    t.write("\x1b[>11u\x1b[?u");
    assert.equal(replies(t), "\x1b[?11u");
    t.write("\x1b[=2;2u");
    assert.equal(flags(), 11 | 2, "or-ed in");
    t.write("\x1b[<u");
    assert.equal(flags(), 1, "popped");
    t.write("\x1b[?1049h");
    assert.equal(flags(), 0, "the alternate screen has its own");
    t.write("\x1b[>31u");
    t.restore(t.snapshot());
    assert.equal(flags(), 31, "a snapshot keeps them");
    t.write("\x1b[?1049l");
    assert.equal(flags(), 1);
    t.write("\x1bc");
    assert.equal(flags(), 0, "a full reset clears them");
  } finally { t.dispose(); }
});

test("OSC 22 pointer shapes match the CSS names, survive snapshots and reset", async () => {
  const t = await terminal();
  try {
    assert.equal(terminalPointerShapes[t.e.tessera_mouse_shape(t.handle)], "text");
    terminalPointerShapes.forEach((name, value) => {
      t.write(`\x1b]22;${name}\x1b\\`);
      assert.equal(t.e.tessera_mouse_shape(t.handle), value, name);
    });
    t.write("\x1b]22;crosshair\x07\x1b]22;no-such-shape\x07");
    assert.equal(terminalPointerShapes[t.e.tessera_mouse_shape(t.handle)], "crosshair", "an unknown name changes nothing");
    t.write("\x1b]22;hand\x07");
    assert.equal(terminalPointerShapes[t.e.tessera_mouse_shape(t.handle)], "pointer", "X cursor names are understood");
    t.restore(t.snapshot());
    assert.equal(terminalPointerShapes[t.e.tessera_mouse_shape(t.handle)], "pointer");
    t.write("\x1bc");
    assert.equal(terminalPointerShapes[t.e.tessera_mouse_shape(t.handle)], "text");
  } finally { t.dispose(); }
});

test("OSC window titles survive every byte split and snapshot, including Unicode and split ST", async () => {
  const t = await terminal();
  try {
    for (const command of [0, 2]) for (const end of ["\x07", "\x1b\\"]) {
      const data = new TextEncoder().encode(`\x1b]${command};vim — 界 😀${end}`);
      for (let split = 0; split <= data.length; split++) {
        t.write("\x1b]2;Previous\x07");
        t.write(data.subarray(0, split));
        t.restore(t.snapshot());
        t.write(data.subarray(split));
        assert.equal(windowTitle(t), "vim — 界 😀", `OSC ${command}, split ${split}`);
        t.restore(t.snapshot());
        assert.equal(windowTitle(t), "vim — 界 😀");
      }
    }
  } finally { t.dispose(); }
});

test("title requests ignore icon, empty, invalid UTF-8 and oversized titles and reset with the core", async () => {
  const t = await terminal();
  try {
    t.write("\x1b]2;Keep\x07");
    for (const sequence of ["\x1b]1;Icon\x07", "\x1b]2;\x07", `\x1b]0;${"x".repeat(4097)}\x07`,
      new Uint8Array([27, 93, 50, 59, 0xff, 7])]) {
      t.write(sequence);
      assert.equal(windowTitle(t), "Keep");
    }
    t.write("\x1b]2;First\x07\x1b]0;<b>Last</b>; title\x1b\\");
    assert.equal(windowTitle(t), "<b>Last</b>; title");
    const revision = t.e.tessera_sixel_title_revision(t.handle);
    t.write("\x1b]2;<b>Last</b>; title\x07");
    assert.notEqual(t.e.tessera_sixel_title_revision(t.handle), revision, "a later request can replace a manually renamed window");
    t.write("\x1bc");
    assert.equal(windowTitle(t), "");
  } finally { t.dispose(); }
});

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
test("file effects are transient across snapshots, including partial OSC and split ST", async () => {
  const sequence = "\x1b]777;tessera-file;1;query;nonce\x1b\\";
  for (let split = 0; split <= sequence.length; split++) {
    const t = await terminal();
    try {
      t.write(sequence.slice(0, split));
      t.restore(t.snapshot());
      assert.deepEqual(fileEffects(t), [], "a snapshot never carries queued effects");
      t.write(sequence.slice(split));
      assert.deepEqual(fileEffects(t), split === sequence.length ? [] : ["query;nonce"], `split ${split}`);
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

test("cell reads carry the underline style and its own colour", async () => {
  const t = await terminal(10, 3);
  const p = t.e.ghostty_wasm_alloc_u8_array(10 * 16);
  try {
    const colours = () => {
      const at = t.e.tessera_underline_colors(t.handle);
      return (index) => new Uint32Array(t.e.memory.buffer, at, index + 1)[index];
    };
    t.write("\x1b[4:3;58:2::255:0:0mA\x1b[4:4mB\x1b[59mC\x1b[0;4mD\x1b[21mE\x1b[4:5;58:5:2mF\x1b[0mG\x1b[24m");
    const full = t.cells();
    const colour = colours();
    const style = (col, row = 0) => full[(row * 10 + col) * 16 + 15];
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(col => style(col)), [3 | 8, 4 | 8, 4, 1, 2, 5 | 8, 0],
      "curly red, dotted red, dotted, single, double, dashed green, none");
    assert.equal(full[0 * 16 + 10] & 4, 4, "the underline flag is still set");
    assert.equal(colour(0), 0xff0000);
    assert.equal(colour(1), 0xff0000);
    assert.notEqual(colour(5), 0, "a palette colour is resolved");
    t.write("\x1b[3;1H\x1b[32mg\x1b[0m");
    const palette = t.cells();
    assert.equal(colour(5), (palette[20 * 16 + 4] << 16) | (palette[20 * 16 + 5] << 8) | palette[20 * 16 + 6], "to the same green as SGR 32");
    t.write("\x1b[2;1H\x1b[4:3;58:2::1:2:3mx");
    assert.equal(t.e.tessera_sixel_viewport_row(t.handle, 1, p, 10), 10);
    const row = new Uint8Array(t.e.memory.buffer, p, 160).slice();
    assert.equal(row[15], 3 | 8);
    assert.equal(colours()(0), 0x010203, "a one-row read indexes from its first cell");
    t.write("\x1b[0m\r\n\r\n\r\n\r\n");
    assert.equal(t.e.ghostty_terminal_get_scrollback_line(t.handle, 0, p, 10), 10);
    const history = new Uint8Array(t.e.memory.buffer, p, 160).slice();
    assert.equal(history[15], 3 | 8, "history lines too");
    assert.equal(colours()(0), 0xff0000);
  } finally { t.e.ghostty_wasm_free_u8_array(p, 10 * 16); t.dispose(); }
});

function searchFor(t, needle) {
  const bytes = new TextEncoder().encode(needle);
  const p = t.e.ghostty_wasm_alloc_u8_array(Math.max(1, bytes.length));
  new Uint8Array(t.e.memory.buffer).set(bytes, p);
  const count = t.e.tessera_search_start(t.handle, p, bytes.length);
  t.e.ghostty_wasm_free_u8_array(p, Math.max(1, bytes.length));
  return count;
}
function searchMatches(t, capacity = 64) {
  const p = t.e.ghostty_wasm_alloc_u8_array(capacity * 16);
  try {
    const count = t.e.tessera_search_matches(t.handle, p, capacity);
    const data = new Uint32Array(t.e.memory.buffer, p, count * 4).slice();
    return Array.from({ length: count }, (_, i) => [...data.slice(i * 4, i * 4 + 4)]);
  } finally { t.e.ghostty_wasm_free_u8_array(p, capacity * 16); }
}

test("scrollback search finds matches newest first, ignoring ASCII case, across wrapped rows", async () => {
  const t = await terminal(10, 4);
  try {
    t.write("alpha\r\nneedle one\r\nfiller\r\nfiller\r\nNEEDLE two\r\nfiller\r\nxxxxxxneedle\r\n");
    assert.equal(searchFor(t, "needle"), 3);
    // Rows count from the top of the history; the last match wraps from
    // column 6 of one row to column 1 of the next.
    assert.deepEqual(searchMatches(t), [[6, 6, 7, 1], [4, 0, 4, 5], [1, 0, 1, 5]]);
    assert.equal(t.e.tessera_search_selected(t.handle), 0, "the newest is selected");
    assert.equal(t.e.tessera_search_select(t.handle, 1), 1);
    assert.equal(t.e.tessera_search_select(t.handle, 1), 1);
    assert.equal(t.e.tessera_search_selected(t.handle), 2);
    assert.equal(t.e.tessera_search_select(t.handle, 1), 0, "no wrapping past the oldest");
    assert.equal(t.e.tessera_search_select(t.handle, 0), 1);
    assert.equal(t.e.tessera_search_selected(t.handle), 1);
    assert.equal(searchMatches(t, 2).length, 2, "capacity is respected");

    t.write("one more needle\r\n");
    assert.equal(t.e.tessera_search_update(t.handle), 4, "new output is searched");
    assert.deepEqual(searchMatches(t)[0], [8, 9, 9, 4]);
    assert.equal(t.e.tessera_search_selected(t.handle), 2, "the selection stays on the same match");

    assert.equal(searchFor(t, "nothing here"), 0);
    assert.equal(t.e.tessera_search_selected(t.handle), -1);
    assert.equal(searchFor(t, ""), 0, "an empty needle ends the search");
    assert.equal(t.e.tessera_search_update(t.handle), 0);
    assert.equal(searchFor(t, "x".repeat(1025)), 0);
    assert.equal(searchFor(t, "ALPHA"), 1);
    t.e.tessera_search_end(t.handle);
    assert.equal(t.e.tessera_search_selected(t.handle), -1);
    assert.equal(searchMatches(t).length, 0);
  } finally { t.dispose(); }
});

test("scrollback search follows the shown screen and ends with a full reset", async () => {
  const t = await terminal(20, 4);
  try {
    t.write("shell needle\r\n");
    assert.equal(searchFor(t, "needle"), 1);
    t.write("\x1b[?1049h\x1b[Heditor needle needle");
    assert.equal(t.e.tessera_search_update(t.handle), 2, "the alternate screen once a program shows it");
    t.write("\x1b[?1049l");
    assert.equal(t.e.tessera_search_update(t.handle), 1, "and the shell's again after");
    t.write("\x1b[?1049h");
    assert.equal(t.e.tessera_search_update(t.handle), 0);
    t.write("\x1bc");
    assert.equal(t.e.tessera_search_selected(t.handle), -1, "a full reset ends it");
    assert.equal(t.e.tessera_search_update(t.handle), 0);
    t.write("needle\r\n");
    assert.equal(searchFor(t, "needle"), 1, "and a new one works after");
  } finally { t.dispose(); }
});

test("scrollback search survives history being trimmed and the terminal being freed", async () => {
  const t = await terminal(20, 4);
  try {
    for (let i = 0; i < 200; i++) t.write(`line ${i} needle\r\n`);
    assert.equal(searchFor(t, "needle"), 200);
    for (let i = 0; i < 2000; i++) t.write(`more output ${i} with a few words to fill pages\r\n`);
    const count = t.e.tessera_search_update(t.handle);
    assert.ok(count <= 200);
    for (const match of searchMatches(t, 256)) assert.ok(match[0] === 0xffffffff || match[0] < 3000, String(match));
    t.e.ghostty_terminal_resize(t.handle, 30, 6);
    assert.ok(t.e.tessera_search_update(t.handle) >= 0, "a resize starts it again");
  } finally { t.dispose(); }
});

function commandEvents(t) {
  const e = t.e, ptr = e.ghostty_wasm_alloc_u8_array(4096), chunks = [];
  try {
    for (let count; (count = e.tessera_command_read(t.handle, ptr, 4096));) chunks.push(Buffer.from(new Uint8Array(e.memory.buffer, ptr, count)));
  } finally { e.ghostty_wasm_free_u8_array(ptr, 4096); }
  const data = Buffer.concat(chunks), events = [];
  for (let offset = 0; offset < data.length;) {
    const length = data.readUInt32LE(offset); offset += 4;
    events.push([data[offset], data[offset + 1], data.subarray(offset + 2, offset + length).toString()]);
    offset += length;
  }
  return events;
}

test("prompt marks queue command starts, with the command line, and ends, with the status", async () => {
  const t = await terminal(40, 6);
  try {
    t.write("\x1b]133;A\x1b\\$ \x1b]133;B\x1b\\make all\r\n\x1b]133;C;cmdline_url=make%20all\x1b\\building\r\n\x1b]133;D;2\x1b\\");
    assert.deepEqual(commandEvents(t), [[1, 0, "make all"], [2, 2, ""]]);
    assert.deepEqual(commandEvents(t), [], "drained");
    t.write("\x1b]133;C\x1b\\\x1b]133;D\x1b\\");
    assert.deepEqual(commandEvents(t), [[1, 0, ""], [3, 0, ""]], "no command line, no status");
    t.write("\x1b]133;C;cmdline=echo\\ hi\x1b\\\x1b]133;D;0\x1b\\");
    assert.deepEqual(commandEvents(t), [[1, 0, "echo hi"], [2, 0, ""]], "the printf %q form too");
    t.write(`\x1b]133;C;cmdline_url=${"%C3%A9".repeat(300)}\x1b\\`);
    const [[, , long]] = commandEvents(t);
    assert.equal(Buffer.byteLength(long), 512, "cut to 512 bytes");
    assert.equal(long, "é".repeat(256), "on a character boundary");
    t.write("\x1b]133;C;cmdline_url=first\x1b\\\x1b]133;C\x1b\\");
    assert.deepEqual(commandEvents(t), [[1, 0, "first"], [1, 0, ""]], "a command line is used once");
    for (let i = 0; i < 20000; i++) t.write("\x1b]133;D;1\x1b\\");
    assert.ok(commandEvents(t).length <= 64 * 1024 / 6, "the queue is bounded");
  } finally { t.dispose(); }
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
