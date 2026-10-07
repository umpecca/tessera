import assert from "node:assert/strict";
import test from "node:test";

import {
  installTerminalBlockRenderer,
  terminalBlockRects,
  terminalBoxDrawingRects,
  terminalSymbolNeedsCellConstraint,
} from "./terminal-block-renderer.mjs";

const supported = [
  0x2580,
  ...Array.from({ length: 16 }, (_, index) => 0x2581 + index),
  0x2594,
  0x2595,
  ...Array.from({ length: 10 }, (_, index) => 0x2596 + index),
].filter((codepoint) => codepoint < 0x2591 || codepoint > 0x2593);

test("solid box borders join across cells at varied text metrics", () => {
  const joins = [
    ["│", "│", "vertical"], ["┃", "┃", "vertical"],
    ["┌", "│", "vertical"], ["│", "└", "vertical"],
    ["┏", "┃", "vertical"], ["┃", "┗", "vertical"],
    ["─", "─", "horizontal"], ["━", "━", "horizontal"],
    ["┌", "─", "horizontal"], ["─", "┐", "horizontal"],
    ["┏", "━", "horizontal"], ["━", "┓", "horizontal"],
    ["├", "─", "horizontal"], ["─", "┤", "horizontal"],
    ["┬", "│", "vertical"], ["│", "┴", "vertical"],
  ];
  function edgePixels(rects, width, height, edge) {
    const pixels = new Set();
    for (const rect of rects) for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        if (edge === "left" && x === 0 || edge === "right" && x === width - 1) pixels.add(y);
        if (edge === "top" && y === 0 || edge === "bottom" && y === height - 1) pixels.add(x);
      }
    }
    return [...pixels].sort((a, b) => a - b);
  }
  for (const [width, height] of [[1, 1], [8, 18], [9, 23], [12, 29], [16, 37]]) {
    for (const [first, second, direction] of joins) {
      const a = terminalBoxDrawingRects(first.codePointAt(0), width, height);
      const b = terminalBoxDrawingRects(second.codePointAt(0), width, height);
      const edgeA = edgePixels(a, width, height, direction === "vertical" ? "bottom" : "right");
      const edgeB = edgePixels(b, width, height, direction === "vertical" ? "top" : "left");
      assert.ok(edgeA.length, `${first} has no joining edge`);
      assert.deepEqual(edgeA, edgeB, `${first}${second} at ${width}x${height}`);
    }
  }
});

test("solid box glyphs have connected geometry within their cell", () => {
  const codes = [...Array.from({ length: 4 }, (_, i) => 0x2500 + i),
    ...Array.from({ length: 64 }, (_, i) => 0x250c + i),
    ...Array.from({ length: 12 }, (_, i) => 0x2574 + i)];
  for (const code of codes) {
    const rects = terminalBoxDrawingRects(code, 9, 23);
    const pixels = new Set();
    for (const rect of rects) {
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 9 && rect.y + rect.height <= 23);
      for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
        assert.ok(!pixels.has(y * 9 + x), `overlapping fills change faint opacity for U+${code.toString(16)}`);
        pixels.add(y * 9 + x);
      }
    }
    assert.ok(pixels.size);
    const visited = new Set(), queue = [pixels.values().next().value];
    while (queue.length) {
      const point = queue.pop();
      if (visited.has(point) || !pixels.has(point)) continue;
      visited.add(point);
      queue.push(point - 9, point + 9);
      if (point % 9 > 0) queue.push(point - 1);
      if (point % 9 < 8) queue.push(point + 1);
    }
    assert.equal(visited.size, pixels.size, `disconnected U+${code.toString(16)}`);
  }
  for (const code of [0x2504, 0x254c, 0x2550, 0x256d, 0x2571, 0x41]) {
    assert.equal(terminalBoxDrawingRects(code, 9, 23), null);
  }
});

test("box borders preserve original styling, faint alpha and invisibility", () => {
  const originalCells = [], fills = [];
  class Renderer {
    renderCellText(cell) {
      originalCells.push(cell);
      this.ctx.fillStyle = "selected foreground";
    }
  }
  const flags = { INVISIBLE: 32, FAINT: 128 };
  installTerminalBlockRenderer(Renderer, flags);
  const renderer = new Renderer();
  renderer.metrics = { width: 9, height: 23 };
  renderer.ctx = { globalAlpha: 1, fillRect(...rect) { fills.push({ rect, color: this.fillStyle, alpha: this.globalAlpha }); } };
  const cell = { codepoint: 0x2502, width: 1, grapheme_len: 0, flags: flags.FAINT | 1 };
  renderer.renderCellText(cell, 2, 3);
  assert.equal(originalCells[0].codepoint, 32);
  assert.equal(originalCells[0].flags, cell.flags);
  assert.equal(renderer.ctx.globalAlpha, 1);
  assert.ok(fills.length);
  assert.ok(fills.every(fill => fill.color === "selected foreground" && fill.alpha === 0.5));
  assert.equal(Math.min(...fills.map(fill => fill.rect[1])), 69);
  assert.equal(Math.max(...fills.map(fill => fill.rect[1] + fill.rect[3])), 92);
  const count = fills.length;
  renderer.renderCellText({ ...cell, flags: flags.INVISIBLE }, 2, 3);
  assert.equal(fills.length, count);
  assert.equal(originalCells.at(-1).codepoint, 0x2502);
});

test("provides pixel-aligned geometry for every supported solid block element", () => {
  for (const codepoint of supported) {
    const rects = terminalBlockRects(codepoint, 9, 17);
    assert.ok(rects?.length, `missing geometry for U+${codepoint.toString(16)}`);
    for (const rect of rects) {
      assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.y));
      assert.ok(Number.isInteger(rect.width) && Number.isInteger(rect.height));
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 9 && rect.y + rect.height <= 17);
    }
  }
});

