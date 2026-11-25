// Keyboard selection, as Ghostty does it (its adjust_selection bindings and
// Selection.adjust): while the pane has a selection, Shift with an arrow,
// Page Up/Down, Home or End moves the selection's end, the point a drag
// left, and the key does not reach the program. Without a selection the key
// is the program's as usual.

const adjustments = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  PageUp: "page_up", PageDown: "page_down", Home: "home", End: "end",
};

// The adjustment for Shift alone with one of those keys, or null. Keys go by
// what they report, so Fn+Shift+Up on a Mac keyboard (Shift+Page Up) pages.
export function terminalSelectionAdjustment(event) {
  if (!event?.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
  return adjustments[event.key] ?? null;
}

// Rows are absolute, as ghostty-web's selection keeps them: scrollback from
// 0, then the screen.
function rowCells(term, row) {
  const core = term.wasmTerm;
  const scrollback = core.getScrollbackLength();
  return (row < scrollback ? core.getScrollbackLine(row) : core.getLine(row - scrollback)) || [];
}

const hasText = (cell) => Boolean(cell && cell.codepoint !== 0);

// Moves the selection's end by adjustment and scrolls it into view. Returns
// false when there is no selection to adjust, so the key goes on.
export function adjustTerminalSelection(term, adjustment) {
  const manager = term?.selectionManager;
  if (!manager?.hasSelection?.() || !manager.selectionEnd || !term.wasmTerm) return false;
  const cols = term.cols, rows = term.rows;
  const lastRow = term.wasmTerm.getScrollbackLength() + rows - 1;
  let { col, absoluteRow: row } = manager.selectionEnd;

  const home = () => { col = 0; row = 0; };
  const end = () => {
    for (let candidate = lastRow; candidate >= 0; candidate--) {
      if (rowCells(term, candidate).some(hasText)) { row = candidate; col = cols - 1; return; }
    }
  };
  switch (adjustment) {
    case "up":
      if (row > 0) row -= 1; else col = 0;
      break;
    case "down": {
      let next = row + 1;
      while (next <= lastRow && !rowCells(term, next).some(hasText)) next++;
      if (next <= lastRow) row = next; else col = cols - 1;
      break;
    }
    // The previous or next cell with text, across rows; none leaves it.
    case "left":
    case "right": {
      const step = adjustment === "left" ? -1 : 1;
      let c = col, r = row, cells = rowCells(term, r);
      for (;;) {
        c += step;
        if (c < 0 || c >= cols) {
          r += step;
          if (r < 0 || r > lastRow) break;
          cells = rowCells(term, r);
          c = step < 0 ? cols - 1 : 0;
        }
        if (hasText(cells[c])) { col = c; row = r; break; }
      }
      break;
    }
    case "page_up":
      if (row - rows >= 0) row -= rows; else home();
      break;
    case "page_down":
      if (row + rows <= lastRow) row += rows; else end();
      break;
    case "home": home(); break;
    case "end": end(); break;
    default: return false;
  }

  manager.markCurrentSelectionDirty?.();
  manager.selectionEnd = { col, absoluteRow: row };
  // Scroll so the end is on screen, by as little as it takes, measured from
  // where a scroll already under way is heading. viewportY counts rows back
  // from the bottom.
  const position = Math.round(term.smoothScroll?.target ?? term.viewportY ?? 0);
  const viewportRow = row - term.wasmTerm.getScrollbackLength() + position;
  if (viewportRow < 0) term.smoothScrollTo?.(position - viewportRow);
  else if (viewportRow >= rows) term.smoothScrollTo?.(Math.max(0, position - (viewportRow - rows + 1)));
  manager.selectionChangedEmitter?.fire?.();
  term.requestRender?.();
  return true;
}

const modifierKeys = new Set(["Shift", "Control", "Alt", "Meta", "OS", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock", "Hyper", "Super", "AltGraph"]);

// Ghostty's selection-clear-on-typing: a key typed into the program clears
// the selection. A modifier pressed on its own types nothing.
export function clearTerminalSelectionForTyping(term, event, enabled) {
  if (!enabled || event?.type !== "keydown" || modifierKeys.has(event.key)) return;
  if (term?.hasSelection?.()) term.clearSelection();
}
