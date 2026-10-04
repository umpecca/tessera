import assert from "node:assert/strict";
import test from "node:test";
import { defaultRetainedOutputBytes, normalizeTerminalBacklogLimit, TerminalReplica } from "./terminal-replica.mjs";
import { TerminalWriteCoordinator, TerminalWriteScheduler } from "./terminal-write-scheduler.mjs";

function frame(kind, sequence, offset, data = new Uint8Array()) {
  const result = new Uint8Array(21 + data.length), view = new DataView(result.buffer);
  view.setUint8(0, kind); view.setBigUint64(1, BigInt(sequence), true);
  view.setBigUint64(9, BigInt(offset), true); view.setUint32(17, data.length, true);
  result.set(data, 21); return result;
}
function fixture(options = {}, coordinator = null) {
  let queue = [], calls = [], errors = [];
  const term = Object.fromEntries(["write", "restoreSnapshot", "applyGeometry", "applyConfiguration", "applyImageSettings", "clearImages"].map(name => [name, (...args) => calls.push([name, ...args])]));
  const scheduler = coordinator ? new TerminalWriteScheduler(() => {}, { coordinator })
    : { enqueueTask(task) { queue.push(task); }, reset() { queue = []; } };
  const replica = new TerminalReplica(term, scheduler, "core", text => calls.push(["clipboard", text]), error => errors.push(error), options);
  return { replica, term, calls, errors, drainOne() { queue.shift()?.(); }, drain() { while (queue.length) queue.shift()(); } };
}
const attach = { protocol: 2, core: "core", epoch: "shell", sequence: 3, offset: 12, snapshotBytes: 4, reset: true, cols: 80, rows: 24 };

function sharedScheduler(options = {}) {
  let scheduled = null;
  const coordinator = new TerminalWriteCoordinator({
    schedule(callback) { scheduled = callback; return 1; }, cancelSchedule() { scheduled = null; }, now: () => 0, ...options,
  });
  return { coordinator, runOne() { const next = scheduled; scheduled = null; next?.(); },
    drain() { while (scheduled) this.runOne(); }, get pending() { return Boolean(scheduled); } };
}

test("active replica priority preserves byte accounting and fully applied cursors", () => {
  const shared = sharedScheduler({ maximumBytesPerTurn: 4 });
  const a = fixture({}, shared.coordinator), b = fixture({}, shared.coordinator);
  for (const f of [a, b]) { f.replica.attach(attach); f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); }
  shared.drain();
  a.replica.scheduler.setActive(true);
  for (let i = 1; i <= 6; i++) {
    for (const f of [b, a]) f.replica.receive(frame(1, i + 3, 12 + i, new Uint8Array([i])));
  }
  shared.runOne();
  assert.equal(a.replica.cursor.sequence, 6);
  assert.equal(a.replica.cursor.offset, 15);
  assert.equal(a.replica.queuedOutputBytes, 3);
  assert.equal(b.replica.cursor.sequence, 4);
  assert.equal(b.replica.queuedOutputBytes, 5);
  shared.drain();
  for (const f of [a, b]) {
    assert.deepEqual(f.calls.filter(call => call[0] === "write").map(call => call[1][0]), [1, 2, 3, 4, 5, 6]);
    assert.equal(f.replica.cursor.sequence, 9);
    assert.equal(f.replica.cursor.offset, 18);
    assert.equal(f.replica.queuedOutputBytes, 0);
    assert.deepEqual(f.errors, []);
  }
});