test("uses exact full, fractional, and quadrant boundaries", () => {
  assert.deepEqual(terminalBlockRects(0x2588, 9, 17), [{ x: 0, y: 0, width: 9, height: 17 }]);
  assert.deepEqual(terminalBlockRects(0x2584, 9, 17), [{ x: 0, y: 9, width: 9, height: 8 }]);
  assert.deepEqual(terminalBlockRects(0x258c, 9, 17), [{ x: 0, y: 0, width: 5, height: 17 }]);
  assert.deepEqual(terminalBlockRects(0x259a, 9, 17), [
    { x: 0, y: 0, width: 5, height: 9 },
    { x: 5, y: 9, width: 4, height: 8 },
  ]);
});

test("leaves shade and ordinary characters on the normal font renderer", () => {
  for (const codepoint of [0x2591, 0x2592, 0x2593, "A".codePointAt(0)]) {
    assert.equal(terminalBlockRects(codepoint, 9, 17), null);
  }
});

test("constrains symbol ranges that commonly need a fallback face", () => {
  for (const codepoint of [0x2192, 0x23f5, 0x25c9, 0x2702, 0x2801, 0x2b9e, 0x1f5a5]) {
    assert.equal(terminalSymbolNeedsCellConstraint(codepoint), true);
  }
  for (const codepoint of ["A".codePointAt(0), 0x0301, 0x4e00, 0xe0b0]) {
    assert.equal(terminalSymbolNeedsCellConstraint(codepoint), false);
  }
});

test("renderer extension replaces a block glyph with translated cell rectangles", () => {
  class Renderer {
    renderCellText(cell) {
      this.originalCells.push(cell);
      this.ctx.fillStyle = "orange";
    }
  }
  installTerminalBlockRenderer(Renderer, { INVISIBLE: 32, FAINT: 128 });
  installTerminalBlockRenderer(Renderer, { INVISIBLE: 32, FAINT: 128 });
  const renderer = new Renderer();
  renderer.metrics = { width: 9, height: 17 };
  renderer.originalCells = [];
  renderer.ctx = {
    globalAlpha: 1,
    fillStyle: "",
    rectangles: [],
    fillRect(...rect) { this.rectangles.push(rect); },
  };

  renderer.renderCellText({ codepoint: 0x2588, grapheme_len: 0, width: 1, flags: 0 }, 2, 3);
  assert.equal(renderer.originalCells.length, 1, "patch was installed more than once");
  assert.equal(renderer.originalCells[0].codepoint, 32);
  assert.deepEqual(renderer.ctx.rectangles, [[18, 51, 9, 17]]);
});

test("renderer supplies a cell maxWidth to symbols and restores canvas state", () => {
  class Renderer {
    renderCellText(cell) {
      this.fontFamilies.push(this.fontFamily);
      this.ctx.fillText(String.fromCodePoint(cell.codepoint), 18, 51);
    }
  }
  installTerminalBlockRenderer(Renderer, { INVISIBLE: 32, FAINT: 128 });
  const calls = [];
  const originalFillText = (...args) => calls.push(args);
  const renderer = new Renderer();
  renderer.metrics = { width: 9, height: 17 };
  renderer.fontFamily = '"JetBrains Mono", monospace';
  renderer.tesseraSymbolFontFamily = '"JetBrains Mono", "Noto Sans Symbols 2", monospace';
  renderer.fontFamilies = [];
  renderer.ctx = { fillText: originalFillText };

  renderer.renderCellText({ codepoint: 0x23f8, width: 1, flags: 0 }, 2, 3);
  renderer.renderCellText({ codepoint: 0x1f5a5, width: 2, flags: 0 }, 2, 3);
  assert.deepEqual(calls, [
    ["⏸", 18, 51, 9],
    ["🖥", 18, 51, 18],
  ]);
  assert.deepEqual(renderer.fontFamilies, [
    '"JetBrains Mono", "Noto Sans Symbols 2", monospace',
    '"JetBrains Mono", "Noto Sans Symbols 2", monospace',
  ]);
  assert.equal(renderer.fontFamily, '"JetBrains Mono", monospace');
  assert.equal(renderer.ctx.fillText, originalFillText);
});

test("renderer does not constrain ordinary or invisible glyphs", () => {
  class Renderer {
    renderCellText(cell) { this.ctx.fillText(String.fromCodePoint(cell.codepoint), 0, 0); }
  }
  installTerminalBlockRenderer(Renderer, { INVISIBLE: 32, FAINT: 128 });
  const calls = [];
  const renderer = new Renderer();
  renderer.metrics = { width: 9, height: 17 };
  renderer.ctx = { fillText: (...args) => calls.push(args) };
  renderer.renderCellText({ codepoint: 0x41, width: 1, flags: 0 }, 0, 0);
  renderer.renderCellText({ codepoint: 0x23f5, width: 1, flags: 32 }, 0, 0);
  assert.deepEqual(calls, [["A", 0, 0], ["⏵", 0, 0]]);
});

test("ordinary text bypasses symbol metrics and geometry bookkeeping", () => {
  let rendered = 0;
  class Renderer {
    renderCellText() { rendered++; }
  }
  installTerminalBlockRenderer(Renderer, { INVISIBLE: 32, FAINT: 128 });
  const renderer = new Renderer();
  Object.defineProperty(renderer, "metrics", {
    get() { assert.fail("ordinary cells must not read symbol geometry metrics"); },
  });

  renderer.renderCellText({ codepoint: 0x41, width: 1, flags: 1 }, 0, 0);
  assert.equal(rendered, 1);
});
