// Scrollback search highlights. Before each paint the terminal sets
// renderer.tesseraSearchRows to the matches showing, by viewport row, as
// [first column, last column, selected] (terminal-entry.js
// searchRowsInView). Matches are drawn as Ghostty draws them, dark text on
// yellow, the selected one on orange; a text selection over them wins.
const patch = Symbol.for("tessera.terminalSearchHighlights");
const INVERSE = 16;

export const terminalSearchHighlightColors = Object.freeze({
  match: "#f2d64b",
  selected: "#ff9628",
  text: [0, 0, 0],
});

// "selected", "match" or null for the cell at column (width columns wide).
export function terminalSearchHighlightAt(rows, column, row, width = 1) {
  const ranges = rows?.get(row);
  if (!ranges) return null;
  let found = null;
  for (const [start, end, selected] of ranges) {
    if (column + width - 1 < start || column > end) continue;
    if (selected) return "selected";
    found = "match";
  }
  return found;
}

export function installTerminalSearchHighlights(Renderer) {
  const prototype = Renderer?.prototype;
  if (!prototype || prototype[patch] || typeof prototype.renderCellBackground !== "function"
    || typeof prototype.renderCellText !== "function") return;
  const renderCellBackground = prototype.renderCellBackground;
  const renderCellText = prototype.renderCellText;
  const highlight = (renderer, cell, column, row) => {
    if (!renderer.tesseraSearchRows || renderer.isInSelection?.(column, row)) return null;
    return terminalSearchHighlightAt(renderer.tesseraSearchRows, column, row, cell.width || 1);
  };
  prototype.renderCellBackground = function renderTesseraSearchBackground(cell, column, row) {
    const kind = highlight(this, cell, column, row);
    if (!kind) return renderCellBackground.call(this, cell, column, row);
    this.ctx.fillStyle = terminalSearchHighlightColors[kind];
    this.ctx.fillRect(column * this.metrics.width, row * this.metrics.height,
      this.metrics.width * (cell.width || 1), this.metrics.height);
  };
  prototype.renderCellText = function renderTesseraSearchText(cell, column, row) {
    if (!highlight(this, cell, column, row)) return renderCellText.call(this, cell, column, row);
    const [fg_r, fg_g, fg_b] = terminalSearchHighlightColors.text;
    return renderCellText.call(this, { ...cell, fg_r, fg_g, fg_b, flags: cell.flags & ~INVERSE }, column, row);
  };
  Object.defineProperty(prototype, patch, { value: true });
}
