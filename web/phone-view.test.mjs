import assert from "node:assert/strict";
import test from "node:test";

import {
  PhoneView,
  normalizePhoneViewOverride,
  phoneCards,
  phoneFontShrink,
  phoneFontSize,
  phoneViewPathOverride,
  phoneInteractionModeStorageKey,
  normalizePhoneInteractionMode,
  readingLines,
  shortenDirectory,
  isPhoneDevice,
  shouldUsePhoneView,
  sortTerminalCards,
  terminalCardStatus,
} from "./phone-view.mjs";

test("the phone view follows the screen unless this browser chose a view", () => {
  assert.equal(shouldUsePhoneView({ width: 390, coarsePointer: true, override: "" }), true);
  assert.equal(shouldUsePhoneView({ width: 390, coarsePointer: false, override: "" }), false, "a narrow desktop window");
  assert.equal(shouldUsePhoneView({ width: 820, coarsePointer: true, override: "" }), false, "an iPad");
  assert.equal(shouldUsePhoneView({ width: 844, coarsePointer: true, override: "", phone: true }), true, "a phone turned sideways");
  assert.equal(shouldUsePhoneView({ width: 844, coarsePointer: true, override: "desktop", phone: true }), false, "unless it chose the desktop view");
  assert.equal(shouldUsePhoneView({ width: 390, coarsePointer: true, override: "desktop" }), false);
  assert.equal(shouldUsePhoneView({ width: 1440, coarsePointer: false, override: "phone" }), true);
  assert.equal(shouldUsePhoneView({ width: 390, coarsePointer: true, override: "tablet" }), true, "an unknown choice is no choice");
  assert.equal(normalizePhoneViewOverride("phone"), "phone");
  assert.equal(normalizePhoneViewOverride(null), "");
  assert.equal(phoneViewPathOverride("/m"), "phone");
  assert.equal(phoneViewPathOverride("/m/"), "phone");
  assert.equal(phoneViewPathOverride("/mobile"), "");
  assert.equal(phoneViewPathOverride("/users/default/sessions/m"), "");
});

test("directories in the host account's home folder start with ~", () => {
  assert.equal(shortenDirectory("/Users/me/src/tessera", "/Users/me"), "~/src/tessera");
  assert.equal(shortenDirectory("/Users/me", "/Users/me/"), "~");
  assert.equal(shortenDirectory("/Users/meg/src", "/Users/me"), "/Users/meg/src");
  assert.equal(shortenDirectory("/tmp", ""), "/tmp");
  assert.equal(shortenDirectory("", "/Users/me"), "");
  assert.equal(shortenDirectory(undefined, "/Users/me"), "");
});

test("a card says what its shell is doing", () => {
  assert.deepEqual(terminalCardStatus(null), { state: "closed", label: "Not running" });
  assert.deepEqual(terminalCardStatus({ exited: true, running: true }), { state: "exited", label: "Shell exited" });
  assert.deepEqual(terminalCardStatus({ running: true, command: "make all", runningSeconds: 250 }, 2),
    { state: "running", label: "make all · 4 min 12 s" });
  assert.deepEqual(terminalCardStatus({ running: true, command: "" }), { state: "running", label: "Running · 0 s" });
  assert.deepEqual(terminalCardStatus({ marksPrompts: true }), { state: "idle", label: "At the prompt" });
  assert.deepEqual(terminalCardStatus({ marksPrompts: true, lastCommand: { line: "npm test", status: 1, seconds: 3 } }),
    { state: "idle", label: "At the prompt · npm test failed (exit 1)" });
  assert.deepEqual(terminalCardStatus({ marksPrompts: true, lastCommand: { line: "ls", status: 0, seconds: 0 } }),
    { state: "idle", label: "At the prompt" });
  assert.deepEqual(terminalCardStatus({ outputSecondsAgo: 50 }, 10), { state: "quiet", label: "Output 1 min ago" });
  assert.deepEqual(terminalCardStatus({ outputSecondsAgo: -1 }), { state: "quiet", label: "No output yet" });
});

test("an alert nobody has seen comes first on the card", () => {
  const running = { running: true, command: "claude", runningSeconds: 9, marksPrompts: true };
  assert.deepEqual(terminalCardStatus({ ...running, alert: { kind: "notification", title: "Claude Code", body: "Claude needs your permission" } }),
    { state: "attention", label: "Claude Code: Claude needs your permission" });
  assert.deepEqual(terminalCardStatus({ ...running, alert: { kind: "notification", body: "Waiting" } }), { state: "attention", label: "Waiting" });
  assert.deepEqual(terminalCardStatus({ ...running, alert: { kind: "bell" } }), { state: "attention", label: "Bell" });
  assert.deepEqual(terminalCardStatus({ marksPrompts: true, alert: { kind: "command", title: "make all", status: 2, seconds: 252 } }),
    { state: "failed", label: "make all · failed (exit 2) after 4 min 12 s" });
  assert.deepEqual(terminalCardStatus({ marksPrompts: true, alert: { kind: "command", title: "", seconds: 7 } }),
    { state: "finished", label: "Command · finished after 7 s" });
  assert.deepEqual(terminalCardStatus({ marksPrompts: true, alert: { kind: "command", title: "x".repeat(80), status: 0 } }).label,
    `${"x".repeat(59)}… · finished`);
  assert.equal(terminalCardStatus({ ...running, alert: { kind: "unknown" } }).state, "running");
});

test("cards needing attention come first, then running shells, then the latest output", () => {
  const card = (title, state, outputSecondsAgo) => ({ title, status: { state }, summary: { outputSecondsAgo } });
  const sorted = sortTerminalCards([
    card("idle old", "idle", 600),
    card("quiet never", "quiet", -1),
    card("running", "running", 5),
    card("idle new", "idle", 2),
    card("failed", "failed", 900),
    card("exited", "exited", 1),
    card("attention", "attention", 30),
  ]);
  assert.deepEqual(sorted.map((c) => c.title), ["attention", "failed", "running", "idle new", "idle old", "quiet never", "exited"]);
});

