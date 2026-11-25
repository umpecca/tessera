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
  const renderer={getMetrics:()=>metrics,isInSelection:()=>false,ctx:{depth:0,save(){this.depth++;},restore(){this.depth--;},drawImage(...args){draws.push(args);},fillRect(...args){fills.push(args);},beginPath(){},rect(){},clip(){},fillText(){}}};
  const owner=new SixelRenderer(), buffer={exports:e,handle};
  try {
    write('\x1b[2;3H\x1bPq"1;1;4;12#1;2;100;0;0!4~-!4~\x1b\\');
    owner.render(renderer,buffer,0); assert.equal(canvases.length,1);assert.equal(draws.length,4);
    const first=draws[0].slice(5); draws.length=0;
    owner.render(renderer,buffer,0,undefined,new Set([1]));
    assert.equal(draws.length,2,"only image fragments in repainted rows are composited");
    assert.ok(draws.every(draw=>draw[6]===6));
    const drawImage=renderer.ctx.drawImage;
    renderer.ctx.drawImage=()=>{throw new Error("canvas failed");};
    assert.throws(()=>owner.render(renderer,buffer,0),/canvas failed/);
    assert.equal(renderer.ctx.depth,0,"image paint failure releases canvas state");
    renderer.ctx.drawImage=drawImage;
    draws.length=0;
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

test("idle image frames skip metadata, allocation, decoding, and compositing", () => {
  const exports = new Proxy({}, { get() { assert.fail("idle image frames must not access WASM"); } });
  new SixelRenderer().render({}, { exports }, 0, 4, new Set());
});

test("only painted visible images create bitmaps; history and alternate images wait until revealed", async () => {
  const bytes = await fs.readFile(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports;
  let handle = e.ghostty_terminal_new(20, 6);
  e.tessera_sixel_geometry(handle, 2, 6);
  const write = text => {
    const data = new TextEncoder().encode(text), ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    new Uint8Array(e.memory.buffer).set(data, ptr); e.ghostty_terminal_write(handle, ptr, data.length);
    e.ghostty_wasm_free_u8_array(ptr, data.length);
  };
  const originalDocument = globalThis.document, originalImageData = globalThis.ImageData;
  const canvases = [], draws = [];
  globalThis.document = { createElement() {
    const canvas = { width: 0, height: 0, getContext: () => ({ putImageData() {} }) };
    canvases.push(canvas); return canvas;
  } };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const owner = new SixelRenderer(), buffer = { exports: e, handle };
  const renderer = { getMetrics: () => ({ width: 2, height: 6 }), isInSelection: () => false,
    ctx: { save() {}, restore() {}, drawImage(...args) { draws.push(args); } } };
  const image = '\x1bPq"1;1;4;6#1;2;100;0;0!4~\x1b\\';
  try {
    write("\x1b[H" + image + "\r\n".repeat(10));
    write("\x1b[?1049h\x1b[H" + image + "\x1b[?1049l\x1b[2;1H" + image);
    assert.equal(e.tessera_sixel_image_count(handle), 3);
    owner.render(renderer, buffer, 0, undefined, new Set([5]));
    assert.equal(canvases.length, 0, "an unpainted visible image also stays lazy");
    owner.render(renderer, buffer, 0);
    assert.equal(canvases.length, 1); assert.deepEqual([...owner.images.keys()], [3]);
    owner.render(renderer, buffer, 0);
    assert.equal(canvases.length, 1, "visible image is copied once");
    owner.render(renderer, buffer, e.ghostty_terminal_get_scrollback_length(handle));
    assert.equal(canvases.length, 2); assert.ok(owner.images.has(1));
    write("\x1b[?47h"); owner.render(renderer, buffer, 0);
    assert.equal(canvases.length, 3); assert.ok(owner.images.has(2));
    write("\x1b[?47l");
    const length = e.tessera_sixel_snapshot_export(handle);
    const snapshot = new Uint8Array(e.memory.buffer, e.tessera_sixel_snapshot_data(handle), length).slice();
    const ptr = e.ghostty_wasm_alloc_u8_array(length);
    new Uint8Array(e.memory.buffer).set(snapshot, ptr);
    const restored = e.tessera_sixel_snapshot_import(ptr, length);
    e.ghostty_wasm_free_u8_array(ptr, length);
    assert.ok(restored);
    owner.clear(); e.ghostty_terminal_free(handle); handle = restored; buffer.handle = handle;
    owner.render(renderer, buffer, 0);
    assert.equal(canvases.length, 4); assert.deepEqual([...owner.images.keys()], [3]);
    assert.ok(draws.length > 0);
  } finally {
    owner.clear(); e.ghostty_terminal_free(handle);
    globalThis.document = originalDocument; globalThis.ImageData = originalImageData;
  }
});

test("metadata allocation growth cannot detach visible fragment records", async () => {
  const bytes = await fs.readFile(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports, handle = e.ghostty_terminal_new(20, 6);
  e.tessera_sixel_geometry(handle, 2, 6);
  const data = new TextEncoder().encode('\x1bPq"1;1;8;6#1;2;100;0;0!8~\x1b\\'), ptr = e.ghostty_wasm_alloc_u8_array(data.length);
  new Uint8Array(e.memory.buffer).set(data, ptr); e.ghostty_terminal_write(handle, ptr, data.length);
  e.ghostty_wasm_free_u8_array(ptr, data.length);
  const originalDocument = globalThis.document, originalImageData = globalThis.ImageData;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {} }) }) };
  globalThis.ImageData = class {};
  let draws = 0, grew = false;
  const owner = new SixelRenderer();
  const buffer = { handle, exports: { ...e, ghostty_wasm_alloc_u8_array(length) {
    const result = e.ghostty_wasm_alloc_u8_array(length);
    if (length === 28) { e.memory.grow(1); grew = true; }
    return result;
  } } };
  try {
    owner.render({ getMetrics: () => ({ width: 2, height: 6 }), isInSelection: () => false,
      ctx: { save() {}, restore() {}, drawImage() { draws++; } } }, buffer, 0);
    assert.equal(grew, true); assert.equal(draws, 4);
  } finally {
    owner.clear(); e.ghostty_terminal_free(handle);
    globalThis.document = originalDocument; globalThis.ImageData = originalImageData;
  }
});

