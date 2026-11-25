import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalContextMenuFallback,
  TerminalMouseHover,
  TerminalMousePress,
  clearTerminalSelectionStartedDuringGesture,
  emptyTerminalCopyGuidance,
  isTerminalContextMenuGesture,
  terminalHoverButtonCode,
  terminalMouseCoordinates,
  terminalMouseMessage,
  terminalMouseSequence,
  terminalPasteText,
} from "./terminal-input.mjs";

test("macOS Control-primary-click is contextual while other link modifiers remain primary", () => {
  const controlClick = { button: 0, ctrlKey: true };
  assert.equal(isTerminalContextMenuGesture(controlClick, { appleKeyboard: true }), true);
  assert.equal(isTerminalContextMenuGesture(controlClick, { appleKeyboard: false }), false);
  assert.equal(isTerminalContextMenuGesture({ button: 0, metaKey: true }, { appleKeyboard: true }), false);
  assert.equal(isTerminalContextMenuGesture({ button: 0, shiftKey: true }, { appleKeyboard: true }), false);
  assert.equal(isTerminalContextMenuGesture({ button: 2 }), true);
});

test("an empty copy inside a mouse-aware program names both ways to copy", () => {
  const inside = emptyTerminalCopyGuidance(true);
  // The override modifier is the only way to select there, and it is invisible.
  assert.match(inside, /Shift/);
  assert.match(inside, /own copy key/);

  const outside = emptyTerminalCopyGuidance(false);
  // Ordinary dragging already selects, so the override would be misleading.
  assert.doesNotMatch(outside, /Shift/);
  assert.match(outside, /Drag/);
});

test("pasted text keeps its content but never its own bracketed paste markers", () => {
  assert.equal(terminalPasteText("plain text"), "plain text");
  assert.equal(terminalPasteText("first\nsecond\r\nthird"), "first\nsecond\r\nthird");
  assert.equal(
    terminalPasteText("safe\x1b[201~rm -rf /\x1b[200~more"),
    "saferm -rf /more",
  );
  assert.equal(terminalPasteText(""), "");
  assert.equal(terminalPasteText(null), "");
});

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

test("terminal mouse hover reports motion once per cell, and again after a reset", () => {
  const hover = new TerminalMouseHover();
  assert.equal(hover.move({ col: 3, row: 2 }), true);
  assert.equal(hover.move({ col: 3, row: 2 }), false);
  assert.equal(hover.move({ col: 4, row: 2 }), true);
  assert.equal(hover.move({ col: 4, row: 3 }), true);
  hover.reset();
  assert.equal(hover.move({ col: 4, row: 3 }), true, "re-entering the pane reports the cell");
  assert.equal(terminalHoverButtonCode, 35);
});

test("terminal mouse press reports a drag once per cell", () => {
  const press = new TerminalMousePress();
  press.begin(5, 0, { col: 5, row: 5 });
  assert.equal(press.update(5, { col: 5, row: 5 }), false);
  assert.equal(press.update(5, { col: 6, row: 5 }), true);
  assert.equal(press.update(5, { col: 6, row: 5 }), false);
  assert.equal(press.update(5, { col: 6, row: 4 }), true);
  assert.deepEqual(press.finish(5).position, { col: 6, row: 4 });
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

test("mouse reports use cells, or host pixels while the program has mode 1016 set", () => {
  let pixels = false;
  const term = { cols: 80, rows: 24, hostCellWidth: 9, hostCellHeight: 18,
    getMode: (mode, ansi) => mode === 1016 && ansi === false && pixels,
    renderer: { getMetrics: () => ({ width: 7.6, height: 15.2 }) } };
  // The middle of cell (11, 6): 10.5 cells across, 5.5 cells down.
  const fx = 10.5 / 80, fy = 5.5 / 24;
  assert.deepEqual(terminalMouseCoordinates(term, fx, fy), { col: 11, row: 6 });
  assert.equal(terminalMouseSequence(0, terminalMouseCoordinates(term, fx, fy), "M"), "\x1b[<0;11;6M");

  pixels = true;
  const position = terminalMouseCoordinates(term, fx, fy);
  assert.deepEqual(position, { col: 11, row: 6, x: 95, y: 100 });
  assert.equal(terminalMouseSequence(32, position, "M"), "\x1b[<32;95;100M");
  // Textual maps a pixel back to a cell as (pixel - 1) / cell size.
  assert.equal(Math.floor((position.x - 1) / 9) + 1, 11);
  assert.equal(Math.floor((position.y - 1) / 18) + 1, 6);

  // 1-based and clamped: Textual drops negative positions.
  assert.deepEqual(terminalMouseCoordinates(term, 0, 0), { col: 1, row: 1, x: 1, y: 1 });
  assert.deepEqual(terminalMouseCoordinates(term, -0.1, 1.2), { col: 1, row: 24, x: 1, y: 432 });

  // Before the host has sent geometry, the local cell size, as sent in resizes.
  delete term.hostCellWidth; delete term.hostCellHeight;
  assert.deepEqual(terminalMouseCoordinates(term, 1, 1), { col: 80, row: 24, x: 640, y: 360 });

  term.getMode = () => { throw new Error("disposed"); };
  assert.deepEqual(terminalMouseCoordinates(term, fx, fy), { col: 11, row: 6 });
});
