export function terminalMouseMessage(data) {
  return JSON.stringify({ type: "mouse", data });
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

  update(pointerID, position) {
    if (!this.matches(pointerID)) {
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
