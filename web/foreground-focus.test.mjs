import assert from "node:assert/strict";
import test from "node:test";
import { createForegroundFocus } from "./foreground-focus.mjs";
import { createEvents } from "./application-events.mjs";

function fixture({ native = false, installed = true } = {}) {
  const doc = new EventTarget(), win = new EventTarget(), timers = new Map();
  let timerID = 0, focused = true, active, overlays = [], workspaceID = "workspace", focusCalls = 0;
  const node = parent => ({ isConnected: true, hidden: false, parent,
    closest() { return this.hidden ? this : null; },
    getClientRects() { return this.isConnected && !this.hidden ? [{}] : []; },
    contains(target) { return target === this || target?.parent === this; },
    focus() { doc.activeElement = this; },
  });
  doc.body = node(); doc.documentElement = node(); doc.activeElement = doc.body;
  doc.hidden = false; doc.hasFocus = () => focused; doc.querySelectorAll = () => overlays;
  Object.assign(win, { tesseraNativeDevice: native ? "ipad" : undefined,
    navigator: { standalone: installed }, matchMedia: () => ({ matches: installed }),
    setTimeout(callback) { timers.set(++timerID, callback); return timerID; },
    clearTimeout(id) { timers.delete(id); },
  });
  const element = node(), input = node(element);
  const term = { isOpen: true, isDisposed: false, focus() { focusCalls++; input.focus(); } };
  const pane = { id: "active", zIndex: 10, kind: "terminal", element, terminal: { term } };
  active = pane;
  const desktop = { rectangles: [pane], getActivePane: () => active }, phone = { phoneView: { active: false } };
  const workspace = { isLoadingWorkspace: false }, effects = [];
  const dependencies = { desktop: () => desktop, phone: () => phone, workspace: () => workspace,
    navigation: () => ({ workspaceID }),
    terminal: () => ({ updateTerminalFocus: () => effects.push("report focus") }),
    connectivity: () => ({ checkForBrowserWake: () => effects.push("check wake") }),
    clipboard: () => ({ refreshClipboardBridgeAndPrompt: () => effects.push("clipboard check") }),
  };
  const platform = { window: win, document: doc };
  const controller = createForegroundFocus(dependencies, platform);
  const drain = () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); };
  return { controller, platform, dependencies, win, doc, pane, term, input, node, desktop, phone, workspace, effects, timers, drain,
    get calls() { return focusCalls; },
    setFocused(value) { focused = value; }, setActive(value) { active = value; },
    setWorkspace(value) { workspaceID = value; }, setOverlays(value) { overlays = value; } };
}

test("installed web apps restore the current foreground pane without selecting, saving or sending keys", () => {
  const f = fixture();
  assert.equal(f.controller.request(), true);
  assert.equal(f.doc.activeElement, f.input);
  assert.equal(f.calls, 1);
  assert.deepEqual(f.effects, []);
  assert.equal(f.controller.request(), false, "existing text focus is left alone");
  assert.equal(f.calls, 1);
});

test("ordinary tabs stay unchanged and native apps require an explicit native request", () => {
  const ordinary = fixture({ installed: false });
  assert.equal(ordinary.controller.request(), false);
  const native = fixture({ native: true, installed: false });
  assert.equal(native.controller.request(), false);
  assert.equal(native.controller.request({ native: true }), true);
  assert.equal(ordinary.calls, 0); assert.equal(native.calls, 1);
});

test("embedded app frames and selected DOM text are not disturbed", () => {
  const frame = fixture(); frame.win.top = {};
  assert.equal(frame.controller.request(), false);
  const selected = fixture(); selected.doc.getSelection = () => ({ isCollapsed: false });
  assert.equal(selected.controller.request(), false);
});

test("standalone display-mode detection works without Safari's navigator flag", () => {
  const f = fixture(); delete f.win.navigator.standalone;
  f.win.matchMedia = query => ({ matches: query === "(display-mode: standalone)" });
  assert.equal(f.controller.request(), true);
});

test("remote/browser panes use their existing input focus APIs", () => {
  for (const kind of ["browser", "rdp", "vnc"]) {
    const f = fixture(), target = f.node(f.pane.element);
    f.pane.kind = kind;
    if (kind === "browser") f.pane.browser = { frame: target };
    if (kind === "rdp") f.pane.rdp = { session: {}, canvas: target };
    if (kind === "vnc") f.pane.vnc = { rfb: { focus() { target.focus(); } } };
    assert.equal(f.controller.request(), true);
    assert.equal(f.doc.activeElement, target);
  }
});

