import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { placeWindowPaneBefore } from "./window-switcher.mjs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function setup() {
  const panes = ["build", "editor", "notes", "guide"].map(id => ({ id, kind: "worksheet", minimized: id === "notes" }));
  const rows = panes.map((pane, index) => {
    const classes = new Set();
    return {
      dataset: { paneId: pane.id },
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
      getBoundingClientRect: () => ({ top: 100 + index * 40, height: 40 }),
      querySelector: () => ({ focus: () => { globals.focused = pane.id; } }),
    };
  });
  let saves = 0;
  const globals = {
    rectangles: panes, windowListEntries: [...panes], windowListDrag: null,
    windowList: { hidden: false }, windowListItems: {
      querySelectorAll: selector => rows.filter(row => selector !== ".is-dragging" || row.classList.contains("is-dragging")),
      getBoundingClientRect: () => ({ left: 0, right: 100, top: 90, bottom: 290 }),
      classList: { add() {}, remove() {} },
      setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {}, scrollTop: 0,
    },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: callback => callback(),
    placeWindowPaneBefore, setWindowListSelection: index => { globals.selection = index; },
    finishWindowOrderMove: (pane, moved) => { if (moved) saves++; },
  };
  for (const name of ["startWindowListDrag", "clearWindowListDropIndicator", "clearWindowListDrag", "updateWindowListDrop", "updateWindowListDropIndicator", "scrollWindowListDrag", "dropWindowListEntry", "handleWindowListKeyboard"]) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf("\n}\n", start) + 2;
    vm.runInNewContext(source.slice(start, end), globals);
  }
  const event = (y, row = rows[0]) => ({ clientX: 50, clientY: y, currentTarget: row, button: 0, isPrimary: true, pointerId: 1, target: { closest: () => null },
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  return { globals, panes, rows, event, saves: () => saves };
}

test("dragging shows an insertion boundary and commits only on drop, with selection and focus retained", () => {
  const { globals: g, panes, rows, event, saves } = setup();
  const dragged = panes[0];
  g.startWindowListDrag(event(120), dragged);
  assert.equal(rows[0].classList.contains("is-dragging"), false);
  const over = event(225);
  g.updateWindowListDrop(over);
  assert.equal(over.prevented, true);
  assert.equal(g.selection, 0);
  assert.equal(rows[0].classList.contains("is-dragging"), true);
  assert.equal(rows[3].classList.contains("is-drop-before"), true);
  assert.deepEqual(panes.map(pane => pane.id), ["build", "editor", "notes", "guide"]);
  assert.equal(saves(), 0);
  g.dropWindowListEntry(over);
  assert.deepEqual(panes.map(pane => pane.id), ["editor", "notes", "build", "guide"]);
  assert.equal(saves(), 1);
  assert.equal(g.focused, "build");
  assert.equal(g.windowListDrag, null);
  assert.equal(rows.some(row => row.classList.contains("is-dragging") || row.classList.contains("is-drop-before")), false);
});

test("a minimized window can drop at the end without restoring it", () => {
  const { globals: g, panes, rows, event, saves } = setup();
  const notes = panes[2];
  g.startWindowListDrag(event(200, rows[2]), notes);
  g.updateWindowListDrop(event(280));
  assert.equal(rows[3].classList.contains("is-drop-after"), true);
  g.dropWindowListEntry(event(280));
  assert.equal(panes.at(-1), notes);
  assert.equal(notes.minimized, true);
  assert.equal(saves(), 1);
});

test("canceled, unchanged, external, and hidden-list drags never save or reorder", () => {
  const { globals: g, panes, rows, event, saves } = setup();
  const original = [...panes];
  const external = event(200);
  g.updateWindowListDrop(external);
  g.dropWindowListEntry(external);
  assert.equal(external.prevented, undefined);
  g.startWindowListDrag(event(120), panes[0]);
  g.updateWindowListDrop(event(280));
  g.clearWindowListDrag();
  g.dropWindowListEntry(event(280));
  g.startWindowListDrag(event(120), panes[0]);
  g.updateWindowListDrop(event(130));
  g.dropWindowListEntry(event(130)); // before its existing next neighbor
  g.startWindowListDrag(event(120), panes[0]);
  g.windowList.hidden = true;
  g.dropWindowListEntry(event(280));
  g.clearWindowListDrag();
  assert.deepEqual(panes, original);
  assert.equal(saves(), 0);
  assert.equal(rows.some(row => row.classList.contains("is-dragging") || row.classList.contains("is-drop-after")), false);
});

test("leaving the list clears insertion feedback without ending the drag", () => {
  const { globals: g, panes, rows, event } = setup();
  g.startWindowListDrag(event(120), panes[0]);
  g.updateWindowListDrop(event(280));
  g.clearWindowListDropIndicator();
  assert.equal(g.windowListDrag.valid, false);
  assert.equal(rows[0].classList.contains("is-dragging"), true);
  assert.equal(rows[3].classList.contains("is-drop-after"), false);
  g.updateWindowListDrop(event(100));
  assert.equal(rows[0].classList.contains("is-drop-before"), true);
});

test("small clicks and row buttons remain ordinary clicks; other pointers cannot finish a drag", () => {
  const { globals: g, panes, event, saves } = setup();
  const button = event(120);
  button.target.closest = () => ({});
  g.startWindowListDrag(button, panes[0]);
  assert.equal(g.windowListDrag, null);
  g.startWindowListDrag(event(120), panes[0]);
  g.updateWindowListDrop(event(123));
  g.dropWindowListEntry(event(123));
  assert.equal(g.windowListDrag, null);
  assert.equal(saves(), 0);
  g.startWindowListDrag(event(120), panes[0]);
  const otherPointer = { ...event(280), pointerId: 2 };
  g.updateWindowListDrop(otherPointer);
  assert.equal(g.windowListDrag.started, false);
  g.updateWindowListDrop(event(280));
  g.dropWindowListEntry(otherPointer);
  assert.equal(saves(), 0);
  assert.equal(g.windowListDrag.started, true);
});

test("Escape cancels without closing the list or committing on the subsequent release", () => {
  const { globals: g, panes, event, saves } = setup();
  const original = [...panes];
  g.startWindowListDrag(event(120), panes[0]);
  g.updateWindowListDrop(event(280));
  const escape = { key: "Escape", preventDefault() {}, stopPropagation() {} };
  g.handleWindowListKeyboard(escape);
  g.updateWindowListDrop(event(280));
  g.dropWindowListEntry(event(280));
  assert.deepEqual(panes, original);
  assert.equal(saves(), 0);
  assert.equal(g.windowList.hidden, false);
  assert.equal(g.windowListDrag, null);
});

test("edge scrolling runs only while the pointer is inside the list", () => {
  const { globals: g, panes, event } = setup();
  g.startWindowListDrag(event(120), panes[0]);
  g.updateWindowListDrop(event(280));
  g.scrollWindowListDrag();
  assert.equal(g.windowListItems.scrollTop, 6);
  g.updateWindowListDrop({ ...event(280), clientX: 150 });
  assert.equal(g.windowListDrag.valid, false);
  g.scrollWindowListDrag();
  assert.equal(g.windowListItems.scrollTop, 6);
});
