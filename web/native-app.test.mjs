import assert from "node:assert/strict";
import test from "node:test";
import { createNativeApp, nativeImportEntries, nativeTerminalKey } from "./native-app.mjs";
import { shouldUsePhoneView } from "./phone-view.mjs";
import { SaveClipboardDialog } from "./save-clipboard.mjs";
import { createPhone } from "./phone-workspace.mjs";
import { createTerminal } from "./terminal-view.mjs";

function fixture({ native = true } = {}) {
  const storage = new Map(), effects = [], listeners = new Map();
  const events = target => ({ addEventListener(type, fn) { listeners.set(`${target}:${type}`, fn); }, removeEventListener(type) { listeners.delete(`${target}:${type}`); } });
  const window = { ...events("window"), tesseraNativeDevice: native ? "ipad" : undefined, setTimeout, clearTimeout,
    requestAnimationFrame: fn => setTimeout(() => fn(performance.now()), 1), cancelAnimationFrame: clearTimeout,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  window.top = window;
  let dialogs = [];
  const document = { ...events("document"), hidden: false, querySelectorAll: () => dialogs, activeElement: { blur: () => effects.push("blur") } };
  const manager = { selectionStart: { col: 1, absoluteRow: 4 }, selectionEnd: { col: 5, absoluteRow: 5 }, markCurrentSelectionDirty() {} };
  const term = { viewportY: 4, rows: 24, cols: 80, smoothScroll: { target: 4 }, selectionManager: manager, hasSelection: () => true,
    getScrollbackLength: () => 10, smoothScrollTo: value => effects.push(["scroll", value]), requestRender() {}, setPaintFPSLimit: value => effects.push(["fps", value]) };
  const rect = { id: "pane", kind: "terminal", cwd: "/work", terminal: { term, replica: { cursor: { epoch: "epoch" } }, mouseBridge: { cancelTouchGesture: () => effects.push("cancel gesture") } } };
  const preferences = { olderMacMode: false };
  const dialog = { element: { hidden: true }, entries: [], open: options => effects.push(["import", options]), add: entries => effects.push(["append", entries]) };
  const dependencies = {
    desktop: () => ({ rectangles: [rect], getActivePane: () => rect }), navigation: () => ({ currentUser: "alice", workspaceID: "workspace" }),
    terminal: () => ({ terminalFits: { cancelGridSize: () => effects.push("cancel resize") } }),
    phone: () => ({ sendPhoneKey: (...args) => effects.push(["key", ...args]) }), preferences: () => preferences,
    connectivity: () => ({ handleBrowserOnline: () => effects.push("reconnect") }),
    clipboard: () => ({ saveClipboardDialog: dialog }), menus: () => ({ hideAllMenus: () => effects.push("hide menus") }),
    palette: () => ({ openCommandPalette: () => effects.push("palette") }), windows: () => ({ openWindowList: () => effects.push("windows") }),
    sessionList: () => ({ openSessionList: () => effects.push("sessions") }), settings: () => ({ openSettingsModal: () => effects.push("settings") }),
    events: () => ({ cancelForegroundFocus: () => effects.push("cancel foreground focus"), restoreForegroundFocus: options => effects.push(["foreground focus", options]) }),
  };
  const feature = createNativeApp(dependencies, { window, document });
  feature.initialize();
  return { feature, window, document, effects, rect, term, manager, preferences, storage, listeners, dialog, setDialogs: value => { dialogs = value; } };
}

test("native integration is inert in ordinary browsers and tablet layout stays out of phone mode", () => {
  const f = fixture({ native: false });
  assert.equal(f.window.tesseraNativeApp, undefined);
  assert.equal(f.listeners.size, 0);
  assert.equal(shouldUsePhoneView({ width: 320, coarsePointer: true, tablet: true }), false);
  assert.equal(shouldUsePhoneView({ width: 320, coarsePointer: true, tablet: true, override: "phone" }), true);
  f.feature.dispose();
});

test("native app commands invoke existing controllers without synthetic typing", async () => {
  const f = fixture();
  for (const command of ["palette", "windows", "sessions", "settings"]) assert.deepEqual(await f.feature.perform(command), { ok: true });
  assert.deepEqual(f.effects, ["palette", "windows", "sessions", "settings"]);
  assert.deepEqual(await f.feature.perform("constructor"), { ok: false });
  await f.feature.perform("suspend");
  assert.deepEqual(await f.feature.perform("palette"), { ok: false });
  f.feature.dispose();
});

test("background/native layout changes preserve view state and ordinary reconnect resume does not request focus", async () => {
  const f = fixture();
  await f.feature.perform("suspend");
  assert.equal(f.rect.terminal.nativeUIHold, true);
  assert.equal(f.window.tesseraNativeSuspended, true);
  assert.ok(f.effects.includes("cancel resize"));
  const saved = JSON.parse([...f.storage.values()][0]);
  assert.equal(saved.views[0].viewport, 4);
  assert.deepEqual(saved.views[0].selection.start, f.manager.selectionStart);
  f.effects.length = 0;
  await f.feature.perform("resume");
  assert.equal(f.window.tesseraNativeSuspended, false);
  assert.deepEqual(f.effects, ["reconnect", ["scroll", 4]]);
  assert.equal(f.storage.size, 0);
  f.feature.dispose();
});

test("native resume requests guarded focus only on an explicitly authorized foreground transition", async () => {
  const f = fixture();
  await f.feature.perform("resume");
  assert.equal(f.effects.some(effect => effect[0] === "foreground focus"), false);
  await f.feature.perform("resume", { restoreFocus: true });
  assert.deepEqual(f.effects.at(-1), ["foreground focus", { native: true }]);
  f.feature.dispose();
});

test("native suspension and UI holds cancel pending foreground focus", async () => {
  const f = fixture();
  for (const command of ["suspend", "holdSize"]) {
    f.effects.length = 0;
    await f.feature.perform(command);
    assert.equal(f.effects[0], "cancel foreground focus");
  }
  f.feature.dispose();
});

test("view restoration clamps history and never restores a selection into changed host content", () => {
  const f = fixture();
  f.feature.snapshot();
  f.term.getScrollbackLength = () => 2;
  f.manager.selectionStart = null;
  f.feature.restore();
  assert.deepEqual(f.effects, [["scroll", 2]]);
  assert.equal(f.manager.selectionStart, null);
  f.feature.dispose();
});

test("typing before restoration cancels delayed view movement", () => {
  const f = fixture();
  f.feature.snapshot();
  f.listeners.get("document:keydown")({ key: "x" });
  f.feature.restore();
  assert.deepEqual(f.effects, []);
  f.feature.dispose();
});

test("terminal keys accept only named keys or modified letters and cannot type through dialogs", async () => {
  assert.equal(nativeTerminalKey({ key: "c" }), null);
  assert.equal(nativeTerminalKey({ key: "F13" }), null);
  assert.equal(nativeTerminalKey({ key: "Enter" }), null, "a native import must not execute a command");
  assert.equal(nativeTerminalKey({ key: "F12" }).code, "F12");
  assert.equal(nativeTerminalKey({ key: "c", ctrlKey: true }).code, "KeyC");
  const f = fixture();
  await f.feature.perform("key", { key: "Escape" });
  assert.equal(f.effects[0][0], "key");
  f.setDialogs([{ getClientRects: () => [{}] }]);
  assert.deepEqual(await f.feature.perform("key", { key: "F1" }), { ok: false });
  assert.equal(f.effects.length, 1);
  f.feature.dispose();
});

test("native imports are bounded, sanitize filenames and open a save review without clipboard reads or execution", async () => {
  const items = [{ name: "../report.txt", type: "text/plain", data: btoa("report") }];
  const entries = nativeImportEntries(items);
  assert.equal(entries[0].name, "report.txt");
  assert.equal(await entries[0].blob.text(), "report");
  for (const invalid of [[], new Array(9).fill(items[0]), [{ ...items[0], name: ".." }], [{ ...items[0], data: "bad base64" }]]) assert.throws(() => nativeImportEntries(invalid));
  const f = fixture();
  await f.feature.perform("files", { items });
  const review = f.effects.find(effect => effect[0] === "import")[1];
  assert.equal(review.current, "/work");
  assert.equal(review.title, "Import Files to Host");
  assert.equal(review.entries[0].name, "report.txt");
  assert.equal(f.effects.some(effect => effect[0] === "key"), false);
  f.feature.dispose();
});

test("refresh preference preserves Older Mac limits and does not resize the shell", async () => {
  const f = fixture();
  await f.feature.perform("refreshPreference", { highRefresh: false });
  await f.feature.perform("refreshPreference", { highRefresh: true });
  f.preferences.olderMacMode = true;
  await f.feature.perform("refreshPreference", { highRefresh: true });
  assert.deepEqual(f.effects, [["fps", 60], ["fps", 0], ["fps", 30]]);
  f.feature.dispose();
});

test("concurrent native imports append to review but cannot mutate an active save", async () => {
  const f = fixture();
  const items = [{ name: "file.txt", data: btoa("file") }];
  f.dialog.element.hidden = false;
  await f.feature.perform("files", { items });
  assert.equal(f.effects[0][0], "append");
  f.dialog.saving = true;
  await assert.rejects(f.feature.perform("files", { items }), /current file save/);
  f.feature.dispose();
});

test("native size hold also applies to tablet layout and only foreground terminal interaction releases it", () => {
  const window = { tesseraNativeSuspended: true };
  const phone = createPhone({ navigation: () => ({ currentUser: null }) }, { window });
  const terminal = createTerminal({ phone: () => phone }, { window, document: { hidden: false, hasFocus: () => true } });
  let claims = 0;
  terminal.terminalFits = { claimGridSize: () => claims++ };
  const rect = { kind: "terminal", terminal: { nativeUIHold: true } };
  assert.equal(phone.terminalWatchesSize({}), true, "Terminals created while suspended also watch without resizing");
  assert.equal(phone.terminalWatchesSize(rect.terminal), true);
  terminal.claimTerminalSize(rect);
  assert.equal(claims, 0);
  assert.equal(rect.terminal.nativeUIHold, true);
  window.tesseraNativeSuspended = false;
  terminal.claimTerminalSize(rect);
  assert.equal(claims, 1);
  assert.equal(phone.terminalWatchesSize(rect.terminal), false);
});

test("frame measurements have a bounded duration and reject background sampling", async () => {
  const f = fixture();
  const report = await f.feature.measureRefreshRate(250);
  assert.ok(report.frames > 0 && report.fps > 0 && report.milliseconds >= 250);
  f.document.hidden = true;
  await assert.rejects(f.feature.measureRefreshRate(), /visible/);
  f.feature.dispose();
});

test("import review bypasses clipboard access and ignores replies from an earlier dialog generation", async () => {
  let resolveRead;
  const dialog = { generation: 0, entries: [], title: {}, element: { hidden: true }, panel: { focus() {} },
    readClipboard: () => new Promise(resolve => { resolveRead = resolve; }),
    setStatus() {}, renderItems() {}, browse() {}, add(entries) { this.entries.push(...entries); },
  };
  SaveClipboardDialog.prototype.open.call(dialog);
  const imported = nativeImportEntries([{ name: "file.txt", data: btoa("file") }]);
  SaveClipboardDialog.prototype.open.call(dialog, { entries: imported, title: "Import Files to Host" });
  resolveRead([{ name: "old clipboard" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dialog.entries.map(entry => entry.name), ["file.txt"]);
  assert.equal(dialog.title.textContent, "Import Files to Host");
});