function incrementalFixture() {
  const owner = new SixelRenderer(), calls = [], regions = [], forces = [];
  owner.hadVisibleTiles = true;
  const buffer = {
    exports: { tessera_sixel_image_count: () => 1, tessera_sixel_tiles: () => 4 },
    getDimensions: () => ({ cols: 20, rows: 6 }),
    getLine: row => row >= 0 && row < 6 ? [`row ${row}`] : null,
    dirty: [], cursor: null, selection: null,
  };
  const ctx = { depth: 0,
    save() { this.depth++; }, restore() { this.depth--; },
    beginPath() { regions.length = 0; }, rect(...args) { regions.push(args); }, clip() {},
  };
  class Renderer {
    constructor() { this.ctx = ctx; this.cursorStyle = "block"; }
    getMetrics() { return { width: 8, height: 18 }; }
    render(buffer, force, viewport, provider, opacity) {
      forces.push(force);
      for (const row of force ? [0, 1, 2, 3, 4, 5] : buffer.dirty) {
        this.renderLine(buffer.getLine(row), row, 20);
      }
      this.currentSelectionCoords = buffer.selection;
      if (buffer.cursor) this.renderCursor(...buffer.cursor);
      if (opacity > 0) this.renderScrollbar();
      buffer.dirty = [];
      return "painted";
    }
    renderLine(cells, row) { calls.push(["text", row, this.currentSelectionCoords]); }
    renderCursor(...args) { calls.push(["cursor", ...args]); }
    renderScrollbar() { calls.push(["scrollbar"]); }
  }
  owner.render = (renderer, buffer, viewport, count, rows) => calls.push(["images", rows && [...rows]]);
  installSixelRenderer(Renderer);
  const renderer = new Renderer(), provider = { sixelRenderer: owner };
  return { owner, buffer, calls, regions, forces, ctx, renderer,
    paint: (force = false, opacity = 0) => renderer.render(buffer, force, 0, provider, opacity) };
}

