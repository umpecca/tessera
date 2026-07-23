export function terminalMouseMessage(data) {
  return JSON.stringify({ type: "mouse", data });
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
