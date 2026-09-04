const headerBytes = 21;
const maximumSnapshotBytes = 192 * 1024 * 1024;

// Resume cursors represent fully applied events. Pending socket data can be
// discarded on disconnect without rolling back partially applied events.
export class TerminalReplica {
  constructor(term, scheduler, core, clipboard = () => {}, onError = (error) => { throw error; }) {
    this.term = term;
    this.scheduler = scheduler;
    this.core = core;
    this.clipboard = clipboard;
    this.onError = onError;
    this.cursor = { epoch: "", sequence: 0, offset: 0 };
    this.queuedSequence = 0;
    this.pending = null;
  }

  enqueue(task) {
    this.scheduler.enqueueTask(() => {
      try { task(); }
      catch (error) { this.disconnect(); this.onError(error); }
    });
  }

  disconnect() {
    this.scheduler.reset();
    this.pending = null;
    this.queuedSequence = this.cursor.sequence;
  }

  attach(message) {
    this.disconnect();
    if (message.protocol !== 2 || message.core !== this.core) throw new Error("Terminal core changed; reload Tessera");
    for (const key of ["sequence", "offset", "snapshotBytes"]) {
      if (!Number.isSafeInteger(message[key]) || message[key] < 0) throw new Error("Invalid terminal attachment");
    }
    if (message.snapshotBytes > maximumSnapshotBytes) throw new Error("Terminal snapshot exceeds storage limit");
    if (message.reset) {
      if (!message.snapshotBytes) throw new Error("Terminal snapshot is missing");
      this.pending = { message, data: new Uint8Array(message.snapshotBytes), offset: 0 };
    } else if (message.epoch !== this.cursor.epoch || message.sequence !== this.cursor.sequence || message.offset !== this.cursor.offset) {
      throw new Error("Terminal resume cursor does not match applied state");
    }
    this.queuedSequence = message.sequence;
  }

  receive(data) {
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
          });
        }
        continue;
      }
      if (this.pending || sequence !== this.queuedSequence + 1) throw new Error("Terminal event sequence has a gap");
      this.queuedSequence = sequence;
      if (![1, 2, 3, 5, 6, 7].includes(kind) || (kind === 2 && length !== 16) || (kind === 5 && (length !== 1 || payload[0] > 1)) || (kind === 7 && length !== 0)) throw new Error("Unknown terminal event");
      if (kind === 6 && (length !== 5 || ![16, 32, 64].includes(new DataView(payload.buffer, payload.byteOffset, length).getUint32(0, true)) || payload[4] > 1)) throw new Error("Invalid image settings event");
      this.enqueue(() => {
        if (kind === 1) this.term.write(payload);
        if (kind === 2) {
          const geometry = new DataView(payload.buffer, payload.byteOffset, payload.length);
          this.term.applyGeometry(...[0, 4, 8, 12].map((index) => geometry.getUint32(index, true)));
        }
        if (kind === 3 && payload.length) this.clipboard(new TextDecoder().decode(payload));
        if (kind === 5) this.term.applyConfiguration(payload[0] === 1);
        if (kind === 6) this.term.applyImageSettings(new DataView(payload.buffer, payload.byteOffset, length).getUint32(0, true), payload[4] === 1);
        if (kind === 7) this.term.clearImages();
        this.cursor = { ...this.cursor, sequence, offset: streamOffset };
      });
    }
  }
}