test("visible images follow dirty rows, clip glyph overflow, and paint once in row order", () => {
  const { buffer, calls, regions, forces, ctx, renderer, paint } = incrementalFixture();
  buffer.dirty = [4, 2, 4]; buffer.selection = { startRow: 2, endRow: 4 };
  const original = renderer.renderLine;
  assert.equal(paint(), "painted");
  assert.deepEqual(forces, [false]);
  assert.deepEqual(calls.filter(call => call[0] === "text").map(call => call[1]), [1, 2, 3, 4, 5]);
  assert.ok(calls.filter(call => call[0] === "text").every(call => call[2] === buffer.selection));
  assert.deepEqual(calls.at(-1), ["images", [4, 2]]);
  assert.deepEqual(regions, [[0, 72, 160, 18], [0, 36, 160, 18]]);
  assert.equal(ctx.depth, 0);
  assert.equal(renderer.renderLine, original);
  assert.equal(Object.hasOwn(renderer, "renderLine"), false);
});

test("cursor visibility and shape repaint overlays even with clean native rows", () => {
  const { buffer, calls, owner, renderer, paint } = incrementalFixture();
  buffer.cursor = [3, 2];
  paint();
  assert.deepEqual(calls.at(-2), ["images", [2]]);
  assert.deepEqual(calls.at(-1), ["cursor", 3, 2]);
  calls.length = 0; paint();
  assert.deepEqual(calls, [["images", []]], "an unchanged cursor is not alpha-composited twice");
  calls.length = 0; buffer.cursor = null; paint();
  assert.deepEqual(calls.at(-1), ["images", [2]], "DEC cursor hide removes the old overlay");
  assert.equal(owner.cursorCell, null);
  buffer.cursor = [3, 2]; paint();
  calls.length = 0;
  // Shape changes use the same cursor position and may leave all native rows clean.
  renderer.cursorStyle = "bar";
  paint();
  assert.deepEqual(calls.at(-2), ["images", [2]]);
});

test("visible scrollbars, their removal, cache clears, and explicit redraws keep full paints", () => {
  const { owner, forces, paint } = incrementalFixture();
  paint(); paint(false, 0.5); paint(false, 0.1); paint(); paint();
  owner.clear(); paint(); paint(); paint(true);
  assert.deepEqual(forces, [false, true, true, true, false, true, false, true]);
});

test("fractional device-pixel row boundaries retain full paints without clipping seams", () => {
  const { renderer, forces, paint } = incrementalFixture();
  renderer.devicePixelRatio = 1.25;
  paint(); paint();
  renderer.devicePixelRatio = 1.5;
  paint();
  assert.deepEqual(forces, [true, true, false], "integer device-pixel row heights permit incremental paints");
});

test("aligned fractional image and plain grids retain clipped incremental paints", () => {
  for (const visible of [true, false]) {
    const { buffer, owner, renderer, calls, regions, forces, paint } = incrementalFixture();
    renderer.devicePixelRatio = 1.25; renderer.tesseraPixelGrid = true;
    if (!visible) {
      buffer.exports.tessera_sixel_image_count = () => 0;
      owner.hadVisibleTiles = false; owner.images.clear();
    }
    buffer.dirty = [4]; paint();
    assert.deepEqual(forces, [false]);
    assert.deepEqual(calls.filter(call => call[0] === "text").map(call => call[1]), [3, 4, 5]);
    assert.deepEqual(regions, [[0, 72, 160, 18]]);
    assert.equal(calls.some(call => call[0] === "images"), visible);
    calls.length = 0; paint();
    assert.equal(calls.some(call => call[0] === "text"), false, "idle fractional frames paint no rows");
  }
});

test("native full invalidation and viewport changes preserve streaming full paints", () => {
  const { buffer, renderer, calls, forces, paint } = incrementalFixture();
  buffer.needsFullRedraw = () => true;
  paint();
  assert.deepEqual(calls.at(-1), ["images", undefined]);
  buffer.needsFullRedraw = () => false;
  renderer.lastViewportY = 2;
  calls.length = 0; paint();
  assert.deepEqual(calls.at(-1), ["images", undefined]);
  assert.deepEqual(forces, [true, true]);
});

