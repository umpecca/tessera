// Scrolling shares the terminal's paint scheduler, so position and pixels advance
// together instead of racing a second animation loop.
export class TerminalScroll {
  constructor(terminal, now = () => performance.now()) {
    this.terminal = terminal;
    this.now = now;
    this.target = null;
    this.lastFrame = null;
    this.direction = 0;
  }

  by(lines) {
    if (!Number.isFinite(lines) || lines === 0) return;
    const term = this.terminal;
    const direction = Math.sign(lines);
    // A reversal must respond to the finger immediately, without first finishing
    // the previous gesture's queued movement.
    const origin = this.target !== null && direction === this.direction
      ? this.target : term.viewportY;
    this.direction = direction;
    this.to(origin - lines);
  }

  to(position) {
    const term = this.terminal;
    if (!term.wasmTerm || !Number.isFinite(position)) return;
    this.target = Math.max(0, Math.min(term.getScrollbackLength(), position));
    term.targetViewportY = this.target;
    this.lastFrame ??= this.now();
    if (term.options.smoothScrollDuration === 0
        || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      term.viewportY = this.target;
      this.cancel();
      term.scrollEmitter.fire(term.viewportY);
    }
    term.noteInteractiveInput();
    term.showScrollbar();
    term.requestRender();
  }

  advance() {
    if (this.target === null) return false;
    const term = this.terminal;
    if (term.wasmTerm?.isAlternateScreen?.()) {
      term.viewportY = 0;
      this.cancel();
      return false;
    }
    this.target = Math.max(0, Math.min(term.getScrollbackLength(), this.target));
    term.targetViewportY = this.target;
    const now = this.now(), elapsed = Math.max(0, now - this.lastFrame);
    this.lastFrame = now;
    const duration = Math.max(1, term.options.smoothScrollDuration ?? 120);
    term.viewportY += (this.target - term.viewportY) * (1 - Math.exp(-elapsed * 3 / duration));
    const height = term.renderer?.getMetrics().height || 20;
    const ratio = term.renderer?.devicePixelRatio || 1;
    if (Math.abs(this.target - term.viewportY) * height * ratio < 0.5) {
      term.viewportY = this.target;
      this.cancel();
    }
    term.noteInteractiveInput();
    // The adapter suppresses its own onScroll paint request during this frame.
    term.scrollEmitter.fire(term.viewportY);
    return this.target !== null;
  }

  cancel() {
    this.target = null;
    this.lastFrame = null;
    this.direction = 0;
    this.terminal.targetViewportY = this.terminal.viewportY;
  }
}