test("cards combine the workspace's panes with the host's summaries", () => {
  const panes = [
    { id: "a", kind: "terminal", title: "Build", cwd: "/Users/me/old" },
    { id: "b", kind: "terminal", title: "", cwd: "/Users/me/src" },
    { id: "c", kind: "browser", title: "Docs" },
  ];
  const response = {
    home: "/Users/me",
    terminals: [
      { paneId: "a", running: true, command: "make", runningSeconds: 1, directory: "/Users/me/src/tessera", tail: ["cc foo.c"], outputSecondsAgo: 0, progress: { state: "set", percent: 40 } },
      { paneId: "z", running: true, tail: [] },
    ],
  };
  const { terminals, others } = phoneCards(panes, response);
  assert.deepEqual(others, [{ id: "c", kind: "browser", title: "Docs" }]);
  assert.equal(terminals.length, 2, "a shell with no pane is not listed");
  assert.deepEqual(terminals.map((c) => [c.id, c.title, c.directory, c.status.state]),
    [["a", "Build", "~/src/tessera", "running"], ["b", "Terminal", "~/src", "closed"]]);
  assert.deepEqual(terminals[0].tail, ["cc foo.c"]);
  assert.deepEqual(terminals[0].progress, { state: "set", percent: 40 });
  assert.equal(terminals[1].progress, null);
  assert.deepEqual(phoneCards(panes, null).terminals.map((c) => c.status.state), ["closed", "closed"], "before the first answer");
  const indeterminate = phoneCards(panes, { terminals: [{ paneId: "a", progress: { state: "indeterminate", percent: -1 } }] });
  assert.deepEqual(indeterminate.terminals[0].progress, { state: "indeterminate", percent: null });
});

class FakeElement {
  constructor(ownerDocument, tag) {
    this.ownerDocument = ownerDocument;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.className = "";
    this.textContent = "";
    this.classList = { toggle: (name, on) => { this.classes ??= new Set(); if (on) this.classes.add(name); else this.classes.delete(name); } };
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter((l) => l !== listener); }
  dispatch(type, event = {}) { for (const listener of this.listeners[type] || []) listener({ stopPropagation() {}, target: this, ...event }); }
  click() { this.dispatch("click"); }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  getBoundingClientRect() { return { bottom: 40, right: 380 }; }
  querySelector(selector) { return this.findAll((node) => node.tagName === selector.toUpperCase())[0] || null; }
  findAll(match) { const found = []; for (const child of this.children) { if (match(child)) found.push(child); found.push(...child.findAll(match)); } return found; }
  byClass(name) { return this.findAll((node) => node.className.split(" ").includes(name)); }
}

function fakeDocument() {
  const document = {
    hidden: false,
    listeners: {},
    createElement(tag) { return new FakeElement(document, tag); },
    addEventListener(type, listener) { (document.listeners[type] ??= []).push(listener); },
    removeEventListener(type, listener) { document.listeners[type] = (document.listeners[type] || []).filter((l) => l !== listener); },
  };
  document.documentElement = new FakeElement(document, "html");
  document.documentElement.clientWidth = 390;
  return document;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the phone view keeps one request waiting for changes, and opens terminals", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const document = fakeDocument();
  const root = new FakeElement(document, "div");
  const requests = [];
  const events = [];
  const panes = [{ id: "a", kind: "terminal", title: "Build" }, { id: "b", kind: "terminal", title: "Claude" }];
  const view = new PhoneView(root, {
    panes: () => panes,
    workspaceID: () => "work space",
    sessionName: () => "Main",
    onOpen: (id) => events.push(["open", id]),
    onBack: (id) => events.push(["back", id]),
    onInterrupt: (id) => events.push(["interrupt", id]),
    fetch: (url, options) => {
      const reply = deferred();
      requests.push({ url, options, reply });
      options.signal.addEventListener("abort", () => reply.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      return reply.promise;
    },
  });
  const answer = (index, body) => requests[index].reply.resolve({ ok: true, json: async () => body });

  view.enter();
  assert.equal(root.hidden, false);
  assert.equal(document.documentElement.dataset.phoneView, "inbox");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/workspace/work%20space/terminals");
  assert.equal(root.byClass("phone-session-button")[0].textContent, "Main");
  assert.equal(root.byClass("phone-list-status")[0].textContent, "Loading…");

  answer(0, { version: "v1", home: "/h", terminals: [{ paneId: "b", running: true, command: "claude", alert: { kind: "bell" }, tail: ["> hi"], outputSecondsAgo: 0 }] });
  await settle();
  assert.equal(requests.length, 2, "the next request goes out at once");
  assert.equal(requests[1].url, "/api/workspace/work%20space/terminals?version=v1");
  const cards = root.byClass("phone-card");
  assert.deepEqual(cards.map((card) => [card.dataset.paneId, card.dataset.state]), [["b", "attention"], ["a", "closed"]]);
  assert.equal(root.byClass("phone-card-tail")[0].textContent, "> hi");

  // The page goes into the background: the waiting request is dropped.
  document.hidden = true;
  for (const listener of document.listeners.visibilitychange) listener();
  assert.equal(requests[1].options.signal.aborted, true);
  document.hidden = false;
  for (const listener of document.listeners.visibilitychange) listener();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, "/api/workspace/work%20space/terminals", "coming back asks afresh");

  cards[0].byClass("phone-card-open")[0].click();
  assert.equal(view.openPaneID, "b");
  assert.equal(document.documentElement.dataset.phoneView, "terminal");
  assert.equal(root.byClass("phone-terminal-title")[0].textContent, "Claude");
  assert.equal(root.byClass("phone-terminal-state")[0].textContent, "claude · 0 s", "an open terminal's alert is seen");
  assert.deepEqual(events, [["open", "b"]]);

  const more = root.byClass("phone-terminal-header")[0].byClass("phone-icon-button").at(-1);
  more.click();
  const menu = root.byClass("phone-menu")[0];
  assert.deepEqual(menu.children.map((item) => item.textContent), ["Interrupt (Ctrl+C)", "Rename…", "Close…"]);
  menu.children[0].click();
  assert.equal(root.byClass("phone-menu").length, 0);

  root.byClass("phone-back")[0].click();
  assert.equal(view.openPaneID, "");
  assert.equal(document.documentElement.dataset.phoneView, "inbox");
  assert.deepEqual(events, [["open", "b"], ["interrupt", "b"], ["back", "b"]]);

  // A failed request is tried again later, without losing the list.
  requests.at(-1).reply.resolve({ ok: false, status: 502 });
  await settle();
  const count = requests.length;
  assert.equal(root.byClass("phone-card").length, 2);
  t.mock.timers.tick(1000);
  assert.equal(requests.length, count + 1);

  view.leave();
  assert.equal(root.hidden, true);
  assert.equal(document.documentElement.dataset.phoneView, undefined);
  assert.equal(requests.at(-1).options.signal.aborted, true);
});

