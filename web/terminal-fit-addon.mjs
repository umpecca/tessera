const minimumColumns = 2;
const minimumRows = 1;
const resizeDebounceMilliseconds = 100;

// ghostty-web draws its scrollbar inside the terminal canvas, so Tessera does
// not reserve a second scrollbar gutter while calculating the grid size.
export class TesseraFitAddon {
  constructor() {
    this.isResizing = false;
    this.lastColumns = undefined;
    this.lastRows = undefined;
    this.resizeObserver = undefined;
    this.resizeDebounceTimer = undefined;
    this.terminal = undefined;
  }

  activate(terminal) {
    this.terminal = terminal;
  }

  dispose() {
    this.resizeObserver?.disconnect();
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
    }
    this.resizeObserver = undefined;
    this.resizeDebounceTimer = undefined;
    this.lastColumns = undefined;
    this.lastRows = undefined;
    this.terminal = undefined;
  }

  fit() {
    if (this.isResizing) {
      return;
    }
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
      setTimeout(() => {
        this.isResizing = false;
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
      if (this.isResizing || !entries[0]) {
        return;
      }
      if (this.resizeDebounceTimer) {
        clearTimeout(this.resizeDebounceTimer);
      }
      this.resizeDebounceTimer = setTimeout(() => this.fit(), resizeDebounceMilliseconds);
    });
    this.resizeObserver.observe(this.terminal.element);
  }
}

function cssPixels(value) {
  return Number.parseFloat(value) || 0;
}

