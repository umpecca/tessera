// Isolate parser failures from the browser renderer and reusable input adapter.
import fs from "node:fs/promises";
const wasm = process.argv.find(value => value.startsWith("--wasm="))?.slice(7) || new URL("../../internal/terminalcore/ghostty-vt.wasm", import.meta.url);
const bytes = await fs.readFile(wasm);
const onlyWorkload = process.argv.find(value => value.startsWith("--workload="))?.slice(11);
const workloads = {
  ascii: "ordinary output for module",
  accent: "ÅÉgyp output",
  cjk: "界 世界 output",
  combining: "é output",
  devanagari: "देवनागरी output",
  mixed: "ÅÉgyp 界 é देवनागरी output",
};
for (const [workload, text] of Object.entries(workloads)) for (const updateEveryWrite of [false, true]) {
  if (onlyWorkload && workload !== onlyWorkload) continue;
  let e;
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log(ptr, length) {
    if (process.argv.includes("--logs") && e) process.stderr.write(new TextDecoder().decode(new Uint8Array(e.memory.buffer, ptr, length)) + "\n");
  } } });
  e = instance.exports;
  const handle = e.ghostty_terminal_new(80, 24);
  const data = new TextEncoder().encode((`\x1b[32m${text}\x1b[0m\r\n`).repeat(128));
  const ptr = e.ghostty_wasm_alloc_u8_array(data.length);
  new Uint8Array(e.memory.buffer).set(data, ptr);
  let completedWrites = 0, error;
  try {
    while (completedWrites < 300) {
      e.ghostty_terminal_write(handle, ptr, data.length); completedWrites++;
      if (updateEveryWrite) { e.ghostty_render_state_update(handle); e.ghostty_render_state_mark_clean(handle); }
    }
  } catch (failure) {
    error = String(failure);
    if (process.argv.includes("--logs")) process.stderr.write(failure.stack + "\n");
  }
  console.log(JSON.stringify({ workload, updateEveryWrite, bytesPerWrite: data.length, completedWrites,
    linesWritten: completedWrites * 128, memoryMiB: e.memory.buffer.byteLength / 1024 / 1024, error }));
  if (!error) { e.ghostty_wasm_free_u8_array(ptr, data.length); e.ghostty_terminal_free(handle); }
}
