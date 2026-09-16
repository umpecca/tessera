const minimumColumns = 2;
const minimumRows = 1;
const resizeDebounceMilliseconds = 100;

// ghostty-web draws its scrollbar inside the terminal canvas, so Tessera does
// not reserve a second scrollbar gutter while calculating the grid size.
export class TesseraFitAddon {
  constructor(options = {}) {
    this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer || ((timerID) => clearTimeout(timerID));
    this.isResizing = false;
    this.fitPending = false;
    this.lastColumns = undefined;
    this.lastRows = undefined;
    this.resizeObserver = undefined;
    this.resizeDebounceTimer = undefined;
    this.resizeReleaseTimer = undefined;
    this.terminal = undefined;
  }

  activate(terminal) {
    this.terminal = terminal;
  }

  dispose() {
    this.resizeObserver?.disconnect();
    if (this.resizeDebounceTimer !== undefined) {
      this.clearTimer(this.resizeDebounceTimer);
    }
    if (this.resizeReleaseTimer !== undefined) {
      this.clearTimer(this.resizeReleaseTimer);
    }
    this.resizeObserver = undefined;
    this.resizeDebounceTimer = undefined;
    this.resizeReleaseTimer = undefined;
    this.fitPending = false;
    this.isResizing = false;
    this.lastColumns = undefined;
    this.lastRows = undefined;
    this.terminal = undefined;
  }

  fit() {
    if (this.isResizing) {
      // The last pane-resize event can land during this short guard. Remember
      // it or the canvas can remain on an intermediate grid indefinitely.
      this.fitPending = true;
      return;
    }
    this.fitPending = false;
    const dimensions = this.proposeDimensions();
    const terminal = this.terminal;
    if (!dimensions || !terminal) {
      return;
    }
    if (
      (dimensions.cols === this.lastColumns && dimensions.rows === this.lastRows)
      || (dimensions.cols === terminal.cols && dimensions.rows === terminal.rows)
    ) {
      return;
    }

    this.lastColumns = dimensions.cols;
    this.lastRows = dimensions.rows;
    this.isResizing = true;
    try {
      terminal.resize(dimensions.cols, dimensions.rows);
    } finally {
      this.resizeReleaseTimer = this.setTimer(() => {
        this.resizeReleaseTimer = undefined;
        this.isResizing = false;
        if (this.fitPending) {
          this.fitPending = false;
          this.fit();
        }
      }, 50);
    }
  }

  proposeDimensions() {
    const terminal = this.terminal;
    const element = terminal?.element;
    const metrics = terminal?.renderer?.getMetrics?.();
    if (!element || !metrics || metrics.width === 0 || metrics.height === 0) {
      return undefined;
    }
    if (element.clientWidth === 0 || element.clientHeight === 0) {
      return undefined;
    }

    const style = window.getComputedStyle(element);
    const horizontalPadding = cssPixels(style.getPropertyValue("padding-left"))
      + cssPixels(style.getPropertyValue("padding-right"));
    const verticalPadding = cssPixels(style.getPropertyValue("padding-top"))
      + cssPixels(style.getPropertyValue("padding-bottom"));
    const availableWidth = element.clientWidth - horizontalPadding;
    const availableHeight = element.clientHeight - verticalPadding;

    return {
      cols: Math.max(minimumColumns, Math.floor(availableWidth / metrics.width)),
      rows: Math.max(minimumRows, Math.floor(availableHeight / metrics.height)),
    };
  }

  observeResize() {
    if (!this.terminal?.element || this.resizeObserver) {
      return;
    }
    this.resizeObserver = new ResizeObserver((entries) => {
      if (!entries[0]) {
        return;
      }
      if (this.resizeDebounceTimer !== undefined) {
        this.clearTimer(this.resizeDebounceTimer);
      }
      this.resizeDebounceTimer = this.setTimer(() => {
        this.resizeDebounceTimer = undefined;
        this.fit();
      }, resizeDebounceMilliseconds);
    });
    this.resizeObserver.observe(this.terminal.element);
  }
}

function cssPixels(value) {
  return Number.parseFloat(value) || 0;
}
