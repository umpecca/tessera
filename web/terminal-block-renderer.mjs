const rendererPatch = Symbol.for("tessera.terminalBlockRenderer");

function rectangle(x, y, right, bottom) {
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function terminalBlockRects(codepoint, width, height) {
  const cellWidth = Math.max(1, Math.round(width));
  const cellHeight = Math.max(1, Math.round(height));
  const xHalf = Math.round(cellWidth / 2);
  const yHalf = Math.round(cellHeight / 2);
  let rects = null;

  if (codepoint === 0x2580) { // upper half
    rects = [rectangle(0, 0, cellWidth, yHalf)];
  } else if (codepoint >= 0x2581 && codepoint <= 0x2587) { // lower eighths
    const eighths = codepoint - 0x2580;
    const top = Math.round(cellHeight * (8 - eighths) / 8);
    rects = [rectangle(0, top, cellWidth, cellHeight)];
  } else if (codepoint === 0x2588) { // full block
    rects = [rectangle(0, 0, cellWidth, cellHeight)];
  } else if (codepoint >= 0x2589 && codepoint <= 0x258f) { // left eighths
    const eighths = 0x2590 - codepoint;
    const right = Math.round(cellWidth * eighths / 8);
    rects = [rectangle(0, 0, right, cellHeight)];
  } else if (codepoint === 0x2590) { // right half
    rects = [rectangle(xHalf, 0, cellWidth, cellHeight)];
  } else if (codepoint === 0x2594) { // upper one eighth
    rects = [rectangle(0, 0, cellWidth, Math.round(cellHeight / 8))];
  } else if (codepoint === 0x2595) { // right one eighth
    rects = [rectangle(Math.round(cellWidth * 7 / 8), 0, cellWidth, cellHeight)];
  } else if (codepoint >= 0x2596 && codepoint <= 0x259f) {
    const quadrantMasks = [
      0b0100, // lower left
      0b1000, // lower right
      0b0001, // upper left
      0b1101, // upper left and both lower quadrants
      0b1001, // upper left and lower right
      0b0111, // both upper quadrants and lower left
      0b1011, // both upper quadrants and lower right
      0b0010, // upper right
      0b0110, // upper right and lower left
      0b1110, // upper right and both lower quadrants
    ];
    const mask = quadrantMasks[codepoint - 0x2596];
    const quadrants = [
      rectangle(0, 0, xHalf, yHalf),
      rectangle(xHalf, 0, cellWidth, yHalf),
      rectangle(0, yHalf, xHalf, cellHeight),
      rectangle(xHalf, yHalf, cellWidth, cellHeight),
    ];
    rects = quadrants.filter((rect, index) => mask & (1 << index));
  }

  return rects?.filter(Boolean) || null;
}

export function installTerminalBlockRenderer(CanvasRenderer, CellFlags) {
  const prototype = CanvasRenderer?.prototype;
  if (!prototype || prototype[rendererPatch]) {
    return;
  }
  const originalRenderCellText = prototype.renderCellText;
  if (typeof originalRenderCellText !== "function") {
    return;
  }

  prototype.renderCellText = function renderTesseraBlockCell(cell, column, row) {
    const width = this.metrics.width * (cell.width || 1);
    const rects = terminalBlockRects(cell.codepoint, width, this.metrics.height);
    if (!rects || cell.flags & CellFlags.INVISIBLE) {
      return originalRenderCellText.call(this, cell, column, row);
    }

    // Let ghostty-web establish the exact foreground/selection color and draw
    // decorations, but replace the font glyph itself with a harmless space.
    originalRenderCellText.call(this, { ...cell, codepoint: 32, grapheme_len: 0 }, column, row);
    const previousAlpha = this.ctx.globalAlpha;
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }
    const left = column * this.metrics.width;
    const top = row * this.metrics.height;
    for (const rect of rects) {
      this.ctx.fillRect(left + rect.x, top + rect.y, rect.width, rect.height);
    }
    this.ctx.globalAlpha = previousAlpha;
  };
  Object.defineProperty(prototype, rendererPatch, { value: true });
}
