const socketOpen = 1; // WebSocket.OPEN

// Moving or resizing a pane fits its terminal on every pointer move. Fitting
// reads layout and can resize the PTY, so fits are coalesced into one per frame
// per terminal, and the grid size is sent only when it actually changes.
export class TerminalFitScheduler {
  constructor(options = {}) {
    this.requestFrame = options.requestFrame
      || ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame
      || ((frameID) => globalThis.cancelAnimationFrame(frameID));
    this.frames = new Map();
  }

  request(terminalState) {
    if (!terminalState?.fit || this.frames.has(terminalState)) {
      return;
    }
    this.frames.set(terminalState, this.requestFrame(() => {
      this.frames.delete(terminalState);
      if (!terminalState.fit) {
        return;
      }
      terminalState.fit.fit();
      this.sendGridSize(terminalState);
    }));
  }

  cancel(terminalState) {
    const frameID = this.frames.get(terminalState);
    if (frameID === undefined) {
      return;
    }
    this.frames.delete(terminalState);
    this.cancelFrame(frameID);
  }

  // A fresh socket has not been told any size yet, so callers reset sentCols and
  // sentRows when they connect one.
  sendGridSize(terminalState) {
    const term = terminalState?.term;
    if (!term || terminalState.socket?.readyState !== socketOpen) {
      return;
    }
    if (term.cols === terminalState.sentCols && term.rows === terminalState.sentRows) {
      return;
    }
    terminalState.sentCols = term.cols;
    terminalState.sentRows = term.rows;
    terminalState.socket.send(JSON.stringify({
      type: "resize",
      cols: term.cols,
      rows: term.rows,
    }));
  }
}
