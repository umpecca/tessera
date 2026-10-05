import assert from "node:assert/strict";
import test from "node:test";
import { installTerminalPixelGrid } from "./terminal-pixel-grid.mjs";

test("adjoining backgrounds, clips, and image destinations share physical pixel boundaries", () => {
  for (const ratio of [1.1, 1.25, 1.5, 1.75]) {
    const calls = [];
    class Context {
      fillRect(...args) { calls.push(["fill", ...args]); }
      rect(...args) { calls.push(["clip", ...args]); }
      drawImage(...args) { calls.push(["image", ...args]); }
    }
    class Renderer {
      constructor() { this.ctx = new Context(); this.devicePixelRatio = ratio; }
      getMetrics() { return { width: 9, height: 19 }; }
      render() {
        for (let row = 0; row < 5; row++) {
          this.ctx.fillRect(0, row * 19, 9, 19); this.ctx.rect(0, row * 19, 9, 19);
          this.ctx.drawImage("bitmap", 1, 2, 3, 4, 0, row * 19, 9, 19);
        }
      }
    }
    installTerminalPixelGrid(Renderer); const renderer = new Renderer(); renderer.render();
    let bottom = 0;
    for (let row = 0; row < 5; row++) {
      const [fill, clip, image] = calls.slice(row * 3, row * 3 + 3);
      assert.deepEqual(clip.slice(1), fill.slice(1)); assert.deepEqual(image.slice(6), fill.slice(1));
      assert.deepEqual(image.slice(1, 6), ["bitmap", 1, 2, 3, 4]);
      const [, x, y, w, h] = fill;
      assert.ok(Math.abs(x * ratio - Math.round(x * ratio)) < 1e-10);
      assert.equal(Math.round(y * ratio), bottom); bottom = Math.round((y + h) * ratio);
      assert.equal(Math.round(w * ratio), Math.round(9 * ratio));
    }
    assert.equal(Object.hasOwn(renderer.ctx, "fillRect"), false);
  }
});

test("integer grids bypass wrapping, installation is idempotent, and errors restore context methods", () => {
  for (const ratio of [1, 2, 1.25]) {
    const ctx = { fillRect() {}, rect() {}, drawImage() {} }, originals = { ...ctx };
    class Renderer {
      constructor() { this.ctx = ctx; this.devicePixelRatio = ratio; }
      getMetrics() { return { width: 9, height: 19 }; }
      render(...args) {
        assert.deepEqual(args, ["buffer", true, 0, "provider", 0]);
        if (ratio !== 1.25) assert.deepEqual(ctx, originals);
        throw new Error("paint failed");
      }
    }
    installTerminalPixelGrid(Renderer); const render = Renderer.prototype.render;
    installTerminalPixelGrid(Renderer); assert.equal(Renderer.prototype.render, render);
    assert.throws(() => new Renderer().render("buffer", true, 0, "provider", 0), /paint failed/);
    assert.deepEqual(ctx, originals);
  }
});

test("underline and hover strokes use an integer thickness and matching pixel center", () => {
  for (const ratio of [1.1, 1.25, 1.5, 1.75]) {
    const calls = [], ctx = { lineWidth: 1, fillRect() {}, rect() {}, drawImage() {},
      moveTo(...args) { calls.push(args); }, lineTo(...args) { calls.push(args); },
      stroke() { calls.push(this.lineWidth); } };
    class Renderer {
      constructor() { this.ctx = ctx; this.devicePixelRatio = ratio; }
      getMetrics() { return { width: 9, height: 19 }; }
      render() { ctx.moveTo(0, 18); ctx.lineTo(9, 18); ctx.stroke(); }
    }
    installTerminalPixelGrid(Renderer); new Renderer().render();
    const thickness = Math.round(ratio), center = calls[0][1] * ratio;
    assert.equal(calls[2] * ratio, thickness);
    assert.equal(center % 1, thickness % 2 / 2);
    assert.equal(calls[0][1], calls[1][1]); assert.equal(ctx.lineWidth, 1);
  }
});
