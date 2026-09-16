const patch = Symbol.for("tessera.terminalPlainRenderer");
const experimentalRenderLine = Symbol.for("tessera.terminalPlainRenderer.renderLine");
const rendererStats = Symbol.for("tessera.terminalPlainRenderer.statistics");

function recordRow(renderer, path) {
  const stats = renderer[rendererStats];
  if (stats) stats[path]++;
}

function isSimpleCell(cell) {
  return cell.width === 1 && !cell.flags && !cell.grapheme_len && !cell.hyperlink_id
    && (cell.codepoint === 0 || (cell.codepoint >= 32 && cell.codepoint <= 126));
}

// Keep glyphs on their individual cell coordinates: drawing a whole string
// would allow kerning/ligatures to change the terminal's fixed grid.
export function installPlainRenderer(Renderer) {
  const proto = Renderer?.prototype;
  if (!proto || proto[patch] || typeof proto.renderLine !== "function") return;
  const original = proto.renderLine;
  proto[experimentalRenderLine] = function(cells, row, cols) {
    if (!cells.length || this.currentSelectionCoords || this.hoveredLinkRange) {
      recordRow(this, "originalRows");
      return original.call(this, cells, row, cols);
    }
    let simpleCells = 0;
    for (const cell of cells) {
      if (isSimpleCell(cell)) simpleCells++;
    }
    const hybrid = simpleCells !== cells.length;
    if (simpleCells === 0 || (hybrid
        && (typeof this.renderCellBackground !== "function" || typeof this.renderCellText !== "function"))) {
      recordRow(this, "originalRows");
      return original.call(this, cells, row, cols);
    }
    recordRow(this, hybrid ? "hybridRows" : "fastRows");
    const { ctx, metrics } = this;
    const y = row * metrics.height;
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, y, cols * metrics.width, metrics.height);

    // Match Ghostty's background-first ordering so later cell backgrounds
    // cannot cover glyphs. Adjacent cells of one color share a single fill.
    let backgroundStart = -1;
    let backgroundKey = -1;
    for (let col = 0; col <= cells.length; col++) {
      const cell = cells[col];
      const simple = cell && isSimpleCell(cell);
      const key = simple && (cell.bg_r || cell.bg_g || cell.bg_b)
        ? (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b
        : -1;
      if (key !== backgroundKey && backgroundStart >= 0) {
        ctx.fillStyle = this.rgbToCSS(
          (backgroundKey >> 16) & 255,
          (backgroundKey >> 8) & 255,
          backgroundKey & 255,
        );
        ctx.fillRect(
          backgroundStart * metrics.width,
          y,
          (col - backgroundStart) * metrics.width,
          metrics.height,
        );
      }
      if (key !== backgroundKey) {
        backgroundStart = key >= 0 ? col : -1;
        backgroundKey = key;
      }
      if (cell && !simple && cell.width !== 0) {
        this.renderCellBackground(cell, col, row);
      }
    }

    const normalFont = `${this.fontSize}px ${this.fontFamily}`;
    let normalFontSelected = false;
    let foregroundKey = -1;
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      if (!isSimpleCell(cell)) {
        if (cell.width !== 0) this.renderCellText(cell, col, row);
        normalFontSelected = false;
        foregroundKey = -1;
        continue;
      }
      const code = cell.codepoint;
      if (code <= 32) continue;
      if (!normalFontSelected) {
        ctx.font = normalFont;
        normalFontSelected = true;
      }
      const key = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
      if (key !== foregroundKey) {
        ctx.fillStyle = this.rgbToCSS(cell.fg_r, cell.fg_g, cell.fg_b);
        foregroundKey = key;
      }
      ctx.fillText(String.fromCharCode(code), col * metrics.width, y + metrics.baseline);
    }
  };
  proto[patch] = true;
}

export function setPlainRendererEnabled(renderer, enabled) {
  if (!renderer) return;
  if (enabled === true && typeof renderer[experimentalRenderLine] === "function") {
    if (renderer.renderLine !== renderer[experimentalRenderLine]) {
      renderer[rendererStats] = { fastRows: 0, hybridRows: 0, originalRows: 0 };
    }
    renderer.renderLine = renderer[experimentalRenderLine];
    return;
  }
  // Stable mode inherits Ghostty's original prototype method, so it adds no
  // branch or wrapper call to the normal per-row rendering path.
  delete renderer.renderLine;
}

export function plainRendererStatistics(renderer) {
  if (!renderer || renderer.renderLine !== renderer[experimentalRenderLine]) return null;
  const stats = renderer[rendererStats] || { fastRows: 0, hybridRows: 0, originalRows: 0 };
  return { ...stats, totalRows: stats.fastRows + stats.hybridRows + stats.originalRows };
}
