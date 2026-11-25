export function terminalMouseMessage(data) {
  return JSON.stringify({ type: "mouse", data });
}

export function isTerminalContextMenuGesture(event, { appleKeyboard = false } = {}) {
  return event.button === 2 || Boolean(appleKeyboard && event.button === 0 && event.ctrlKey);
}

// Bracketed paste wraps pasted text in `ESC [ 200~` and `ESC [ 201~` so an
// application can tell it apart from typing. Clipboard text carrying those
// markers would close the bracket early and leave the rest of the paste looking
// like keystrokes, so they are dropped before the text is handed over.
export function terminalPasteText(text) {
  if (typeof text !== "string") {
    return "";
  }
  return text.replace(/\x1b\[20[01]~/g, "");
}

// What to tell the operator when a copy found nothing to copy.
//
// A mouse-aware application owns unmodified dragging, so inside one there is
// no terminal selection unless the operator held the override modifier — and
// nothing on screen says that modifier exists. The application's own selection
// is not the terminal's to read either; that text reaches the clipboard only
// when the application copies it itself, over OSC 52.
export function emptyTerminalCopyGuidance(mouseTracking) {
  return mouseTracking
    ? "Nothing is selected. Hold Shift while dragging to select inside a full-screen program, or use that program's own copy key."
    : "Nothing is selected. Drag across the terminal to select text first.";
}

export function clearTerminalSelectionStartedDuringGesture(term, hadSelection) {
  if (hadSelection !== false || typeof term?.hasSelection !== "function"
      || typeof term?.clearSelection !== "function") {
    return false;
  }
  try {
    if (!term.hasSelection()) {
      return false;
    }
    term.clearSelection();
    return true;
  } catch {
    return false;
  }
}

export class TerminalContextMenuFallback {
  constructor(maxAgeMilliseconds = 1000) {
    this.maxAgeMilliseconds = maxAgeMilliseconds;
    this.buttonCode = null;
    this.timeStamp = null;
  }

  notePress(buttonCode, timeStamp) {
    this.buttonCode = buttonCode;
    this.timeStamp = timeStamp;
  }

  needsFallback(buttonCode, timeStamp) {
    const age = this.timeStamp === null ? Number.POSITIVE_INFINITY : timeStamp - this.timeStamp;
    const sawMatchingPress = this.buttonCode === buttonCode
      && age >= 0
      && age <= this.maxAgeMilliseconds;
    this.buttonCode = null;
    this.timeStamp = null;
    return !sawMatchingPress;
  }
}

// Pointer motion with no button held, for programs that turn on any-event
// tracking (mode 1003) to draw hover effects. Reported once per cell, as
// drags are, so a pointer resting or wobbling inside a cell sends nothing.
export class TerminalMouseHover {
  constructor() {
    this.position = null;
  }

  // Returns whether the pointer entered another cell.
  move(position) {
    if (this.position?.col === position.col && this.position?.row === position.row) {
      return false;
    }
    this.position = position;
    return true;
  }

  // Forget the cell, so the next motion reports wherever it is: after the
  // pointer leaves the pane, a press, or tracking turning off.
  reset() {
    this.position = null;
  }
}

// SGR motion with no button: 32 (motion) + 3 (no button).
export const terminalHoverButtonCode = 35;

// A pointer at a fraction (0 to 1) across and down the terminal grid, as the
// cell it is over and, while the program has SGR-Pixels (mode 1016) set, as
// the pixel too. Those pixels are in the space the host told the program
// about through in-band size reports (mode 2048): columns × cell width by
// rows × cell height, with the cell size the host accepted, not CSS pixels.
// Both are 1-based; Textual subtracts one and drops negative positions.
// Textual turns on 1016 whenever the terminal supports 2048.
export function terminalMouseCoordinates(term, fractionX, fractionY) {
  const cols = term.cols, rows = term.rows;
  const col = Math.min(cols, Math.max(1, Math.floor(fractionX * cols) + 1));
  const row = Math.min(rows, Math.max(1, Math.floor(fractionY * rows) + 1));
  let pixels = false;
  try { pixels = Boolean(term.getMode?.(1016, false)); } catch {}
  if (!pixels) return { col, row };
  const metrics = term.renderer?.getMetrics?.();
  const cellWidth = term.hostCellWidth || Math.max(1, Math.round(metrics?.width || 8));
  const cellHeight = term.hostCellHeight || Math.max(1, Math.round(metrics?.height || 16));
  const width = cols * cellWidth, height = rows * cellHeight;
  return {
    col, row,
    x: Math.min(width, Math.max(1, Math.floor(fractionX * width) + 1)),
    y: Math.min(height, Math.max(1, Math.floor(fractionY * height) + 1)),
  };
}

// An SGR mouse report (mode 1006), in pixels when the position carries them.
export function terminalMouseSequence(code, position, finalByte) {
  return `\x1b[<${code};${position.x ?? position.col};${position.y ?? position.row}${finalByte}`;
}

export class TerminalMousePress {
  constructor() {
    this.pointerID = null;
    this.buttonCode = null;
    this.position = null;
  }

  begin(pointerID, buttonCode, position) {
    this.pointerID = pointerID;
    this.buttonCode = buttonCode;
    this.position = position;
  }

  matches(pointerID) {
    return this.buttonCode !== null && this.pointerID === pointerID;
  }

  // Returns whether the press moved to another cell. Like xterm, a drag is
  // reported once per cell: a pointer wobbling inside one cell would otherwise
  // send a stream of identical reports, and any the program has not read when
  // it exits are left for the shell to print.
  update(pointerID, position) {
    if (!this.matches(pointerID)) {
      return false;
    }
    if (this.position?.col === position.col && this.position?.row === position.row) {
      return false;
    }
    this.position = position;
    return true;
  }

  finish(pointerID, position = null) {
    if (this.buttonCode === null || (pointerID !== null && pointerID !== this.pointerID)) {
      return null;
    }
    const release = {
      pointerID: this.pointerID,
      buttonCode: this.buttonCode,
      position: position || this.position,
    };
    this.pointerID = null;
    this.buttonCode = null;
    this.position = null;
    return release;
  }
}
