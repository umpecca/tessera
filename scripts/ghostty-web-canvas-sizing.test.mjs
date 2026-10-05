import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { alignGhosttyWebCanvasSizing } from "./ghostty-web-canvas-sizing.mjs";

test("patches every size boundary of the pinned renderer exactly once", async () => {
  const source = await fs.readFile(new URL("../node_modules/ghostty-web/dist/ghostty-web.js", import.meta.url), "utf8");
  const patched = alignGhosttyWebCanvasSizing(source);
  assert.equal(alignGhosttyWebCanvasSizing(patched), patched);
  assert.equal((patched.match(/Math.round\([gE] \* this.devicePixelRatio\)/g) || []).length, 2);
  assert.equal((patched.match(/!== Math.round\(D\./g) || []).length, 2);
  assert.throws(() => alignGhosttyWebCanvasSizing(source.replace("this.canvas.width = g * this.devicePixelRatio", "this.canvas.width = different")), /canvas sizing changed/);
  assert.throws(() => alignGhosttyWebCanvasSizing(source + "this.canvas.width = g * this.devicePixelRatio"), /canvas sizing changed/);
});
