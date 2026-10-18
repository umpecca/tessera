import assert from "node:assert/strict";
import test from "node:test";
import {
  clockBlock, clockGlyphs, clockLayout, clockPosition, clockText, DigitalRain, DismissGuard,
  gradientColor, mosaicGrid, paletteAt, rainGlyphs, screensaverPalettes,
} from "./screensaver.mjs";

test("glyphs are 7 rows of equal width", () => {
  for (const [ch, glyph] of Object.entries(clockGlyphs)) {
    assert.equal(glyph.length, 7, ch);
    assert.ok(glyph.every(row => row.length === glyph[0].length), ch);
  }
});

test("clock text pads 24-hour times and drops the leading zero for 12-hour", () => {
  const morning = new Date(2026, 9, 17, 9, 5);
  const evening = new Date(2026, 9, 17, 21, 41);
  const midnight = new Date(2026, 9, 17, 0, 0);
  assert.equal(clockText(morning, false), "09:05");
  assert.equal(clockText(evening, false), "21:41");
  assert.equal(clockText(evening, true), "9:41");
  assert.equal(clockText(midnight, true), "12:00");
});

test("clock layout spaces glyphs by one column", () => {
  const layout = clockLayout("00:00");
  assert.equal(layout.width, 5 + 1 + 5 + 1 + 1 + 1 + 5 + 1 + 5);
  assert.equal(clockLayout("9:41").width, 19);
  const colon = clockLayout(":");
  assert.deepEqual(colon.cells, [[0, 2], [0, 4]]);
  assert.ok(layout.cells.every(([x, y]) => x >= 0 && x < layout.width && y >= 0 && y < 7));
});

test("grid tiles are whole device pixels and cover the screen", () => {
  for (const [width, height, dpr] of [[1440, 900, 2], [1180, 820, 2], [820, 1180, 2], [1920, 1080, 1], [3840, 2160, 1.5], [375, 667, 3]]) {
    const grid = mosaicGrid(width, height, dpr);
    assert.ok(Number.isInteger(grid.tile), `${width}x${height}`);
    assert.ok(grid.originX <= 0 && grid.originX + grid.cols * grid.tile >= grid.width);
    assert.ok(grid.originY <= 0 && grid.originY + grid.rows * grid.tile >= grid.height);
    const block = clockBlock(grid);
    assert.ok(block.width <= grid.cols && block.height <= grid.rows, `clock fits ${width}x${height}`);
  }
  assert.equal(mosaicGrid(1440, 900, 2).clockScale, 2);
});

test("the drifting clock stays on screen and moves over time", () => {
  const grid = mosaicGrid(1440, 900, 2);
  const block = clockBlock(grid);
  const positions = new Set();
  for (let seconds = 0; seconds < 1800; seconds += 5) {
    const { x, y } = clockPosition(seconds, grid);
    assert.ok(x >= 0 && x + block.width <= grid.cols, `x at ${seconds}s`);
    assert.ok(y >= 0 && y + block.height <= grid.rows, `y at ${seconds}s`);
    positions.add(`${x},${y}`);
  }
  assert.ok(positions.size > 20);
});

test("palettes hold, then blend into the next", () => {
  const settled = (seconds, index) => {
    const palette = paletteAt(seconds);
    const expected = screensaverPalettes[index];
    assert.deepEqual(palette.stops, expected.stops);
    assert.deepEqual(palette.trail, expected.trail);
    assert.deepEqual(palette.lit, expected.lit);
    assert.equal(palette.rain, expected.rain);
    assert.equal(palette.field, expected.field);
  };
  settled(10, 0);
  settled(47 + 10, 1);
  settled(47 * screensaverPalettes.length + 10, 0);
  const blending = paletteAt(47 * 0.95);
  assert.notDeepEqual(blending.stops, screensaverPalettes[0].stops);
  assert.notDeepEqual(blending.stops, screensaverPalettes[1].stops);
  assert.ok(blending.rain < screensaverPalettes[0].rain && blending.rain > screensaverPalettes[1].rain);
});

test("the phosphor palette rains hardest", () => {
  const phosphor = screensaverPalettes.find(palette => palette.name === "phosphor");
  assert.ok(screensaverPalettes.every(palette => palette === phosphor || palette.rain < phosphor.rain));
  assert.ok(rainGlyphs.length > 40 && rainGlyphs.every(glyph => [...glyph].length === 1));
});

function seeded(seed = 1) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

test("rain streams are brightest at the head and fade behind it", () => {
  const rain = new DigitalRain(1, 40, seeded());
  rain.drops[0].push({ y: 10.5, speed: 10, length: 5 });
  rain.step(0, 0);
  assert.equal(rain.heads[10], 1);
  assert.equal(rain.intensity[10], 1);
  for (let r = 7; r <= 10; r++) assert.ok(rain.intensity[r - 1] < rain.intensity[r], `row ${r}`);
  assert.equal(rain.intensity[5], 0);
  assert.equal(rain.intensity[11], 0);
  rain.step(0.1, 0);
  assert.equal(rain.heads[11], 1);
});

test("the first pour reveals every column from the top, then the rain keeps falling", () => {
  const rain = new DigitalRain(60, 40, seeded(7));
  assert.ok(rain.reveal.every(row => row === -Infinity));
  rain.pour();
  let seconds = 0;
  while (rain.reveal.some(row => row < 40) && seconds < 10) {
    rain.step(1 / 60, 1);
    seconds += 1 / 60;
  }
  assert.ok(seconds < 2.2, `revealed in ${seconds.toFixed(2)}s`);
  for (let i = 0; i < 60 * 30; i++) rain.step(1 / 60, 1);
  const lit = rain.intensity.filter(value => value > 0).length;
  assert.ok(lit > 60 * 40 * 0.05, `dense rain covers ${lit} tiles`);
  assert.ok(rain.drops.every(list => list.length <= 3));
});

test("sparse rain covers less than dense rain", () => {
  const coverage = density => {
    const rain = new DigitalRain(60, 40, seeded(3));
    let total = 0;
    for (let i = 0; i < 60 * 60; i++) {
      rain.step(1 / 60, density);
      if (i >= 60 * 20) total += rain.intensity.filter(value => value > 0).length;
    }
    return total;
  };
  assert.ok(coverage(0.3) < coverage(1) * 0.6);
});

test("gradient color clamps and interpolates between stops", () => {
  const stops = [[0, 0, 0], [100, 200, 50], [200, 200, 200]];
  assert.deepEqual(gradientColor(stops, -1), [0, 0, 0]);
  assert.deepEqual(gradientColor(stops, 2), [200, 200, 200]);
  assert.deepEqual(gradientColor(stops, 0.25), [50, 100, 25]);
});

test("dismissal ignores the opening input and small pointer jitter", () => {
  const guard = new DismissGuard(1000);
  assert.equal(guard.ready(1200), false);
  assert.equal(guard.moved(10, 10, 1200), false);
  assert.equal(guard.ready(1500), true);
  assert.equal(guard.moved(10, 10, 1500), false);
  assert.equal(guard.moved(18, 14, 1520), false);
  assert.equal(guard.moved(30, 10, 1540), true);
});