test("the live replica path yields after 64 KiB and advances only fully applied cursors", () => {
  const shared = sharedScheduler(), f = fixture({}, shared.coordinator);
  f.replica.attach(attach); f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); shared.drain();
  for (let i = 1; i <= 128; i++) f.replica.receive(frame(1, i + 3, 12 + i * 8192, new Uint8Array(8192)));
  assert.equal(f.replica.queuedOutputBytes, 1024 * 1024);
  shared.runOne();
  assert.equal(f.calls.filter(call => call[0] === "write").length, 8);
  assert.equal(f.replica.queuedOutputBytes, 1024 * 1024 - 64 * 1024);
  assert.equal(f.replica.cursor.sequence, 11);
  assert.equal(f.replica.cursor.offset, 12 + 64 * 1024);
  assert.equal(shared.pending, true);
  shared.drain();
  assert.equal(f.calls.filter(call => call[0] === "write").length, 128);
  assert.equal(f.replica.cursor.sequence, 131);
  assert.equal(f.replica.queuedOutputBytes, 0);
});

test("mixed replica events retain per-pane ordering across shared partial turns", () => {
  const shared = sharedScheduler({ maximumBytesPerTurn: 4 });
  const a = fixture({}, shared.coordinator), b = fixture({}, shared.coordinator);
  for (const f of [a, b]) { f.replica.attach(attach); f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); }
  a.replica.receive(frame(1, 4, 14, new Uint8Array([65, 66])));
  b.replica.receive(frame(1, 4, 14, new Uint8Array([67, 68])));
  a.replica.receive(frame(2, 5, 14, new Uint8Array(new Uint32Array([100, 30, 8, 16]).buffer)));
  b.replica.receive(frame(6, 5, 14, new Uint8Array([16, 0, 0, 0, 1])));
  a.replica.receive(frame(1, 6, 16, new Uint8Array([69, 70])));
  b.replica.receive(frame(7, 6, 14));
  a.replica.receive(frame(5, 7, 16, new Uint8Array([1])));
  b.replica.receive(frame(3, 7, 14, new TextEncoder().encode("live")));
  a.replica.receive(frame(1, 8, 18, new Uint8Array([71, 72])));
  shared.runOne();
  for (const f of [a, b]) {
    assert.deepEqual(f.calls.map(call => call[0]), ["restoreSnapshot", "write"]);
    assert.equal(f.replica.cursor.sequence, 4);
  }
  shared.drain();
  assert.deepEqual(a.calls.map(call => call[0]), ["restoreSnapshot", "write", "applyGeometry", "write", "applyConfiguration", "write"]);
  assert.deepEqual(b.calls.map(call => call[0]), ["restoreSnapshot", "write", "applyImageSettings", "clearImages", "clipboard"]);
  assert.deepEqual(a.calls[2].slice(1), [100, 30, 8, 16]);
  assert.equal(a.replica.cursor.sequence, 8);
  assert.equal(b.replica.cursor.sequence, 7);
  for (const f of [a, b]) { assert.equal(f.replica.queuedOutputBytes, 0); assert.deepEqual(f.errors, []); }
});

test("one replica's backlog recovery cancels only its own parsing work", () => {
  const shared = sharedScheduler();
  let recoveries = 0;
  const a = fixture({ onBacklogExceeded: () => recoveries++ }, shared.coordinator), b = fixture({}, shared.coordinator);
  for (const f of [a, b]) { f.replica.attach({ ...attach, retainedOutputBytes: 4 }); f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); }
  shared.drain();
  a.replica.receive(frame(1, 4, 16, new Uint8Array(4)));
  b.replica.receive(frame(1, 4, 14, new Uint8Array([65, 66])));
  a.replica.receive(frame(1, 5, 17, new Uint8Array(1)));
  assert.equal(recoveries, 1);
  assert.equal(shared.pending, true);
  shared.drain();
  assert.equal(a.replica.cursor.sequence, 3);
  assert.equal(a.replica.needsSnapshot, true);
  assert.deepEqual(a.calls.map(call => call[0]), ["restoreSnapshot"]);
  assert.equal(b.replica.cursor.sequence, 4);
  assert.deepEqual(b.calls.map(call => call[0]), ["restoreSnapshot", "write"]);
});

