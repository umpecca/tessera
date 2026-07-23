export class TerminalRenderScheduler {
  constructor(options = {}) {
    this.requestFrame = options.requestFrame
      || ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame
      || ((frameID) => globalThis.cancelAnimationFrame(frameID));
    this.entries = new Map();
    this.pending = new Set();
    this.frameID = null;
    this.enabled = true;
  }

  register(terminal, render) {
    this.entries.set(terminal, {
      continuous: false,
      paused: false,
      render,
    });
    this.request(terminal);
  }

  unregister(terminal) {
    this.entries.delete(terminal);
    this.pending.delete(terminal);
    this.cancelFrameIfIdle();
  }

  request(terminal) {
    const entry = this.entries.get(terminal);
    if (!entry || entry.paused) {
      return;
    }
    this.pending.add(terminal);
    this.scheduleFrame();
  }

  setContinuous(terminal, continuous) {
    const entry = this.entries.get(terminal);
    if (!entry) {
      return;
    }
    entry.continuous = Boolean(continuous);
    if (entry.continuous && !entry.paused) {
      this.scheduleFrame();
    } else {
      this.cancelFrameIfIdle();
    }
  }

  setPaused(terminal, paused) {
    const entry = this.entries.get(terminal);
    if (!entry) {
      return;
    }
    const next = Boolean(paused);
    if (entry.paused === next) {
      return;
    }
    entry.paused = next;
    this.pending.delete(terminal);
    if (next) {
      this.cancelFrameIfIdle();
    } else {
      this.request(terminal);
    }
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) {
      return;
    }
    this.enabled = next;
    if (!next) {
      if (this.frameID !== null) {
        this.cancelFrame(this.frameID);
        this.frameID = null;
      }
      return;
    }
    for (const [terminal, entry] of this.entries) {
      if (!entry.paused) {
        this.pending.add(terminal);
      }
    }
    this.scheduleFrame();
  }

  scheduleFrame() {
    if (!this.enabled || this.frameID !== null || !this.hasWork()) {
      return;
    }
    this.frameID = this.requestFrame(() => this.renderFrame());
  }

  renderFrame() {
    this.frameID = null;
    if (!this.enabled) {
      return;
    }

    const requested = this.pending;
    this.pending = new Set();
    for (const [terminal, entry] of this.entries) {
      if (entry.paused || (!entry.continuous && !requested.has(terminal))) {
        continue;
      }
      entry.render();
    }
    this.scheduleFrame();
  }

  hasWork() {
    if (this.pending.size > 0) {
      return true;
    }
    for (const entry of this.entries.values()) {
      if (entry.continuous && !entry.paused) {
        return true;
      }
    }
    return false;
  }

  cancelFrameIfIdle() {
    if (this.frameID === null || this.hasWork()) {
      return;
    }
    this.cancelFrame(this.frameID);
    this.frameID = null;
  }
}
