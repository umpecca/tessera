import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { SixelRenderer, installSixelRenderer } from "./terminal-sixel-renderer.mjs";

test("native fragments scale with cells, cache once, and release on eviction", async () => {
  const bytes = await fs.readFile(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {env:{log(){}}});
  const e=instance.exports, handle=e.ghostty_terminal_new(20,6);
  e.tessera_sixel_geometry(handle,2,6);
  const write=data=>{
    const encoded=new TextEncoder().encode(data),p=e.ghostty_wasm_alloc_u8_array(encoded.length);
    new Uint8Array(e.memory.buffer).set(encoded,p);e.ghostty_terminal_write(handle,p,encoded.length);
    e.ghostty_wasm_free_u8_array(p,encoded.length);
  };
  const originalDocument=globalThis.document, originalImageData=globalThis.ImageData;
  const canvases=[], draws=[], fills=[];
  globalThis.document={createElement(){const canvas={width:0,height:0,getContext(){return {putImageData(){}};}};canvases.push(canvas);return canvas;}};
  globalThis.ImageData=class {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}};
  let metrics={width:2,height:6};
  const renderer={getMetrics:()=>metrics,isInSelection:()=>false,ctx:{save(){},restore(){},drawImage(...args){draws.push(args);},fillRect(...args){fills.push(args);},beginPath(){},rect(){},clip(){},fillText(){}}};
  const owner=new SixelRenderer(), buffer={exports:e,handle};
  try {
    write('\x1b[2;3H\x1bPq"1;1;4;12#1;2;100;0;0!4~-!4~\x1b\\');
    owner.render(renderer,buffer,0); assert.equal(canvases.length,1);assert.equal(draws.length,4);
    const first=draws[0].slice(5); draws.length=0;
    renderer.devicePixelRatio=2; owner.render(renderer,buffer,0);
    assert.deepEqual(draws[0].slice(5),first,"DPI does not change logical placement");
    metrics={width:4,height:12};draws.length=0;owner.render(renderer,buffer,0);
    assert.deepEqual(draws[0].slice(5),first.map(x=>x*2));assert.equal(canvases.length,1);
    write("\x1b[2J");owner.prune(buffer);
    assert.equal(owner.images.size,0);assert.equal(canvases[0].width,0);
    e.tessera_sixel_geometry(handle,100,1000);
    write('\x1b[H\x1bPq"1;1;2000;3000#1;2;100;0;0~\x1b\\');
    owner.render(renderer,buffer,0);
    assert.equal(owner.images.size,1);
    e.tessera_sixel_image_settings(handle,16,1);
    draws.length=0;owner.render(renderer,buffer,0);
    assert.equal(owner.images.size,0,"eviction releases the cached bitmap");
    assert.equal(canvases[1].width,0);
    assert.equal(draws.length,0);assert.ok(fills.length>0,"evicted cells paint markers");
    e.tessera_sixel_image_settings(handle,16,0);
    fills.length=0;owner.render(renderer,buffer,0);
    assert.equal(fills.length,0,"marker toggle hides discarded image cells");
    e.tessera_sixel_clear_images(handle);
    assert.equal(e.tessera_sixel_image_count(handle),0);
  } finally {owner.clear();e.ghostty_terminal_free(handle);globalThis.document=originalDocument;globalThis.ImageData=originalImageData;}
});

test("text, images, cursor, and scrollbar paint in the intended order",()=>{
  const calls=[];
  class Renderer {
    render(){calls.push("text");this.renderCursor(1,2);this.renderScrollbar();}
    renderCursor(){calls.push("cursor");}
    renderScrollbar(){calls.push("scrollbar");}
  }
  installSixelRenderer(Renderer);
  const renderer=new Renderer();
  renderer.render({exports:{tessera_sixel_image_count:()=>1,tessera_sixel_tiles:()=>1}},false,0,{sixelRenderer:{images:new Map(),render(){calls.push("images");}}});
  assert.deepEqual(calls,["text","images","cursor","scrollbar"]);
});

