import assert from "node:assert/strict";
import test from "node:test";

import { adjacentWindowPane, moveWindowPane, placeWindowPaneBefore, windowSwitcherEntries } from "./window-switcher.mjs";

function pane(id, options = {}) {
  return {
    id,
    kind: options.kind || "terminal",
    minimized: Boolean(options.minimized),
    title: options.title || "",
  };
}

test("lists visible windows in cycling order with names and positions", () => {
  const panes = [
    pane("one", { title: "Build" }),
    pane("hidden", { minimized: true }),
    pane("pending", { kind: "pending" }),
    pane("four"),
  ];

  const entries = windowSwitcherEntries(panes, "four");

  assert.deepEqual(entries.map(({ id, name, position, total, active }) => ({ id, name, position, total, active })), [
    { id: "one", name: "Build", position: 1, total: 2, active: false },
    { id: "four", name: "Window 4", position: 2, total: 2, active: true },
  ]);
});

test("trims persisted names and marks no entry for an unknown active pane", () => {
  const entries = windowSwitcherEntries([pane("one", { title: "  Editor  " })], "missing");

  assert.equal(entries[0].name, "Editor");
  assert.equal(entries[0].active, false);
});

test("adjacent selection follows the visible order and wraps both ways", () => {
  const first = pane("first");
  const minimized = pane("minimized", { minimized: true });
  const second = pane("second");
  const panes = [first, minimized, second];

  assert.equal(adjacentWindowPane(panes, first, 1), second);
  assert.equal(adjacentWindowPane(panes, second, 1), first);
  assert.equal(adjacentWindowPane(panes, first, -1), second);
  assert.equal(adjacentWindowPane([], first, 1), null);
});

test("cycling preserves the existing first-window start when none is active", () => {
  const first = pane("first");
  const last = pane("last");

  assert.equal(adjacentWindowPane([first, last], null, 1), first);
  assert.equal(adjacentWindowPane([first, last], null, -1), first);
});

test("moving a window changes cycling order while preserving pane state and pending slots", () => {
  const first = pane("first");
  const pending = pane("drawing", { kind: "pending" });
  const second = pane("second", { title: "Editor" });
  const third = pane("third");
  Object.assign(second, { zIndex: 12, x: 45, y: 70, text: "unsaved contents" });
  const panes = [first, pending, second, third];
  assert.equal(moveWindowPane(panes, second, -1), true);
  assert.deepEqual(panes, [second, pending, first, third]);
  assert.equal(adjacentWindowPane(panes, second, 1), first);
  assert.equal(panes[0], second);
  assert.equal(second.zIndex, 12);
  assert.equal(second.x, 45);
  assert.equal(second.text, "unsaved contents");
  assert.equal(moveWindowPane(panes, second, 1), true);
  assert.deepEqual(panes, [first, pending, second, third]);
});

test("reordering stops at boundaries and rejects missing, pending, or invalid moves", () => {
  const first = pane("first"), last = pane("last"), pending = pane("pending", { kind: "pending" });
  const panes = [pending, first, last, pending];
  for (const [target, direction] of [[first, -1], [last, 1], [pending, 1], [pane("absent"), 1], [first, 0], [null, 1]]) {
    assert.equal(moveWindowPane(panes, target, direction), false);
    assert.deepEqual(panes, [pending, first, last, pending]);
  }
  assert.equal(moveWindowPane([], first, 1), false);
});

test("minimized windows can be reordered and retain their place when restored", () => {
  const first = pane("first"), minimized = pane("hidden", { minimized: true }), last = pane("last");
  const panes = [first, minimized, last];
  assert.equal(moveWindowPane(panes, minimized, 1), true);
  assert.deepEqual(windowSwitcherEntries(panes, "first").map(entry => entry.id), ["first", "last"]);
  assert.deepEqual(windowSwitcherEntries(panes, "first", { includeMinimized: true }).map(entry => entry.id), ["first", "last", "hidden"]);
  minimized.minimized = false;
  assert.equal(adjacentWindowPane(panes, last, 1), minimized);
  assert.equal(adjacentWindowPane(panes, minimized, 1), first);
});

test("drag insertion moves across multiple windows in either direction and preserves pending slots", () => {
  const first = pane("first"), second = pane("second"), hidden = pane("hidden", { minimized: true }), last = pane("last");
  const pending = pane("drawing", { kind: "pending" });
  Object.assign(first, { zIndex: 8, x: 123, text: "working text" });
  const panes = [first, pending, second, hidden, last];
  assert.equal(placeWindowPaneBefore(panes, first, last), true);
  assert.deepEqual(panes, [second, pending, hidden, first, last]);
  assert.equal(placeWindowPaneBefore(panes, last, second), true);
  assert.deepEqual(panes, [last, pending, second, hidden, first]);
  assert.equal(placeWindowPaneBefore(panes, hidden, null), true);
  assert.deepEqual(panes, [last, pending, second, first, hidden]);
  assert.equal(hidden.minimized, true);
  assert.equal(first.zIndex, 8);
  assert.equal(first.x, 123);
  assert.equal(first.text, "working text");
});

test("dragging to the same position or an invalid anchor leaves the array intact", () => {
  const first = pane("first"), last = pane("last"), pending = pane("drawing", { kind: "pending" });
  const panes = [first, pending, last];
  for (const [item, before] of [[first, first], [first, last], [last, null], [pending, first],
    [null, last], [pane("removed"), first], [first, pending], [first, undefined], [first, pane("removed")]]) {
    assert.equal(placeWindowPaneBefore(panes, item, before), false);
    assert.deepEqual(panes, [first, pending, last]);
  }
});
