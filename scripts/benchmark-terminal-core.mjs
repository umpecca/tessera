import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
const original = await fs.readFile("node_modules/ghostty-web/dist/ghostty-web.js", "utf8");
const baseline = Buffer.from(original.match(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/)[1], "base64");
const current = await fs.readFile("internal/terminalcore/ghostty-vt.wasm");
if (!process.argv.includes("--retained-images-only")) for (const [name, bytes] of [["upstream", baseline], ["tessera", current]]) {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  for (const scroll of [false, true]) {
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const handle = e.ghostty_terminal_new(80, 24);
      const data = new TextEncoder().encode(("ordinary shell output: building a package 0123456789" + (scroll ? "\r\n" : "\r")).repeat(128));
      const p = e.ghostty_wasm_alloc_u8_array(data.length);
      new Uint8Array(e.memory.buffer).set(data, p);
      for (let i = 0; i < 200; i++) e.ghostty_terminal_write(handle, p, data.length);
      const start = performance.now();
      for (let i = 0; i < 2000; i++) e.ghostty_terminal_write(handle, p, data.length);
      samples.push(data.length * 2000 / (performance.now() - start) / 1000);
      e.ghostty_wasm_free_u8_array(p, data.length); e.ghostty_terminal_free(handle);
    }
    console.log(`${name} ${scroll ? "scroll" : "rewrite"}: ${samples.sort((a,b)=>a-b)[2].toFixed(1)} MB/s`);
  }
}

// Optional --compare=<wasm path> measures a saved core in the same process.
// Tiny writes expose cleanup work that bulk throughput measurements hide.
const comparison = process.argv.find((arg) => arg.startsWith("--compare="));
const cores = comparison ? [["before", await fs.readFile(comparison.slice("--compare=".length))], ["tessera", current]] : [["tessera", current]];
for (const [name, bytes] of cores) {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  const encoder = new TextEncoder();
  function write(handle, text) {
    const data = encoder.encode(text);
    const ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    new Uint8Array(e.memory.buffer).set(data, ptr);
    e.ghostty_terminal_write(handle, ptr, data.length);
    e.ghostty_wasm_free_u8_array(ptr, data.length);
  }
  for (const lines of [0, 1000, 10000]) for (const image of [false, true]) {
    const handle = e.ghostty_terminal_new(80, 24);
    e.tessera_sixel_geometry(handle, 8, 16);
    if (lines) write(handle, ("x".repeat(79) + "\r\n").repeat(lines));
    if (image) {
      write(handle, '\x1b[H\x1bPq"1;1;8;6#1;2;100;0;0!8~\x1b\\');
      write(handle, "\x1b[24;1H\r\n\r\n");
    }
    const data = encoder.encode("\rtick");
    const ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    new Uint8Array(e.memory.buffer).set(data, ptr);
    for (let i = 0; i < 200; i++) e.ghostty_terminal_write(handle, ptr, data.length);
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      for (let i = 0; i < 500; i++) e.ghostty_terminal_write(handle, ptr, data.length);
      samples.push((performance.now() - start) * 1000 / 500);
    }
    const history = e.ghostty_terminal_get_scrollback_length(handle);
    if (e.tessera_sixel_image_count(handle) !== Number(image)) throw new Error("Benchmark image was lost");
    console.log(`${name} ${history} history lines, ${image ? "one image" : "no images"}: ${samples.sort((a,b)=>a-b)[2].toFixed(3)} us/write`);
    e.ghostty_wasm_free_u8_array(ptr, data.length);
    e.ghostty_terminal_free(handle);
  }
}
