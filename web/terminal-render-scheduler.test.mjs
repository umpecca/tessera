import assert from "node:assert/strict";
import test from "node:test";

import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";

function testScheduler() {
  let nextFrameID = 1;
  const frames = new Map();
  const canceled = [];
  const scheduler = new TerminalRenderScheduler({
    requestFrame(callback) {
      const frameID = nextFrameID;
      nextFrameID += 1;
      frames.set(frameID, callback);
      return frameID;
    },
    cancelFrame(frameID) {
      canceled.push(frameID);
      frames.delete(frameID);
    },
  });
  return {
    canceled,
    flushFrame() {
      const next = frames.entries().next().value;
      assert.ok(next, "expected a scheduled animation frame");
      const [frameID, callback] = next;
      frames.delete(frameID);
      callback();
    },
    frames,
    scheduler,
  };
}

test("coalesces requested terminals into one shared frame", () => {
  const { flushFrame, frames, scheduler } = testScheduler();
  const renders = [];
  const first = {};
  const second = {};

  scheduler.register(first, () => renders.push("first"));
  scheduler.register(second, () => renders.push("second"));
  scheduler.request(first);

  assert.equal(frames.size, 1);
  flushFrame();
  assert.deepEqual(renders, ["first", "second"]);
  assert.equal(frames.size, 0);
});

test("keeps only continuous terminals on subsequent frames", () => {
  const { flushFrame, frames, scheduler } = testScheduler();
  let activeRenders = 0;
  let inactiveRenders = 0;
  const active = {};
  const inactive = {};

  scheduler.register(active, () => activeRenders += 1);
  scheduler.register(inactive, () => inactiveRenders += 1);
  scheduler.setContinuous(active, true);

  flushFrame();
  assert.equal(activeRenders, 1);
  assert.equal(inactiveRenders, 1);
  assert.equal(frames.size, 1);

  flushFrame();
  assert.equal(activeRenders, 2);
  assert.equal(inactiveRenders, 1);
});

test("suppresses paused terminals and redraws once when restored", () => {
  const { flushFrame, frames, scheduler } = testScheduler();
  let renders = 0;
  const terminal = {};

  scheduler.register(terminal, () => renders += 1);
  scheduler.setPaused(terminal, true);
  scheduler.request(terminal);
  assert.equal(frames.size, 0);

  scheduler.setPaused(terminal, false);
  assert.equal(frames.size, 1);
  flushFrame();
  assert.equal(renders, 1);
  assert.equal(frames.size, 0);
});

test("document visibility cancels frames and redraws visible terminals", () => {
  const { canceled, flushFrame, frames, scheduler } = testScheduler();
  let firstRenders = 0;
  let pausedRenders = 0;
  const first = {};
  const paused = {};

  scheduler.register(first, () => firstRenders += 1);
  scheduler.register(paused, () => pausedRenders += 1);
  scheduler.setPaused(paused, true);
  scheduler.setEnabled(false);

  assert.equal(canceled.length, 1);
  assert.equal(frames.size, 0);
  scheduler.request(first);
  assert.equal(frames.size, 0);

  scheduler.setEnabled(true);
  flushFrame();
  assert.equal(firstRenders, 1);
  assert.equal(pausedRenders, 0);
});

test("unregister removes terminal work and cancels an idle frame", () => {
  const { canceled, frames, scheduler } = testScheduler();
  const terminal = {};

  scheduler.register(terminal, () => {});
  assert.equal(frames.size, 1);
  scheduler.unregister(terminal);

  assert.equal(frames.size, 0);
  assert.equal(canceled.length, 1);
});
