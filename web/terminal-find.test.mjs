import assert from "node:assert/strict";
import test from "node:test";
import { TerminalFindBar, terminalFindShortcut, terminalFindStatus } from "./terminal-find.mjs";
import { installTerminalSearchHighlights, terminalSearchHighlightAt, terminalSearchHighlightColors } from "./terminal-search-highlight.mjs";

test("find keys: Command on an Apple keyboard, Ctrl+Shift+F and F3 elsewhere", () => {
  const apple = (event) => terminalFindShortcut(event, { appleKeyboard: true });
  const other = (event) => terminalFindShortcut(event, { appleKeyboard: false });
  assert.equal(apple({ metaKey: true, key: "f" }), "open");
  assert.equal(apple({ metaKey: true, key: "F" }), "open", "Caps Lock");
  assert.equal(apple({ metaKey: true, key: "g" }), "older");
  assert.equal(apple({ metaKey: true, shiftKey: true, key: "G" }), "newer");
  assert.equal(apple({ metaKey: true, shiftKey: true, key: "F" }), null);
  assert.equal(apple({ ctrlKey: true, key: "f" }), null, "Ctrl+F is the shell's");
  assert.equal(apple({ metaKey: true, altKey: true, key: "f" }), null);
  assert.equal(other({ ctrlKey: true, shiftKey: true, key: "F" }), "open");
  assert.equal(other({ ctrlKey: true, key: "f" }), null, "Ctrl+F is the shell's");
  assert.equal(other({ key: "F3" }), "older");
  assert.equal(other({ shiftKey: true, key: "F3" }), "newer");
  assert.equal(other({ metaKey: true, key: "f" }), null);
  assert.equal(terminalFindShortcut(null), null);
});

test("the count reads from the oldest match", () => {
  assert.equal(terminalFindStatus(null), "");
  assert.equal(terminalFindStatus({ count: 0, selected: -1 }), "No matches");
  assert.equal(terminalFindStatus({ count: 12, selected: 0 }), "12 of 12", "the newest");
  assert.equal(terminalFindStatus({ count: 12, selected: 11 }), "1 of 12");
  assert.equal(terminalFindStatus({ count: 1, selected: -1 }), "1 match");
});

// Just enough DOM for the bar.
function fakeDocument() {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.value = ""; this.textContent = "";
      this.classList = { set: new Set(), toggle: (name, on) => (on ? this.classList.set.add(name) : this.classList.set.delete(name)), contains: (name) => this.classList.set.has(name) }; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type, event = {}) { const full = { preventDefault() { this.prevented = true; }, stopPropagation() {}, ...event }; for (const listener of this.listeners[type] || []) listener(full); return full; }
    focus() { fakeDocument.focused = this; }
    select() { this.selected = true; }
    remove() { this.removed = true; }
  }
  return { createElement: (tag) => new Node(tag) };
}

function fakeTerm() {
  const term = { searches: [], selects: [], listeners: new Set(), searchResults: null };
  term.onSearchChange = (listener) => { term.listeners.add(listener); return { dispose: () => term.listeners.delete(listener) }; };
  term.emit = (results) => { term.searchResults = results; for (const listener of term.listeners) listener(results); };
  term.search = (needle) => { term.searches.push(needle); term.emit(needle ? { needle, count: 3, selected: 0, matches: [] } : null); };
  term.searchSelect = (older) => { term.selects.push(older); return true; };
  return term;
}

