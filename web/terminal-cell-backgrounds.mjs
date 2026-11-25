// Cell backgrounds. ghostty-web skips any cell whose background is exactly
// black, taking black for the default it already filled the row with. Rows
// are filled with the pane's theme background, which is white in light mode
// and the foreground under reverse video (mode 5), so black there is a real
// colour: an inverse (SGR 7) cell over default text, or SGR 40. A cell is
// skipped only when its background is the one the row already has.
const patch = Symbol.for("tessera.terminalCellBackgrounds");
const INVERSE = 16;
const parsed = Symbol("tessera.themeBackground");

// The theme background as 0xRRGGBB, or 0 (black, ghostty-web's assumption)
// when it is not a #rrggbb colour.
export function terminalThemeBackgroundKey(renderer) {
  const background = renderer?.theme?.background;
  const cache = renderer?.[parsed];
  if (cache && cache.background === background) return cache.key;
  const match = /^#([0-9a-f]{6})$/i.exec(background || "");
  const key = match ? Number.parseInt(match[1], 16) : 0;
  if (renderer) renderer[parsed] = { background, key };
  return key;
}

export function installTerminalCellBackgrounds(Renderer) {
  const prototype = Renderer?.prototype;
  if (!prototype || prototype[patch] || typeof prototype.renderCellBackground !== "function") return;
  prototype.renderCellBackground = function renderTesseraCellBackground(cell, column, row) {
    const x = column * this.metrics.width, y = row * this.metrics.height;
    const width = this.metrics.width * cell.width;
    if (this.isInSelection(column, row)) {
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(x, y, width, this.metrics.height);
      return;
    }
    const inverse = cell.flags & INVERSE;
    const r = inverse ? cell.fg_r : cell.bg_r, g = inverse ? cell.fg_g : cell.bg_g, b = inverse ? cell.fg_b : cell.bg_b;
    if (((r << 16) | (g << 8) | b) === terminalThemeBackgroundKey(this)) return;
    this.ctx.fillStyle = this.rgbToCSS(r, g, b);
    this.ctx.fillRect(x, y, width, this.metrics.height);
  };
  Object.defineProperty(prototype, patch, { value: true });
}
