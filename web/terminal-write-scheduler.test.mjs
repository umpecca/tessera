import assert from "node:assert/strict";
import test from "node:test";

import { TerminalWriteScheduler } from "./terminal-write-scheduler.mjs";

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

test("writes queued chunks in FIFO order from one scheduled drain", () => {
  const schedules = scheduleQueue();
  const written = [];
  const scheduler = new TerminalWriteScheduler(
    (chunk) => written.push(...chunk),
    { schedule: schedules.schedule, cancelSchedule: schedules.cancelSchedule },
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
    {
      schedule: schedules.schedule,
      cancelSchedule: schedules.cancelSchedule,
      maximumChunkBytes: 4,
      maximumBytesPerTurn: 4,
    },
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
    {
      schedule: schedules.schedule,
      cancelSchedule: schedules.cancelSchedule,
      now: () => times.shift() ?? 9,
      maximumChunkBytes: 1,
      maximumBytesPerTurn: 100,
      timeBudgetMilliseconds: 5,
    },
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
    { schedule: schedules.schedule, cancelSchedule: schedules.cancelSchedule },
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
    { schedule: schedules.schedule, cancelSchedule: schedules.cancelSchedule },
  );

  scheduler.enqueue(bytes(1, 2, 3));
  scheduler.dispose();
  scheduler.enqueue(bytes(4, 5));
  assert.equal(schedules.pending, 0);
  schedules.runAll();
  assert.deepEqual(written, []);
});

