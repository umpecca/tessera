import assert from "node:assert/strict";
import test from "node:test";

import { adjacentWindowPane, windowSwitcherEntries } from "./window-switcher.mjs";

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