test("image controls apply in order and advance the watermark only after application", () => {
  const f = fixture(); f.replica.attach(attach);
  f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); f.drain();
  f.replica.receive(frame(6, 4, 12, new Uint8Array([16, 0, 0, 0, 1])));
  f.replica.receive(frame(7, 5, 12));
  assert.equal(f.replica.cursor.sequence, 3);
  f.drain();
  assert.deepEqual(f.calls.slice(-2), [["applyImageSettings", 16, true], ["clearImages"]]);
  assert.equal(f.replica.cursor.sequence, 5);
  assert.throws(() => f.replica.receive(frame(6, 6, 12, new Uint8Array([128,0,0,0,1]))), /Invalid image settings/);
});

test("snapshot chunks apply atomically before output and canonical geometry", () => {
  const f = fixture(); f.replica.attach(attach);
  f.replica.receive(frame(4, 3, 12, new Uint8Array([1, 2])));
  f.drain(); assert.equal(f.calls.length, 0);
  f.replica.receive(frame(4, 3, 12, new Uint8Array([3, 4])));
  f.replica.receive(frame(1, 4, 14, new Uint8Array([65, 66])));
  const geometry = new Uint8Array(new Uint32Array([100, 30, 8, 16]).buffer);
  f.replica.receive(frame(2, 5, 14, geometry));
  assert.equal(f.replica.cursor.sequence, 0);
  f.drain();
  assert.deepEqual(f.calls.map(x => x[0]), ["restoreSnapshot", "write", "applyGeometry"]);
  assert.deepEqual(f.calls[2].slice(1), [100, 30, 8, 16]);
  assert.deepEqual(f.replica.cursor, { epoch: "shell", sequence: 5, offset: 14 });
});

test("disconnect discards unapplied events and resumes from applied watermark", () => {
  const f = fixture(); f.replica.attach(attach);
  f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); f.drain();
  f.replica.receive(frame(1, 4, 13, new Uint8Array([65])));
  f.replica.disconnect(); f.drain();
  assert.equal(f.replica.cursor.sequence, 3);
  f.replica.attach({ ...attach, reset: false, snapshotBytes: 0 });
  f.replica.receive(frame(1, 4, 13, new Uint8Array([65]))); f.drain();
  assert.equal(f.calls.filter(x => x[0] === "write").length, 1);
});

test("incompatible cores and gaps fail explicitly; replay clipboard is inert", () => {
  const f = fixture();
  assert.throws(() => f.replica.attach({ ...attach, core: "old" }), /core changed/);
  f.replica.attach(attach); f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); f.drain();
  assert.throws(() => f.replica.receive(frame(1, 5, 12)), /gap/);
  f.replica.receive(frame(3, 4, 12)); f.drain();
  assert.equal(f.calls.filter(x => x[0] === "clipboard").length, 0);
  f.replica.receive(frame(3, 5, 12, new TextEncoder().encode("live"))); f.drain();
  assert.deepEqual(f.calls.at(-1), ["clipboard", "live"]);
});

test("disconnect during snapshot leaves the existing replica intact", () => {
  const f = fixture(); f.replica.attach(attach);
  f.replica.receive(frame(4, 3, 12, new Uint8Array(2)));
  f.replica.disconnect(); f.drain(); assert.equal(f.calls.length, 0);
  assert.equal(f.replica.cursor.epoch, "");
});

test("backlog choices are bounded and invalid stored preferences fall back to Auto", () => {
  for (const value of ["auto", null, undefined, "unlimited", "4", "64", -1, NaN]) {
    assert.equal(normalizeTerminalBacklogLimit(value), "auto");
  }
  for (const value of [8, "16", "32"]) {
    assert.equal(normalizeTerminalBacklogLimit(value), String(value));
    assert.equal(fixture({ backlogLimit: value }).replica.maximumBacklogBytes, Number(value) * 1024 * 1024);
  }
});