test("phone menus toggle on the same trigger and outside pointerdown cannot reopen them", () => {
  const document = fakeDocument();
  const root = new FakeElement(document, "div");
  const view = new PhoneView(root, {
    panes: () => [{ id: "a", kind: "terminal", title: "Build" }],
    terminalView: () => ({ cols: 80, rows: 24, fitted: true }),
  });
  view.openPaneID = "a";
  const tap = button => {
    view.onOutsidePointer({ target: button });
    button.click();
  };
  tap(view.moreButton);
  assert.equal(root.byClass("phone-menu").length, 1);
  assert.equal(view.moreButton.getAttribute("aria-expanded"), "true");
  const icon = document.createElement("span");
  view.moreButton.append(icon);
  view.onOutsidePointer({ target: icon });
  assert.notEqual(view.menu, null, "pointerdown inside the trigger must wait for its toggle click");
  tap(view.moreButton);
  assert.equal(view.menu, null);
  assert.equal(view.moreButton.getAttribute("aria-expanded"), "false");
  tap(view.moreButton);
  tap(view.viewButton);
  assert.equal(root.byClass("phone-menu").length, 1, "another trigger replaces the menu");
  assert.equal(view.moreButton.getAttribute("aria-expanded"), "false");
  assert.equal(view.viewButton.getAttribute("aria-expanded"), "true");
  tap(view.viewButton);
  assert.equal(view.menu, null);
  tap(view.moreButton);
  view.onOutsidePointer({ target: view.menu.children[0] });
  assert.notEqual(view.menu, null, "menu items remain clickable");
  view.onOutsidePointer({ target: root });
  assert.equal(view.menu, null, "outside taps still dismiss");
  assert.equal(view.moreButton.getAttribute("aria-expanded"), "false");
});

test("card action menus still toggle after status polling replaces their button", () => {
  const document = fakeDocument();
  const root = new FakeElement(document, "div");
  const view = new PhoneView(root, { panes: () => [{ id: "a", kind: "terminal", title: "Build" }] });
  view.active = true;
  view.render();
  let more = root.byClass("phone-card-more")[0];
  more.click();
  const menu = view.menu;
  view.render();
  more = root.byClass("phone-card-more")[0];
  assert.equal(view.menuAnchor, more);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  view.onOutsidePointer({ target: more });
  assert.equal(view.menu, menu);
  more.click();
  assert.equal(view.menu, null);
  assert.equal(more.getAttribute("aria-expanded"), "false");
});

test("a closed pane takes its open terminal back to the list", () => {
  const document = fakeDocument();
  const root = new FakeElement(document, "div");
  const panes = [{ id: "a", kind: "terminal", title: "Build" }];
  const events = [];
  const view = new PhoneView(root, {
    panes: () => panes,
    workspaceID: () => "w",
    onOpen: (id) => events.push(["open", id]),
    onBack: (id) => events.push(["back", id]),
    fetch: () => new Promise(() => {}),
  });
  view.open("a");
  assert.equal(view.openPaneID, "", "nothing opens while the view is off");
  view.enter();
  view.open("a");
  panes.length = 0;
  view.panesChanged();
  assert.equal(view.openPaneID, "");
  assert.equal(document.documentElement.dataset.phoneView, "inbox");
  view.open("a");
  view.reset();
  assert.deepEqual(events, [["open", "a"], ["open", "a"], ["back", "a"]], "a new session goes back to its list");
  view.leave();
});

test("shells and panes that disagree are reported once, while the list shows", async () => {
  const document = fakeDocument();
  const root = new FakeElement(document, "div");
  const panes = [{ id: "a", kind: "terminal", title: "A" }, { id: "w", kind: "browser", title: "Web" }];
  const requests = [];
  let changed = 0;
  const view = new PhoneView(root, {
    panes: () => panes,
    workspaceID: () => "w",
    onShellsChanged: () => { changed += 1; },
    fetch: () => { const reply = deferred(); requests.push(reply); return reply.promise; },
  });
  const answer = async (terminals) => {
    requests.at(-1).resolve({ ok: true, json: async () => ({ version: String(requests.length), terminals }) });
    await settle();
  };
  view.enter();
  await answer([{ paneId: "a", tail: [] }]);
  assert.equal(changed, 0);
  await answer([{ paneId: "a", tail: [] }, { paneId: "desk-new", tail: [] }]);
  assert.equal(changed, 1, "the desk opened a window");
  await answer([{ paneId: "a", tail: ["more"] }, { paneId: "desk-new", tail: [] }]);
  assert.equal(changed, 1, "the same difference again");
  view.open("a");
  await answer([{ paneId: "desk-new", tail: [] }]);
  assert.equal(changed, 1, "not under an open terminal");
  view.back();
  await answer([{ paneId: "desk-new", tail: [] }]);
  assert.equal(changed, 2);
  panes.splice(0, 1, { id: "desk-new", kind: "terminal", title: "New" });
  await answer([{ paneId: "desk-new", tail: [] }]);
  await answer([{ paneId: "desk-new", tail: [] }, { paneId: "again", tail: [] }]);
  assert.equal(changed, 3, "agreement resets what was reported");
  view.leave();
});

