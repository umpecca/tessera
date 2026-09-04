import assert from "node:assert/strict";
import test from "node:test";
import { TerminalReplica } from "./terminal-replica.mjs";

function frame(kind, sequence, offset, data = new Uint8Array()) {
  const result = new Uint8Array(21 + data.length), view = new DataView(result.buffer);
  view.setUint8(0, kind); view.setBigUint64(1, BigInt(sequence), true);
  view.setBigUint64(9, BigInt(offset), true); view.setUint32(17, data.length, true);
  result.set(data, 21); return result;
}
function fixture() {
  let queue = [], calls = [], errors = [];
  const term = Object.fromEntries(["write", "restoreSnapshot", "applyGeometry", "applyConfiguration", "applyImageSettings", "clearImages"].map(name => [name, (...args) => calls.push([name, ...args])]));
  const scheduler = { enqueueTask(task) { queue.push(task); }, reset() { queue = []; } };
  const replica = new TerminalReplica(term, scheduler, "core", text => calls.push(["clipboard", text]), error => errors.push(error));
  return { replica, calls, errors, drain() { while (queue.length) queue.shift()(); } };
}
const attach = { protocol: 2, core: "core", epoch: "shell", sequence: 3, offset: 12, snapshotBytes: 4, reset: true, cols: 80, rows: 24 };

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