test("Auto follows attachment retention and falls back safely for older metadata", () => {
  const f = fixture();
  f.replica.attach({ ...attach, retainedOutputBytes: 1234 });
  assert.equal(f.replica.maximumBacklogBytes, 1234);
  for (const value of [undefined, 0, -1, "1234", 1.5, Infinity]) {
    f.replica.attach({ ...attach, retainedOutputBytes: value });
    assert.equal(f.replica.maximumBacklogBytes, defaultRetainedOutputBytes);
  }
  f.replica.setBacklogLimit("8");
  f.replica.attach({ ...attach, retainedOutputBytes: 1234 });
  assert.equal(f.replica.maximumBacklogBytes, 8 * 1024 * 1024);
});

test("backlog counts only unapplied output and releases bytes after each ordered write", () => {
  const f = fixture();
  f.replica.attach({ ...attach, retainedOutputBytes: 4 });
  f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); f.drain();
  f.replica.receive(frame(1, 4, 14, new Uint8Array([65, 66])));
  f.replica.receive(frame(5, 5, 14, new Uint8Array([1])));
  f.replica.receive(frame(1, 6, 16, new Uint8Array([67, 68])));
  assert.equal(f.replica.queuedOutputBytes, 4, "the limit itself is allowed");
  assert.equal(f.replica.cursor.sequence, 3);
  f.drainOne();
  assert.equal(f.replica.queuedOutputBytes, 2);
  assert.equal(f.replica.cursor.sequence, 4);
  f.drainOne();
  assert.equal(f.replica.queuedOutputBytes, 2, "configuration consumes no output budget");
  f.drain();
  assert.equal(f.replica.queuedOutputBytes, 0);
  assert.deepEqual(f.replica.cursor, { epoch: "shell", sequence: 6, offset: 16 });
  assert.equal(f.errors.length, 0);
});

test("overflow drops the rest of a batch and stale socket messages without advancing the cursor", () => {
  let recoveries = 0;
  const f = fixture({ onBacklogExceeded: () => recoveries++ });
  f.replica.attach({ ...attach, retainedOutputBytes: 4 });
  f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); f.drain();
  f.replica.receive(frame(1, 4, 16, new Uint8Array(4))); f.drain();
  f.replica.receive(frame(1, 5, 19, new Uint8Array(3)));
  const batch = new Uint8Array([...frame(1, 6, 21, new Uint8Array(2)), ...frame(7, 7, 21)]);
  f.replica.receive(batch);
  assert.equal(recoveries, 1);
  assert.equal(f.replica.queuedOutputBytes, 0);
  assert.deepEqual(f.replica.cursor, { epoch: "shell", sequence: 4, offset: 16 });
  assert.equal(f.replica.queuedSequence, 4);
  assert.equal(f.replica.needsSnapshot, true);
  f.replica.receive(frame(1, 8, 25, new Uint8Array(4))); f.drain();
  assert.equal(recoveries, 1);
  assert.deepEqual(f.calls.map(call => call[0]), ["restoreSnapshot", "write"]);
  assert.equal(f.errors.length, 0);

  // The new host snapshot jumps past discarded output. Only a complete
  // import clears the recovery request, and live events follow it in order.
  f.replica.attach({ ...attach, sequence: 10, offset: 100, retainedOutputBytes: 4 });
  f.replica.receive(frame(4, 10, 100, new Uint8Array([1, 2])));
  f.drain();
  assert.equal(f.replica.cursor.sequence, 4);
  f.replica.receive(frame(4, 10, 100, new Uint8Array([3, 4])));
  f.replica.receive(frame(1, 11, 102, new Uint8Array([69, 70])));
  assert.equal(f.replica.needsSnapshot, true);
  f.drainOne();
  assert.equal(f.replica.needsSnapshot, false);
  assert.equal(f.replica.queuedOutputBytes, 2);
  f.drain();
  assert.deepEqual(f.replica.cursor, { epoch: "shell", sequence: 11, offset: 102 });
  assert.deepEqual(f.calls.map(call => call[0]), ["restoreSnapshot", "write", "restoreSnapshot", "write"]);
  assert.equal(recoveries, 1);
});