test("text view rows join where the terminal wrapped them", () => {
  assert.deepEqual(readingLines([
    { text: "$ ls          ", continues: false },
    { text: "a-very-long-na", continues: false },
    { text: "me wrapped    ", continues: true },
    { text: "next line     ", continues: false },
    { text: "              ", continues: false },
    { text: "              ", continues: false },
  ]), ["$ ls", "a-very-long-name wrapped", "next line"]);
  assert.deepEqual(readingLines([{ text: "word ", continues: false }, { text: "next", continues: true }]), ["word next"], "the space at the wrap stays");
  assert.deepEqual(readingLines([{ text: "orphan", continues: true }]), ["orphan"], "a first row that continues one cut off");
  assert.deepEqual(readingLines([]), []);
});

test("fitting the font settles where whole-pixel cells would make it swing", () => {
  // Cells as the renderer makes them: whole pixels, rounding the face's width.
  const cellWidth = (size) => Math.round(size * 0.6);
  for (const columns of [20, 37, 45, 75, 80, 120, 153]) {
    const width = 374;
    let size = phoneFontSize({ columns, width, fontSize: 13, cellWidth: cellWidth(13), largest: 39 });
    const sizes = [size];
    for (let step = 0; step < 50; step++) {
      const next = phoneFontShrink({ columns, width, fontSize: size, cellWidth: cellWidth(size) });
      if (next === null) break;
      assert.ok(next < size, "only ever smaller");
      size = next;
      sizes.push(size);
    }
    assert.ok(sizes.length < 50, `${columns} columns never settled: ${sizes.join(", ")}`);
    assert.ok(columns * cellWidth(size) <= width || size === 4, `${columns} columns at ${size} overflow`);
  }
  assert.equal(phoneFontShrink({ columns: 37, width: 374, fontSize: 16, cellWidth: 10 }), null, "fits already");
  assert.equal(phoneFontShrink({ columns: 153, width: 374, fontSize: 4, cellWidth: 3 }), null, "at the floor");
});

test("the phone's font fits the shell's columns to its width", () => {
  // 160 columns at 13 px, 7.8 px a cell, into 374 px: 3.9 px, at least 4.
  assert.equal(phoneFontSize({ columns: 160, width: 374, fontSize: 13, cellWidth: 7.8 }), 4);
  // 60 columns into 374 px: 10.38… → 10.25.
  assert.equal(phoneFontSize({ columns: 60, width: 374, fontSize: 13, cellWidth: 7.8 }), 10.25);
  assert.equal(phoneFontSize({ columns: 60, width: 374, fontSize: 13, cellWidth: 7.8, zoom: 1.5 }), 15.5);
  assert.equal(phoneFontSize({ columns: 20, width: 374, fontSize: 13, cellWidth: 7.8, largest: 26 }), 26);
  assert.equal(phoneFontSize({ columns: 0, width: 374, fontSize: 13, cellWidth: 7.8 }), 13, "nothing measured yet");
});

test("the view menu shows the shell's size and switches screen, text, zoom and fit", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const document = fakeDocument();
  const root = new FakeElement(document, "div");
  const calls = [];
  let view = { cols: 160, rows: 48, fitted: false, zoom: 1, alternate: false };
  const stored = new Map([["tessera.phone-reading.v1", "screen"]]);
  const lines = ["one", "two"];
  const view$ = new PhoneView(root, {
    panes: () => [{ id: "a", kind: "terminal", title: "A" }],
    workspaceID: () => "w",
    fetch: () => new Promise(() => {}),
    terminalView: () => view,
    setZoom: (id, factor) => calls.push(["zoom", id, factor]),
    stepFontSize: (id, step) => calls.push(["font", id, step]),
    setFit: (id, on) => calls.push(["fit", id, on]),
    refreshTerminal: (id) => calls.push(["refresh", id]),
    readingText: () => (view.alternate ? null : lines),
    storage: { get: (key) => stored.get(key) ?? null, set: (key, value) => stored.set(key, value) },
  });
  view$.enter();
  view$.open("a");
  assert.ok(calls.some(([name]) => name === "refresh"));
  const viewButton = root.byClass("phone-view-button")[0];
  const items = () => root.byClass("phone-menu")[0].children.map((node) => [node.textContent, node.attributes["aria-checked"] ?? "", Boolean(node.disabled)]);
  viewButton.click();
  assert.deepEqual(items(), [
    ["Shell 160×48 · its own size", "", false],
    ["Screen", "true", false], ["Text", "false", false],
    ["Larger", "", false], ["Smaller", "", true],
    ["Fit to this phone", "false", false],
  ]);
  root.byClass("phone-menu")[0].children[3].click();
  assert.deepEqual(calls.at(-1), ["zoom", "a", 1.25]);

  viewButton.click();
  root.byClass("phone-menu")[0].children[2].click();
  const reading = root.byClass("phone-reading")[0];
  assert.equal(reading.hidden, false);
  assert.equal(reading.textContent, "one\ntwo");
  assert.equal(stored.get("tessera.phone-reading.v1"), "text", "remembered for this browser");

  view = { ...view, alternate: true };
  view$.renderReading();
  assert.equal(reading.hidden, true, "a full-screen program shows its screen");
  viewButton.click();
  assert.deepEqual(items()[2], ["Text (not for full-screen programs)", "false", true]);

  view = { cols: 45, rows: 30, fitted: true, zoom: 1, alternate: false, fontSize: 13 };
  viewButton.click();
  assert.equal(view$.menu, null, "the open menu toggles closed before reopening with updated size");
  viewButton.click();
  assert.deepEqual(items()[0], ["Shell 45×30 · fitted to this phone · 13px", "", false]);
  assert.deepEqual(items().slice(3, 5).map(([, , disabled]) => disabled), [false, false], "the terminal's own font size on this phone");
  root.byClass("phone-menu")[0].children[4].click();
  assert.deepEqual(calls.at(-1), ["font", "a", -1]);
  viewButton.click();
  root.byClass("phone-menu")[0].children[5].click();
  assert.deepEqual(calls.at(-1), ["fit", "a", false]);
  view$.back();
  assert.equal(reading.hidden, true);
  view$.leave();

  const fresh = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal", title: "A" }],
    workspaceID: () => "w",
    fetch: () => new Promise(() => {}),
    readingText: () => ["text first"],
    storage: { get: () => null, set() {} },
  });
  fresh.enter();
  fresh.open("a");
  assert.equal(fresh.readingView.hidden, true, "the screen is the default");
  fresh.leave();
});

