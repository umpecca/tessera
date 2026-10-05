// A small whole-window spring, not a mesh compositor. Individual rotate/scale
// properties leave the pane's translate, dimensions and persisted box intact.
export class WindowWobble {
  constructor({ enabled, requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id) }) {
    this.enabled = enabled;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.frame = null;
    this.state = null;
  }

  start(element, x, y, originX, originY) {
    this.stop();
    if (!this.enabled()) return;
    this.state = { element, lastX: x, lastY: y, x: 0, y: 0, vx: 0, vy: 0, time: null, dragging: true };
    element.style.transformOrigin = `${originX}px ${originY}px`;
  }

  move(x, y) {
    const state = this.state;
    if (!state || !state.dragging) return;
    if (!this.enabled()) { this.stop(); return; }
    const dx = x - state.lastX;
    const dy = y - state.lastY;
    state.lastX = x;
    state.lastY = y;
    // Bound both each impulse and their sum, even with many pointer events
    // between animation frames. Faster drags flex more but never grow unbounded.
    state.vx = Math.max(-180, Math.min(180, state.vx - Math.max(-60, Math.min(60, dx)) * 3));
    state.vy = Math.max(-180, Math.min(180, state.vy - Math.max(-60, Math.min(60, dy)) * 3));
    if (dx || dy) this.schedule();
  }

  release() {
    if (!this.state) return;
    this.state.dragging = false;
    if (this.frame === null) this.stop();
  }

  schedule() {
    if (this.frame !== null) return;
    this.frame = this.requestFrame(time => this.tick(time));
  }

  tick(time) {
    this.frame = null;
    const state = this.state;
    if (!state) return;
    if (!this.enabled() || !state.element.isConnected) { this.stop(); return; }
    // Substep the damped spring for consistent behavior at 30/60/120 Hz;
    // cap elapsed time after stalls so background wakeups cannot explode it.
    const elapsed = state.time === null ? 1 / 60 : Math.max(0, Math.min(.05, (time - state.time) / 1000));
    state.time = time;
    const steps = Math.max(1, Math.ceil(elapsed / (1 / 120)));
    const dt = elapsed / steps;
    for (let i = 0; i < steps; i++) {
      state.vx += (-170 * state.x - 15 * state.vx) * dt;
      state.vy += (-170 * state.y - 15 * state.vy) * dt;
      state.x = Math.max(-16, Math.min(16, state.x + state.vx * dt));
      state.y = Math.max(-16, Math.min(16, state.y + state.vy * dt));
    }
    state.element.style.rotate = `${(state.x * .07).toFixed(3)}deg`;
    state.element.style.scale = `${(1 + Math.abs(state.y) * .0006).toFixed(4)} ${(1 + Math.abs(state.x) * .0006).toFixed(4)}`;
    if (Math.abs(state.x) + Math.abs(state.y) < .02 && Math.abs(state.vx) + Math.abs(state.vy) < .1) {
      state.element.style.removeProperty("rotate");
      state.element.style.removeProperty("scale");
      state.x = state.y = state.vx = state.vy = 0;
      state.time = null;
      if (!state.dragging) this.stop();
      return;
    }
    this.schedule();
  }

  stop(element) {
    if (element && this.state?.element !== element) return;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    if (this.state) {
      for (const property of ["rotate", "scale", "transform-origin"]) this.state.element.style.removeProperty(property);
    }
    this.state = null;
  }
}
