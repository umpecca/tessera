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
    this.isHidden = options.isHidden
      || (() => globalThis.document?.hidden === true);
    // A terminal can watch the shell at whatever size it has (a phone looking
    // in), or take a size only for a while (a phone typing), which the host
    // gives back when this browser lets go.
    this.watchesSize = options.watchesSize || (() => false);
    this.sizeIsTemporary = options.sizeIsTemporary || (() => false);
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

  // Several browsers can show one shell, and the shell has one size. Whichever
  // browser is in use claims it: when the host is at another browser's grid,
  // this one sends its own again, even though it already sent that grid once.
  claimGridSize(terminalState) {
    const term = terminalState?.term;
    if (!term) {
      return;
    }
    const cols = term.desiredCols ?? term.cols;
    const rows = term.desiredRows ?? term.rows;
    if (term.cols === cols && term.rows === rows) {
      return;
    }
    terminalState.sentCols = 0;
    terminalState.sentRows = 0;
    this.sendGridSize(terminalState);
  }

  // A fresh socket has not been told any size yet, so callers reset sentCols and
  // sentRows when they connect one.
  sendGridSize(terminalState) {
    this.cancelGridSize(terminalState);
    const term = terminalState?.term;
    if (!term || terminalState.socket?.readyState !== socketOpen) {
      return;
    }
    // A hidden page is not in use, and its viewport is not the one anyone is
    // looking at: iPadOS resizes a backgrounded web app while it renders the
    // app switcher, and sending that size reflows a running program's output
    // at the wrong width. The local canvas may still fit; the shell keeps the
    // last size sent, and the refit on becoming visible sends the real one.
    if (this.isHidden() || this.watchesSize(terminalState)) {
      return;
    }
    const cols = term.desiredCols ?? term.cols;
    const rows = term.desiredRows ?? term.rows;
    const metrics = term.renderer?.getMetrics?.();
    const cellWidth = Math.max(1, Math.round(metrics?.width || 8));
    const cellHeight = Math.max(1, Math.round(metrics?.height || 16));
    if (cols === terminalState.sentCols && rows === terminalState.sentRows && cellWidth === terminalState.sentCellWidth && cellHeight === terminalState.sentCellHeight) {
      return;
    }
    terminalState.sentCols = cols;
    terminalState.sentRows = rows;
    terminalState.sentCellWidth = cellWidth;
    terminalState.sentCellHeight = cellHeight;
    terminalState.socket.send(JSON.stringify({
      type: "resize",
      cols, rows, cellWidth, cellHeight,
      ...(this.sizeIsTemporary(terminalState) ? { temporary: true } : {}),
    }));
  }
}
