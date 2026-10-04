const defaultMaximumChunkBytes = 16 * 1024;
const defaultMaximumBytesPerTurn = 64 * 1024;
const defaultTimeBudgetMilliseconds = 5;
const activeEventsPerVisit = 3;

// All browser replicas share one turn. The active pane gets extra complete
// events per visit, while other ready panes keep their place in the rotation.
export class TerminalWriteCoordinator {
  constructor(options = {}) {
    this.schedule = options.schedule || ((callback) => globalThis.setTimeout(callback, 0));
    this.cancelSchedule = options.cancelSchedule
      || ((scheduleID) => globalThis.clearTimeout(scheduleID));
    this.now = options.now || (() => globalThis.performance.now());
    this.maximumBytesPerTurn = options.maximumBytesPerTurn ?? defaultMaximumBytesPerTurn;
    this.timeBudgetMilliseconds = options.timeBudgetMilliseconds ?? defaultTimeBudgetMilliseconds;
    this.pending = new Set();
    this.activeScheduler = null;
    this.activeCanPreempt = true;
    this.currentScheduler = null;
    this.remainingEvents = 0;
    this.scheduleID = null;
    this.draining = false;
    this.channel = null;
    this.nextScheduleID = 0;
    if (!options.schedule && typeof globalThis.MessageChannel === "function") {
      // A posted task yields to the browser without the nested-timer delay
      // imposed on a long chain of setTimeout(..., 0) parsing turns.
      this.channel = new globalThis.MessageChannel();
      this.channel.port1.onmessage = event => {
        if (event.data === this.scheduleID) this.drain();
      };
      // Node exposes ref/unref; browser ports do not. Idle test imports must
      // not keep the process alive, while a queued drain must finish normally.
      this.channel.port1.unref?.();
      this.channel.port2.unref?.();
    }
  }

  request(scheduler) {
    if (scheduler === this.activeScheduler && this.activeCanPreempt && scheduler !== this.currentScheduler
      && !this.pending.has(scheduler)) {
      this.pending = new Set([scheduler, ...this.pending]);
    } else {
      this.pending.add(scheduler);
    }
    this.scheduleDrain();
  }

  setActive(scheduler, active) {
    if (active ? this.activeScheduler === scheduler : this.activeScheduler !== scheduler) return;
    this.activeScheduler = active ? scheduler : null;
    this.activeCanPreempt = true;
    this.currentScheduler = null;
    this.remainingEvents = 0;
    if (active && this.pending.delete(scheduler)) {
      this.pending = new Set([scheduler, ...this.pending]);
    }
  }

  remove(scheduler) {
    this.pending.delete(scheduler);
    if (this.currentScheduler === scheduler) {
      this.currentScheduler = null;
      this.remainingEvents = 0;
    }
    if (!this.pending.size && this.scheduleID !== null) {
      if (this.channel) this.channel.port1.unref?.();
      else this.cancelSchedule(this.scheduleID);
      this.scheduleID = null;
    }
  }

  scheduleDrain() {
    if (this.draining || this.scheduleID !== null || !this.pending.size) return;
    if (this.channel) {
      this.scheduleID = ++this.nextScheduleID;
      this.channel.port1.ref?.();
      this.channel.port2.postMessage(this.scheduleID);
    } else {
      this.scheduleID = this.schedule(() => this.drain());
    }
  }

  drain() {
    this.scheduleID = null;
    this.draining = true;
    const startedAt = this.now();
    let writtenBytes = 0;
    try {
      while (this.pending.size) {
        if (!this.currentScheduler) {
          this.currentScheduler = this.pending.values().next().value;
          this.remainingEvents = this.currentScheduler === this.activeScheduler ? activeEventsPerVisit : 1;
        }
        const scheduler = this.currentScheduler;
        // Carry the remaining visit across yields. Expensive active events must
        // not earn a fresh quota on every posted turn and starve other panes.
        this.remainingEvents--;
        // Fresh active output may jump ahead once, then a background pane must
        // progress before another promotion. A trickle must not starve builds.
        this.activeCanPreempt = scheduler !== this.activeScheduler;
        this.pending.delete(scheduler);
        // An event is indivisible: its applied cursor advances only after it
        // completes. Check both budgets between events, including control tasks.
        try { writtenBytes += scheduler.drainOne(); }
        finally {
          if (!scheduler.disposed && scheduler.head < scheduler.chunks.length) {
            this.pending.add(scheduler);
          }
          if (this.currentScheduler === scheduler
            && (!this.pending.has(scheduler) || this.remainingEvents === 0)) {
            this.currentScheduler = null;
            this.remainingEvents = 0;
          }
        }
        if (writtenBytes >= this.maximumBytesPerTurn
          || this.now() - startedAt >= this.timeBudgetMilliseconds) break;
      }
    } finally {
      this.draining = false;
      this.scheduleDrain();
      if (!this.pending.size) {
        this.activeCanPreempt = true;
        this.channel?.port1.unref?.();
      }
    }
  }
}

const sharedWriteCoordinator = new TerminalWriteCoordinator();

// Each pane owns its FIFO and can discard it on reconnect, pause, or disposal
// without canceling another terminal's work in the shared coordinator.
export class TerminalWriteScheduler {
  constructor(write, options = {}) {
    this.write = write;
    this.coordinator = options.coordinator || sharedWriteCoordinator;
    this.maximumChunkBytes = options.maximumChunkBytes ?? defaultMaximumChunkBytes;
    this.chunks = [];
    this.head = 0;
    this.disposed = false;
  }

  enqueue(data) {
    if (this.disposed || !data || data.length === 0) return;
    for (let offset = 0; offset < data.length; offset += this.maximumChunkBytes) {
      const chunk = data.subarray(offset, offset + this.maximumChunkBytes);
      this.chunks.push({ work: chunk, bytes: chunk.length });
    }
    this.coordinator.request(this);
  }

  enqueueTask(task, outputBytes = 0) {
    if (this.disposed) return;
    this.chunks.push({ work: task, bytes: outputBytes });
    this.coordinator.request(this);
  }

  drainOne() {
    const chunk = this.chunks[this.head];
    this.chunks[this.head++] = null;
    try {
      if (typeof chunk.work === "function") chunk.work();
      else this.write(chunk.work);
      return chunk.bytes;
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      if (this.head >= this.chunks.length) {
        this.chunks = [];
        this.head = 0;
      } else if (this.head >= 1024) {
        this.chunks = this.chunks.slice(this.head);
        this.head = 0;
      }
    }
  }

  reset() {
    this.coordinator.remove(this);
    this.chunks = [];
    this.head = 0;
  }

  setActive(active) {
    if (!this.disposed) this.coordinator.setActive(this, active);
  }

  dispose() {
    this.setActive(false);
    this.reset();
    this.disposed = true;
    this.write = null;
  }
}
