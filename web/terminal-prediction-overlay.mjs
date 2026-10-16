// Draws predicted characters on a transparent canvas laid exactly over the
// terminal's own canvas, so predictions can appear and vanish without ever
// touching the terminal's pixels or state.
export class TerminalPredictionOverlay {
  constructor(renderer) {
    this.renderer = renderer;
    this.canvas = null;
    this.drawn = false;
  }

  ensureCanvas() {
    const base = this.renderer?.canvas;
    const parent = base?.parentElement;
    if (!parent) return null;
    if (!this.canvas || this.canvas.parentElement !== parent) {
      this.canvas?.remove();
      const canvas = base.ownerDocument.createElement("canvas");
      canvas.className = "terminal-prediction-overlay";
      canvas.setAttribute("aria-hidden", "true");
      Object.assign(canvas.style, { position: "absolute", pointerEvents: "none", left: "0", top: "0" });
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
      parent.appendChild(canvas);
      this.canvas = canvas;
    }
    return this.canvas;
  }

  clear() {
    if (!this.drawn || !this.canvas) return;
    this.canvas.getContext("2d").clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn = false;
  }

  // draw shows { cells: [{col, row, char}], cursor: {col, row} | null }.
  draw(visible) {
    if (!visible.cells.length) {
      this.clear();
      return;
    }
    const canvas = this.ensureCanvas();
    const renderer = this.renderer;
    const base = renderer.canvas;
    if (!canvas || !renderer.metrics) return;
    if (canvas.width !== base.width || canvas.height !== base.height) {
      canvas.width = base.width;
      canvas.height = base.height;
    }
    canvas.style.width = base.style.width;
    canvas.style.height = base.style.height;
    canvas.style.left = `${base.offsetLeft}px`;
    canvas.style.top = `${base.offsetTop}px`;

    const ctx = canvas.getContext("2d");
    const ratio = renderer.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const { width, height, baseline } = renderer.metrics;
    const theme = renderer.theme || {};
    const foreground = theme.foreground || "#d4d4d4";
    ctx.font = `${renderer.fontSize}px ${renderer.fontFamily}`;
    ctx.textBaseline = "alphabetic";
    const underline = Math.max(1, Math.round(height * 0.06));
    for (const { col, row, char } of visible.cells) {
      const x = col * width;
      const y = row * height;
      ctx.fillStyle = theme.background || "#000";
      ctx.fillRect(x, y, width, height);
      ctx.fillStyle = foreground;
      ctx.fillText(char, x, y + baseline);
      // The underline marks a character the server has not echoed yet.
      ctx.globalAlpha = 0.6;
      ctx.fillRect(x, y + height - underline, width, underline);
      ctx.globalAlpha = 1;
    }
    if (visible.cursor) {
      const x = visible.cursor.col * width;
      const y = visible.cursor.row * height;
      // No background fill: whatever is right of the typed text stays.
      ctx.fillStyle = theme.cursor || foreground;
      const style = renderer.cursorStyle;
      if (style === "underline") {
        const size = Math.max(2, Math.floor(height * 0.15));
        ctx.fillRect(x, y + height - size, width, size);
      } else if (style === "bar") {
        ctx.fillRect(x, y, Math.max(2, Math.floor(width * 0.15)), height);
      } else {
        ctx.fillRect(x, y, width, height);
      }
    }
    this.drawn = true;
  }

  dispose() {
    this.canvas?.remove();
    this.canvas = null;
    this.drawn = false;
  }
}
