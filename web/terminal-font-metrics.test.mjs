import assert from "node:assert/strict";
import test from "node:test";
import { CanvasRenderer, CellFlags } from "ghostty-web";
import { installTerminalFontMetrics } from "./terminal-font-metrics.mjs";
import { installPlainRenderer, setPlainRendererEnabled } from "./terminal-plain-renderer.mjs";

installTerminalFontMetrics(CanvasRenderer);
installPlainRenderer(CanvasRenderer);

function fixture(t, textMetrics, options = {}) {
  const calls = [];
  const ctx = {
    measureText(text) {
      calls.push(["measure", text, this.font]);
      return text === "M" ? { width: 8.4, actualBoundingBoxAscent: 11, actualBoundingBoxDescent: 0 }
        : typeof textMetrics === "function" ? textMetrics(this.font) : textMetrics;
    },
    scale() {},
    fillRect(...args) { calls.push(["rect", ...args]); },
    fillText(...args) { calls.push(["text", ...args]); },
  };
  const canvas = { style: {}, getContext() { return ctx; } };
  const oldDocument = globalThis.document;
  globalThis.document = { createElement() { return canvas; } };
  t.after(() => { globalThis.document = oldDocument; });
  const renderer = new CanvasRenderer(canvas, {
    fontSize: 14, fontFamily: '"JetBrains Mono", monospace', devicePixelRatio: 1, ...options,
  });
  if (options.rowSpacing) {
    renderer.tesseraRowSpacing = options.rowSpacing;
    renderer.remeasureFont();
  }
  return { renderer, calls, canvas };
}

test("full font bounds put text and accents inside the terminal cell", (t) => {
  const { renderer, calls } = fixture(t, {
    fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 4,
    actualBoundingBoxAscent: 13, actualBoundingBoxDescent: 3,
  });
  assert.deepEqual(renderer.getMetrics(), { width: 9, height: 18, baseline: 14 });
  assert.equal(renderer.charWidth, 9);
  assert.equal(renderer.charHeight, 18);
  assert.deepEqual(calls.slice(0, 2), [
    ["measure", "M", '14px "JetBrains Mono", monospace'],
    ["measure", "MgÅÉ|", '14px "JetBrains Mono", monospace'],
  ]);
});

test("older browsers measure accented letters and descenders together", (t) => {
  const { renderer } = fixture(t, { actualBoundingBoxAscent: 14, actualBoundingBoxDescent: 3 });
  assert.deepEqual(renderer.getMetrics(), { width: 9, height: 17, baseline: 14 });
});

test("glyphs extending beyond the reported font bounds still fit in their cells", (t) => {
  const { renderer } = fixture(t, {
    fontBoundingBoxAscent: 19, fontBoundingBoxDescent: 6,
    actualBoundingBoxAscent: 22, actualBoundingBoxDescent: 7,
  });
  assert.deepEqual(renderer.getMetrics(), { width: 9, height: 29, baseline: 22 });
});

test("missing or zero vertical measurements keep usable fallback metrics", (t) => {
  const { renderer } = fixture(t, { actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 });
  assert.deepEqual(renderer.getMetrics(), { width: 9, height: 15, baseline: 12 });
});

test("tight fractional measurements fit ascenders and descenders without extra padding", (t) => {
  const ascent = 13.6, descent = 3.2;
  const { renderer } = fixture(t, { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent });
  const metrics = renderer.getMetrics();
  assert.deepEqual(metrics, { width: 9, height: 18, baseline: 14 });
  assert.ok(metrics.baseline >= ascent);
  assert.ok(metrics.height - metrics.baseline >= descent);
});

test("comfortable spacing adds one pixel above and below full font bounds", (t) => {
  const { renderer } = fixture(t, { fontBoundingBoxAscent: 13.6, fontBoundingBoxDescent: 3.2 }, { rowSpacing: "comfortable" });
  assert.deepEqual(renderer.getMetrics(), { width: 9, height: 20, baseline: 15 });
  renderer.setFontSize(24);
  assert.equal(renderer.getMetrics().height, 20, "font changes retain spacing preference");
});

test("bold accents share a cell tall enough for both font weights", (t) => {
  const { renderer } = fixture(t, (font) => ({
    fontBoundingBoxAscent: 13, fontBoundingBoxDescent: 4,
    actualBoundingBoxAscent: font.startsWith("bold") ? 16 : 13,
    actualBoundingBoxDescent: 3,
  }));
  assert.deepEqual(renderer.getMetrics(), { width: 9, height: 20, baseline: 16 });
});

test("font changes, font loading, and canvas resizing use the same metrics", (t) => {
  let loaded = false;
  const { renderer, canvas } = fixture(t, (font) => {
    if (font.startsWith("24px")) return { fontBoundingBoxAscent: 24, fontBoundingBoxDescent: 7 };
    if (font.includes("Fira Code")) return { fontBoundingBoxAscent: 13, fontBoundingBoxDescent: 4 };
    return { fontBoundingBoxAscent: loaded ? 14 : 12, fontBoundingBoxDescent: 4 };
  }, { devicePixelRatio: 2 });
  assert.equal(renderer.getMetrics().baseline, 12);
  loaded = true;
  renderer.remeasureFont();
  assert.equal(renderer.getMetrics().baseline, 14);
  renderer.setFontFamily('"Fira Code", monospace');
  assert.deepEqual(renderer.getMetrics(), { width: 9, height: 17, baseline: 13 });
  renderer.setFontSize(24);
  assert.deepEqual(renderer.getMetrics(), { width: 9, height: 31, baseline: 24 });
  renderer.resize(80, 24);
  assert.equal(canvas.style.height, "744px");
  assert.equal(canvas.height, 1488);
});

test("normal, bold, selected, and experimental text share the corrected baseline", (t) => {
  const { renderer, calls } = fixture(t, { fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 4 });
  const cell = { codepoint: 100, width: 1, flags: 0, grapheme_len: 0, hyperlink_id: 0,
    fg_r: 220, fg_g: 220, fg_b: 220, bg_r: 0, bg_g: 0, bg_b: 0 };
  renderer.resize(3, 4);
  renderer.renderLine([cell, { ...cell, flags: CellFlags.BOLD }], 1, 3);
  renderer.currentSelectionCoords = { startCol: 0, startRow: 2, endCol: 1, endRow: 2 };
  renderer.renderLine([cell], 2, 3);
  renderer.currentSelectionCoords = null;
  setPlainRendererEnabled(renderer, true);
  renderer.renderLine([cell, { ...cell, flags: CellFlags.BOLD }, { ...cell, codepoint: 103 }], 3, 3);
  assert.deepEqual(calls.filter(call => call[0] === "text"), [
    ["text", "d", 0, 32], ["text", "d", 9, 32],
    ["text", "d", 0, 50],
    ["text", "d", 0, 68], ["text", "d", 9, 68], ["text", "g", 18, 68],
  ]);
  calls.length = 0;
  renderer.renderCursor(2, 1);
  assert.deepEqual(calls, [["rect", 18, 18, 9, 18]]);
});

test("installing the metrics adapter twice leaves measurement unchanged", () => {
  const measure = CanvasRenderer.prototype.measureFont;
  installTerminalFontMetrics(CanvasRenderer);
  assert.equal(CanvasRenderer.prototype.measureFont, measure);
});
