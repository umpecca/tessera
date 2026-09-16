import test from "node:test";
import assert from "node:assert/strict";
import { installPlainRenderer } from "./terminal-plain-renderer.mjs";

function fixture() {
  const calls = [];
  class Renderer {
    renderLine(...args) { calls.push(["fallback", ...args]); }
    rgbToCSS(r, g, b) { return `rgb(${r}, ${g}, ${b})`; }
  }
  installPlainRenderer(Renderer);
  installPlainRenderer(Renderer);
  const renderer = new Renderer();
  Object.assign(renderer, {
    ctx: { fillRect: (...args) => calls.push(["background", ...args]), fillText: (...args) => calls.push(["text", ...args]) },
    metrics: { width: 9, height: 18, baseline: 14 },
    theme: { background: "#000" }, fontSize: 14, fontFamily: "Fira Code",
  });
  const cell = { codepoint: 65, width: 1, flags: 0, grapheme_len: 0, hyperlink_id: 0,
    fg_r: 220, fg_g: 220, fg_b: 220, bg_r: 0, bg_g: 0, bg_b: 0 };
  return { renderer, cell, calls };
}

test("plain rows preserve grid positions and clear the full row, including blank cells", () => {
  const {renderer, cell, calls} = fixture();
  renderer.renderLine([cell, {...cell, codepoint:32}, {...cell, codepoint:66}, {...cell, codepoint:0}], 2, 8);
  assert.deepEqual(calls, [["background",0,36,72,18], ["text","A",0,50], ["text","B",18,50]]);
  assert.equal(renderer.ctx.font, "14px Fira Code");
  assert.equal(renderer.ctx.fillStyle, "rgb(220, 220, 220)");
});

for (const change of [{flags:1}, {width:2}, {width:0}, {codepoint:0x2588}, {codepoint:0x1f600},
  {codepoint:9}, {grapheme_len:1}, {hyperlink_id:1}, {bg_r:1}, {bg_g:1}, {bg_b:1}, {fg_r:1}]) {
  test(`complex row falls back atomically: ${JSON.stringify(change)}`, () => {
    const {renderer, cell, calls} = fixture();
    const cells = [cell, {...cell, ...change}];
    renderer.renderLine(cells, 2, 8);
    assert.deepEqual(calls, [["fallback",cells,2,8]]);
  });
}

for (const key of ["currentSelectionCoords", "hoveredLinkRange"]) {
  test(`${key} retains normal rendering`, () => {
    const {renderer, cell, calls} = fixture();
    renderer[key] = {};
    renderer.renderLine([cell], 0, 1);
    assert.equal(calls[0][0], "fallback");
  });
}