test("failed visible paints restore methods and canvas state and retry after dirty flags clear", () => {
  const { owner, buffer, renderer, ctx, forces, paint } = incrementalFixture();
  const line = renderer.renderLine.bind(renderer);
  renderer.renderLine = line;
  const cursor = renderer.renderCursor, scrollbar = renderer.renderScrollbar, composite = owner.render;
  owner.render = () => { throw new Error("image paint failed"); };
  buffer.dirty = [2];
  assert.throws(() => paint(), /image paint failed/);
  assert.deepEqual(buffer.dirty, []);
  assert.equal(owner.needsFullRender, true);
  assert.equal(ctx.depth, 0);
  assert.equal(renderer.renderLine, line);
  assert.equal(renderer.renderCursor, cursor); assert.equal(renderer.renderScrollbar, scrollbar);
  owner.render = composite;
  paint(); paint();
  assert.deepEqual(forces, [false, true, false]);
  assert.equal(owner.needsFullRender, false);
});

test("neighbor retrieval failures release the clip state and retain full-paint recovery", () => {
  const { owner, buffer, renderer, ctx, paint } = incrementalFixture();
  buffer.dirty = [2];
  const getLine = buffer.getLine;
  buffer.getLine = row => { if (row === 1) throw new Error("neighbor failed"); return getLine(row); };
  assert.throws(() => paint(), /neighbor failed/);
  assert.equal(ctx.depth, 0);
  assert.equal(Object.hasOwn(renderer, "renderLine"), false);
  assert.equal(owner.needsFullRender, true);
});

test("removing images after a failed first composite still clears partial image pixels", () => {
  const { owner, buffer, forces, paint } = incrementalFixture();
  owner.hadVisibleTiles = false;
  owner.render = () => { throw new Error("first image paint failed"); };
  assert.throws(() => paint(), /first image paint failed/);
  buffer.exports.tessera_sixel_image_count = () => 0;
  paint(); paint();
  assert.deepEqual(forces, [true, true, false]);
  assert.equal(owner.needsFullRender, false);
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

async function kittyCore() {
  const bytes = await fs.readFile(new URL("../internal/terminalcore/ghostty-vt.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log() {} } });
  const e = instance.exports, handle = e.ghostty_terminal_new(20, 6);
  e.tessera_sixel_geometry(handle, 10, 20);
  const write = (text) => {
    const data = new TextEncoder().encode(text), ptr = e.ghostty_wasm_alloc_u8_array(data.length);
    new Uint8Array(e.memory.buffer).set(data, ptr); e.ghostty_terminal_write(handle, ptr, data.length);
    e.ghostty_wasm_free_u8_array(ptr, data.length);
  };
  return { e, handle, buffer: { exports: e, handle }, write };
}
const kittyCommand = (keys, data = "") => `\x1b_G${keys};${data}\x1b\\`;
const kittyPixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]).toString("base64");

test("Kitty placements repaint the pane when they appear, move or go, and not on idle frames", async () => {
  const { e, handle, buffer, write } = await kittyCore();
  const forces = [], drawn = [];
  const owner = new SixelRenderer();
  owner.renderKitty = (_renderer, _buffer, kitty, _provider, rows) => drawn.push([kitty.count, rows && [...rows]]);
  Object.assign(buffer, { getDimensions: () => ({ cols: 20, rows: 6 }), getLine: (row) => [`row ${row}`], dirty: [] });
  const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} };
  // Paints every row when forced and only dirty rows otherwise, as
  // ghostty-web's renderer does.
  class Renderer {
    constructor() { this.ctx = ctx; }
    getMetrics() { return { width: 8, height: 18 }; }
    render(buffer, force) {
      forces.push(force);
      for (const row of force ? [0, 1, 2, 3, 4, 5] : buffer.dirty) this.renderLine(buffer.getLine(row), row, 20);
      buffer.dirty = [];
    }
    renderLine() {}
  }
  installSixelRenderer(Renderer);
  const renderer = new Renderer(), provider = { sixelRenderer: owner };
  const paint = (viewport = 0) => { renderer.render(buffer, false, viewport, provider); return forces.at(-1); };
  try {
    assert.equal(paint(), false, "no images: ordinary dirty-row painting");
    write(kittyCommand("a=T,i=1,f=32,s=2,v=2,q=2", kittyPixels));
    assert.equal(paint(), true, "a new image repaints");
    assert.deepEqual(drawn, [[1, undefined]], "and draws it over the whole pane");
    buffer.dirty = [0];
    assert.equal(paint(), false, "a text change keeps dirty-row painting");
    assert.deepEqual(drawn.at(-1), [1, [0]], "and redraws the image inside the repainted row's clip");
    write(kittyCommand("a=p,i=1,c=2,r=1,q=2"));
    assert.equal(paint(), true, "another placement repaints");
    write(kittyCommand("a=d,d=i,i=1,q=2"));
    assert.equal(paint(), true, "deleting repaints where it was");
    assert.equal(paint(), false);
    write(kittyCommand("a=T,i=2,f=32,s=2,v=2,q=2", kittyPixels) + "\r\n".repeat(10));
    paint();
    assert.equal(paint(), false, "scrolled out of view");
    assert.equal(paint(e.ghostty_terminal_get_scrollback_length(handle)), true, "and back");
  } finally { owner.clear(); e.ghostty_terminal_free(handle); }
});

