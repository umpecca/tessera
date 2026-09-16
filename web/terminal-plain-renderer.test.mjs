import test from "node:test";
import assert from "node:assert/strict";
import {
  installPlainRenderer,
  plainRendererStatistics,
  setPlainRendererEnabled,
} from "./terminal-plain-renderer.mjs";

function fixture(experimental = true) {
  const calls = [];
  const styles = [];
  class Renderer {
    renderLine(...args) { calls.push(["fallback", ...args]); }
    renderCellBackground(...args) { calls.push(["original-background", ...args]); }
    renderCellText(...args) { calls.push(["original-text", ...args]); }
    rgbToCSS(r, g, b) { return `rgb(${r}, ${g}, ${b})`; }
  }
  installPlainRenderer(Renderer);
  installPlainRenderer(Renderer);
  const renderer = new Renderer();
  const ctx = {
    fillRect(...args) {
      calls.push(["background", ...args]);
      styles.push(["background", this.fillStyle]);
    },
    fillText(...args) {
      calls.push(["text", ...args]);
      styles.push(["text", this.fillStyle]);
    },
  };
  Object.assign(renderer, {
    ctx,
    metrics: { width: 9, height: 18, baseline: 14 },
    theme: { background: "#000" }, fontSize: 14, fontFamily: "Fira Code",
  });
  setPlainRendererEnabled(renderer, experimental);
  const cell = { codepoint: 65, width: 1, flags: 0, grapheme_len: 0, hyperlink_id: 0,
    fg_r: 220, fg_g: 220, fg_b: 220, bg_r: 0, bg_g: 0, bg_b: 0 };
  return { renderer, cell, calls, styles };
}

test("stable mode uses Ghostty's original renderer", () => {
  const {renderer, cell, calls} = fixture(false);
  const cells = [cell];
  renderer.renderLine(cells, 0, 1);
  assert.deepEqual(calls, [["fallback", cells, 0, 1]]);
  assert.equal(Object.hasOwn(renderer, "renderLine"), false);
});

test("renderer mode can switch on an open terminal", () => {
  const {renderer, cell, calls} = fixture(false);
  setPlainRendererEnabled(renderer, true);
  renderer.renderLine([cell], 0, 1);
  assert.equal(calls[0][0], "background");
  assert.equal(Object.hasOwn(renderer, "renderLine"), true);
  assert.deepEqual(plainRendererStatistics(renderer), {
    fastRows: 1, hybridRows: 0, originalRows: 0, totalRows: 1,
  });

  calls.length = 0;
  setPlainRendererEnabled(renderer, false);
  const cells = [cell];
  renderer.renderLine(cells, 0, 1);
  assert.deepEqual(calls, [["fallback", cells, 0, 1]]);
  assert.equal(Object.hasOwn(renderer, "renderLine"), false);
  assert.equal(plainRendererStatistics(renderer), null);

  setPlainRendererEnabled(renderer, true);
  assert.deepEqual(plainRendererStatistics(renderer), {
    fastRows: 0, hybridRows: 0, originalRows: 0, totalRows: 0,
  });
});

test("plain rows preserve grid positions and clear the full row, including blank cells", () => {
  const {renderer, cell, calls} = fixture();
  renderer.renderLine([cell, {...cell, codepoint:32}, {...cell, codepoint:66}, {...cell, codepoint:0}], 2, 8);
  assert.deepEqual(calls, [["background",0,36,72,18], ["text","A",0,50], ["text","B",18,50]]);
  assert.equal(renderer.ctx.font, "14px Fira Code");
  assert.equal(renderer.ctx.fillStyle, "rgb(220, 220, 220)");
});

test("mixed foreground colors stay on the experimental path", () => {
  const {renderer, cell, calls, styles} = fixture();
  renderer.renderLine([
    cell,
    {...cell, codepoint: 66, fg_r: 240, fg_g: 80, fg_b: 70},
    {...cell, codepoint: 67, fg_r: 240, fg_g: 80, fg_b: 70},
    {...cell, codepoint: 68},
  ], 1, 4);
  assert.deepEqual(calls, [
    ["background", 0, 18, 36, 18],
    ["text", "A", 0, 32],
    ["text", "B", 9, 32],
    ["text", "C", 18, 32],
    ["text", "D", 27, 32],
  ]);
  assert.deepEqual(styles, [
    ["background", "#000"],
    ["text", "rgb(220, 220, 220)"],
    ["text", "rgb(240, 80, 70)"],
    ["text", "rgb(240, 80, 70)"],
    ["text", "rgb(220, 220, 220)"],
  ]);
});

