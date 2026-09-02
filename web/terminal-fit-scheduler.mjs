const socketOpen = 1; // WebSocket.OPEN
const defaultGridSizeDelay = 120;

// Moving or resizing a pane fits its terminal on every pointer move. Fitting
// reads layout, so fits are coalesced into one per frame per terminal. PTY grid
// updates are delayed until the geometry settles because full-screen programs
// can redraw their entire UI for every intermediate size.
export class TerminalFitScheduler {
  constructor(options = {}) {
    this.requestFrame = options.requestFrame
      || ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame
      || ((frameID) => globalThis.cancelAnimationFrame(frameID));
    this.setTimer = options.setTimer
      || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimer = options.clearTimer
      || ((timerID) => globalThis.clearTimeout(timerID));
    this.gridSizeDelay = options.gridSizeDelay ?? defaultGridSizeDelay;
    this.frames = new Map();
    this.gridSizeTimers = new Map();
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
      this.requestGridSize(terminalState);
    }));
  }

  cancel(terminalState) {
    const frameID = this.frames.get(terminalState);
    if (frameID !== undefined) {
      this.frames.delete(terminalState);
      this.cancelFrame(frameID);
    }
    this.cancelGridSize(terminalState);
  }

  // Full-screen terminal programs redraw on every PTY resize. Keep fitting the
  // local canvas during a drag, but let the program see only the final settled
  // grid instead of a stream of transient sizes.
  requestGridSize(terminalState) {
    if (!terminalState?.term) {
      return;
    }
    this.cancelGridSize(terminalState);
    this.gridSizeTimers.set(terminalState, this.setTimer(() => {
      this.gridSizeTimers.delete(terminalState);
      this.sendGridSize(terminalState);
    }, this.gridSizeDelay));
  }

  cancelGridSize(terminalState) {
    const timerID = this.gridSizeTimers.get(terminalState);
    if (timerID === undefined) {
      return;
    }
    this.gridSizeTimers.delete(terminalState);
    this.clearTimer(timerID);
  }

  // A fresh socket has not been told any size yet, so callers reset sentCols and
  // sentRows when they connect one.
  sendGridSize(terminalState) {
    this.cancelGridSize(terminalState);
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