test("Kitty images draw whole in front of text, scaled to this pane's cells, in z order, cached by generation", async () => {
  const { e, handle, buffer, write } = await kittyCore();
  const canvases = [];
  const saved = { document: globalThis.document, ImageData: globalThis.ImageData };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.document = { createElement: () => {
    const canvas = { width: 0, height: 0, images: [], getContext: () => ({ putImageData: (image) => canvas.images.push(image) }) };
    canvases.push(canvas);
    return canvas;
  } };
  const draws = [];
  const renderer = { getMetrics: () => ({ width: 5, height: 10 }), ctx: { save() {}, restore() {}, drawImage: (...args) => draws.push(args) } };
  const provider = { hostCellWidth: 10, hostCellHeight: 20 };
  const owner = new SixelRenderer();
  try {
    write("ab" + kittyCommand("a=T,i=4,f=32,s=2,v=2,z=3,q=2", kittyPixels));
    write(kittyCommand("a=T,i=3,f=24,s=1,v=1,c=2,r=1,X=4,Y=2,q=2", Buffer.from([9, 8, 7]).toString("base64")));
    let kitty = owner.readKitty(buffer, 0);
    owner.renderKitty(renderer, buffer, kitty, provider);
    assert.equal(draws.length, 2);
    assert.equal(draws[0][0], owner.kittyImages.get(3).canvas, "lower z first: image 3 (z 0) under image 4 (z 3)");
    assert.equal(draws[1][0], owner.kittyImages.get(4).canvas);
    assert.deepEqual(draws[0].slice(1), [0, 0, 1, 1, 3 * 5 + 2, 0 + 1, 10, 10], "two cells by one row at half the host's cell size, offsets halved");
    assert.deepEqual(draws[1].slice(1), [0, 0, 2, 2, 2 * 5, 0, 1, 1], "a 2x2 image at column 2");
    assert.deepEqual([...owner.kittyImages.get(3).canvas.images[0].data], [9, 8, 7, 255], "RGB becomes opaque RGBA");
    owner.renderKitty(renderer, buffer, kitty, provider);
    assert.equal(canvases.length, 2, "bitmaps are cached");
    write(kittyCommand("a=t,i=4,f=32,s=2,v=2,q=2", Buffer.from(Array(16).fill(1)).toString("base64")));
    kitty = owner.readKitty(buffer, 0);
    owner.renderKitty(renderer, buffer, kitty, provider);
    assert.deepEqual([...owner.kittyImages.get(4).canvas.images.at(-1).data.slice(0, 4)], [1, 1, 1, 1], "a replaced image is decoded again");
    const imageThree = owner.kittyImages.get(3).canvas;
    write(kittyCommand("a=d,d=I,i=3,q=2"));
    owner.readKitty(buffer, 0);
    assert.deepEqual([...owner.kittyImages.keys()], [4], "a deleted image's bitmap is released");
    assert.equal(imageThree.width, 0);
    owner.renderKitty(renderer, buffer, kitty, provider, new Set());
    assert.equal(draws.length, 6, "nothing on a frame with no repainted rows");
  } finally {
    owner.clear();
    e.ghostty_terminal_free(handle);
    Object.assign(globalThis, saved);
  }
});

