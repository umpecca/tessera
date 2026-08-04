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
  const frames = frameQueue();
  const scheduler = new TerminalFitScheduler(frames);
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
  const frames = frameQueue();
  const scheduler = new TerminalFitScheduler(frames);
  const terminal = fakeTerminal();
  terminal.sentCols = 80;
  terminal.sentRows = 24;

  scheduler.request(terminal);
  frames.run();
  assert.deepEqual(terminal.sent, []);
});

test("a grid change is sent once", () => {
  const frames = frameQueue();
  const scheduler = new TerminalFitScheduler(frames);
  const terminal = fakeTerminal();
  terminal.sentCols = 80;
  terminal.sentRows = 24;
  terminal.nextSize = { cols: 100, rows: 30 };

  scheduler.request(terminal);
  frames.run();
  scheduler.request(terminal);
  frames.run();
  assert.deepEqual(terminal.sent, [{ type: "resize", cols: 100, rows: 30 }]);
});

test("a reconnected socket is told the size again", () => {
  const frames = frameQueue();
  const scheduler = new TerminalFitScheduler(frames);
  const terminal = fakeTerminal();
  scheduler.sendGridSize(terminal);
  assert.equal(terminal.sent.length, 1);

  const sent = [];
  terminal.socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  terminal.sentCols = 0;
  terminal.sentRows = 0;
  scheduler.sendGridSize(terminal);
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
  const frames = frameQueue();
  const scheduler = new TerminalFitScheduler(frames);
  const terminal = fakeTerminal();

  scheduler.request(terminal);
  scheduler.cancel(terminal);
  assert.equal(frames.pending, 0);

  frames.run();
  assert.equal(terminal.fits, undefined);
});

test("a terminal disposed after its frame was queued is not fitted", () => {
  const frames = frameQueue();
  const scheduler = new TerminalFitScheduler(frames);
  const terminal = fakeTerminal();

  scheduler.request(terminal);
  terminal.fit = null;
  frames.run();
  assert.deepEqual(terminal.sent, []);
});