test("the find bar searches as you type, moves with Enter and closes with Escape", () => {
  globalThis.document = fakeDocument();
  const timers = new Map(); let nextTimer = 0, closed = 0;
  const term = fakeTerm(), container = document.createElement("div");
  const bar = new TerminalFindBar({ term, container, onClose: () => closed++,
    schedule: (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer; },
    cancel: (id) => timers.delete(id) });
  try {
    assert.equal(container.children[0], bar.element);
    assert.equal(bar.isOpen, false);
    bar.open();
    assert.equal(bar.isOpen, true);
    assert.equal(fakeDocument.focused, bar.input);
    bar.input.value = "ne"; bar.input.dispatch("input");
    bar.input.value = "needle"; bar.input.dispatch("input");
    assert.equal(timers.size, 1, "typing waits for a pause");
    assert.deepEqual(term.searches, []);
    bar.input.dispatch("keydown", { key: "Enter" });
    assert.deepEqual(term.searches, ["needle"], "Enter runs a search the pause is still holding");
    assert.deepEqual(term.selects, [true], "and moves to the next older match");
    assert.equal(bar.status.textContent, "3 of 3");
    assert.equal(bar.olderButton.disabled, false);
    assert.equal(bar.newerButton.disabled, true, "nothing newer than the newest");
    bar.input.dispatch("keydown", { key: "Enter", shiftKey: true });
    assert.deepEqual(term.selects, [true, false]);
    term.emit({ needle: "needle", count: 0, selected: -1, matches: [] });
    assert.equal(bar.status.textContent, "No matches");
    assert.equal(bar.element.classList.contains("is-empty"), true);
    const escape = bar.input.dispatch("keydown", { key: "Escape" });
    assert.equal(escape.prevented, true);
    assert.equal(bar.isOpen, false);
    assert.equal(term.searches.at(-1), "", "closing ends the search");
    assert.equal(closed, 1);
    bar.open("selected text");
    assert.equal(bar.input.value, "selected text");
    assert.equal(term.searches.at(-1), "selected text", "a selection is searched at once");
    bar.close();
    bar.open();
    assert.equal(term.searches.at(-1), "selected text", "reopening searches the last text again");
    assert.equal(bar.input.selected, true);
    bar.olderButton.dispatch("click");
    assert.deepEqual(term.selects.at(-1), true);
  } finally {
    bar.dispose();
    assert.equal(term.listeners.size, 0);
    assert.equal(bar.element.removed, true);
    delete globalThis.document;
  }
});

test("search highlights: yellow matches, the selected one orange, dark text, a selection wins", () => {
  const rows = new Map([[2, [[3, 8, false], [12, 14, true]]]]);
  assert.equal(terminalSearchHighlightAt(rows, 3, 2), "match");
  assert.equal(terminalSearchHighlightAt(rows, 8, 2), "match");
  assert.equal(terminalSearchHighlightAt(rows, 9, 2), null);
  assert.equal(terminalSearchHighlightAt(rows, 11, 2, 2), "selected", "a wide character reaching into a match");
  assert.equal(terminalSearchHighlightAt(rows, 3, 1), null);
  assert.equal(terminalSearchHighlightAt(null, 3, 2), null);

  const drawn = [];
  class Renderer {
    constructor() { this.metrics = { width: 10, height: 20 }; this.ctx = { fillRect: (...args) => drawn.push(["fill", this.ctx.fillStyle, ...args]) }; this.selected = false; }
    isInSelection() { return this.selected; }
    renderCellBackground(cell, column, row) { drawn.push(["background", column, row]); }
    renderCellText(cell, column, row) { drawn.push(["text", cell.fg_r, cell.flags, column, row]); }
  }
  installTerminalSearchHighlights(Renderer);
  installTerminalSearchHighlights(Renderer);
  const r = new Renderer();
  const cell = { width: 1, fg_r: 200, fg_g: 200, fg_b: 200, flags: 16 | 1 };
  r.renderCellBackground(cell, 4, 2);
  r.renderCellText(cell, 4, 2);
  assert.deepEqual(drawn, [["background", 4, 2], ["text", 200, 17, 4, 2]], "ghostty-web's own paint without a search");
  drawn.length = 0;
  r.tesseraSearchRows = rows;
  r.renderCellBackground(cell, 4, 2);
  r.renderCellText(cell, 4, 2);
  r.renderCellBackground(cell, 13, 2);
  r.renderCellBackground(cell, 9, 2);
  assert.deepEqual(drawn, [
    ["fill", terminalSearchHighlightColors.match, 40, 40, 10, 20],
    ["text", 0, 1, 4, 2],
    ["fill", terminalSearchHighlightColors.selected, 130, 40, 10, 20],
    ["background", 9, 2],
  ], "dark text with inverse cleared, other flags kept");
  drawn.length = 0;
  r.selected = true;
  r.renderCellBackground(cell, 4, 2);
  r.renderCellText(cell, 4, 2);
  assert.deepEqual(drawn, [["background", 4, 2], ["text", 200, 17, 4, 2]], "the text selection shows instead");
});