test("Unicode placeholder characters are never drawn as text", () => {
  const drawn = [];
  class Renderer { render() {} renderCellText(cell) { drawn.push(cell.codepoint); } }
  installSixelRenderer(Renderer);
  const renderer = new Renderer();
  renderer.renderCellText({ codepoint: 0x10EEEE });
  renderer.renderCellText({ codepoint: 65 });
  assert.deepEqual(drawn, [65]);
});

test("rows paint Kitty images behind text between their fill, cell backgrounds and text", () => {
  const calls = [];
  class Renderer {
    constructor() {
      this.metrics = { width: 8, height: 16 };
      this.theme = { background: "#000000" };
      this.ctx = { fillRect: (...args) => calls.push(["fill", ...args]) };
    }
    render() {}
    renderLine() { calls.push(["ghostty-web line"]); }
    renderCellBackground(cell, col) { calls.push(["background", col]); }
    renderCellText(cell, col) { calls.push(["text", col]); }
  }
  installSixelRenderer(Renderer);
  const renderer = new Renderer();
  const cells = [{ codepoint: 65, width: 1 }, { codepoint: 0, width: 0 }, { codepoint: 66, width: 1 }];
  renderer.renderLine(cells, 2, 3);
  assert.deepEqual(calls, [["fill", 0, 32, 24, 16], ["background", 0], ["background", 2], ["text", 0], ["text", 2]],
    "without Kitty images, ghostty-web's three steps");
  calls.length = 0;
  renderer.tesseraKittyBelow = (row, underText) => calls.push([underText ? "images under text" : "images under backgrounds", row]);
  renderer.renderLine(cells, 2, 3);
  assert.deepEqual(calls.map((call) => call[0]), ["fill", "images under backgrounds", "background", "background", "images under text", "text", "text"]);
});

