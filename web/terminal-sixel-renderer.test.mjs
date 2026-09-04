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
  renderer.render({exports:{tessera_sixel_image_count:()=>1}},false,0,{sixelRenderer:{images:new Map(),render(){calls.push("images");}}});
  assert.deepEqual(calls,["text","images","cursor","scrollbar"]);
});
