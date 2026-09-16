const patch = Symbol.for("tessera.terminalPlainRenderer");

// Keep glyphs on their individual cell coordinates: drawing a whole string
// would allow kerning/ligatures to change the terminal's fixed grid.
export function installPlainRenderer(Renderer) {
  const proto = Renderer?.prototype;
  if (!proto || proto[patch] || typeof proto.renderLine !== "function") return;
  const original = proto.renderLine;
  proto.renderLine = function(cells, row, cols) {
    if (!cells.length || this.currentSelectionCoords || this.hoveredLinkRange) {
      return original.call(this, cells, row, cols);
    }
    const first = cells[0];
    for (const cell of cells) {
      if (cell.width !== 1 || cell.flags || cell.grapheme_len || cell.hyperlink_id
          || (cell.codepoint !== 0 && (cell.codepoint < 32 || cell.codepoint > 126))
          || cell.bg_r || cell.bg_g || cell.bg_b
          || cell.fg_r !== first.fg_r || cell.fg_g !== first.fg_g || cell.fg_b !== first.fg_b) {
        return original.call(this, cells, row, cols);
      }
    }
    const { ctx, metrics } = this;
    const y = row * metrics.height;
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, y, cols * metrics.width, metrics.height);
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    ctx.fillStyle = this.rgbToCSS(first.fg_r, first.fg_g, first.fg_b);
    for (let col = 0; col < cells.length; col++) {
      const code = cells[col].codepoint;
      if (code > 32) ctx.fillText(String.fromCharCode(code), col * metrics.width, y + metrics.baseline);
    }
  };
  proto[patch] = true;
}
