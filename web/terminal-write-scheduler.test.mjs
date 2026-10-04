import assert from "node:assert/strict";
import test from "node:test";

import { TerminalWriteCoordinator, TerminalWriteScheduler } from "./terminal-write-scheduler.mjs";

function scheduleQueue() {
  const callbacks = new Map();
  let nextID = 1;
  return {
    schedule(callback) {
      const id = nextID;
      nextID += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancelSchedule(id) {
      callbacks.delete(id);
    },
    get pending() {
      return callbacks.size;
    },
    runNext() {
      const entry = callbacks.entries().next().value;
      if (!entry) {
        return false;
      }
      const [id, callback] = entry;
      callbacks.delete(id);
      callback();
      return true;
    },
    runAll() {
      while (this.runNext()) {
        // Each drain may schedule its successor.
      }
    },
  };
}

function bytes(...values) {
  return Uint8Array.from(values);
}

function schedulerOptions(schedules, options = {}) {
  const { maximumChunkBytes, ...budgets } = options;
  return { maximumChunkBytes, coordinator: new TerminalWriteCoordinator({
    schedule: schedules.schedule, cancelSchedule: schedules.cancelSchedule, now: () => 0, ...budgets,
  }) };
}

test("writes queued chunks in FIFO order from one scheduled drain", () => {
  const schedules = scheduleQueue();
  const written = [];
  const scheduler = new TerminalWriteScheduler(
    (chunk) => written.push(...chunk),
    schedulerOptions(schedules),
  );

  scheduler.enqueue(bytes(1, 2));
  scheduler.enqueue(bytes(3, 4));
  assert.equal(schedules.pending, 1);

  schedules.runAll();
  assert.deepEqual(written, [1, 2, 3, 4]);
  assert.equal(schedules.pending, 0);
});

test("splits a large replay and yields at the byte budget", () => {
  const schedules = scheduleQueue();
  const written = [];
  const scheduler = new TerminalWriteScheduler(
    (chunk) => written.push([...chunk]),
    schedulerOptions(schedules, {
      maximumChunkBytes: 4,
      maximumBytesPerTurn: 4,
    }),
  );

  scheduler.enqueue(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
  schedules.runNext();
  assert.deepEqual(written, [[0, 1, 2, 3]]);
  assert.equal(schedules.pending, 1);

  schedules.runAll();
  assert.deepEqual(written, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
});

test("yields when parsing consumes the time budget", () => {
  const schedules = scheduleQueue();
  const written = [];
  const times = [0, 2, 7, 8, 9];
  const scheduler = new TerminalWriteScheduler(
    (chunk) => written.push(chunk[0]),
    schedulerOptions(schedules, {
      now: () => times.shift() ?? 9,
      maximumChunkBytes: 1,
      maximumBytesPerTurn: 100,
      timeBudgetMilliseconds: 5,
    }),
  );

  scheduler.enqueue(bytes(1, 2, 3));
  schedules.runNext();
  assert.deepEqual(written, [1, 2]);
  assert.equal(schedules.pending, 1);

  schedules.runAll();
  assert.deepEqual(written, [1, 2, 3]);
});

test("reset cancels pending work from a superseded stream", () => {
  const schedules = scheduleQueue();
  const written = [];
  const scheduler = new TerminalWriteScheduler(
    (chunk) => written.push(...chunk),
    schedulerOptions(schedules),
  );

  scheduler.enqueue(bytes(1, 2, 3));
  scheduler.reset();
  assert.equal(schedules.pending, 0);
  schedules.runAll();
  assert.deepEqual(written, []);

  scheduler.enqueue(bytes(4, 5));
  schedules.runAll();
  assert.deepEqual(written, [4, 5]);
});

test("dispose cancels pending work and ignores later output", () => {
  const schedules = scheduleQueue();
  const written = [];
  const scheduler = new TerminalWriteScheduler(
    (chunk) => written.push(...chunk),
    schedulerOptions(schedules),
  );

  scheduler.enqueue(bytes(1, 2, 3));
  scheduler.dispose();
  scheduler.enqueue(bytes(4, 5));
  assert.equal(schedules.pending, 0);
  schedules.runAll();
  assert.deepEqual(written, []);
});

test("time-sliced tasks release their consumed output references before the queue empties", () => {
  const schedules = scheduleQueue();
  let now = 0;
  const scheduler = new TerminalWriteScheduler(() => {}, schedulerOptions(schedules, {
    now: () => now, timeBudgetMilliseconds: 5,
  }));
  scheduler.enqueueTask(() => { now += 5; });
  scheduler.enqueueTask(() => {});
  schedules.runNext();
  assert.equal(scheduler.head, 1);
  assert.equal(scheduler.chunks[0], null);
  assert.equal(schedules.pending, 1);
  schedules.runAll();
  assert.equal(schedules.pending, 0);
});

test("live tasks count output bytes while configuration tasks consume only time", () => {
  const schedules = scheduleQueue(), calls = [];
  const scheduler = new TerminalWriteScheduler(() => {}, schedulerOptions(schedules, { maximumBytesPerTurn: 4 }));
  scheduler.enqueueTask(() => calls.push("output 1"), 2);
  scheduler.enqueueTask(() => calls.push("resize"));
  scheduler.enqueueTask(() => calls.push("output 2"), 2);
  scheduler.enqueueTask(() => calls.push("output 3"), 2);
  schedules.runNext();
  assert.deepEqual(calls, ["output 1", "resize", "output 2"]);
  assert.equal(schedules.pending, 1);
  schedules.runAll();
  assert.deepEqual(calls, ["output 1", "resize", "output 2", "output 3"]);
});

test("all default terminal queues use the same parsing coordinator", () => {
  const a = new TerminalWriteScheduler(() => {}), b = new TerminalWriteScheduler(() => {});
  assert.equal(a.coordinator, b.coordinator);
  a.dispose(); b.dispose();
});

test("posted default turns ignore canceled messages and apply only the replacement stream", async () => {
  const calls = [], scheduler = new TerminalWriteScheduler(() => {});
  scheduler.enqueueTask(() => calls.push("discarded"));
  scheduler.reset();
  await new Promise(resolve => scheduler.enqueueTask(() => { calls.push("current"); resolve(); }));
  assert.deepEqual(calls, ["current"]);
  scheduler.dispose();
});

test("busy terminals rotate in FIFO order under one shared byte limit", () => {
  const schedules = scheduleQueue(), calls = [];
  const options = schedulerOptions(schedules, { maximumBytesPerTurn: 8, maximumChunkBytes: 4 });
  const panes = ["A", "B", "C", "D"].map(name => new TerminalWriteScheduler(data => calls.push([name, ...data]), options));
  for (const pane of panes) pane.enqueue(bytes(1, 1, 1, 1, 2, 2, 2, 2));
  assert.equal(schedules.pending, 1, "busy panes must share one scheduled callback");
  schedules.runNext();
  assert.deepEqual(calls, [["A", 1, 1, 1, 1], ["B", 1, 1, 1, 1]]);
  schedules.runNext();
  assert.deepEqual(calls.slice(2), [["C", 1, 1, 1, 1], ["D", 1, 1, 1, 1]]);
  schedules.runAll();
  assert.deepEqual(calls.slice(4), [["A", 2, 2, 2, 2], ["B", 2, 2, 2, 2], ["C", 2, 2, 2, 2], ["D", 2, 2, 2, 2]]);
});

test("the time limit is shared and costly panes cannot starve their siblings", () => {
  const schedules = scheduleQueue(), calls = [];
  let now = 0;
  const options = schedulerOptions(schedules, { now: () => now, timeBudgetMilliseconds: 5 });
  const panes = ["A", "B", "C", "D"].map(name => new TerminalWriteScheduler(data => { now += 5; calls.push([name, ...data]); }, options));
  for (const pane of panes) { pane.enqueue(bytes(1)); pane.enqueue(bytes(2)); }
  schedules.runNext();
  assert.equal(now, 5, "one global turn cannot grant four separate 5 ms budgets");
  assert.deepEqual(calls, [["A", 1]]);
  for (let i = 0; i < 3; i++) schedules.runNext();
  assert.deepEqual(calls, [["A", 1], ["B", 1], ["C", 1], ["D", 1]]);
  schedules.runAll();
  assert.deepEqual(calls.slice(4), [["A", 2], ["B", 2], ["C", 2], ["D", 2]]);
});

test("canceling a pane leaves its sibling's pending callback and output intact", () => {
  const schedules = scheduleQueue(), calls = [], options = schedulerOptions(schedules);
  const a = new TerminalWriteScheduler(data => calls.push(["A", ...data]), options);
  const b = new TerminalWriteScheduler(data => calls.push(["B", ...data]), options);
  a.enqueue(bytes(1)); b.enqueue(bytes(2)); a.reset();
  assert.equal(schedules.pending, 1);
  schedules.runAll();
  assert.deepEqual(calls, [["B", 2]]);
  a.enqueue(bytes(3)); a.dispose();
  assert.equal(schedules.pending, 0, "removing the last ready pane cancels the callback");
});

test("reset and new input during a drain discard the old stream without creating extra callbacks", () => {
  const schedules = scheduleQueue(), calls = [], options = schedulerOptions(schedules);
  const a = new TerminalWriteScheduler(data => calls.push(["A", ...data]), options);
  const b = new TerminalWriteScheduler(data => calls.push(["B", ...data]), options);
  a.enqueueTask(() => { b.reset(); b.enqueue(bytes(3)); a.enqueue(bytes(4)); });
  b.enqueue(bytes(2));
  schedules.runNext();
  assert.deepEqual(calls, [["B", 3], ["A", 4]]);
  assert.equal(schedules.pending, 0);
});

test("a parser failure releases its queue and keeps other terminals scheduled", () => {
  const schedules = scheduleQueue(), calls = [], options = schedulerOptions(schedules);
  const a = new TerminalWriteScheduler(() => { throw new Error("parse failed"); }, options);
  const b = new TerminalWriteScheduler(data => calls.push(...data), options);
  a.enqueue(bytes(1)); a.enqueue(bytes(2)); b.enqueue(bytes(3));
  assert.throws(() => schedules.runNext(), /parse failed/);
  assert.equal(a.chunks.length, 0);
  assert.equal(schedules.pending, 1);
  schedules.runAll();
  assert.deepEqual(calls, [3]);
});

test("oversized events finish atomically and yield before the next pane's event", () => {
  const schedules = scheduleQueue(), calls = [], options = schedulerOptions(schedules, { maximumBytesPerTurn: 4 });
  const a = new TerminalWriteScheduler(() => {}, options), b = new TerminalWriteScheduler(() => {}, options);
  a.enqueueTask(() => calls.push("large complete event"), 8);
  b.enqueueTask(() => calls.push("small complete event"), 2);
  schedules.runNext();
  assert.deepEqual(calls, ["large complete event"]);
  schedules.runNext();
  assert.deepEqual(calls, ["large complete event", "small complete event"]);
});

test("the active pane gets three ordered events per visit within the shared byte budget", () => {
  const schedules = scheduleQueue(), calls = [];
  const options = schedulerOptions(schedules, { maximumBytesPerTurn: 4, maximumChunkBytes: 1 });
  const panes = ["A", "B", "C", "D"].map(name => new TerminalWriteScheduler(data => calls.push(`${name}${data[0]}`), options));
  for (const pane of panes) pane.enqueue(bytes(1, 2, 3, 4, 5, 6));
  panes[3].setActive(true);
  schedules.runNext();
  assert.deepEqual(calls, ["D1", "D2", "D3", "A1"]);
  schedules.runNext();
  assert.deepEqual(calls.slice(4), ["B1", "C1", "D4", "D5"]);
  schedules.runNext();
  assert.deepEqual(calls.slice(8), ["D6", "A2", "B2", "C2"]);
  schedules.runAll();
  for (const name of ["A", "B", "C", "D"]) {
    assert.deepEqual(calls.filter(call => call.startsWith(name)), [1, 2, 3, 4, 5, 6].map(i => `${name}${i}`));
  }
});

test("costly active events keep their quota across turns and repeated activation cannot starve siblings", () => {
  const schedules = scheduleQueue(), calls = [];
  let now = 0;
  const options = schedulerOptions(schedules, { now: () => now, maximumChunkBytes: 1 });
  const panes = ["A", "B", "C"].map(name => new TerminalWriteScheduler(data => { now += 5; calls.push(`${name}${data[0]}`); }, options));
  panes[0].setActive(true);
  panes[0].enqueue(bytes(1, 2, 3, 4, 5, 6));
  for (const pane of panes.slice(1)) pane.enqueue(bytes(1, 2));
  for (let i = 0; i < 5; i++) {
    panes[0].setActive(true);
    schedules.runNext();
    assert.equal(now, (i + 1) * 5, "each callback still has one shared time budget");
  }
  assert.deepEqual(calls, ["A1", "A2", "A3", "B1", "C1"]);
  schedules.runAll();
  assert.deepEqual(calls.slice(5), ["A4", "A5", "A6", "B2", "C2"]);
});

test("switching focus transfers the unfinished active visit immediately", () => {
  const schedules = scheduleQueue(), calls = [];
  const options = schedulerOptions(schedules, { maximumBytesPerTurn: 1, maximumChunkBytes: 1 });
  const a = new TerminalWriteScheduler(data => calls.push(`A${data[0]}`), options);
  const b = new TerminalWriteScheduler(data => calls.push(`B${data[0]}`), options);
  a.setActive(true); a.enqueue(bytes(1, 2, 3)); b.enqueue(bytes(1, 2, 3));
  schedules.runNext();
  b.setActive(true); a.setActive(false);
  for (let i = 0; i < 3; i++) schedules.runNext();
  assert.deepEqual(calls, ["A1", "B1", "B2", "B3"]);
  schedules.runAll();
  assert.deepEqual(calls.slice(4), ["A2", "A3"]);
});

test("an idle active pane reserves no capacity and its fresh output precedes queued builds", () => {
  const schedules = scheduleQueue(), calls = [];
  const options = schedulerOptions(schedules, { maximumBytesPerTurn: 1, maximumChunkBytes: 1 });
  const panes = ["A", "B", "C"].map(name => new TerminalWriteScheduler(data => calls.push(`${name}${data[0]}`), options));
  panes[0].setActive(true);
  panes[1].enqueue(bytes(1, 2)); panes[2].enqueue(bytes(1));
  schedules.runNext();
  assert.deepEqual(calls, ["B1"]);
  panes[0].enqueue(bytes(1)); schedules.runNext();
  assert.deepEqual(calls, ["B1", "A1"]);
  schedules.runAll();
  assert.deepEqual(calls.slice(2), ["C1", "B2"]);
});

test("reset preserves active priority for the replacement stream and disposal releases it", () => {
  const schedules = scheduleQueue(), calls = [];
  const options = schedulerOptions(schedules, { maximumBytesPerTurn: 1, maximumChunkBytes: 1 });
  const a = new TerminalWriteScheduler(data => calls.push(`A${data[0]}`), options);
  const b = new TerminalWriteScheduler(data => calls.push(`B${data[0]}`), options);
  a.setActive(true); a.enqueue(bytes(1, 2, 3)); b.enqueue(bytes(1, 2));
  schedules.runNext(); a.reset(); a.enqueue(bytes(4, 5)); schedules.runNext();
  assert.equal(options.coordinator.activeScheduler, a);
  schedules.runNext();
  assert.deepEqual(calls, ["A1", "B1", "A4"]);
  a.dispose(); a.setActive(true);
  assert.equal(options.coordinator.activeScheduler, null, "the coordinator must not retain a disposed terminal");
  schedules.runAll();
  assert.deepEqual(calls.slice(3), ["B2"]);
});

test("active output enqueued during parsing cannot renew its current visit", () => {
  const schedules = scheduleQueue(), calls = [], options = schedulerOptions(schedules);
  let count = 0;
  const a = new TerminalWriteScheduler(() => {
    calls.push(`A${++count}`);
    if (count < 6) a.enqueue(bytes(1));
  }, options);
  const b = new TerminalWriteScheduler(() => calls.push("B1"), options);
  a.setActive(true); a.enqueue(bytes(1)); b.enqueue(bytes(1));
  schedules.runAll();
  assert.deepEqual(calls, ["A1", "A2", "A3", "B1", "A4", "A5", "A6"]);
});

test("focus changes during a parsed event promote the new active pane next", () => {
  const schedules = scheduleQueue(), calls = [], options = schedulerOptions(schedules, { maximumChunkBytes: 1 });
  const a = new TerminalWriteScheduler(data => { calls.push(`A${data[0]}`); if (data[0] === 1) b.setActive(true); }, options);
  const b = new TerminalWriteScheduler(data => calls.push(`B${data[0]}`), options);
  a.setActive(true); a.enqueue(bytes(1, 2, 3)); b.enqueue(bytes(1, 2, 3));
  schedules.runAll();
  assert.deepEqual(calls, ["A1", "B1", "B2", "B3", "A2", "A3"]);
});

test("active output arriving between turns cannot repeatedly jump ahead of waiting builds", () => {
  const schedules = scheduleQueue(), calls = [];
  const options = schedulerOptions(schedules, { maximumBytesPerTurn: 1, maximumChunkBytes: 1 });
  const panes = ["A", "B", "C"].map(name => new TerminalWriteScheduler(data => calls.push(`${name}${data[0]}`), options));
  panes[0].setActive(true);
  panes[0].enqueue(bytes(1));
  panes[1].enqueue(bytes(1, 2)); panes[2].enqueue(bytes(1, 2));
  for (let i = 0; i < 6; i++) {
    schedules.runNext();
    if (!panes[0].chunks.length) panes[0].enqueue(bytes(i + 2));
  }
  assert.deepEqual(calls.slice(0, 3), ["A1", "B1", "C1"]);
  assert.equal(calls.filter(call => call.startsWith("B")).length, 2);
  assert.equal(calls.filter(call => call.startsWith("C")).length, 2);
  schedules.runAll();
});