test("a phone is a touch screen under 600 points on its shorter side", () => {
  assert.equal(isPhoneDevice({ coarsePointer: true, screenWidth: 390, screenHeight: 844 }), true);
  assert.equal(isPhoneDevice({ coarsePointer: true, screenWidth: 844, screenHeight: 390 }), true, "turned sideways");
  assert.equal(isPhoneDevice({ coarsePointer: true, screenWidth: 820, screenHeight: 1180 }), false, "an iPad");
  assert.equal(isPhoneDevice({ coarsePointer: false, screenWidth: 390, screenHeight: 844 }), false, "a small desktop screen");
  assert.equal(isPhoneDevice({ coarsePointer: true, screenWidth: 0, screenHeight: 0 }), false, "no screen size");
});

test("the phone backdrop follows the active terminal rather than the workspace theme", () => {
  const document = fakeDocument(), properties = new Map();
  document.documentElement.style.setProperty = (key, value) => properties.set(key, value);
  const colors = { a: "#000000", b: "#ffffff" };
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal" }, { id: "b", kind: "terminal" }],
    terminalView: id => ({ background: colors[id] }),
  });
  view.openPaneID = "a";
  view.renderTerminalHeader();
  assert.equal(properties.get("--phone-terminal-bg"), "#000000");
  colors.a = "#123456";
  view.measure();
  assert.equal(properties.get("--phone-terminal-bg"), "#123456", "keyboard measurements pick up program background changes");
  view.openPaneID = "b";
  view.renderTerminalHeader();
  assert.equal(properties.get("--phone-terminal-bg"), "#ffffff", "a light terminal must not get a hard-coded black backdrop");
  delete colors.b;
  view.renderTerminalHeader();
  assert.equal(properties.get("--phone-terminal-bg"), "var(--terminal-bg)");
});

test("the keyboard inset follows the viewport for a while after each change", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const saved = { innerHeight: globalThis.innerHeight, visualViewport: globalThis.visualViewport, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  t.after(() => Object.assign(globalThis, saved));
  const viewport = { height: 844, offsetTop: 0, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, removeEventListener() {} };
  let frames = [];
  Object.assign(globalThis, {
    innerHeight: 844,
    visualViewport: viewport,
    requestAnimationFrame: (callback) => frames.push(callback),
    cancelAnimationFrame: () => { frames = []; },
  });
  const runFrame = () => { const due = frames; frames = []; for (const callback of due) callback(); };
  const document = fakeDocument();
  const properties = {};
  document.documentElement.style = { setProperty: (name, value) => { properties[name] = value; } };
  const view = new PhoneView(new FakeElement(document, "div"), { panes: () => [], workspaceID: () => "w", fetch: () => new Promise(() => {}) });
  view.enter();

  viewport.height = 600;
  viewport.listeners.resize();
  assert.equal(properties["--phone-keyboard-inset"], "244px");

  // The keyboard goes, and iOS sends nothing more.
  document.listeners.focusout[0]();
  viewport.height = 844;
  runFrame();
  assert.equal(properties["--phone-keyboard-inset"], "0px", "a later frame sees it gone");
  t.mock.timers.tick(1100);
  runFrame();
  assert.equal(frames.length, 0, "and then stops measuring");
  view.leave();
});

test("compose focus holds the viewport until the keyboard close animation has settled", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const saved = { innerHeight: globalThis.innerHeight, visualViewport: globalThis.visualViewport, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  t.after(() => Object.assign(globalThis, saved));
  let frames = [];
  const viewport = { height: 844, offsetTop: 0, addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, { innerHeight: 844, visualViewport: viewport,
    requestAnimationFrame: callback => frames.push(callback), cancelAnimationFrame: () => { frames = []; } });
  const runFrame = () => { const due = frames; frames = []; for (const callback of due) callback(); };
  const document = fakeDocument(), holds = [], follows = [];
  document.documentElement.style.setProperty = () => {};
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal" }, { id: "b", kind: "terminal" }], workspaceID: () => "w",
    fetch: () => new Promise(() => {}), input: { sendKey() {}, sendText() {} },
    onComposeViewport: (...args) => holds.push(args), followComposeViewport: id => follows.push(id),
  });
  t.after(() => view.leave());
  view.enter(); view.open("a");
  view.onViewport({ type: "focusin", target: view.moreButton });
  assert.deepEqual(holds, [], "native/menu/terminal focus is not compose editing");
  view.input.field.focus();
  view.onViewport({ type: "focusin", target: view.input.field });
  assert.deepEqual(holds, [["a", true]]);
  viewport.height = 500;
  runFrame();
  assert.equal(view.keyboardInset, 344);
  assert.equal(follows.at(-1), "a", "the existing bitmap follows the visible viewport");
  view.input.field.blur();
  view.onViewport({ type: "focusout", target: view.input.field });
  t.mock.timers.tick(1100); runFrame();
  assert.equal(view.composePaneID, "a", "a delayed OS keyboard close must not release an intermediate grid");
  viewport.height = 844;
  view.onViewport();
  assert.equal(view.composePaneID, "a", "close has started but is not settled");
  t.mock.timers.tick(1100); runFrame();
  assert.equal(view.composePaneID, "");
  assert.deepEqual(holds, [["a", true], ["a", false]]);
  view.input.field.focus();
  view.onViewport({ type: "focusin", target: view.input.field });
  view.open("b");
  assert.deepEqual(holds.slice(-2), [["a", true], ["a", false]], "switching terminals cannot leave the old one held");
});

