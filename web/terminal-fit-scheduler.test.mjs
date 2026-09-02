import assert from "node:assert/strict";
import test from "node:test";

import { TerminalFitScheduler } from "./terminal-fit-scheduler.mjs";

function frameQueue() {
  const frames = new Map();
  let nextID = 1;
  return {
    requestFrame: (callback) => {
      const id = nextID++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    get pending() {
      return frames.size;
    },
    run() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
  };
}

function timerQueue() {
  const timers = new Map();
  const delays = [];
  let nextID = 1;
  return {
    setTimer: (callback, delay) => {
      const id = nextID++;
      timers.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    get delays() {
      return delays;
    },
    get pending() {
      return timers.size;
    },
    run() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
  };
}

function schedulerHarness() {
  const frames = frameQueue();
  const timers = timerQueue();
  return {
    frames,
    timers,
    scheduler: new TerminalFitScheduler({
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
  };
}

function fakeTerminal(cols = 80, rows = 24) {
  const sent = [];
  const term = { cols, rows };
  const state = {
    term,
    socket: { readyState: 1, send: (data) => sent.push(JSON.parse(data)) },
    sentCols: 0,
    sentRows: 0,
    sent,
  };
  state.fit = {
    fit: () => {
      state.fits = (state.fits || 0) + 1;
      if (state.nextSize) {
        term.cols = state.nextSize.cols;
        term.rows = state.nextSize.rows;
      }
    },
  };
  return state;
}

test("a burst of fit requests collapses into one fit per frame", () => {
  const { frames, scheduler } = schedulerHarness();
  const terminal = fakeTerminal();

  for (let i = 0; i < 50; i += 1) {
    scheduler.request(terminal);
  }
  assert.equal(frames.pending, 1);

  frames.run();
  assert.equal(terminal.fits, 1);

  // The next burst gets its own frame.
  scheduler.request(terminal);
  frames.run();
  assert.equal(terminal.fits, 2);
});

test("fitting without a grid change sends nothing", () => {
  const { frames, scheduler, timers } = schedulerHarness();
  const terminal = fakeTerminal();
  terminal.sentCols = 80;
  terminal.sentRows = 24;

  scheduler.request(terminal);
  frames.run();
  timers.run();
  assert.deepEqual(terminal.sent, []);
});

test("a grid change is sent once after the layout settles", () => {
  const { frames, scheduler, timers } = schedulerHarness();
  const terminal = fakeTerminal();
  terminal.sentCols = 80;
  terminal.sentRows = 24;
  terminal.nextSize = { cols: 100, rows: 30 };

  scheduler.request(terminal);
  frames.run();
  assert.deepEqual(terminal.sent, []);
  scheduler.request(terminal);
  frames.run();
  assert.equal(timers.pending, 1);
  assert.deepEqual(terminal.sent, []);
  timers.run();
  assert.deepEqual(terminal.sent, [{ type: "resize", cols: 100, rows: 30 }]);
});

test("a resize burst sends only its final grid size", () => {
  const { frames, scheduler, timers } = schedulerHarness();
  const terminal = fakeTerminal();
  terminal.sentCols = 80;
  terminal.sentRows = 24;

  for (const nextSize of [
    { cols: 90, rows: 25 },
    { cols: 110, rows: 31 },
    { cols: 132, rows: 40 },
  ]) {
    terminal.nextSize = nextSize;
    scheduler.request(terminal);
    frames.run();
    assert.equal(timers.pending, 1);
  }

  assert.deepEqual(terminal.sent, []);
  timers.run();
  assert.deepEqual(terminal.sent, [{ type: "resize", cols: 132, rows: 40 }]);
  assert.deepEqual(timers.delays, [120, 120, 120]);
});

test("a reconnected socket is told the size again", () => {
  const { scheduler, timers } = schedulerHarness();
  const terminal = fakeTerminal();
  scheduler.sendGridSize(terminal);
  assert.equal(terminal.sent.length, 1);

  const sent = [];
  terminal.socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  terminal.sentCols = 0;
  terminal.sentRows = 0;
  scheduler.requestGridSize(terminal);
  scheduler.sendGridSize(terminal);
  assert.equal(timers.pending, 0);
  assert.deepEqual(sent, [{ type: "resize", cols: 80, rows: 24 }]);
});

test("a closed socket is never written to", () => {
  const scheduler = new TerminalFitScheduler(frameQueue());
  const terminal = fakeTerminal();
  terminal.socket.readyState = 3;
  scheduler.sendGridSize(terminal);
  assert.deepEqual(terminal.sent, []);
  assert.equal(terminal.sentCols, 0);
});

test("disposing a terminal drops its pending fit", () => {
  const { frames, scheduler } = schedulerHarness();
  const terminal = fakeTerminal();

  scheduler.request(terminal);
  scheduler.cancel(terminal);
  assert.equal(frames.pending, 0);

  frames.run();
  assert.equal(terminal.fits, undefined);
});

test("a terminal disposed after its frame was queued is not fitted", () => {
  const { frames, scheduler } = schedulerHarness();
  const terminal = fakeTerminal();

  scheduler.request(terminal);
  terminal.fit = null;
  frames.run();
  assert.deepEqual(terminal.sent, []);
});

test("disposing after a fit cancels its pending grid size", () => {
  const { frames, scheduler, timers } = schedulerHarness();
  const terminal = fakeTerminal();
  terminal.nextSize = { cols: 100, rows: 30 };

  scheduler.request(terminal);
  frames.run();
  assert.equal(timers.pending, 1);

  scheduler.cancel(terminal);
  assert.equal(timers.pending, 0);
  timers.run();
  assert.deepEqual(terminal.sent, []);
});