test("adjacent background colors are merged before text is painted", () => {
  const {renderer, cell, calls, styles} = fixture();
  renderer.renderLine([
    {...cell, bg_r: 20, bg_g: 40, bg_b: 60},
    {...cell, codepoint: 66, bg_r: 20, bg_g: 40, bg_b: 60},
    {...cell, codepoint: 67},
    {...cell, codepoint: 68, bg_r: 90, bg_g: 30, bg_b: 10},
  ], 2, 6);
  assert.deepEqual(calls.slice(0, 3), [
    ["background", 0, 36, 54, 18],
    ["background", 0, 36, 18, 18],
    ["background", 27, 36, 9, 18],
  ]);
  assert.deepEqual(styles.slice(0, 3), [
    ["background", "#000"],
    ["background", "rgb(20, 40, 60)"],
    ["background", "rgb(90, 30, 10)"],
  ]);
  assert.ok(calls.slice(3).every(call => call[0] === "text"));
});

test("hybrid rows preserve two-pass ordering around complex cells", () => {
  const {renderer, cell, calls} = fixture();
  const background = {bg_r: 20, bg_g: 40, bg_b: 60};
  const complex = {...cell, codepoint: 66, flags: 1, ...background};
  renderer.renderLine([{...cell, ...background}, complex, {...cell, codepoint: 67, ...background}], 2, 3);
  assert.deepEqual(calls.map(call => call[0]), [
    "background", "background", "original-background", "background",
    "text", "original-text", "text",
  ]);
  assert.strictEqual(calls[2][1], complex);
  assert.strictEqual(calls[5][1], complex);
  assert.deepEqual(plainRendererStatistics(renderer), {
    fastRows: 0, hybridRows: 1, originalRows: 0, totalRows: 1,
  });
});

for (const change of [{flags:1}, {width:2}, {codepoint:0x2588}, {codepoint:0x1f600},
  {codepoint:9}, {grapheme_len:1}, {hyperlink_id:1}]) {
  test(`hybrid row delegates only the complex cell: ${JSON.stringify(change)}`, () => {
    const {renderer, cell, calls} = fixture();
    const complex = {...cell, ...change};
    const cells = [cell, complex];
    renderer.renderLine(cells, 2, 8);
    assert.equal(calls.some(call => call[0] === "fallback"), false);
    assert.ok(calls.some(call => call[0] === "text" && call[1] === "A"));
    assert.ok(calls.some(call => call[0] === "original-background" && call[1] === complex));
    assert.ok(calls.some(call => call[0] === "original-text" && call[1] === complex));
  });
}

test("zero-width cells stay skipped inside hybrid rows", () => {
  const {renderer, cell, calls} = fixture();
  renderer.renderLine([cell, {...cell, width: 0}], 0, 2);
  assert.deepEqual(calls.map(call => call[0]), ["background", "text"]);
  assert.equal(plainRendererStatistics(renderer).hybridRows, 1);
});

test("fully complex rows use the original row renderer", () => {
  const {renderer, cell, calls} = fixture();
  const cells = [{...cell, flags: 1}, {...cell, codepoint: 66, flags: 1}];
  renderer.renderLine(cells, 2, 8);
  assert.deepEqual(calls, [["fallback", cells, 2, 8]]);
  assert.equal(plainRendererStatistics(renderer).originalRows, 1);
});

test("hybrid mode falls back when Ghostty cell methods are unavailable", () => {
  const {renderer, cell, calls} = fixture();
  renderer.renderCellText = null;
  const cells = [cell, {...cell, flags: 1}];
  renderer.renderLine(cells, 2, 8);
  assert.deepEqual(calls, [["fallback", cells, 2, 8]]);
});

for (const key of ["currentSelectionCoords", "hoveredLinkRange"]) {
  test(`${key} retains normal rendering`, () => {
    const {renderer, cell, calls} = fixture();
    renderer[key] = {};
    renderer.renderLine([cell], 0, 1);
    assert.equal(calls[0][0], "fallback");
  });
}
