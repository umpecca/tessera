import assert from "node:assert/strict";
import test from "node:test";

import {
  PhoneView,
  normalizePhoneViewOverride,
  phoneCards,
  phoneFontShrink,
  phoneFontSize,
  phoneViewPathOverride,
  readingLines,
  shortenDirectory,
  shouldUsePhoneView,
  sortTerminalCards,
  terminalCardStatus,
} from "./phone-view.mjs";

test("the phone view follows the screen unless this browser chose a view", () => {
  assert.equal(shouldUsePhoneView({ width: 390, coarsePointer: true, override: "" }), true);
  assert.equal(shouldUsePhoneView({ width: 390, coarsePointer: false, override: "" }), false, "a narrow desktop window");
  assert.equal(shouldUsePhoneView({ width: 820, coarsePointer: true, override: "" }), false, "an iPad");
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
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter((l) => l !== listener); }
  dispatch(type, event = {}) { for (const listener of this.listeners[type] || []) listener({ stopPropagation() {}, target: this, ...event }); }
  click() { this.dispatch("click"); }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  focus() {}
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

test("the view menu shows the shell's size and switches screen, text, zoom and fit", () => {
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

  view = { cols: 45, rows: 30, fitted: true, zoom: 1, alternate: false };
  viewButton.click();
  assert.deepEqual(items()[0], ["Shell 45×30 · fitted to this phone", "", false]);
  assert.equal(items()[3][2], true, "no zoom while fitted");
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
  assert.equal(fresh.readingView.hidden, false, "text is the default");
  fresh.leave();
});
