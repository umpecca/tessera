import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { moveWindowPane } from "./window-switcher.mjs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function appFunction(name, globals) {
  globals.shortcutsUI ||= { element: { hidden: true } };
  globals.windowListDrag ??= null;
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, globals);
}
function overlays() {
  return Object.fromEntries(["settingsModal", "localHTTPSModal", "renameWindowModal", "sessionsModal", "sessionActionModal",
    "serverUpdateModal", "serverConnectionModal", "workspaceConflictModal", "helpModal", "directoryBrowser",
    "userSelect", "commandPalette", "commandWheel", "windowList"].map(name => [name, { hidden: true }]));
}
function keyboard(key, modifiers = {}) {
  return { key, ...modifiers, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

test("Ctrl/Cmd+Shift+Up/Down moves the active window and yields to overlays and ordinary editor keys", () => {
  const globals = overlays();
  const active = { id: "editor" }, moves = [];
  Object.assign(globals, { getActivePane: () => active, moveWindowInOrder: (pane, direction, options) => moves.push({ pane, direction, show: options.showSwitcher }) });
  const resolve = appFunction("paneShortcutAction", globals);
  resolve({ key: "ArrowUp", ctrlKey: true, shiftKey: true }).run();
  resolve({ key: "ArrowDown", metaKey: true, shiftKey: true }).run();
  assert.deepEqual(moves, [{ pane: active, direction: -1, show: true }, { pane: active, direction: 1, show: true }]);
  for (const keys of [{ key: "ArrowUp" }, { key: "ArrowUp", ctrlKey: true }, { key: "ArrowDown", shiftKey: true },
    { key: "ArrowUp", ctrlKey: true, shiftKey: true, altKey: true }]) assert.equal(resolve(keys), null);
  for (const overlay of Object.values(globals).filter(value => value?.hidden === true)) {
    overlay.hidden = false;
    assert.equal(resolve({ key: "ArrowUp", ctrlKey: true, shiftKey: true }), null);
    overlay.hidden = true;
  }
});

test("a move updates the open list and saves once, while boundary presses only show feedback", () => {
  const first = { id: "a", kind: "terminal", zIndex: 7 }, second = { id: "b", kind: "worksheet", zIndex: 9 };
  const rectangles = [first, second], feedback = [];
  let saves = 0, updates = 0;
  const status = { textContent: "" };
  const globals = {
    rectangles, moveWindowPane, windowList: { hidden: false }, windowListEntries: rectangles,
    windowListStatus: status, workspaceMenuLabel: pane => pane.id,
    updateDeskbar() { updates++; }, scheduleWorkspaceSave() { saves++; },
    showWindowSwitcher: options => feedback.push(options.includeMinimized),
  };
  globals.finishWindowOrderMove = appFunction("finishWindowOrderMove", globals);
  const move = appFunction("moveWindowInOrder", globals);
  assert.equal(move(second, -1, { showSwitcher: true }), true);
  assert.deepEqual(rectangles, [second, first]);
  assert.equal(saves, 1);
  assert.equal(updates, 1);
  assert.equal(status.textContent, "b moved to 1 of 2.");
  assert.equal(second.zIndex, 9);
  assert.equal(move(second, -1, { showSwitcher: true }), false);
  assert.equal(saves, 1);
  assert.deepEqual(feedback, [true, true]);
});

test("list shortcuts reorder the highlighted row and leave native button activation intact", () => {
  const first = { id: "a" }, second = { id: "b" }, moved = [], selected = [], focused = [];
  const panel = {};
  const handle = appFunction("handleWindowListKeyboard", {
    windowListPanel: panel, windowListEntries: [first, second], windowListSelection: 1,
    moveWindowInOrder: (pane, direction) => moved.push([pane, direction]),
    setWindowListSelection: index => selected.push(index),
    windowListItems: { querySelectorAll: () => [{ focus: () => focused.push(0) }, { focus: () => focused.push(1) }] },
    selectWindowListEntry: () => selected.push("open"), hideWindowList: () => selected.push("close"),
  });
  const moveUp = keyboard("ArrowUp", { ctrlKey: true, shiftKey: true });
  handle(moveUp);
  handle(keyboard("ArrowDown", { metaKey: true }));
  assert.deepEqual(moved, [[second, -1], [second, 1]]);
  assert.equal(moveUp.prevented, true);
  handle(keyboard("ArrowUp"));
  assert.deepEqual(selected, [0]);
  const nativeButton = keyboard("Enter", { target: {} });
  handle(nativeButton);
  assert.equal(nativeButton.prevented, undefined);
  handle(keyboard("Enter", { target: panel }));
  handle(keyboard("Escape"));
  assert.deepEqual(selected, [0, "open", "close"]);
});

test("window-list Tab containment wraps the enabled controls", () => {
  const document = { activeElement: null };
  const controls = [0, 1, 2].map(id => ({ id, focus() { document.activeElement = this; } }));
  const panel = { querySelectorAll: () => controls };
  const handle = appFunction("handleWindowListKeyboard", { document, windowListPanel: panel });
  document.activeElement = panel;
  handle(keyboard("Tab", { shiftKey: true }));
  assert.equal(document.activeElement, controls[2]);
  handle(keyboard("Tab"));
  assert.equal(document.activeElement, controls[0]);
  const normal = keyboard("Tab");
  handle(normal);
  assert.equal(normal.prevented, undefined);
});

test("the browser proxy relays reorder shortcuts while ordinary selection/navigation stays local", () => {
  const proxy = readFileSync(new URL("../internal/httpapi/browser_proxy.go", import.meta.url), "utf8");
  const start = proxy.indexOf("const relayKeys=");
  const script = proxy.slice(start).split("\n").slice(0, 2).join("\n");
  let handler;
  const posted = [];
  vm.runInNewContext(script, { addEventListener: (type, callback) => { handler = callback; }, parent: { postMessage: message => posted.push(message) } });
  for (const modifiers of [{ ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }]) {
    const event = keyboard("ArrowUp", modifiers);
    handler(event);
    assert.equal(event.prevented, true);
  }
  for (const modifiers of [{}, { ctrlKey: true }, { shiftKey: true }, { ctrlKey: true, shiftKey: true, altKey: true }]) {
    const event = keyboard("ArrowDown", modifiers);
    handler(event);
    assert.equal(event.prevented, undefined);
  }
  assert.equal(posted.length, 2);
  assert.equal(posted[0].key, "ArrowUp");
});
