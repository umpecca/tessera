import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const early = readFileSync(new URL("./startup.js", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

function fixture({ path = "/", values = {}, blocked = false } = {}) {
  const storage = new Map(Object.entries(values)), timers = new Map();
  const root = { dataset: { startup: "loading" } };
  const attributes = new Set(["inert", "aria-busy"]);
  const nodes = { startup: { hidden: false }, "startup-message": { textContent: "Opening" },
    "startup-reload": { hidden: true }, board: { removeAttribute(name) { attributes.delete(name); } } };
  const context = vm.createContext({
    document: { documentElement: root, getElementById: id => nodes[id] },
    location: { pathname: path }, window: {},
    localStorage: {
      getItem(key) { if (blocked) throw Error("blocked"); return storage.get(key) || null; },
      setItem(key, value) { if (blocked) throw Error("blocked"); storage.set(key, value); },
    },
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(early, context);
  return { root, nodes, attributes, storage, timers, context, startup: context.window.tesseraStartup };
}

test("the early theme follows the routed user before the remembered user", () => {
  const values = { "tessera-user": "alice", "tessera.theme.v1.alice": "operator", "tessera.theme.v1.bob": "hacker" };
  assert.equal(fixture({ values }).root.dataset.theme, "operator");
  assert.equal(fixture({ path: "/users/bob/sessions/project", values }).root.dataset.theme, "hacker");
  assert.equal(fixture({ path: "/users/bob/sessions/project/", values }).root.dataset.theme, "hacker");
  assert.equal(fixture({ path: "/users/a%20b/sessions/project", values: { "tessera.theme.v1.a%20b": "studio" } }).root.dataset.theme, "studio");
});

test("missing, malformed, and inaccessible caches cannot break startup", () => {
  for (const options of [{}, { blocked: true }, { path: "/users/%zz/sessions/project" },
    { values: { "tessera.theme.v1.default": "__proto__" } },
    { values: { "tessera.theme.v1.default": "unknown" } }]) {
    const f = fixture(options);
    assert.equal(f.root.dataset.theme, undefined);
    f.startup.cacheTheme("alice", "operator"); f.startup.finish();
    assert.equal(f.root.dataset.startup, undefined);
    assert.equal(f.nodes.startup.hidden, true);
    assert.equal(f.attributes.size, 0); assert.equal(f.timers.size, 0);
  }
});

test("theme updates are per-user and reject invalid or unowned values", () => {
  const f = fixture({ values: { "tessera.theme.v1.alice": "operator" } });
  f.startup.cacheTheme("bob", "studio"); f.startup.cacheTheme("alice", "hacker");
  f.startup.cacheTheme(null, "studio"); f.startup.cacheTheme("bob", "unknown");
  assert.deepEqual(Object.fromEntries(f.storage), { "tessera.theme.v1.alice": "hacker", "tessera.theme.v1.bob": "studio" });
});

test("a stalled or failed module exposes recovery and later success releases the gate", () => {
  const f = fixture(); const timer = [...f.timers.values()][0];
  assert.equal(timer.delay, 15000); timer.callback();
  assert.equal(f.root.dataset.startup, "error");
  assert.equal(f.nodes["startup-reload"].hidden, false);
  assert.match(f.nodes["startup-message"].textContent, /longer/);
  f.startup.fail(); assert.match(f.nodes["startup-message"].textContent, /could not/);
  f.startup.finish(); assert.equal(f.root.dataset.startup, undefined);
});

test("the visibility gate and parser-blocking script precede both CSS and the app", () => {
  assert.ok(html.indexOf('/startup.js?v=dev') < html.indexOf('/styles.css?v=dev'));
  assert.ok(html.indexOf('/styles.css?v=dev') < html.indexOf('/app.js?v=dev'));
  assert.match(html, /<html[^>]+data-startup="loading"/);
  assert.match(html, /body > :not\(#startup\):not\(noscript\) \{ visibility: hidden;/);
  assert.match(html, /aria-busy="true" inert/);
  assert.match(html, /<noscript>/);
  assert.ok(html.indexOf('600ms') > 0);
});

function loadFunctions(names, globals) {
  const context = vm.createContext({ phoneView: { active: false }, updatePhoneView() {}, ...globals });
  for (const name of names) {
    const start = app.indexOf(`function ${name}(`), end = app.indexOf("\n}\n", start) + 2;
    const prefix = app.slice(start - 6, start) === "async " ? "async " : "";
    vm.runInContext(`${prefix}${app.slice(start, end)}`, context);
  }
  return context;
}

test("restoration finishes before reveal, focus and optional prompts", async () => {
  const f = fixture(), order = [];
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const context = loadFunctions(["openStartupWorkspace", "showStartupFailure"], {
    document: f.context.document, board: f.nodes.board, currentUser: "alice", activeRect: { id: "saved" },
    window: { tesseraStartup: { finish() { order.push("reveal"); f.startup.finish(); } } },
    startApp: async () => { order.push("session"); return true; },
    waitForStartupWorkspace: () => { order.push("wait"); return waiting; },
    focusPane() { assert.equal(f.attributes.size, 0); order.push("focus"); },
    refreshClipboardBridgeAndPrompt: () => order.push("clipboard"),
    showIPadHTTPGuidanceIfNeeded: () => order.push("guidance"),
    startServerConnectionMonitor: () => order.push("monitor"), console,
  });
  const opening = context.openStartupWorkspace(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.root.dataset.startup, "loading");
  assert.deepEqual(order, ["session", "wait"]);
  ready(); await opening;
  assert.deepEqual(order, ["session", "wait", "reveal", "focus", "clipboard", "guidance", "monitor"]);
});

test("a failed session has a recovery action and never reveals a partial workspace", async () => {
  const f = fixture(); let monitored = false;
  const context = loadFunctions(["openStartupWorkspace", "showStartupFailure"], {
    document: f.context.document, board: f.nodes.board, window: {},
    startApp: async () => false, startServerConnectionMonitor() { monitored = true; }, console,
  });
  await context.openStartupWorkspace();
  assert.equal(f.root.dataset.startup, "error"); assert.equal(f.attributes.size, 2);
  assert.equal(f.nodes["startup-reload"].hidden, false); assert.equal(monitored, true);
});

test("first-time user selection can reveal without waiting for a workspace", async () => {
  const f = fixture(); let prompts = 0;
  const context = loadFunctions(["openStartupWorkspace"], {
    document: f.context.document, board: f.nodes.board, currentUser: null, window: {},
    defaultThemeID: "next-tessera", applyTheme() {},
    startApp: async () => true, waitForStartupWorkspace() { assert.fail("no selected session"); },
    refreshClipboardBridgeAndPrompt() { prompts++; }, showIPadHTTPGuidanceIfNeeded() { prompts++; },
    startServerConnectionMonitor() {}, console,
  });
  await context.openStartupWorkspace();
  assert.equal(f.root.dataset.startup, undefined); assert.equal(prompts, 2);
});

test("visible terminal snapshots must paint; hidden panes and failed or stalled terminals cannot trap startup", async () => {
  const state = { replica: { cursor: { epoch: "" }, needsSnapshot: true }, term: { fullRedrawPending: true } };
  const visible = { kind: "terminal", terminal: state }, covered = { kind: "terminal" }, minimized = { kind: "terminal", minimized: true };
  let now = 0, complete = true;
  const context = loadFunctions(["waitForStartupWorkspace"], {
    workspaceHasBackground: false, rectangles: [visible, covered, minimized],
    document: { hidden: false }, performance: { now: () => now },
    terminalIsCovered: rect => rect === covered,
    window: { setTimeout(resolve, delay) {
      now += delay;
      if (complete && now === 50) { state.replica.cursor.epoch = "shell"; state.replica.needsSnapshot = false; }
      if (complete && now === 75) state.term.fullRedrawPending = false;
      resolve();
    } },
  });
  await context.waitForStartupWorkspace(); assert.equal(now, 75);
  complete = false; state.replica.needsSnapshot = true; now = 0;
  await context.waitForStartupWorkspace(); assert.equal(now, 3000);
  now = 0; visible.terminalStatus = { state: "failed" };
  await context.waitForStartupWorkspace(); assert.equal(now, 0);
  context.document.hidden = true; delete visible.terminalStatus;
  await context.waitForStartupWorkspace(); assert.equal(now, 0);
});