test("configuration bursts and snapshot bytes do not trigger output backlog recovery", () => {
  let recoveries = 0;
  const f = fixture({ onBacklogExceeded: () => recoveries++ });
  f.replica.attach({ ...attach, retainedOutputBytes: 1 });
  f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); f.drain();
  for (let sequence = 4; sequence < 2004; sequence++) {
    f.replica.receive(frame(5, sequence, 12, new Uint8Array([sequence % 2])));
  }
  assert.equal(f.replica.queuedOutputBytes, 0);
  f.drain();
  assert.equal(f.replica.cursor.sequence, 2003);
  assert.equal(recoveries, 0);
});

test("lowering a live limit recovers immediately; raising it preserves queued output", () => {
  let recoveries = 0;
  const f = fixture({ backlogLimit: "8", onBacklogExceeded: () => recoveries++ });
  f.replica.attach({ ...attach, retainedOutputBytes: 4 });
  f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); f.drain();
  f.replica.receive(frame(1, 4, 17, new Uint8Array(5)));
  f.replica.setBacklogLimit("16");
  assert.equal(recoveries, 0);
  assert.equal(f.replica.queuedOutputBytes, 5);
  f.replica.setBacklogLimit("auto");
  assert.equal(recoveries, 1);
  assert.equal(f.replica.queuedOutputBytes, 0);
  f.drain();
  assert.equal(f.replica.cursor.sequence, 3);
});

test("disconnect and parser errors reset byte accounting without applying queued events", () => {
  const f = fixture(); f.replica.attach(attach);
  f.replica.receive(frame(4, 3, 12, new Uint8Array(4))); f.drain();
  f.replica.receive(frame(1, 4, 14, new Uint8Array(2)));
  f.replica.disconnect(); f.drain();
  assert.equal(f.replica.queuedOutputBytes, 0);
  assert.equal(f.replica.cursor.sequence, 3);
  f.replica.attach({ ...attach, reset: false, snapshotBytes: 0 });
  f.term.write = () => { throw new Error("parse failed"); };
  f.replica.receive(frame(1, 4, 14, new Uint8Array(2))); f.drain();
  assert.equal(f.replica.queuedOutputBytes, 0);
  assert.equal(f.replica.cursor.sequence, 3);
  assert.match(f.errors[0].message, /parse failed/);
});

test("a stalled consumer receiving 16 MiB stays bounded and cancels its pending drain", () => {
  let scheduled = null, recoveries = 0, writes = 0, peakBytes = 0;
  const coordinator = new TerminalWriteCoordinator({
    schedule(callback) { scheduled = callback; return 1; },
    cancelSchedule() { scheduled = null; },
  });
  const scheduler = new TerminalWriteScheduler(() => {}, { coordinator });
  const replica = new TerminalReplica({ write() { writes++; }, restoreSnapshot() {} }, scheduler, "core", undefined, undefined, {
    onBacklogExceeded() { recoveries++; },
  });
  replica.attach(attach);
  replica.receive(frame(4, 3, 12, new Uint8Array(4)));
  scheduled(); scheduled = null;
  for (let sequence = 4; sequence < 2052; sequence++) {
    replica.receive(frame(1, sequence, 12 + (sequence - 3) * 8192, new Uint8Array(8192)));
    peakBytes = Math.max(peakBytes, replica.queuedOutputBytes);
  }
  assert.equal(peakBytes, defaultRetainedOutputBytes);
  assert.equal(recoveries, 1);
  assert.equal(writes, 0);
  assert.equal(replica.cursor.sequence, 3);
  assert.equal(replica.queuedOutputBytes, 0);
  assert.equal(scheduler.chunks.length, 0);
  assert.equal(scheduled, null);
});
