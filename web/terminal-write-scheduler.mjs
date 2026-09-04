const defaultMaximumChunkBytes = 16 * 1024;
const defaultMaximumBytesPerTurn = 64 * 1024;
const defaultTimeBudgetMilliseconds = 5;

// Ghostty parses writes synchronously in WASM. Feeding every WebSocket message
// to it immediately can keep the browser main thread busy indefinitely during
// a verbose build, so each terminal drains an ordered queue in bounded tasks.
export class TerminalWriteScheduler {
  constructor(write, options = {}) {
    this.write = write;
    this.schedule = options.schedule
      || ((callback) => globalThis.setTimeout(callback, 0));
    this.cancelSchedule = options.cancelSchedule
      || ((scheduleID) => globalThis.clearTimeout(scheduleID));
    this.now = options.now || (() => globalThis.performance.now());
    this.maximumChunkBytes = options.maximumChunkBytes ?? defaultMaximumChunkBytes;
    this.maximumBytesPerTurn = options.maximumBytesPerTurn ?? defaultMaximumBytesPerTurn;
    this.timeBudgetMilliseconds = options.timeBudgetMilliseconds ?? defaultTimeBudgetMilliseconds;
    this.chunks = [];
    this.head = 0;
    this.scheduleID = null;
    this.disposed = false;
  }

  enqueue(data) {
    if (this.disposed || !data || data.length === 0) {
      return;
    }
    for (let offset = 0; offset < data.length; offset += this.maximumChunkBytes) {
      this.chunks.push(data.subarray(offset, offset + this.maximumChunkBytes));
    }
    this.scheduleDrain();
  }

  enqueueTask(task) {
    if (this.disposed) return;
    this.chunks.push(task);
    this.scheduleDrain();
  }

  scheduleDrain() {
    if (this.disposed || this.scheduleID !== null || this.head >= this.chunks.length) {
      return;
    }
    this.scheduleID = this.schedule(() => this.drain());
  }

  drain() {
    this.scheduleID = null;
    if (this.disposed) {
      return;
    }

    const startedAt = this.now();
    let writtenBytes = 0;
    while (this.head < this.chunks.length) {
      const chunk = this.chunks[this.head];
      this.head += 1;
      if (typeof chunk === "function") {
        chunk();
      } else {
        this.write(chunk);
        writtenBytes += chunk.length;
      }
      if (
        writtenBytes >= this.maximumBytesPerTurn
        || this.now() - startedAt >= this.timeBudgetMilliseconds
      ) {
        break;
      }
    }

    if (this.head >= this.chunks.length) {
      this.chunks = [];
      this.head = 0;
    } else if (this.head >= 1024) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    this.scheduleDrain();
  }

  reset() {
    if (this.scheduleID !== null) {
      this.cancelSchedule(this.scheduleID);
      this.scheduleID = null;
    }
    this.chunks = [];
    this.head = 0;
  }

  dispose() {
    this.reset();
    this.disposed = true;
    this.write = null;
  }
}
