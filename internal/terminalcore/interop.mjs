// Called by the Go integration test to exercise wazero -> JavaScript state transfer.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
const fixture = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const bytes = await fs.readFile(new URL("./ghostty-vt.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
const e = instance.exports;
function input(data, fn) {
  const p = e.ghostty_wasm_alloc_u8_array(data.length);
  new Uint8Array(e.memory.buffer).set(data,p);
  try { return fn(p,data.length); } finally { e.ghostty_wasm_free_u8_array(p,data.length); }
}
function write(h,data) { input(new TextEncoder().encode(data),(p,n)=>e.ghostty_terminal_write(h,p,n)); }
const a=e.ghostty_terminal_new(40,10);
e.tessera_sixel_configure(a,0); e.tessera_sixel_geometry(a,8,16);
write(a, fixture.before);
e.ghostty_terminal_resize(a,30,8); e.tessera_sixel_geometry(a,7,14);
write(a, fixture.partial);
const b=input(Buffer.from(fixture.snapshot,"base64"),(p,n)=>e.tessera_sixel_snapshot_import(p,n));
assert.ok(b,"host snapshot imports in JavaScript");
function state(h) {
  e.ghostty_render_state_update(h);
  const p=e.ghostty_wasm_alloc_u8_array(30*8*16);
  e.ghostty_render_state_get_viewport(h,p,30*8);
  const cells=new Uint8Array(e.memory.buffer,p,30*8*16).slice();
  e.ghostty_wasm_free_u8_array(p,30*8*16);
  return {cells,cursor:[e.ghostty_render_state_get_cursor_x(h),e.ghostty_render_state_get_cursor_y(h)], images:e.tessera_sixel_image_count(h)};
}
assert.deepEqual(state(b),state(a));
for (const h of [a,b]) write(h, fixture.after);
assert.deepEqual(state(b),state(a));
assert.ok(state(b).images>0);
e.ghostty_terminal_free(a); e.ghostty_terminal_free(b);