for (const reason of ["hidden", "suspended", "minimized", "detached", "covered", "control", "dialog", "menu", "find"]) {
  test(`foreground focus respects ${reason}`, () => {
    const f = fixture();
    if (reason === "hidden") f.doc.hidden = true;
    if (reason === "suspended") f.win.tesseraNativeSuspended = true;
    if (reason === "minimized") f.pane.minimized = true;
    if (reason === "detached") f.pane.element.isConnected = false;
    if (reason === "covered") f.desktop.rectangles.push({ id: "front", zIndex: 20, element: f.node() });
    if (reason === "control") f.doc.activeElement = f.node();
    if (reason === "find") f.pane.findBar = { isOpen: true };
    if (["dialog", "menu"].includes(reason)) f.setOverlays([f.node()]);
    assert.equal(f.controller.request(), false); assert.equal(f.calls, 0); assert.equal(f.timers.size, 0);
  });
}

test("hidden overlays and minimized/hidden peers do not block the actual foreground pane", () => {
  const f = fixture(), overlay = f.node(), peer = f.node();
  overlay.hidden = true; peer.hidden = true;
  f.setOverlays([overlay]);
  f.desktop.rectangles.push({ zIndex: 20, element: peer });
  assert.equal(f.controller.request(), true);
});

test("phone Scroll, Select, compose and non-current-pane modes cannot be turned into direct typing", () => {
  for (const change of [{ mode: "scroll" }, { selecting: true }, { input: { direct: false } }, { openPaneID: "other" }]) {
    const f = fixture();
    f.phone.phoneView = { active: true, openPaneID: "active", mode: "interaction", input: { direct: true }, ...change };
    assert.equal(f.controller.request(), false); assert.equal(f.calls, 0);
  }
  const typing = fixture();
  typing.phone.phoneView = { active: true, openPaneID: "active", mode: "interaction", input: { direct: true } };
  assert.equal(typing.controller.request(), true);
});

test("a local input becoming ready gets a bounded retry, but not after a pane/workspace/user choice changes", () => {
  const f = fixture(); f.term.isOpen = false;
  assert.equal(f.controller.request(), false); assert.equal(f.timers.size, 1);
  f.term.isOpen = true; f.drain(); assert.equal(f.calls, 1);
  for (const change of [f => f.setActive(null), f => f.setWorkspace("other"), f => f.controller.cancel(), f => { f.doc.activeElement = f.node(); }, f => f.setOverlays([f.node()])]) {
    const f = fixture(); f.term.isOpen = false; f.controller.request();
    f.term.isOpen = true; change(f); f.drain();
    assert.equal(f.calls, 0); assert.equal(f.timers.size, 0);
  }
});

test("focus readiness never retries indefinitely", () => {
  const f = fixture(); f.setFocused(false); f.controller.request();
  for (let i = 0; i < 20; i++) f.drain();
  assert.equal(f.calls, 0); assert.equal(f.timers.size, 0);
});

test("temporary refusal of DOM focus is retried without injected input", () => {
  const f = fixture(), focus = f.term.focus;
  f.term.focus = () => {};
  assert.equal(f.controller.request(), false); assert.equal(f.timers.size, 1);
  f.term.focus = focus; f.drain();
  assert.equal(f.doc.activeElement, f.input); assert.equal(f.timers.size, 0);
});

test("native resume retries survive unrelated generic native focus events", () => {
  const f = fixture({ native: true }); f.setFocused(false);
  f.controller.request({ native: true }); assert.equal(f.timers.size, 1);
  f.controller.request(); assert.equal(f.timers.size, 1);
  f.setFocused(true); f.drain(); assert.equal(f.calls, 1);
});

test("browser event wiring restores on foreground/focus/BFCache and cancels on user input or hiding", () => {
  const f = fixture(), events = createEvents(f.dependencies, f.platform);
  events.registerFocus();
  f.win.dispatchEvent(new Event("focus")); assert.equal(f.doc.activeElement, f.input);
  assert.deepEqual(f.effects, ["check wake", "clipboard check", "report focus"]);
  f.doc.activeElement = f.doc.body;
  f.doc.dispatchEvent(new Event("visibilitychange")); assert.equal(f.doc.activeElement, f.input);
  f.doc.activeElement = f.doc.body;
  const shown = new Event("pageshow"); shown.persisted = true;
  f.win.dispatchEvent(shown); assert.equal(f.doc.activeElement, f.input);
  for (const event of ["pointerdown", "keydown", "visibilitychange", "blur", "pagehide"]) {
    f.doc.activeElement = f.doc.body; f.term.isOpen = false;
    f.win.dispatchEvent(new Event("focus")); assert.equal(f.timers.size, 1);
    if (event === "visibilitychange") f.doc.hidden = true;
    (["blur", "pagehide"].includes(event) ? f.win : f.doc).dispatchEvent(new Event(event));
    assert.equal(f.timers.size, 0);
    f.doc.hidden = false; f.term.isOpen = true;
  }
});