test("Select keeps the canvas visible, preserves Text preference and ends on pane changes", () => {
  const document = fakeDocument();
  const changes = [], stored = new Map();
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal", title: "A" }, { id: "b", kind: "terminal", title: "B" }],
    workspaceID: () => "w",
    fetch: () => new Promise(() => {}),
    input: { sendKey() {}, sendText() {} }, readingText: () => ["live text"],
    onSelectionChange: (...args) => changes.push(args),
    storage: { get: key => stored.get(key), set: (key, value) => stored.set(key, value) },
  });
  view.enter();
  view.setSelecting(true);
  assert.equal(view.selecting, false, "no terminal open");
  view.open("a");
  view.setReading(true);
  assert.equal(view.readingView.hidden, false);
  view.setSelecting(true);
  assert.equal(view.selecting, true);
  assert.equal(view.readingView.hidden, true);
  assert.equal(view.copyView, undefined, "no replacement text control");
  assert.equal(view.input.compose.hidden, true);
  assert.equal(view.input.selectionControls.hidden, false);
  assert.equal(document.documentElement.dataset.phoneSelecting, "true");
  assert.equal(document.activeElement, undefined, "Select does not focus an editable keyboard");
  view.renderTerminalHeader();
  view.renderReading();
  assert.equal(view.readingView.hidden, true, "polling cannot cover the canvas");
  view.setSelecting(false);
  assert.equal(view.readingView.hidden, false, "Text preference restored");
  assert.equal(view.input.compose.hidden, false);
  assert.equal(document.documentElement.dataset.phoneSelecting, undefined);
  view.setSelecting(true);
  view.open("b");
  assert.equal(view.selecting, false, "another terminal");
  assert.deepEqual(changes.at(-1), ["a", false], "cancel the old pane before switching");
  view.setSelecting(true);
  view.back();
  assert.equal(view.selecting, false, "back to the list");
  view.leave();
});

test("Select hides typing without losing drafts or disabling page anti-zoom", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const document = fakeDocument();
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal" }],
    terminalView: () => ({ fontSize: 10 }), input: { sendKey() {}, sendText() {} },
  });
  view.openPaneID = "a";
  view.input.direct = true;
  view.input.field.value = "unfinished draft";
  view.setSelecting(true);
  assert.equal(view.input.direct, false, "selection exits direct terminal typing without focusing compose");
  view.input.setDirect(true);
  assert.equal(view.input.direct, false);
  let prevented = 0;
  const event = { preventDefault: () => prevented++, touches: [], target: { closest: () => null } };
  view.onGesture(event);
  view.onTouchEnd(event);
  t.mock.timers.tick(100);
  view.onTouchEnd(event);
  assert.equal(prevented, 2, "canvas selection does not exempt page zoom guards");
  view.setSelecting(false);
  assert.equal(view.input.field.value, "unfinished draft");
  assert.equal(view.input.compose.hidden, false);
  assert.equal(document.documentElement.dataset.phoneSelecting, undefined);
  view.onGesture(event);
  assert.equal(prevented, 3);
});

test("Select puts Copy, Done and mouse-aware TUI scrolling in the existing compose row", () => {
  const document = fakeDocument(), properties = new Map(), calls = [];
  document.documentElement.style.setProperty = (key, value) => properties.set(key, value);
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal" }], terminalView: () => ({ alternate: true, mouseTracking: true }),
    input: { sendText() {}, sendKey() {} },
    onSelectionChange: () => calls.push("hold layout"),
    copySelection: id => calls.push(["copy", id]),
    scrollSelection: (id, direction) => calls.push([id, direction]),
  });
  view.openPaneID = "a";
  view.setSelecting(true);
  assert.equal(view.input.selectionScrollButtons[0].hidden, false);
  view.input.attach("a");
  view.input.element.offsetHeight = 100;
  view.measure();
  assert.equal(properties.get("--phone-input-height"), "100px");
  assert.equal(properties.get("--phone-base-input-height"), "100px");
  view.renderTerminalHeader();
  view.input.selectionScrollButtons[1].click();
  view.input.copyButton.click();
  assert.deepEqual(calls, ["hold layout", ["a", 1], ["copy", "a"]]);
  view.input.doneButton.click();
  assert.equal(view.selecting, false);
  assert.equal(view.input.selectionControls.hidden, true);
});

test("with the input area, the open terminal's buttons sit in its key row and the title heads its actions", () => {
  const document = fakeDocument();
  const root = new FakeElement(document, "div");
  const view = new PhoneView(root, {
    panes: () => [{ id: "a", kind: "terminal", title: "Build" }],
    workspaceID: () => "w",
    fetch: () => new Promise(() => {}),
    input: { sendText() {}, sendKey() {}, storage: { get: () => null, set() {}, remove() {} } },
  });
  view.enter();
  assert.equal(document.documentElement.dataset.phoneBar, "bottom");
  view.open("a");
  assert.equal(view.terminalHeader.hidden, true, "no bar across the top");
  assert.deepEqual(view.input.barStart.children.map((node) => node.attributes["aria-label"]), ["Back to terminals"]);
  assert.deepEqual(view.input.barEnd.children.map((node) => node.attributes["aria-label"]), ["Interaction mode; switch to scroll mode", "View", "Terminal actions"]);
  view.moreButton.click();
  const note = root.byClass("phone-menu-note")[0];
  assert.equal(note.textContent.startsWith("Build"), true);
  view.input.barStart.children[0].click();
  assert.equal(view.openPaneID, "");
  view.leave();
  assert.equal(document.documentElement.dataset.phoneBar, undefined);
});

