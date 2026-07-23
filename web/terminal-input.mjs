export function terminalMouseMessage(data) {
  return JSON.stringify({ type: "mouse", data });
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
