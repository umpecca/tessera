// Underline styles and colours: double (SGR 21 or 4:2), curly (4:3), dotted
// (4:4) and dashed (4:5), in the underline's own colour (SGR 58) when it has
// one, as Neovim uses for diagnostics and spelling. ghostty-web draws every
// underline as one plain line in the text colour. The core marks each cell
// (cell.underline: style in bits 0-2, bit 3 for an own colour, which is
// cell.underline_color, 0xRRGGBB); see scripts/ghostty-web-underlines.mjs.
const patch = Symbol.for("tessera.terminalUnderlines");
const UNDERLINE = 4, INVISIBLE = 32;

export const terminalUnderlineStyles = Object.freeze({ single: 1, double: 2, curly: 3, dotted: 4, dashed: 5 });
// SGR 53, in bit 4 of cell.underline (internal/terminalcore/source/underline_api.zig).
export const terminalOverlineBit = 16;

function css(rgb) {
  return `rgb(${rgb >> 16 & 255}, ${rgb >> 8 & 255}, ${rgb & 255})`;
}

// Draws one cell's underline at ghostty-web's position for a plain one, just
// below the baseline, kept inside the cell so the next row can't cover it.
export function drawTerminalUnderline(ctx, style, colour, left, top, width, metrics) {
  const bottom = top + metrics.height;
  const y = Math.min(top + metrics.baseline + 2, bottom - 1);
  const room = bottom - y;
  if (style === terminalUnderlineStyles.curly) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    // One wave per column, starting and ending on the line, so neighbouring
    // cells join up.
    const amplitude = Math.max(1, Math.min(2, room - 1));
    const centre = Math.min(y, bottom - amplitude - 0.5);
    const column = metrics.width;
    ctx.moveTo(left, centre);
    for (let x = left; x < left + width - 0.5; x += column) {
      ctx.quadraticCurveTo(x + column / 4, centre - 2 * amplitude, x + column / 2, centre);
      ctx.quadraticCurveTo(x + column * 3 / 4, centre + 2 * amplitude, x + column, centre);
    }
    ctx.stroke();
    return;
  }
  const fill = ctx.fillStyle;
  ctx.fillStyle = colour;
  if (style === terminalUnderlineStyles.double) {
    // Two lines on whole pixels either side of a plain underline, a pixel
    // apart, so they stay distinct at 1x as well as on Retina.
    const upper = Math.floor(y) - (room >= 2 ? 1 : 2);
    ctx.fillRect(left, upper, width, 1);
    ctx.fillRect(left, upper + 2, width, 1);
  } else if (style === terminalUnderlineStyles.dotted) {
    // One-pixel dots every other pixel, aligned to the canvas so the pattern
    // runs on across cells.
    for (let x = left + (Math.floor(left) % 2); x < left + width; x += 2) ctx.fillRect(x, y - 0.5, 1, 1);
  } else if (style === terminalUnderlineStyles.dashed) {
    // A dash centred in each column, so there's a gap between columns.
    const column = metrics.width, dash = Math.max(2, Math.round(column / 2));
    for (let x = left; x < left + width - 0.5; x += column) ctx.fillRect(x + Math.round((column - dash) / 2), y - 0.5, dash, 1);
  } else {
    ctx.fillRect(left, y - 0.5, width, 1);
  }
  ctx.fillStyle = fill;
}

export function installTerminalUnderlines(Renderer) {
  const prototype = Renderer?.prototype;
  if (!prototype || prototype[patch] || typeof prototype.renderCellText !== "function") return;
  const renderCellText = prototype.renderCellText;
  prototype.renderCellText = function renderTesseraUnderline(cell, column, row) {
    const style = cell.underline & 7, coloured = cell.underline & 8;
    const overline = cell.underline & terminalOverlineBit && !(cell.flags & INVISIBLE);
    // A plain underline in the text colour is ghostty-web's own.
    const ownUnderline = cell.flags & UNDERLINE && !(cell.flags & INVISIBLE)
      && (style > terminalUnderlineStyles.single || coloured);
    if (!ownUnderline && !overline) {
      return renderCellText.call(this, cell, column, row);
    }
    const result = renderCellText.call(this, ownUnderline ? { ...cell, flags: cell.flags & ~UNDERLINE } : cell, column, row);
    // ghostty-web leaves the text colour (or the selection's) as the fill.
    const textColour = this.ctx.fillStyle;
    const left = column * this.metrics.width, top = row * this.metrics.height;
    const width = this.metrics.width * (cell.width || 1);
    if (ownUnderline) {
      drawTerminalUnderline(this.ctx, style || terminalUnderlineStyles.single, coloured ? css(cell.underline_color) : textColour,
        left, top, width, this.metrics);
    }
    if (overline) {
      // Along the top of the cell in the text colour, as Ghostty draws it.
      const fill = this.ctx.fillStyle;
      this.ctx.fillStyle = textColour;
      this.ctx.fillRect(left, top, width, 1);
      this.ctx.fillStyle = fill;
    }
    return result;
  };
  Object.defineProperty(prototype, patch, { value: true });
}