test("Scroll mode hides input, keeps the toggle/back visible and preserves the draft and reading position", (t) => {
  const document = fakeDocument(), stored = new Map(), changes = [], sent = [];
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal", title: "Build" }], workspaceID: () => "w",
    fetch: () => new Promise(() => {}), onModeChange: (...args) => changes.push(args),
    storage: { get: key => stored.get(key), set: (key, value) => stored.set(key, value) },
    input: { sendText: (...args) => sent.push(args), sendKey: (...args) => sent.push(args),
      storage: { get: key => stored.get(key), set: (key, value) => stored.set(key, value), remove: key => stored.delete(key) } },
  });
  t.after(() => view.leave());
  view.enter(); view.open("a");
  view.input.field.value = "unfinished command";
  view.readingView.scrollTop = 123;
  let blurred = 0;
  document.activeElement = { blur() { blurred++; document.activeElement = null; } };
  view.modeButton.click();
  assert.equal(view.mode, "scroll");
  assert.equal(view.input.element.hidden, true);
  assert.equal(view.terminalHeader.hidden, false);
  assert.equal(view.modeButton.parent, view.terminalHeader);
  assert.equal(view.backButton.parent, view.terminalHeader);
  assert.equal(view.modeButton.getAttribute("aria-pressed"), "true");
  assert.equal(document.documentElement.dataset.phoneBar, undefined);
  assert.equal(document.documentElement.dataset.phoneMode, "scroll");
  assert.equal(blurred, 1);
  assert.equal(view.readingView.scrollTop, 123);
  assert.equal(stored.get(phoneInteractionModeStorageKey), "scroll");
  view.modeButton.click();
  assert.equal(view.mode, "interaction");
  assert.equal(view.input.element.hidden, false);
  assert.equal(view.terminalHeader.hidden, true);
  assert.equal(view.modeButton.parent, view.input.barEnd);
  assert.equal(document.activeElement, null, "returning never opens the keyboard");
  assert.equal(view.input.field.value, "unfinished command");
  assert.equal(view.readingView.scrollTop, 123);
  assert.deepEqual(changes, [["a", "scroll"], ["a", "interaction"]]);
  assert.deepEqual(sent, []);
  view.back();
  assert.equal(view.input.element.hidden, true);
  assert.equal(view.terminalHeader.hidden, true);
});

test("Scroll mode offers canvas selection and Copy/Done without showing typing controls or changing mode", () => {
  const document = fakeDocument(), calls = [], stored = new Map();
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal" }], workspaceID: () => "w", fetch: () => new Promise(() => {}),
    terminalView: () => ({ alternate: true, mouseTracking: true }),
    storage: { get: key => stored.get(key), set: (key, value) => stored.set(key, value) },
    copySelection: id => calls.push(["copy", id]), scrollSelection: (id, direction) => calls.push(["scroll", id, direction]),
    input: { sendKey: () => assert.fail("Scroll selection sent a key"), sendText() {} },
  });
  view.enter(); view.open("a");
  view.input.field.value = "keep draft";
  view.setMode("scroll");
  assert.equal(view.scrollSelectButton.hidden, false);
  view.scrollSelectButton.click();
  assert.equal(view.selecting, true);
  assert.equal(view.mode, "scroll", "selection must not force Interact");
  assert.equal(view.input.suspended, true);
  assert.equal(view.input.element.hidden, true, "typing controls remain hidden");
  assert.equal(view.pageControls.contains(view.input.selectionControls), true);
  assert.equal(view.input.selectionControls.hidden, false);
  assert.ok(view.pageButtons.every(button => button.hidden));
  view.input.copyButton.click();
  view.input.selectionScrollButtons[1].click();
  view.input.sendKey({ init: { key: "Enter" } });
  assert.deepEqual(calls, [["copy", "a"], ["scroll", "a", 1]]);
  assert.equal(document.activeElement === view.input.field, false);
  view.input.doneButton.click();
  assert.equal(view.mode, "scroll");
  assert.equal(view.selecting, false);
  assert.equal(view.scrollSelectButton.hidden, false);
  assert.equal(view.input.element.hidden, true);
  assert.equal(view.input.element.contains(view.input.selectionControls), true);
  assert.equal(view.input.field.value, "keep draft");
  view.setMode("interaction");
  assert.equal(view.input.element.hidden, false);
  assert.equal(document.activeElement === view.input.field, false);
  view.leave();
});

test("Scroll mode pages text locally with overlap and clamps at both ends", () => {
  const document = fakeDocument(), sent = [], pages = [];
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [], scrollPage: (...args) => pages.push(args),
    input: { sendKey: (...args) => sent.push(args), sendText: (...args) => sent.push(args) },
  });
  view.openPaneID = "a";
  view.mode = "scroll";
  view.renderMode();
  assert.equal(view.pageControls.hidden, false);
  assert.deepEqual(view.pageControls.children.map(button => button.textContent), ["Page Up", "Page Down", "Select"]);
  Object.assign(view.readingView, { hidden: false, clientHeight: 400, scrollHeight: 2000, scrollTop: 1000 });
  view.pageControls.children[0].click();
  assert.equal(view.readingView.scrollTop, 640);
  view.pageControls.children[1].click();
  assert.equal(view.readingView.scrollTop, 1000);
  view.readingView.scrollTop = 30;
  view.pageControls.children[0].click();
  assert.equal(view.readingView.scrollTop, 0);
  view.readingView.scrollTop = 1500;
  view.pageControls.children[1].click();
  assert.equal(view.readingView.scrollTop, 1600);
  assert.deepEqual(pages, []);
  assert.deepEqual(sent, [], "paging cannot send terminal keys or text");
});