test("Kitty images behind text go to Ghostty's layers, row by row, with the selection over them", async () => {
  const { e, handle, buffer, write } = await kittyCore();
  const saved = { document: globalThis.document, ImageData: globalThis.ImageData };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {} }) }) };
  const ops = [];
  let selected = () => false;
  const ctx = {
    save: () => ops.push(["save"]), restore: () => ops.push(["restore"]), beginPath() {},
    rect: (...args) => ops.push(["clip", ...args]), clip() {},
    drawImage: (canvas, ...args) => ops.push(["image", owner.kittyIdOf(canvas), ...args.slice(4)]),
    fillRect: (...args) => ops.push(["selection", ...args]),
  };
  const renderer = { getMetrics: () => ({ width: 10, height: 20 }), ctx, theme: { selectionBackground: "#336699" },
    isInSelection: (col, row) => selected(col, row) };
  const provider = { hostCellWidth: 10, hostCellHeight: 20 };
  const owner = new SixelRenderer();
  owner.kittyIdOf = (canvas) => [...owner.kittyImages].find(([, image]) => image.canvas === canvas)?.[0];
  try {
    write(kittyCommand("a=t,i=1,f=32,s=2,v=2,q=2", kittyPixels));
    write(kittyCommand("a=p,i=1,c=2,r=2,z=-2000000000,C=1,q=2") + kittyCommand("a=p,i=1,c=1,r=1,z=-1,C=1,q=2")
      + kittyCommand("a=p,i=1,c=1,r=1,z=4,C=1,q=2"));
    const kitty = owner.readKitty(buffer, 0);
    assert.equal(kitty.count, 3);
    owner.renderKittyRow(renderer, buffer, kitty, provider, 0, false);
    assert.deepEqual(ops.filter((op) => op[0] === "image"), [["image", 1, 0, 0, 20, 40]], "under backgrounds: the z < -1073741824 image");
    assert.ok(ops.some((op) => op[0] === "clip" && op[2] === 0 && op[4] === 20), "clipped to its row");
    ops.length = 0;
    owner.renderKittyRow(renderer, buffer, kitty, provider, 0, true);
    assert.deepEqual(ops.filter((op) => op[0] === "image"), [["image", 1, 0, 0, 10, 20]], "under text: the z -1 image");
    ops.length = 0;
    owner.renderKittyRow(renderer, buffer, kitty, provider, 1, true);
    assert.deepEqual(ops, [], "row 1 has no under-text image");
    owner.renderKittyRow(renderer, buffer, kitty, provider, 1, false);
    assert.deepEqual(ops.filter((op) => op[0] === "image").length, 1, "but the background-layer image spans it");
    ops.length = 0;
    owner.renderKitty(renderer, buffer, kitty, provider);
    assert.deepEqual(ops.filter((op) => op[0] === "image"), [["image", 1, 0, 0, 10, 20]], "in front: the z 4 image");
    ops.length = 0;
    selected = (col, row) => col === 0 && row === 0;
    owner.renderKitty(renderer, buffer, kitty, provider);
    assert.deepEqual(ops.filter((op) => op[0] === "selection"), [["selection", 0, 0, 10, 20]], "the selection shows over an image in front");
    ops.length = 0;
    owner.renderKittyRow(renderer, buffer, kitty, provider, 0, true);
    assert.deepEqual(ops.filter((op) => op[0] === "selection"), [["selection", 0, 0, 10, 20]], "and over one behind text");
    // Unicode placeholder images sit under text, as in Ghostty.
    write("\x1bc"); e.tessera_sixel_geometry(handle, 10, 20);
    write(kittyCommand("a=T,U=1,i=9,f=32,s=2,v=2,c=1,r=1,q=2", kittyPixels) + "\x1b[38;5;9m\u{10EEEE}\u{0305}\u{0305}\x1b[0m");
    const placeholder = owner.readKitty(buffer, 0);
    ops.length = 0;
    owner.renderKitty(renderer, buffer, placeholder, provider);
    assert.deepEqual(ops.filter((op) => op[0] === "image"), [], "not in front");
    owner.renderKittyRow(renderer, buffer, placeholder, provider, 0, true);
    assert.equal(ops.filter((op) => op[0] === "image").length, 1, "under the text layer");
  } finally {
    owner.clear();
    e.ghostty_terminal_free(handle);
    Object.assign(globalThis, saved);
  }
});

test("the overlay path gives rows the Kitty hook while they paint, and removes it after", async () => {
  const { e, handle, buffer, write } = await kittyCore();
  const seen = [];
  const owner = new SixelRenderer();
  owner.renderKittyRow = (_renderer, _buffer, kitty, _provider, row, underText) => seen.push([kitty.count, row, underText]);
  owner.renderKitty = () => {};
  Object.assign(buffer, { getDimensions: () => ({ cols: 20, rows: 6 }), getLine: (row) => [{ codepoint: 65 + row, width: 1 }], dirty: [] });
  class Renderer {
    constructor() {
      this.metrics = { width: 8, height: 18 };
      this.theme = { background: "#000000" };
      this.ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {} };
    }
    getMetrics() { return this.metrics; }
    render(buffer, force) { for (const row of force ? [0, 1] : buffer.dirty) this.renderLine(buffer.getLine(row), row, 1); }
    renderLine() {}
    renderCellBackground() {}
    renderCellText() {}
  }
  installSixelRenderer(Renderer);
  const renderer = new Renderer();
  try {
    write(kittyCommand("a=T,i=1,f=32,s=2,v=2,z=-1,q=2", kittyPixels));
    renderer.render(buffer, false, 0, { sixelRenderer: owner });
    assert.deepEqual(seen, [[1, 0, false], [1, 0, true], [1, 1, false], [1, 1, true]]);
    assert.equal(renderer.tesseraKittyBelow, undefined);
  } finally { owner.clear(); e.ghostty_terminal_free(handle); }
});
