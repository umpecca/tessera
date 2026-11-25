import assert from "node:assert/strict";
import test from "node:test";
import { CanvasRenderer, CellFlags } from "ghostty-web";
import { installTerminalCellBackgrounds, terminalThemeBackgroundKey } from "./terminal-cell-backgrounds.mjs";
import { installPlainRenderer, setPlainRendererEnabled } from "./terminal-plain-renderer.mjs";

// ghostty-web's own renderer, without a canvas: only the state the cell
// painters read.
function renderer(background, { selected = false } = {}) {
  const r = Object.create(CanvasRenderer.prototype);
  const fills = [];
  Object.assign(r, {
    ctx: { fillRect(x, y, w, h) { fills.push([this.fillStyle, x, y, w, h]); } },
    metrics: { width: 8, height: 16, baseline: 12 },
    theme: { background, foreground: "#000000", selectionBackground: "#336699" },
    isInSelection: () => selected,
  });
  return { r, fills };
}

const cell = (fields = {}) => ({ codepoint: 98, width: 1, flags: 0, grapheme_len: 0, hyperlink_id: 0,
  fg_r: 0, fg_g: 0, fg_b: 0, bg_r: 255, bg_g: 255, bg_b: 255, ...fields });

installTerminalCellBackgrounds(CanvasRenderer);
installTerminalCellBackgrounds(CanvasRenderer);

test("light mode paints the black background of inverse text and SGR 40, not the row's white", () => {
  const { r, fills } = renderer("#ffffff");
  r.renderCellBackground(cell({ flags: CellFlags.INVERSE }), 2, 1);
  r.renderCellBackground(cell({ bg_r: 0, bg_g: 0, bg_b: 0 }), 3, 1);
  r.renderCellBackground(cell(), 4, 1);
  assert.deepEqual(fills, [["rgb(0, 0, 0)", 16, 16, 8, 16], ["rgb(0, 0, 0)", 24, 16, 8, 16]]);
});

test("dark mode still skips cells on the default black background", () => {
  const { r, fills } = renderer("#000000");
  r.renderCellBackground(cell({ fg_r: 229, fg_g: 229, fg_b: 229, bg_r: 0, bg_g: 0, bg_b: 0 }), 0, 0);
  r.renderCellBackground(cell({ bg_r: 20, bg_g: 40, bg_b: 60 }), 1, 0);
  assert.deepEqual(fills, [["rgb(20, 40, 60)", 8, 0, 8, 16]]);
});

test("reverse video in dark mode paints inverse cells black on the light row", () => {
  // Under mode 5 the core swaps default colours, and the theme follows.
  const { r, fills } = renderer("#e5e5e5");
  r.renderCellBackground(cell({ fg_r: 0, fg_g: 0, fg_b: 0, bg_r: 229, bg_g: 229, bg_b: 229 }), 0, 0);
  r.renderCellBackground(cell({ fg_r: 0, fg_g: 0, fg_b: 0, bg_r: 229, bg_g: 229, bg_b: 229, flags: CellFlags.INVERSE }), 1, 0);
  assert.deepEqual(fills, [["rgb(0, 0, 0)", 8, 0, 8, 16]]);
});

test("selected cells keep the selection colour, and wide cells their width", () => {
  const { r, fills } = renderer("#ffffff", { selected: true });
  r.renderCellBackground(cell({ width: 2 }), 1, 0);
  assert.deepEqual(fills, [["#336699", 8, 0, 16, 16]]);
});

test("the theme background key follows theme changes and tolerates unknown colours", () => {
  const { r } = renderer("#FFFFFF");
  assert.equal(terminalThemeBackgroundKey(r), 0xffffff);
  r.theme.background = "#e5e5e5";
  assert.equal(terminalThemeBackgroundKey(r), 0xe5e5e5);
  r.theme.background = "black";
  assert.equal(terminalThemeBackgroundKey(r), 0);
  assert.equal(terminalThemeBackgroundKey(null), 0);
});

test("plain rows on a light theme paint black backgrounds and skip the row's own colour", () => {
  class Plain {
    renderLine() {}
    renderCellBackground() {}
    renderCellText() {}
    rgbToCSS(r, g, b) { return `rgb(${r}, ${g}, ${b})`; }
  }
  installPlainRenderer(Plain);
  const plain = new Plain();
  const fills = [];
  Object.assign(plain, {
    ctx: { fillRect(x, y, w, h) { fills.push([this.fillStyle, x, w]); }, fillText() {} },
    metrics: { width: 9, height: 18, baseline: 14 },
    theme: { background: "#ffffff" }, fontSize: 14, fontFamily: "m",
  });
  setPlainRendererEnabled(plain, true);
  plain.renderLine([cell({ codepoint: 65 }), cell({ codepoint: 66, bg_r: 0, bg_g: 0, bg_b: 0 }), cell({ codepoint: 67 })], 0, 3);
  assert.deepEqual(fills, [["#ffffff", 0, 27], ["rgb(0, 0, 0)", 9, 9]]);
});
