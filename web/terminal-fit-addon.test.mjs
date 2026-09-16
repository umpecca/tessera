import assert from "node:assert/strict";
import test from "node:test";

import { TesseraFitAddon } from "./terminal-fit-addon.mjs";

function testTerminal(options = {}) {
  const resizeCalls = [];
  const terminal = {
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    element: {
      clientWidth: options.clientWidth ?? 1000,
      clientHeight: options.clientHeight ?? 500,
    },
    renderer: {
      getMetrics: () => ({
        width: options.cellWidth ?? 10,
        height: options.cellHeight ?? 20,
      }),
    },
    resize: (cols, rows) => resizeCalls.push({ cols, rows }),
  };
  return { resizeCalls, terminal };
}

function withComputedPadding(padding, run) {
  const originalWindow = globalThis.window;
  globalThis.window = {
    getComputedStyle: () => ({
      getPropertyValue: (property) => padding[property] ?? "0px",
    }),
  };
  try {
    run();
  } finally {
    globalThis.window = originalWindow;
  }
}

function timerQueue() {
  const timers = new Map();
  let nextID = 1;
  return {
    setTimer(callback) {
      const id = nextID++;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    runNext() {
      const entry = timers.entries().next().value;
      if (!entry) return;
      const [id, callback] = entry;
      timers.delete(id);
      callback();
    },
    get pending() {
      return timers.size;
    },
  };
}

test("fits whole cells without reserving a separate scrollbar gutter", () => {
  const { terminal } = testTerminal({ clientWidth: 101, clientHeight: 61 });
  const fit = new TesseraFitAddon();
  fit.activate(terminal);

  withComputedPadding({}, () => {
    assert.deepEqual(fit.proposeDimensions(), { cols: 10, rows: 3 });
  });
});

test("subtracts fractional CSS padding before calculating dimensions", () => {
  const { terminal } = testTerminal({ clientWidth: 116, clientHeight: 76 });
  const fit = new TesseraFitAddon();
  fit.activate(terminal);

  withComputedPadding({
    "padding-left": "8.5px",
    "padding-right": "7.5px",
    "padding-top": "8px",
    "padding-bottom": "8px",
  }, () => {
    assert.deepEqual(fit.proposeDimensions(), { cols: 10, rows: 3 });
  });
});

test("resizes only when the calculated grid changes", () => {
  const { resizeCalls, terminal } = testTerminal({ cols: 80, rows: 24 });
  const fit = new TesseraFitAddon();
  fit.activate(terminal);

  withComputedPadding({}, () => {
    fit.fit();
    assert.deepEqual(resizeCalls, [{ cols: 100, rows: 25 }]);
  });
});

test("replays the final fit requested during the resize guard", () => {
  const timers = timerQueue();
  const { resizeCalls, terminal } = testTerminal({ clientWidth: 1000, clientHeight: 500 });
  const fit = new TesseraFitAddon({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  fit.activate(terminal);

  withComputedPadding({}, () => {
    fit.fit();
    terminal.element.clientWidth = 700;
    terminal.element.clientHeight = 320;
    fit.fit();
    assert.deepEqual(resizeCalls, [{ cols: 100, rows: 25 }]);

    timers.runNext();
    assert.deepEqual(resizeCalls, [
      { cols: 100, rows: 25 },
      { cols: 70, rows: 16 },
    ]);
  });
});

test("dispose cancels resize guard timers and pending fits", () => {
  const timers = timerQueue();
  const { resizeCalls, terminal } = testTerminal();
  const fit = new TesseraFitAddon({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  fit.activate(terminal);

  withComputedPadding({}, () => {
    fit.fit();
    terminal.element.clientWidth = 700;
    fit.fit();
    fit.dispose();
    assert.equal(timers.pending, 0);
    assert.deepEqual(resizeCalls, [{ cols: 100, rows: 25 }]);
  });
});
