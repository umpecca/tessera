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

