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

export function installTerminalScrollRenderer(Renderer) {
  const proto = Renderer.prototype;
  if (proto[patch]) return;
  const render = proto.render;
  proto.render = function(buffer, force, viewportY = 0, provider, opacity) {
    const whole = Math.floor(viewportY), fraction = viewportY - whole;
    const previousFraction = this.tesseraScrollFraction || 0;
    this.tesseraScrollFraction = fraction;
    if (!fraction || !provider) {
      return render.call(this, buffer, force || previousFraction > 0, viewportY, provider, opacity);
    }
    const ctx = this.ctx, { width, height } = this.getMetrics();
    const ratio = this.devicePixelRatio || 1;
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
