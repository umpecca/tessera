// While output keeps arriving, a paint waits for this much silence so a frame
// split across many writes is drawn once, but never longer than the hold cap.
export const outputQuietMilliseconds = 3;
export const outputHoldMilliseconds = 16;

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
    this.now = options.now || (() => performance.now());
  }

  register(terminal, render) {
    this.entries.set(terminal, {
      continuous: false,
      paused: false,
      render,
      nextPaint: null,
      lastOutputAt: 0,
      holdStartedAt: null,
      metricsEnabled: false,
      frames: 0,
      totalMs: 0,
      maxMs: 0,
      recentPaints: [],
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

  noteOutput(terminal) {
    const entry = this.entries.get(terminal);
    if (entry && terminal.paintCoalescing) {
      entry.lastOutputAt = this.now();
      entry.holdStartedAt ??= entry.lastOutputAt;
    }
    this.request(terminal);
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
    entry.nextPaint = null;
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
      entry.nextPaint = null;
      if (!entry.paused) {
        this.pending.add(terminal);
      }
    }
    this.scheduleFrame();
  }

  setMetricsEnabled(terminal, enabled) {
    const entry = this.entries.get(terminal);
    if (!entry) return;
    const next = Boolean(enabled);
    if (entry.metricsEnabled === next) return;
    entry.metricsEnabled = next;
    if (next) {
      entry.frames = 0;
      entry.totalMs = 0;
      entry.maxMs = 0;
      entry.recentPaints = [];
    }
  }

  scheduleFrame() {
    if (!this.enabled || this.frameID !== null || !this.hasWork()) {
      return;
    }
    this.frameID = this.requestFrame(timestamp => this.renderFrame(timestamp));
  }

  renderFrame(timestamp = this.now()) {
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
      if (entry.holdStartedAt !== null) {
        const now = this.now();
        const typing = now < (terminal.interactivePaintUntil || 0);
        if (terminal.paintCoalescing && !typing
          && now - entry.lastOutputAt < outputQuietMilliseconds
          && now - entry.holdStartedAt < outputHoldMilliseconds) {
          this.pending.add(terminal);
          continue;
        }
        entry.holdStartedAt = null;
      }
      const cap = terminal.paintFPSLimit || 0;
      const interval = cap > 0 ? 1000 / cap : 0;
      const startedAt = interval || entry.metricsEnabled ? this.now() : 0;
      const interactive = interval > 0 && startedAt < (terminal.interactivePaintUntil || 0);
      // RAF timestamps share one clock across every terminal in the frame.
      // Keep the deadline anchored instead of accumulating callback delays.
      // A 1 ms allowance absorbs rounding at 30/60/120 Hz boundaries.
      if (interval && !interactive && entry.nextPaint !== null
        && timestamp + 1 < entry.nextPaint) {
        this.pending.add(terminal);
        continue;
      }
      if (!interval) entry.nextPaint = null;
      else if (interactive || entry.nextPaint === null || timestamp - entry.nextPaint >= interval) {
        // Rebase after idle periods; never replay a backlog of missed frames.
        entry.nextPaint = timestamp + interval;
      } else {
        entry.nextPaint += interval;
      }
      entry.render();
      if (!entry.metricsEnabled) continue;
      const measuredAt = this.now();
      const duration = Math.max(0, measuredAt - startedAt);
      entry.frames++;
      entry.totalMs += duration;
      entry.maxMs = Math.max(entry.maxMs, duration);
      entry.recentPaints.push({ time: measuredAt, duration });
      while (entry.recentPaints.length > 4096
        || entry.recentPaints[0]?.time <= measuredAt - 5000) {
        entry.recentPaints.shift();
      }
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

  statistics(terminal) {
    const entry = this.entries.get(terminal);
    const recent = entry?.recentPaints.filter(paint => paint.time > this.now() - 5000) || [];
    const recentTotal = recent.reduce((sum, paint) => sum + paint.duration, 0);
    const recentStats = {
      fps: recent.length / 5,
      averageMs: recent.length ? recentTotal / recent.length : 0,
      maxMs: recent.reduce((peak, paint) => Math.max(peak, paint.duration), 0),
      paintMsPerSecond: recentTotal / 5,
    };
    return entry ? {
      frames: entry.frames,
      averageMs: entry.frames ? entry.totalMs / entry.frames : 0,
      maxMs: entry.maxMs,
      totalMs: entry.totalMs,
      recent: recentStats,
    } : { frames: 0, averageMs: 0, maxMs: 0, totalMs: 0, recent: recentStats };
  }

  cancelFrameIfIdle() {
    if (this.frameID === null || this.hasWork()) {
      return;
    }
    this.cancelFrame(this.frameID);
    this.frameID = null;
  }
}