test("retained offscreen images preserve dirty-row paints and explicit redraws", () => {
  const calls = [], queries = [], owner = new SixelRenderer();
  owner.render = () => assert.fail("offscreen images must not decode or composite");
  class Renderer {
    render(...args) { calls.push(args); return "painted"; }
  }
  installSixelRenderer(Renderer);
  const buffer = { handle: 123, exports: {
    tessera_sixel_image_count: () => 2,
    tessera_sixel_tiles(...args) { queries.push(args); return 0; },
  } };
  const renderer = new Renderer(), provider = { sixelRenderer: owner };
  assert.equal(renderer.render(buffer, false, 5.7, provider, 0.4), "painted");
  renderer.render(buffer, true, 5.7, provider, 0.4);
  assert.deepEqual(calls.map(call => call.slice(1)), [[false, 5.7, provider, 0.4], [true, 5.7, provider, 0.4]]);
  assert.deepEqual(queries, [[123, 5, 0, 0], [123, 5, 0, 0]]);
  assert.equal(owner.hadVisibleTiles, false);
});

test("offscreen painting releases evicted cached bitmaps without loading image metadata", () => {
  const owner = new SixelRenderer(), canvas = { width: 8, height: 6 }, forces = [];
  owner.images.set(1, { canvas });
  class Renderer { render(buffer, force) { forces.push(force); } }
  installSixelRenderer(Renderer);
  new Renderer().render({ handle: 1, exports: {
    tessera_sixel_image_count: () => 1,
    tessera_sixel_tiles: () => 0,
    tessera_sixel_image_pixels: () => 0,
    tessera_sixel_image_info: () => assert.fail("offscreen metadata must not be decoded"),
  } }, false, 0, { sixelRenderer: owner });
  assert.deepEqual(forces, [false]);
  assert.equal(owner.images.size, 0);
  assert.deepEqual(canvas, { width: 0, height: 0 });
});

test("removing the last visible image clears once even after cache clear or per-write pruning", () => {
  for (const cleanup of ["clear", "prune"]) {
    const owner = new SixelRenderer(), forces = [], canvas = { width: 8, height: 6 };
    let count = 1;
    const buffer = { handle: 1, exports: {
      tessera_sixel_image_count: () => count,
      tessera_sixel_tiles: () => count,
      tessera_sixel_image_pixels: () => 0,
    } };
    owner.images.set(1, { canvas }); owner.render = () => {};
    class Renderer { render(buffer, force) { forces.push(force); } }
    installSixelRenderer(Renderer);
    const renderer = new Renderer(), provider = { sixelRenderer: owner };
    renderer.render(buffer, false, 0, provider);
    count = 0;
    owner[cleanup](buffer);
    assert.equal(owner.images.size, 0);
    renderer.render(buffer, false, 0, provider);
    renderer.render(buffer, false, 0, provider);
    assert.deepEqual(forces, [true, true, false], cleanup);
  }
});

test("visible fragments reuse their count and keep overlay methods intact", () => {
  const calls = [], owner = new SixelRenderer();
  let queries = 0;
  class Renderer {
    render(buffer, force) { calls.push(["text", force]); this.renderCursor(2, 3); this.renderScrollbar(4); }
    renderCursor(...args) { calls.push(["cursor", ...args]); }
    renderScrollbar(...args) { calls.push(["scrollbar", ...args]); }
  }
  owner.render = (renderer, buffer, viewport, count) => calls.push(["images", viewport, count]);
  installSixelRenderer(Renderer);
  const renderer = new Renderer(), cursor = renderer.renderCursor, scrollbar = renderer.renderScrollbar;
  renderer.render({ handle: 1, exports: {
    tessera_sixel_image_count: () => 2, tessera_sixel_tiles: () => { queries++; return 8; },
  } }, false, 3.5, { sixelRenderer: owner });
  assert.deepEqual(calls, [["text", true], ["images", 3.5, 8], ["cursor", 2, 3], ["scrollbar", 4]]);
  assert.equal(queries, 1);
  assert.equal(owner.hadVisibleTiles, true);
  assert.equal(renderer.renderCursor, cursor); assert.equal(renderer.renderScrollbar, scrollbar);
});

