import { featureFixture } from "./application.test-support.mjs";
import { createBrowser } from "./browser-view.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { terminalFindShortcut } from "./terminal-find.mjs";

function appFunction(name, globals = {}) {
  globals.shortcutsUI ||= { element: { hidden: true } };
  globals.screensaver ||= { element: { hidden: true } };
  globals.saveClipboardDialog ||= { element: { hidden: true }, close() {} };
  globals.terminalFindShortcut ||= terminalFindShortcut;
  globals.appleKeyboardLayout ??= false;
  const fixtureContext = featureFixture([name], globals);
  return fixtureContext[name];
}
function overlays() {
  return Object.fromEntries(["settingsModal", "localHTTPSModal", "renameWindowModal", "sessionsModal", "sessionActionModal",
    "serverUpdateModal", "serverConnectionModal", "workspaceConflictModal", "helpModal", "directoryBrowser",
    "userSelect", "commandPalette", "windowList", "sessionList"].map(name => [name, { hidden: true }]));
}
function keyboard(key, modifiers = {}) {
  return { key, ...modifiers, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this.className = "";
    this.classList = { toggle: (name, on) => { this[`class:${name}`] = on; } };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  contains() { return false; }
  scrollIntoView() {}
  focus() {}
  querySelectorAll(selector) {
    const className = selector.slice(1);
    const found = [];
    const visit = node => {
      for (const child of node.children || []) {
        if (child.className?.split(" ").includes(className)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function renderHarness(sessions, currentSessionID) {
  const items = new Element("div");
  const globals = {
    sessions, currentSessionID, sessionListItems: items, sessionListEntries: [], sessionListSelection: 0,
    document: { activeElement: null, createElement: tag => new Element(tag) },
    selectSessionListEntry: index => globals.opened.push(index), opened: [],
  };
  globals.setSessionListSelection = appFunction("setSessionListSelection", globals);
  const render = appFunction("renderSessionList", globals);
  const selectedName = () => items.children.find(row => row["class:is-selected"])?.children[0].textContent;
  return { render, items, globals, selectedName };
}

test("Ctrl/Cmd+; toggles the session list and other window shortcuts yield while it is open", () => {
  const globals = overlays();
  let toggles = 0, adjacent = 0;
  Object.assign(globals, {
    toggleSessionList: () => toggles++, toggleWindowList() {}, toggleCommandPalette() {},
    focusAdjacentPane: () => adjacent++,
  });
  const resolve = appFunction("paneShortcutAction", globals);
  resolve({ key: ";", ctrlKey: true }).run();
  resolve({ key: ";", metaKey: true }).run();
  // Layouts without a ; key on the Semicolon position still reach it by code.
  resolve({ key: "ö", code: "Semicolon", ctrlKey: true }).run();
  assert.equal(toggles, 3);
  for (const keys of [{ key: ";" }, { key: ";", ctrlKey: true, repeat: true }, { key: ";", ctrlKey: true, altKey: true },
    { key: ";", ctrlKey: true, shiftKey: true }, { key: ";", ctrlKey: true, isComposing: true }]) {
    assert.equal(resolve(keys), null);
  }
  globals.sessionList.hidden = false;
  resolve({ key: ";", ctrlKey: true }).run();
  assert.equal(toggles, 4);
  assert.equal(resolve({ key: "]", ctrlKey: true }), null);
  assert.equal(adjacent, 0);
  assert.ok(resolve({ key: "l", ctrlKey: true }), "Ctrl/Cmd+L still opens the window list");
});

test("a fresh list selects the previous session and marks the current one", () => {
  const { render, items, selectedName } = renderHarness(
    [{ id: "work", name: "Work" }, { id: "home", name: "Home" }, { id: "lab", name: "Lab" }], "work");
  render(null);
  assert.deepEqual(items.children.map(row => row.children[0].textContent), ["1. Work", "2. Home", "3. Lab"]);
  assert.equal(selectedName(), "2. Home");
  assert.equal(items.children[0].children[1].textContent, "Current");
  assert.equal(items.children[0].children[0].attributes["aria-label"], "1. Work (current)");
  assert.equal(items.children[1].children.length, 1);
});

test("a refresh keeps the highlighted session even when the order changes", () => {
  const sessions = [{ id: "work", name: "Work" }, { id: "home", name: "Home" }, { id: "lab", name: "Lab" }];
  const { render, globals, selectedName } = renderHarness(sessions, "work");
  render(null);
  render("lab");
  assert.equal(selectedName(), "3. Lab");
  globals.sessions.reverse();
  render("lab");
  assert.equal(selectedName(), "1. Lab");
  render("gone");
  assert.equal(selectedName(), "1. Lab", "a vanished selection falls back to the most recent other session");
});

test("a single session selects itself and an empty list says so", () => {
  const single = renderHarness([{ id: "work", name: "Work" }], "work");
  single.render(null);
  assert.equal(single.selectedName(), "1. Work");
  const empty = renderHarness([], "");
  empty.render(null);
  assert.equal(empty.items.children[0].textContent, "No sessions");
});

test("choosing a session switches to it, and choosing the current one only closes the list", () => {
  const switched = [];
  let hidden = 0;
  const work = { id: "work", name: "Work" }, home = { id: "home", name: "Home" };
  const select = appFunction("selectSessionListEntry", {
    sessionListEntries: [work, home], sessionListSelection: 1, currentSessionID: "work",
    hideSessionList: () => hidden++, switchSession: session => switched.push(session),
  });
  select();
  select(0);
  select(5);
  assert.deepEqual(switched, [home]);
  assert.equal(hidden, 2);
});

test("list keys move the highlight, open from the panel, and leave native button activation intact", () => {
  const panel = {}, events = [], focused = [];
  const handle = appFunction("handleSessionListKeyboard", {
    sessionListPanel: panel, sessionListSelection: 1,
    setSessionListSelection: index => events.push(index),
    sessionListItems: { querySelectorAll: () => [{ focus: () => focused.push(0) }, { focus: () => focused.push(1) }, { focus: () => focused.push(2) }] },
    selectSessionListEntry: () => events.push("open"), hideSessionList: () => events.push("close"),
  });
  const down = keyboard("ArrowDown");
  handle(down);
  handle(keyboard("ArrowUp"));
  assert.equal(down.prevented, true);
  assert.deepEqual(events, [2, 0]);
  const reorder = keyboard("ArrowUp", { ctrlKey: true });
  handle(reorder);
  assert.equal(reorder.prevented, undefined, "sessions have no manual order to change");
  const nativeButton = keyboard("Enter", { target: {} });
  handle(nativeButton);
  assert.equal(nativeButton.prevented, undefined);
  handle(keyboard("Enter", { target: panel }));
  handle(keyboard("Escape"));
  assert.deepEqual(events, [2, 0, "open", "close"]);
});

test("Browser panes and the browser proxy relay Ctrl/Cmd+; out of the page", () => {
  const browser = createBrowser({});
  browser.initializeBrowserPaneKind();
  assert.ok(browser.browserPaneRelayedKeys.has(";") && browser.browserPaneRelayedKeys.has("Semicolon"), "Browser panes relay Ctrl/Cmd+;");
  const proxy = readFileSync(new URL("../internal/httpapi/browser_proxy.go", import.meta.url), "utf8");
  const start = proxy.indexOf("const relayKeys=");
  const script = proxy.slice(start).split("\n").slice(0, 2).join("\n");
  let handler;
  const posted = [];
  vm.runInNewContext(script, { addEventListener: (type, callback) => { handler = callback; }, top: { postMessage: message => posted.push(message) } });
  const event = keyboard(";", { ctrlKey: true, code: "Semicolon" });
  handler(event);
  handler(keyboard(";"));
  assert.equal(event.prevented, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].code, "Semicolon");
});
