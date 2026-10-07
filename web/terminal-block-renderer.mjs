const rendererPatch = Symbol.for("tessera.terminalBlockRenderer");

function rectangle(x, y, right, bottom) {
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

// Solid box-drawing arms, in left/right/up/down order: 0 absent, 1 light,
// 2 heavy. Dashed, double, rounded and diagonal glyphs retain their font shape.
const straightBoxArms = ["1100", "2200", "0011", "0022"];
const joinedBoxArms = [ // U+250C through U+254B
  "0101", "0201", "0102", "0202", "1001", "2001", "1002", "2002",
  "0110", "0210", "0120", "0220", "1010", "2010", "1020", "2020",
  "0111", "0211", "0121", "0112", "0122", "0221", "0212", "0222",
  "1011", "2011", "1021", "1012", "1022", "2021", "2012", "2022",
  "1101", "2101", "1201", "2201", "1102", "2102", "1202", "2202",
  "1110", "2110", "1210", "2210", "1120", "2120", "1220", "2220",
  "1111", "2111", "1211", "2211", "1121", "1112", "1122", "2121",
  "1221", "2112", "1212", "2221", "2212", "2122", "1222", "2222",
];
const halfBoxArms = [ // U+2574 through U+257F
  "1000", "0010", "0100", "0001", "2000", "0020", "0200", "0002",
  "1200", "0012", "2100", "0021",
];

export function terminalBoxDrawingRects(codepoint, width, height) {
  const arms = straightBoxArms[codepoint - 0x2500]
    || joinedBoxArms[codepoint - 0x250c] || halfBoxArms[codepoint - 0x2574];
  if (!arms) return null;
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  const light = Math.max(1, Math.round(w / 8));
  const [left, right, up, down] = [...arms].map(Number);
  const v = Math.min(w, Math.max(up, down) * light);
  const horizontal = Math.min(h, Math.max(left, right) * light);
  const x = Math.floor((w - v) / 2), y = Math.floor((h - horizontal) / 2);
  const rects = [];
  for (const [weight, direction] of [[left, "left"], [right, "right"], [up, "up"], [down, "down"]]) {
    if (!weight) continue;
    const thickness = Math.min(direction === "left" || direction === "right" ? h : w, weight * light);
    const lineX = Math.floor((w - thickness) / 2), lineY = Math.floor((h - thickness) / 2);
    // Arms overlap at the junction and reach the exact cell edges. This keeps
    // adjoining rows continuous even when text needs extra ascender space.
    if (direction === "left") rects.push(rectangle(0, lineY, x + v, lineY + thickness));
    else if (direction === "right") rects.push(rectangle(x, lineY, w, lineY + thickness));
    else if (direction === "up") rects.push(rectangle(lineX, 0, lineX + thickness, y + horizontal));
    else rects.push(rectangle(lineX, y, lineX + thickness, h));
  }
  // Avoid painting junction pixels twice: faint lines must have the same
  // opacity at corners as along their edges. Use disjoint fills rather than
  // a canvas path, which can rasterize differently under dirty-row clipping.
  const fills = [];
  for (const rect of rects.filter(Boolean)) {
    let parts = [rect];
    for (const filled of fills) {
      parts = parts.flatMap(part => {
        const right = part.x + part.width, bottom = part.y + part.height;
        const x = Math.max(part.x, filled.x), y = Math.max(part.y, filled.y);
        const endX = Math.min(right, filled.x + filled.width), endY = Math.min(bottom, filled.y + filled.height);
        if (endX <= x || endY <= y) return [part];
        return [rectangle(part.x, part.y, right, y), rectangle(part.x, endY, right, bottom),
          rectangle(part.x, y, x, endY), rectangle(endX, y, right, endY)].filter(Boolean);
      });
    }
    fills.push(...parts);
  }
  return fills;
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

export function terminalSymbolNeedsCellConstraint(codepoint) {
  return (codepoint >= 0x2190 && codepoint <= 0x2bff) ||
    (codepoint >= 0x1f000 && codepoint <= 0x1fbff);
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
    // Almost every terminal cell is ordinary text. Keep the High Sierra
    // symbol workaround out of that hot path before reading metrics or doing
    // block geometry work. This matters for rapidly changing bold/ANSI text,
    // which Ghostty renders cell by cell.
    if (!terminalSymbolNeedsCellConstraint(cell.codepoint)) {
      return originalRenderCellText.call(this, cell, column, row);
    }
    const width = this.metrics.width * (cell.width || 1);
    const rects = terminalBlockRects(cell.codepoint, width, this.metrics.height)
      || terminalBoxDrawingRects(cell.codepoint, width, this.metrics.height);
    if (!rects && !(cell.flags & CellFlags.INVISIBLE)) {
      // Symbol fonts are not necessarily monospaced. Canvas fillText otherwise
      // lets a wide fallback glyph overwrite neighboring cells. Its maxWidth
      // argument only condenses glyphs that exceed Ghostty's assigned width,
      // leaving already narrow symbols (including U+23F5) unchanged.
      const originalFillText = this.ctx.fillText;
      const originalFontFamily = this.fontFamily;
      this.ctx.fillText = function fillTerminalSymbol(text, x, y, callerMaxWidth) {
        const maxWidth = Number.isFinite(callerMaxWidth) ? Math.min(callerMaxWidth, width) : width;
        return originalFillText.call(this, text, x, y, maxWidth);
      };
      try {
        if (this.tesseraSymbolFontFamily) {
          this.fontFamily = this.tesseraSymbolFontFamily;
        }
        return originalRenderCellText.call(this, cell, column, row);
      } finally {
        this.fontFamily = originalFontFamily;
        this.ctx.fillText = originalFillText;
      }
    }
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