test("a failed clearing redraw preserves the retry until canvas painting succeeds", () => {
  const owner = new SixelRenderer(), forces = [];
  owner.hadVisibleTiles = true;
  let failing = true;
  class Renderer {
    render(buffer, force) { forces.push(force); if (failing) throw new Error("paint failed"); }
  }
  installSixelRenderer(Renderer);
  const renderer = new Renderer(), buffer = { exports: { tessera_sixel_image_count: () => 0 } }, provider = { sixelRenderer: owner };
  assert.throws(() => renderer.render(buffer, false, 0, provider), /paint failed/);
  assert.equal(owner.hadVisibleTiles, true);
  failing = false;
  renderer.render(buffer, false, 0, provider); renderer.render(buffer, false, 0, provider);
  assert.deepEqual(forces, [true, true, false]);
});

test("terminals with no retained images avoid viewport scans and preserve ordinary paint arguments", () => {
  const forces = [];
  class Renderer { render(buffer, force) { forces.push(force); } }
  installSixelRenderer(Renderer);
  const buffer = { exports: {
    tessera_sixel_image_count: () => 0,
    tessera_sixel_tiles: () => assert.fail("plain terminals must not scan image fragments"),
  } };
  const renderer = new Renderer(), provider = { sixelRenderer: new SixelRenderer() };
  renderer.render(buffer, false, 0, provider); renderer.render(buffer, true, 0, provider);
  assert.deepEqual(forces, [false, true]);
});

test("real core image visibility follows scrollback, resizing, alternate screens, and erasure", async () => {
  const bytes = await fs.readFile(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports, handle = e.ghostty_terminal_new(20, 6), forces = [];
  e.tessera_sixel_geometry(handle, 2, 6);
  const buffer = { exports: e, handle }, owner = new SixelRenderer();
  owner.render = () => {};
  class Renderer { render(buffer, force) { forces.push(force); } }
  installSixelRenderer(Renderer);
  const renderer = new Renderer(), provider = { sixelRenderer: owner };
  const paint = (viewport = 0, force = false) => { renderer.render(buffer, force, viewport, provider); return forces.at(-1); };
  function write(text) {
    const data = new TextEncoder().encode(text), ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    new Uint8Array(e.memory.buffer).set(data, ptr); e.ghostty_terminal_write(handle, ptr, data.length);
    e.ghostty_wasm_free_u8_array(ptr, data.length);
  }
  try {
    write('\x1bPq"1;1;4;6#1;2;100;0;0!4~\x1b\\');
    assert.equal(paint(), true);
    write("\r\n" + "build output\r\n".repeat(20));
    assert.equal(e.tessera_sixel_image_count(handle), 1);
    assert.equal(e.tessera_sixel_tiles(handle, 0, 0, 0), 0);
    assert.equal(paint(), true, "clear the old image as it leaves the viewport");
    assert.equal(paint(), false, "retained scrollback images no longer force redraws");
    assert.equal(paint(e.ghostty_terminal_get_scrollback_length(handle)), true, "scrolling back shows the image");
    e.ghostty_terminal_resize(handle, 10, 4); e.tessera_sixel_geometry(handle, 4, 12);
    assert.equal(paint(e.ghostty_terminal_get_scrollback_length(handle)), true, "reflow and metric changes retain visible fragments");
    write("\x1b[?1049h");
    assert.equal(paint(), true, "clear primary-screen images when entering an empty alternate screen");
    assert.equal(paint(), false);
    write("\x1b[?1049l");
    assert.equal(paint(e.ghostty_terminal_get_scrollback_length(handle)), true);
    write("\x1b[3J\x1b[2J");
    assert.equal(e.tessera_sixel_image_count(handle), 0);
    assert.equal(paint(), true, "last-image erasure clears the old overlay");
    assert.equal(paint(), false);
    assert.equal(paint(0, true), true, "an explicit resize/exposure redraw is preserved");
  } finally { owner.clear(); e.ghostty_terminal_free(handle); }
});
