import assert from "node:assert/strict";
import test from "node:test";
import { adjustTerminalSelection, clearTerminalSelectionForTyping, terminalSelectionAdjustment } from "./terminal-selection-keys.mjs";

// A 6-column terminal: lines of text by absolute row, the first `scrollback`
// of them history, and a selection ending at end.
function terminal(lines, { scrollback = 0, rows = lines.length - scrollback, end, start = { col: 0, absoluteRow: 0 }, viewportY = 0 } = {}) {
  const cols = 6;
  const cells = (text = "") => Array.from({ length: cols }, (_, i) => ({ codepoint: text[i] && text[i] !== "." ? text.codePointAt(i) : 0 }));
  const scrolls = [], changes = [];
  const manager = {
    selectionStart: start, selectionEnd: end,
    hasSelection() { return Boolean(this.selectionStart && this.selectionEnd) && (this.selectionStart.col !== this.selectionEnd.col || this.selectionStart.absoluteRow !== this.selectionEnd.absoluteRow); },
    markCurrentSelectionDirty() {}, selectionChangedEmitter: { fire: () => changes.push(true) },
  };
  return {
    cols, rows, viewportY, selectionManager: manager, scrolls, changes,
    wasmTerm: {
      getScrollbackLength: () => scrollback,
      getScrollbackLine: (row) => cells(lines[row]),
      getLine: (row) => cells(lines[scrollback + row]),
    },
    smoothScrollTo(position) { scrolls.push(position); },
    requestRender() {},
    get end() { return manager.selectionEnd; },
  };
}

test("Shift alone with an arrow, Page Up/Down, Home or End is a selection adjustment", () => {
  const key = (key, extra = {}) => terminalSelectionAdjustment({ key, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...extra });
  assert.deepEqual(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].map((k) => key(k)),
    ["left", "right", "up", "down", "page_up", "page_down", "home", "end"]);
  assert.equal(key("Tab"), null);
  assert.equal(key("ArrowLeft", { shiftKey: false }), null);
  for (const modifier of ["ctrlKey", "altKey", "metaKey"]) assert.equal(key("ArrowLeft", { [modifier]: true }), null);
  assert.equal(terminalSelectionAdjustment(null), null);
});

test("left and right move to the previous or next cell with text, across rows", () => {
  const lines = ["ab..cd", "......", "ef...."];
  let t = terminal(lines, { end: { col: 1, absoluteRow: 0 } });
  assert.equal(adjustTerminalSelection(t, "right"), true);
  assert.deepEqual(t.end, { col: 4, absoluteRow: 0 }, "blank cells are skipped");
  adjustTerminalSelection(t, "right"); adjustTerminalSelection(t, "right");
  assert.deepEqual(t.end, { col: 0, absoluteRow: 2 }, "and blank rows, to the next line with text");
  adjustTerminalSelection(t, "left");
  assert.deepEqual(t.end, { col: 5, absoluteRow: 0 });
  t = terminal(lines, { start: { col: 1, absoluteRow: 2 }, end: { col: 0, absoluteRow: 0 } });
  adjustTerminalSelection(t, "left");
  assert.deepEqual(t.end, { col: 0, absoluteRow: 0 }, "nothing before it: it stays");
  assert.equal(t.changes.length, 1, "the selection still reports a change");
});

test("up and down move a row; down skips blank rows; the ends go to the line's ends", () => {
  const lines = ["ab....", "......", "ef....", "......"];
  const t = terminal(lines, { end: { col: 3, absoluteRow: 0 }, start: { col: 0, absoluteRow: 2 } });
  adjustTerminalSelection(t, "down");
  assert.deepEqual(t.end, { col: 3, absoluteRow: 2 }, "the blank row is skipped");
  adjustTerminalSelection(t, "down");
  assert.deepEqual(t.end, { col: 5, absoluteRow: 2 }, "no row with text below: end of the line");
  adjustTerminalSelection(t, "up"); adjustTerminalSelection(t, "up"); adjustTerminalSelection(t, "up");
  assert.deepEqual(t.end, { col: 0, absoluteRow: 0 }, "at the top: start of the line");
});

test("Page Up/Down move a screen; Home and End go to the start of history and the last text", () => {
  const lines = ["h0", "h1", "h2", "h3", "s0", "s1", "s2....", "......"];
  const t = terminal(lines, { scrollback: 4, rows: 4, end: { col: 2, absoluteRow: 5 }, start: { col: 1, absoluteRow: 4 } });
  adjustTerminalSelection(t, "page_up");
  assert.deepEqual(t.end, { col: 2, absoluteRow: 1 });
  assert.deepEqual(t.scrolls, [3], "scrolled back just far enough to show it");
  adjustTerminalSelection(t, "page_up");
  assert.deepEqual(t.end, { col: 0, absoluteRow: 0 }, "less than a screen left: Home");
  adjustTerminalSelection(t, "page_down");
  assert.deepEqual(t.end, { col: 0, absoluteRow: 4 });
  adjustTerminalSelection(t, "page_down");
  assert.deepEqual(t.end, { col: 5, absoluteRow: 6 }, "past the end: End, the last row with text");
  adjustTerminalSelection(t, "home");
  assert.deepEqual(t.end, { col: 0, absoluteRow: 0 });
  adjustTerminalSelection(t, "end");
  assert.deepEqual(t.end, { col: 5, absoluteRow: 6 });
});

test("the view scrolls toward a selection end below it", () => {
  const lines = ["h0", "h1", "h2", "h3", "s0", "s1", "s2", "s3"];
  const t = terminal(lines, { scrollback: 4, rows: 4, viewportY: 4, end: { col: 0, absoluteRow: 3 }, start: { col: 1, absoluteRow: 0 } });
  adjustTerminalSelection(t, "down");
  assert.deepEqual(t.end, { col: 0, absoluteRow: 4 });
  assert.deepEqual(t.scrolls, [3], "one row toward the bottom");
});

test("no selection, or a single-cell click, leaves the key to the program", () => {
  const lines = ["ab...."];
  assert.equal(adjustTerminalSelection(terminal(lines, { end: null }), "right"), false);
  assert.equal(adjustTerminalSelection(terminal(lines, { end: { col: 0, absoluteRow: 0 } }), "right"), false);
  assert.equal(adjustTerminalSelection(null, "right"), false);
});

test("typing clears the selection when the setting is on; modifiers alone do not", () => {
  let selected = true;
  const term = { hasSelection: () => selected, clearSelection() { selected = false; } };
  clearTerminalSelectionForTyping(term, { type: "keydown", key: "Shift" }, true);
  clearTerminalSelectionForTyping(term, { type: "keydown", key: "Meta" }, true);
  clearTerminalSelectionForTyping(term, { type: "keyup", key: "a" }, true);
  assert.equal(selected, true);
  clearTerminalSelectionForTyping(term, { type: "keydown", key: "a" }, false);
  assert.equal(selected, true, "setting off");
  clearTerminalSelectionForTyping(term, { type: "keydown", key: "a" }, true);
  assert.equal(selected, false);
});
