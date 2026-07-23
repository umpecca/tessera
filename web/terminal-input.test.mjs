import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalContextMenuFallback,
  TerminalMousePress,
  clearTerminalSelectionStartedDuringGesture,
  terminalMouseMessage,
} from "./terminal-input.mjs";

test("terminal mouse input is tagged separately from ordinary binary input", () => {
  const sequence = "\x1b[<32;53;17M";
  assert.deepEqual(JSON.parse(terminalMouseMessage(sequence)), {
    type: "mouse",
    data: sequence,
  });
});

test("terminal mouse press returns one matching release", () => {
  const press = new TerminalMousePress();
  press.begin(7, 2, { col: 10, row: 4 });
  assert.equal(press.matches(7), true);
  assert.equal(press.update(7, { col: 12, row: 5 }), true);
  assert.deepEqual(press.finish(7, { col: 13, row: 6 }), {
    pointerID: 7,
    buttonCode: 2,
    position: { col: 13, row: 6 },
  });
  assert.equal(press.finish(7), null);
});

test("terminal mouse cancellation reuses the last valid position", () => {
  const press = new TerminalMousePress();
  press.begin(9, 0, { col: 3, row: 8 });
  assert.equal(press.update(9, { col: 4, row: 9 }), true);
  assert.deepEqual(press.finish(9), {
    pointerID: 9,
    buttonCode: 0,
    position: { col: 4, row: 9 },
  });
});

test("terminal mouse state ignores another pointer and supports forced release", () => {
  const press = new TerminalMousePress();
  press.begin(11, 2, { col: 20, row: 2 });
  assert.equal(press.update(12, { col: 1, row: 1 }), false);
  assert.equal(press.finish(12), null);
  assert.deepEqual(press.finish(null), {
    pointerID: 11,
    buttonCode: 2,
    position: { col: 20, row: 2 },
  });
});

test("reported context menu clears only a selection started during its gesture", () => {
  let selected = true;
  let clears = 0;
  const term = {
    hasSelection: () => selected,
    clearSelection: () => {
      selected = false;
      clears += 1;
    },
  };

  assert.equal(clearTerminalSelectionStartedDuringGesture(term, false), true);
  assert.equal(clears, 1);

  selected = true;
  assert.equal(clearTerminalSelectionStartedDuringGesture(term, true), false);
  assert.equal(clearTerminalSelectionStartedDuringGesture(term, null), false);
  assert.equal(clears, 1);
});

test("reported context menu selection cleanup tolerates unsupported terminals", () => {
  assert.equal(clearTerminalSelectionStartedDuringGesture(null, false), false);
  assert.equal(clearTerminalSelectionStartedDuringGesture({}, false), false);
  assert.equal(clearTerminalSelectionStartedDuringGesture({
    hasSelection() {
      throw new Error("disposed");
    },
    clearSelection() {},
  }, false), false);
});

test("Safari context-menu-only gesture requests one terminal mouse fallback", () => {
  const fallback = new TerminalContextMenuFallback();
  assert.equal(fallback.needsFallback(2, 5000), true);
});

test("context menu does not duplicate a recent reported secondary press", () => {
  const fallback = new TerminalContextMenuFallback();
  fallback.notePress(2, 5000);
  assert.equal(fallback.needsFallback(2, 5050), false);
  assert.equal(fallback.needsFallback(2, 5060), true);
});

test("context menu ignores stale or non-secondary reported presses", () => {
  const fallback = new TerminalContextMenuFallback(1000);
  fallback.notePress(2, 5000);
  assert.equal(fallback.needsFallback(2, 7000), true);

  fallback.notePress(0, 8000);
  assert.equal(fallback.needsFallback(2, 8050), true);
});
