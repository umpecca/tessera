import assert from "node:assert/strict";
import test from "node:test";
import {
  CellFrame, createShapes, crossingGlyph, dotGlyph, drawLine, drawShapes, echoCount, echoStyles,
  polygonGrid, rasterizeLine, snapshotShapes, stepShapes, vertexGlyph,
} from "./screensaver-polygons.mjs";

function sequence(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

test("the grid is whole cells, centered on the screen", () => {
  const grid = polygonGrid(1210, 834, 8.4, 17);
  assert.equal(grid.cols, 144);
  assert.equal(grid.rows, 49);
  assert.ok(Math.abs(grid.originX * 2 + grid.width - 1210) < 1e-9);
  assert.ok(Math.abs(grid.originY * 2 + grid.height - 834) < 1e-9);
  assert.ok(grid.originX >= 0 && grid.originY >= 0);
  assert.deepEqual([polygonGrid(4, 4, 8, 16).cols, polygonGrid(4, 4, 8, 16).rows], [1, 1]);
});

test("shapes are two four-point outlines inside the box", () => {
  const shapes = createShapes(800, 600, sequence([0.1, 0.5, 0.9, 0.3, 0.7]));
  assert.equal(shapes.length, 2);
  for (const shape of shapes) {
    assert.equal(shape.length, 4);
    for (const point of shape) {
      assert.ok(point.x >= 0 && point.x <= 800 && point.y >= 0 && point.y <= 600);
      const speed = Math.hypot(point.vx, point.vy);
      assert.ok(speed >= 70 && speed <= 180, `speed ${speed}`);
    }
  }
});

test("corners bounce off every edge and keep their speed", () => {
  const point = { x: 5, y: 595, vx: -100, vy: 100 };
  stepShapes([[point]], 0.1, 800, 600);
  assert.deepEqual([point.x, point.y], [5, 595]);
  assert.deepEqual([point.vx, point.vy], [100, -100]);
  const far = { x: 790, y: 10, vx: 300, vy: -300 };
  stepShapes([[far]], 0.1, 800, 600);
  assert.deepEqual([far.x, far.y, far.vx, far.vy], [780, 20, -300, 300]);
  // A shrunken screen folds corners back inside without moving them otherwise.
  const outside = { x: 900, y: 650, vx: 10, vy: 10 };
  stepShapes([[outside]], 0, 800, 600);
  assert.ok(outside.x >= 0 && outside.x <= 800 && outside.y >= 0 && outside.y <= 600);
  assert.ok(outside.vx < 0 && outside.vy < 0);
});

// Draws one line into rows of text, top row first.
function picture(col, row, endCol, endRow) {
  const rows = [];
  drawLine(col, row, endCol, endRow, (c, r, glyph) => {
    rows[r] ??= [];
    rows[r][c] = glyph;
  });
  return Array.from(rows, cells => Array.from(cells ?? [], cell => cell ?? " ").join("").trimEnd());
}

test("lines are ASCII staircases that meet corner to corner", () => {
  assert.deepEqual(picture(0, 0, 8, 2), ["\\_", "  \\___", "      \\__"]);
  assert.deepEqual(picture(0, 2, 8, 0), ["       _/", "   ___/", "__/"]);
  // Either end can come first.
  assert.deepEqual(picture(8, 2, 0, 0), picture(0, 0, 8, 2));
  assert.deepEqual(picture(8, 0, 0, 2), picture(0, 2, 8, 0));
  assert.deepEqual(picture(3, 0, 3, 3), ["   |", "   |", "   |", "   |"]);
  assert.deepEqual(picture(5, 1, 1, 1), ["", " _____"]);
  // A steep line stays "|" in its column and takes a slope glyph where it moves across.
  assert.deepEqual(picture(0, 0, 1, 5), ["\\", "|", "|", " \\", " |", " |"]);
  assert.deepEqual(picture(1, 0, 0, 5), [" /", " |", " |", "/", "|", "|"]);
});

test("lines visit every cell from end to end without gaps", () => {
  for (const [c0, r0, c1, r1] of [[0, 0, 7, 3], [7, 3, 0, 0], [2, 9, 2, 1], [0, 5, 9, 5], [3, 3, 3, 3], [0, 0, 4, 9]]) {
    const cells = [];
    rasterizeLine(c0, r0, c1, r1, (col, row) => cells.push([col, row]));
    assert.deepEqual(cells[0], [c0, r0]);
    assert.deepEqual(cells.at(-1), [c1, r1]);
    assert.equal(cells.length, Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0)) + 1);
    for (let i = 1; i < cells.length; i++) {
      assert.ok(Math.abs(cells[i][0] - cells[i - 1][0]) <= 1 && Math.abs(cells[i][1] - cells[i - 1][1]) <= 1);
    }
  }
});

