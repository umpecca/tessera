import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
const original = await fs.readFile("node_modules/ghostty-web/dist/ghostty-web.js", "utf8");
const baseline = Buffer.from(original.match(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/)[1], "base64");
const current = await fs.readFile("internal/terminalcore/ghostty-vt.wasm");
for (const [name, bytes] of [["upstream", baseline], ["tessera", current]]) {
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
