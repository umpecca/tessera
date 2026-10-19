import assert from "node:assert/strict";
import test from "node:test";

import { terminalProgressDescription, terminalProgressFromMessage, terminalProgressWidth } from "./terminal-progress.mjs";

const message = (fields) => ({ type: "terminal-progress", epoch: "e1", state: "set", percent: 42, ...fields });

test("progress messages", () => {
  assert.deepEqual(terminalProgressFromMessage(message()), { state: "set", percent: 42 });
  assert.equal(terminalProgressFromMessage(message({ state: "remove" })), null);
  assert.deepEqual(terminalProgressFromMessage(message({ state: "indeterminate", percent: -1 })), { state: "indeterminate", percent: null });
  for (const percent of [101, 4.5, "50", undefined]) {
    assert.deepEqual(terminalProgressFromMessage(message({ percent })), { state: "set", percent: null }, String(percent));
  }
  for (const other of [null, { type: "terminal-alert" }, message({ state: "done" })]) {
    assert.equal(terminalProgressFromMessage(other), undefined);
  }
});

test("bar width and description", () => {
  assert.equal(terminalProgressWidth({ state: "set", percent: 42 }), 42);
  assert.equal(terminalProgressWidth({ state: "set", percent: null }), null);
  assert.equal(terminalProgressWidth({ state: "indeterminate", percent: 30 }), null);
  assert.equal(terminalProgressWidth({ state: "error", percent: null }), 100);
  assert.equal(terminalProgressWidth({ state: "pause", percent: 60 }), 60);
  assert.equal(terminalProgressDescription({ state: "set", percent: 42 }), "42% done");
  assert.equal(terminalProgressDescription({ state: "set", percent: null }), "In progress");
  assert.equal(terminalProgressDescription({ state: "indeterminate", percent: null }), "In progress");
  assert.equal(terminalProgressDescription({ state: "error", percent: 80 }), "Error 80%");
  assert.equal(terminalProgressDescription({ state: "pause", percent: null }), "Paused");
});
