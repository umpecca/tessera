const headerBytes = 21;
const maximumSnapshotBytes = 192 * 1024 * 1024;
export const defaultRetainedOutputBytes = 4 * 1024 * 1024;

export function normalizeTerminalBacklogLimit(value) {
  const option = String(value);
  return ["8", "16", "32"].includes(option) ? option : "auto";
}

// Resume cursors represent fully applied events. Pending socket data can be
// discarded on disconnect without rolling back partially applied events.
export class TerminalReplica {
  constructor(term, scheduler, core, clipboard = () => {}, onError = (error) => { throw error; }, options = {}) {
    this.term = term;
    this.scheduler = scheduler;
    this.core = core;
    this.clipboard = clipboard;
    this.onError = onError;
    this.cursor = { epoch: "", sequence: 0, offset: 0 };
    this.queuedSequence = 0;
    this.pending = null;
    this.timing = null;
    this.queuedOutputBytes = 0;
    this.retainedOutputBytes = defaultRetainedOutputBytes;
    this.backlogLimit = normalizeTerminalBacklogLimit(options.backlogLimit);
    this.accepting = false;
    this.needsSnapshot = false;
    this.onBacklogExceeded = options.onBacklogExceeded
      || (() => this.onError(new Error("Terminal output backlog exceeded")));
  }

  get maximumBacklogBytes() {
    return this.backlogLimit === "auto" ? this.retainedOutputBytes : Number(this.backlogLimit) * 1024 * 1024;
  }

  setBacklogLimit(value) {
    this.backlogLimit = normalizeTerminalBacklogLimit(value);
    if (this.queuedOutputBytes > this.maximumBacklogBytes) this.recoverBacklog();
  }

  recoverBacklog() {
    if (!this.accepting) return;
    // Drop only unapplied events. Keep the cursor intact until the fresh
    // snapshot is imported; replaying from it could exceed a reduced limit.
    this.disconnect();
    this.needsSnapshot = true;
    this.onBacklogExceeded();
  }

  enqueue(task, outputBytes = 0) {
    this.queuedOutputBytes += outputBytes;
    this.scheduler.enqueueTask(() => {
      try { task(); this.queuedOutputBytes -= outputBytes; }
      catch (error) { this.disconnect(); this.onError(error); }
    }, outputBytes);
  }

  disconnect() {
    this.scheduler.reset();
    this.pending = null;
    this.queuedSequence = this.cursor.sequence;
    this.queuedOutputBytes = 0;
    this.accepting = false;
  }

  attach(message) {
    this.disconnect();
    if (message.protocol !== 2 || message.core !== this.core) throw new Error("Terminal core changed; reload Tessera");
    for (const key of ["sequence", "offset", "snapshotBytes"]) {
      if (!Number.isSafeInteger(message[key]) || message[key] < 0) throw new Error("Invalid terminal attachment");
    }
    if (message.snapshotBytes > maximumSnapshotBytes) throw new Error("Terminal snapshot exceeds storage limit");
    this.retainedOutputBytes = Number.isSafeInteger(message.retainedOutputBytes) && message.retainedOutputBytes > 0
      ? message.retainedOutputBytes : defaultRetainedOutputBytes;
    if (message.reset) {
      if (!message.snapshotBytes) throw new Error("Terminal snapshot is missing");
      // Once a host chooses a snapshot, retries must keep requesting it until
      // the queued import completes, even if all chunks were already received.
      this.needsSnapshot = true;
      this.pending = { message, data: new Uint8Array(message.snapshotBytes), offset: 0 };
    } else if (message.epoch !== this.cursor.epoch || message.sequence !== this.cursor.sequence || message.offset !== this.cursor.offset) {
      throw new Error("Terminal resume cursor does not match applied state");
    }
    this.queuedSequence = message.sequence;
    this.accepting = true;
  }

  receive(data) {
    // Closing sockets can still deliver queued messages. Only a new
    // attachment may admit output after disconnect or backlog recovery.
    if (!this.accepting) return;
    let offset = 0;
    while (offset < data.length) {
      if (data.length - offset < headerBytes) throw new Error("Incomplete terminal event header");
      const view = new DataView(data.buffer, data.byteOffset + offset, headerBytes);
      const kind = view.getUint8(0);
      const sequence = Number(view.getBigUint64(1, true));
      const streamOffset = Number(view.getBigUint64(9, true));
      const length = view.getUint32(17, true);
      offset += headerBytes;
      if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(streamOffset) || length > data.length - offset) throw new Error("Invalid terminal event");
      const payload = data.subarray(offset, offset + length);
      offset += length;
      if (kind === 4) {
        const pending = this.pending;
        if (!pending || sequence !== pending.message.sequence || streamOffset !== pending.message.offset || length > pending.data.length - pending.offset) throw new Error("Invalid terminal snapshot frame");
        pending.data.set(payload, pending.offset);
        pending.offset += length;
        if (pending.offset === pending.data.length) {
          this.pending = null;
          this.enqueue(() => {
            this.term.restoreSnapshot(pending.data, pending.message);
            this.cursor = { epoch: pending.message.epoch, sequence, offset: streamOffset };
            this.needsSnapshot = false;
          });
        }
        continue;
      }
      if (this.pending || sequence !== this.queuedSequence + 1) throw new Error("Terminal event sequence has a gap");
      if (![1, 2, 3, 5, 6, 7].includes(kind) || (kind === 2 && length !== 16) || (kind === 5 && (length !== 1 || payload[0] > 1)) || (kind === 7 && length !== 0)) throw new Error("Unknown terminal event");
      if (kind === 6 && (length !== 5 || ![16, 32, 64].includes(new DataView(payload.buffer, payload.byteOffset, length).getUint32(0, true)) || payload[4] > 1)) throw new Error("Invalid image settings event");
      if (kind === 1 && this.queuedOutputBytes + length > this.maximumBacklogBytes) {
        this.recoverBacklog();
        return;
      }
      this.queuedSequence = sequence;
      if (kind === 1) this.timing?.received(sequence, payload);
      this.enqueue(() => {
        if (kind === 1) {
          this.term.write(payload);
          this.timing?.applied(sequence);
        }
        if (kind === 2) {
          const geometry = new DataView(payload.buffer, payload.byteOffset, payload.length);
          this.term.applyGeometry(...[0, 4, 8, 12].map((index) => geometry.getUint32(index, true)));
        }
        if (kind === 3 && payload.length) this.clipboard(new TextDecoder().decode(payload));
        if (kind === 5) this.term.applyConfiguration(payload[0] === 1);
        if (kind === 6) this.term.applyImageSettings(new DataView(payload.buffer, payload.byteOffset, length).getUint32(0, true), payload[4] === 1);
        if (kind === 7) this.term.clearImages();
        this.cursor = { ...this.cursor, sequence, offset: streamOffset };
      }, kind === 1 ? length : 0);
    }
  }
}