test("page controls navigate canvas history only in Scroll mode and reserve their own space", () => {
  const document = fakeDocument(), pages = [], properties = new Map();
  document.documentElement.style.setProperty = (key, value) => properties.set(key, value);
  const view = new PhoneView(new FakeElement(document, "div"), { panes: () => [], scrollPage: (...args) => pages.push(args) });
  assert.equal(view.pageControls.hidden, true);
  view.openPaneID = "a";
  view.mode = "scroll";
  view.renderMode();
  view.pageControls.offsetHeight = 56;
  view.measure();
  assert.equal(properties.get("--phone-input-height"), "56px", "controls do not cover terminal content");
  view.pageControls.children[0].click();
  view.pageControls.children[1].click();
  assert.deepEqual(pages, [["a", -1], ["a", 1]]);
  view.mode = "interaction";
  view.renderMode();
  assert.equal(view.pageControls.hidden, true);
  view.pageControls.children[0].click();
  assert.equal(pages.length, 2, "late clicks cannot page outside Scroll mode");
  view.measure();
  assert.equal(properties.get("--phone-input-height"), "0px");
  view.mode = "scroll";
  view.renderMode();
  view.showInbox();
  assert.equal(view.pageControls.hidden, true);
  view.pageControls.children[1].click();
  assert.equal(pages.length, 2, "nothing pages after leaving the terminal");
});

test("the browser's Scroll mode choice is restored without showing keyboard controls", (t) => {
  const document = fakeDocument();
  const view = new PhoneView(new FakeElement(document, "div"), {
    panes: () => [{ id: "a", kind: "terminal", title: "A" }], workspaceID: () => "w",
    fetch: () => new Promise(() => {}), storage: { get: key => key === phoneInteractionModeStorageKey ? "scroll" : null },
    input: { sendKey() {}, sendText() {} },
  });
  t.after(() => view.leave());
  view.enter(); view.open("a");
  assert.equal(view.mode, "scroll");
  assert.equal(view.input.element.hidden, true);
  assert.equal(view.terminalHeader.hidden, false);
  assert.equal(normalizePhoneInteractionMode("invalid"), "interaction");
});

test("a quick second tap on nothing that takes taps doesn't reach iOS's zoom, but keys get both", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const document = fakeDocument();
  const view = new PhoneView(new FakeElement(document, "div"), { panes: () => [], workspaceID: () => "w", fetch: () => new Promise(() => {}) });
  view.enter();
  const gap = { closest: () => null };
  const key = { closest: (selector) => (selector.includes("button") ? key : null) };
  const tap = (target) => {
    let prevented = false;
    for (const listener of document.listeners.touchend) listener({ target, touches: [], preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(tap(gap), false, "a single tap");
  t.mock.timers.tick(200);
  assert.equal(tap(gap), true, "the second of a double-tap");
  t.mock.timers.tick(200);
  assert.equal(tap(key), false, "a key pressed twice is two keys");
  t.mock.timers.tick(1000);
  assert.equal(tap(gap), false, "taps a while apart");
  let pinched = false;
  for (const listener of document.listeners.gesturestart) listener({ preventDefault: () => { pinched = true; } });
  assert.equal(pinched, true, "a pinch is refused");
  view.leave();
  assert.equal(document.listeners.touchend.length, 0);
});

test("coming back puts the page where iOS may have left it scrolled or zoomed", (t) => {
  const saved = { scrollTo: globalThis.scrollTo, visualViewport: globalThis.visualViewport, requestAnimationFrame: globalThis.requestAnimationFrame, addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener };
  t.after(() => Object.assign(globalThis, saved));
  const scrolls = [];
  let frames = [];
  const listeners = {};
  Object.assign(globalThis, {
    scrollTo: (x, y) => scrolls.push([x, y]),
    visualViewport: { height: 844, offsetTop: 0, scale: 1.6, addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: (callback) => frames.push(callback),
    addEventListener: (type, listener) => { listeners[type] = listener; },
    removeEventListener: (type) => { delete listeners[type]; },
  });
  const document = fakeDocument();
  const content = "width=device-width, initial-scale=1, maximum-scale=1";
  const meta = { attributes: { content }, getAttribute(name) { return this.attributes[name]; }, setAttribute(name, value) { this.attributes[name] = value; } };
  document.querySelector = (selector) => (selector === 'meta[name="viewport"]' ? meta : null);
  const view = new PhoneView(new FakeElement(document, "div"), { panes: () => [], workspaceID: () => "w", fetch: () => new Promise(() => {}) });
  view.enter();

  document.hidden = true;
  for (const listener of document.listeners.visibilitychange) listener();
  assert.deepEqual(scrolls, [], "nothing moves while it is away");
  document.hidden = false;
  for (const listener of document.listeners.visibilitychange) listener();
  assert.deepEqual(scrolls, [[0, 0]]);
  assert.notEqual(meta.attributes.content, content, "a changed request drops the zoom");
  for (const callback of frames.splice(0)) callback();
  assert.equal(meta.attributes.content, content, "and the page's own request comes back");

  // Unzoomed, the request is left alone. A page restored from the back
  // cache comes back the same way.
  globalThis.visualViewport.scale = 1;
  listeners.pageshow();
  assert.deepEqual(scrolls, [[0, 0], [0, 0]]);
  assert.equal(meta.attributes.content, content);
  view.leave();
  assert.equal(listeners.pageshow, undefined);
});