test("a cell shows the newest copy, and both shapes at one age make a crossing", () => {
  const frame = new CellFrame(4, 2);
  frame.put(1, 0, "/", 3, 0);
  frame.put(1, 0, "-", 1, 0);
  assert.equal(frame.glyphAt(1), "-");
  assert.equal(frame.echoAt(1), 1);
  frame.put(1, 0, "|", 2, 1);
  assert.equal(frame.glyphAt(1), "-", "an older copy of the other shape stays hidden");
  frame.put(1, 0, "|", 1, 1);
  assert.equal(frame.glyphAt(1), crossingGlyph);
  frame.put(2, 1, "|", 0, 0);
  frame.put(2, 1, vertexGlyph, 0, 0, true);
  assert.equal(frame.glyphAt(1 * 4 + 2), vertexGlyph);
  frame.put(2, 1, "\\", 0, 0);
  assert.equal(frame.glyphAt(1 * 4 + 2), vertexGlyph, "a line never replaces a vertex of its own age");
  frame.put(0, 1, "-", echoCount - 1, 0);
  assert.equal(frame.glyphAt(4), dotGlyph, "the oldest copy dissolves into dots");
  assert.equal(frame.used.length, 3);
  frame.clear();
  assert.equal(frame.used.length, 0);
  assert.ok(frame.rank.every(rank => rank === 0) && frame.shapes.every(shapes => shapes === 0));
});

test("older copies are lighter, and only the newest is bold", () => {
  assert.equal(echoStyles.length, echoCount);
  for (let i = 1; i < echoStyles.length; i++) assert.ok(echoStyles[i].alpha < echoStyles[i - 1].alpha);
  assert.deepEqual(echoStyles.map(style => style.bold), [true, false, false, false, false]);
  assert.deepEqual(echoStyles.map(style => style.dots), [false, false, false, false, true]);
});

test("drawing outlines crossing shapes and builds a trail from history", () => {
  const grid = polygonGrid(200, 200, 10, 10);
  // A square and a diamond whose edges cross.
  const square = [[20, 20], [180, 20], [180, 180], [20, 180]];
  const diamond = [[100, 5], [195, 100], [100, 195], [5, 100]];
  const shapes = [square, diamond].map(points => points.map(([x, y]) => ({ x, y, vx: 0, vy: 0 })));
  const frame = new CellFrame(grid.cols, grid.rows);
  drawShapes(frame, [snapshotShapes(shapes)], grid);
  const glyph = (col, row) => frame.glyphs[row * grid.cols + col] && frame.glyphAt(row * grid.cols + col);
  assert.equal(glyph(2, 2), vertexGlyph);
  assert.equal(glyph(5, 2), "_");
  assert.equal(glyph(2, 5), "|");
  assert.equal(glyph(10, 0), vertexGlyph);
  // The diamond's upper-left edge runs from (0, 10) to (10, 0) and crosses the
  // square's top edge at (8, 2) and its left edge at (2, 8).
  assert.equal(glyph(8, 2), crossingGlyph);
  assert.equal(glyph(2, 8), crossingGlyph);
  assert.ok(frame.used.every(index => frame.echoAt(index) === 0));

  // With history, earlier steps show up as older copies, every sixth step.
  const history = [];
  for (let step = 0; step < 25; step++) {
    const moved = shapes.map(shape => shape.map(point => ({ ...point, x: point.x - step, y: point.y })));
    history.push(snapshotShapes(moved));
  }
  drawShapes(frame, history, grid);
  const ages = new Set(frame.used.map(index => frame.echoAt(index)));
  assert.ok(ages.has(0));
  assert.ok([...ages].every(age => age >= 0 && age < echoCount));
});