export function terminalScrollMouseEvent(terminal, event) {
  const fraction = terminal.viewportY - Math.floor(terminal.viewportY);
  if (!fraction) return event;
  const ratio = terminal.renderer.devicePixelRatio || 1;
  const offset = Math.round(fraction * terminal.renderer.getMetrics().height * ratio) / ratio;
  // Native Event getters and methods require their original receiver.
  return new Proxy(event, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "clientY") return value - offset;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const patch = Symbol.for("tessera.terminalFractionalScroll");
const maximumScrollCacheBytes = 32 * 1024 * 1024;

// One viewport plus its partial top row, never a cache of terminal history.
// Only physically aligned, undecorated text uses this path. The ordinary
// renderer remains authoritative for all other cases.
class TerminalScrollCache {
  constructor(canvas, context) {
    this.canvas = canvas;
    this.context = context;
    this.key = null;
    this.whole = 0;
    this.shiftSafe = false;
    this.bottomCells = null;
  }

  clear() {
    this.canvas.width = this.canvas.height = 0;
    this.key = null;
    this.bottomCells = null;
  }

  render(renderer, render, buffer, force, whole, offset, viewportY, provider, opacity, metrics) {
    const { width, height, baseline } = metrics;
    const ratio = renderer.devicePixelRatio || 1;
    const { cols, rows } = buffer.getDimensions();
    const history = provider.getScrollbackLength();
    const key = [buffer, buffer.handle, renderer.canvas, renderer.canvas.width,
      renderer.canvas.height, cols, rows, history, ratio, width, height, baseline, renderer.metrics,
      renderer.fontSize, renderer.fontFamily, renderer.tesseraSymbolFontFamily,
      renderer.theme.background, renderer.renderLine];
    const valid = !force && !buffer.isDirty()
      && this.key?.every((value, index) => value === key[index]);
    const delta = whole - this.whole;
    const edgeRows = Math.abs(delta) + 2;
    // Shift only when enough middle rows survive to make reuse worthwhile.
    const edges = valid && this.shiftSafe && delta !== 0 && edgeRows * 2 < rows ? edgeRows : 0;
    const ctx = this.context;
    if (!valid || delta !== 0) {
      this.key = null;
      const pixels = height * ratio;
      if (this.canvas.width !== renderer.canvas.width || this.canvas.height !== renderer.canvas.height + pixels) {
        this.canvas.width = renderer.canvas.width;
        this.canvas.height = renderer.canvas.height + pixels;
      }
      ctx.save();
      const original = renderer.ctx, line = renderer.renderLine;
      const ownLine = Object.hasOwn(renderer, "renderLine");
      const scrollbar = renderer.renderScrollbar, ownScrollbar = Object.hasOwn(renderer, "renderScrollbar");
      const cursorVisible = renderer.cursorVisible;
      const cache = this;
      const historyLine = provider.getScrollbackLine, ownHistoryLine = Object.hasOwn(provider, "getScrollbackLine");
      const bufferLine = buffer.getLine, ownBufferLine = Object.hasOwn(buffer, "getLine");
      let shiftSafe = true;
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (edges) {
          ctx.globalCompositeOperation = "copy";
          ctx.drawImage(this.canvas, 0, delta * pixels);
          ctx.globalCompositeOperation = "source-over";
        } else {
          ctx.fillStyle = renderer.theme.background;
          ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
        ctx.setTransform(ratio, 0, 0, ratio, 0, pixels);
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        if (edges) {
          // Repaint both boundary bands, including ink from adjacent source
          // rows. The top row is drawn last, just as in the fractional fallback.
          ctx.beginPath();
          ctx.rect(0, -height, cols * width, (edges + 1) * height);
          ctx.rect(0, (rows - edges) * height, cols * width, edges * height);
          ctx.clip();
          // The base renderer traverses every row while reading history. Skip
          // native reads for the unchanged middle as well as its rasterization.
          const needed = row => row <= edges || row >= rows - edges - 1;
          provider.getScrollbackLine = function(index) {
            return needed(index - history + whole) ? historyLine.call(this, index) : null;
          };
          if (typeof bufferLine === "function") buffer.getLine = function(row) {
            return needed(row + whole) ? bufferLine.call(this, row) : null;
          };
        }
        renderer.renderLine = function(cells, row, columns) {
          // Ghostty resolves multi-codepoint graphemes through viewport-row
          // coordinates. Their rasterization cannot be shifted to another row
          // without re-reading it; same-anchor fractional reuse is still safe.
          if (cells.some(cell => cell.grapheme_len > 0)) shiftSafe = false;
          if (row === rows - 1) cache.bottomCells = cells;
          if (!edges || row <= edges || row >= rows - edges - 1) line.call(this, cells, row, columns);
        };
        renderer.ctx = ctx;
        renderer.renderScrollbar = () => {};
        renderer.cursorVisible = false;
        render.call(renderer, buffer, true, whole, provider, 0);
        const top = provider.getScrollbackLine(history - whole - 1);
        if (top) renderer.renderLine(top, -1, cols);
      } finally {
        renderer.ctx = original;
        renderer.cursorVisible = cursorVisible;
        if (ownLine) renderer.renderLine = line;
        else delete renderer.renderLine;
        if (ownScrollbar) renderer.renderScrollbar = scrollbar;
        else delete renderer.renderScrollbar;
        if (edges) {
          if (ownHistoryLine) provider.getScrollbackLine = historyLine;
          else delete provider.getScrollbackLine;
          if (typeof bufferLine === "function") {
            if (ownBufferLine) buffer.getLine = bufferLine;
            else delete buffer.getLine;
          }
        }
        ctx.restore();
      }
      if (edges && !shiftSafe) {
        // A newly exposed row can introduce graphemes not in the old viewport.
        return this.render(renderer, render, buffer, true, whole, offset, viewportY, provider, opacity, metrics);
      }
      this.whole = whole;
      this.key = key;
      this.shiftSafe = shiftSafe;
    }
    const output = renderer.ctx;
    output.save();
    try {
      output.setTransform(1, 0, 0, 1, 0, 0);
      output.globalAlpha = 1;
      output.globalCompositeOperation = "copy";
      output.imageSmoothingEnabled = false;
      output.drawImage(this.canvas, 0, height * ratio - offset, renderer.canvas.width,
        renderer.canvas.height, 0, 0, renderer.canvas.width, renderer.canvas.height);
    } finally { output.restore(); }
    // Font rasterization at a canvas clip edge can differ from rasterization
    // into a taller backing. Paint the final visible row at the actual canvas
    // boundary; its decoded cells are retained, so this needs no native read.
    if (this.bottomCells) {
      output.save();
      try {
        output.beginPath();
        output.rect(0, (rows - 1) * height + offset / ratio, cols * width, height);
        output.clip();
        output.translate(0, offset / ratio);
        renderer.renderLine(this.bottomCells, rows - 1, cols);
      } finally { output.restore(); }
    }
    if (opacity > 0) renderer.renderScrollbar(viewportY, history, rows, opacity);
  }
}

export function installTerminalScrollRenderer(Renderer, { createCanvas = renderer =>
  renderer.canvas.ownerDocument.createElement("canvas") } = {}) {
  const proto = Renderer.prototype;
  if (proto[patch]) return;
  const render = proto.render;
  proto.clearTesseraScrollCache = function() {
    this.tesseraScrollCache?.clear();
    this.tesseraScrollCache = null;
  };
  proto.render = function(buffer, force, viewportY = 0, provider, opacity) {
    const whole = Math.floor(viewportY), fraction = viewportY - whole;
    const previousFraction = this.tesseraScrollFraction || 0;
    this.tesseraScrollFraction = fraction;
    const metrics = this.getMetrics(), ratio = this.devicePixelRatio || 1;
    const { width, height } = metrics;
    const images = provider?.sixelRenderer;
    const eligible = !this.tesseraScrollCacheDisabled && fraction > 0 && viewportY > 0 && provider && this.canvas?.ownerDocument
      && typeof buffer.isDirty === "function" && typeof this.ctx.setTransform === "function"
      && !this.ctx.isContextLost?.() && !buffer.isAlternateScreen?.()
      && !this.selectionManager?.hasSelection() && !this.currentSelectionCoords
      && !this.hoveredHyperlinkId && !this.hoveredLinkRange
      && !provider.searchNeedle && !this.tesseraSearchRows?.size
      && !buffer.exports?.tessera_sixel_image_count?.(buffer.handle)
      && !images?.hadVisibleTiles && !images?.needsFullRender
      && Number.isInteger(width * ratio) && Number.isInteger(height * ratio)
      && this.canvas.width === buffer.getDimensions().cols * width * ratio
      && this.canvas.height === buffer.getDimensions().rows * height * ratio
      && this.canvas.width * (this.canvas.height + height * ratio) * 4 <= maximumScrollCacheBytes;
    if (eligible) {
      if (this.tesseraScrollCache?.context.isContextLost?.()) this.clearTesseraScrollCache();
      if (!this.tesseraScrollCache) {
        // Allocation failure must not disable scrolling on a constrained device.
        try {
          const canvas = createCanvas(this), attributes = this.ctx.getContextAttributes?.();
          const context = canvas?.getContext("2d", { alpha: true,
            colorSpace: attributes?.colorSpace || "srgb", willReadFrequently: attributes?.willReadFrequently || false });
          if (context) this.tesseraScrollCache = new TerminalScrollCache(canvas, context);
        } catch { /* use the ordinary renderer below */ }
      }
      if (this.tesseraScrollCache) {
        try {
          this.tesseraScrollCache.render(this, render, buffer, force, whole,
            Math.round(fraction * height * ratio), viewportY, provider, opacity, metrics);
          return;
        } catch (error) {
          this.clearTesseraScrollCache();
          throw error;
        }
      }
    }
    // A cache hit bypassed native dirty-row painting. On leaving it, repaint
    // once even if the integral viewport and the native dirty flags are clean.
    force ||= Boolean(this.tesseraScrollCache);
    this.clearTesseraScrollCache();
    if (!fraction || !provider) {
      return render.call(this, buffer, force || previousFraction > 0, viewportY, provider, opacity);
    }
    const ctx = this.ctx;
    const offset = Math.round(fraction * height * ratio) / ratio;
    const scrollbar = this.renderScrollbar, cursorVisible = this.cursorVisible;
    const ownScrollbar = Object.hasOwn(this, "renderScrollbar");
    this.renderScrollbar = () => {};
    this.cursorVisible = false;
    ctx.save();
    try {
      ctx.translate(0, offset);
      render.call(this, buffer, true, whole, provider, opacity);
      // The integer renderer has no row above its viewport. Paint that partial
      // row too, otherwise scrolling reveals a stale strip at the upper edge.
      const cells = provider.getScrollbackLine(provider.getScrollbackLength() - whole - 1);
      if (cells) this.renderLine(cells, -1, buffer.getDimensions().cols);
      const images = provider.sixelRenderer;
      if (images && buffer.exports?.tessera_sixel_image_count?.(buffer.handle)) {
        ctx.save();
        try {
          ctx.beginPath(); ctx.rect(0, -height, width * buffer.getDimensions().cols, height); ctx.clip();
          ctx.translate(0, -height);
          const selection = this.currentSelectionCoords;
          if (selection) this.currentSelectionCoords = {
            ...selection, startRow: selection.startRow + 1, endRow: selection.endRow + 1,
          };
          try { images.render(this, buffer, whole + 1); }
          finally { this.currentSelectionCoords = selection; }
        } finally { ctx.restore(); }
      }
    } finally {
      ctx.restore();
      this.cursorVisible = cursorVisible;
      if (ownScrollbar) this.renderScrollbar = scrollbar;
      else delete this.renderScrollbar;
    }
    // Chrome stays in viewport coordinates while text, selection, and images move.
    if (opacity > 0) scrollbar.call(this, viewportY, provider.getScrollbackLength(), buffer.getDimensions().rows, opacity);
  };
  proto[patch] = true;
}
