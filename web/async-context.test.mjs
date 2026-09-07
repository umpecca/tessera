import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function loadFunctions(names, globals) {
  const context = vm.createContext(globals);
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\n}\n", start) + 2;
    const prefix = source.slice(start - 6, start) === "async " ? "async " : "";
    vm.runInContext(`${prefix}${source.slice(start, end)}`, context);
  }
  return context;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("the latest user selection commits atomically after all of its data loads", async () => {
  const slowWorkspace = deferred();
  const applied = [];
  const ctx = loadFunctions(["selectUser"], {
    currentUser: "original", currentSessionID: "original-session", currentSessionName: "Original",
    userSelectionRequestID: 0, sessions: [{ id: "original-session" }],
    isAllowedUser: () => true,
    fetchSessions: async (user) => [{ id: `${user}-session`, name: `${user} session` }],
    fetchUserSettings: async (user) => ({ user }),
    fetchWorkspace: (id) => id === "alice-session" ? slowWorkspace.promise : Promise.resolve({ id }),
    userAPIPath: (resource, user) => `/api/users/${user}/${resource}`,
    fetch: async () => ({ ok: true }),
    applyUserSettings: (settings) => applied.push(`settings:${settings.user}`),
    loadWorkspace: (workspace) => { ctx.workspaceID = workspace.id; applied.push(`workspace:${workspace.id}`); },
    persistUser: (user) => applied.push(`stored:${user}`), hideUserSelect() {},
    sessionRoute: (user, id) => `/${user}/${id}`,
    window: { history: { pushState() {}, replaceState() {} } },
    syncRunningCommands: async () => {}, console: { warn() {} }, setWorkspaceStatus() {},
  });

  const alice = ctx.selectUser("alice");
  const bob = ctx.selectUser("bob");
  assert.equal(await bob, true);
  assert.equal(ctx.currentUser, "bob");
  slowWorkspace.resolve({ id: "alice-session" });
  assert.equal(await alice, false);
  assert.equal(ctx.currentUser, "bob");
  assert.equal(ctx.currentSessionID, "bob-session");
  assert.deepEqual(applied, ["settings:bob", "workspace:bob-session", "stored:bob"]);
});

test("a failed user load leaves the current identity and workspace untouched", async () => {
  const ctx = loadFunctions(["selectUser"], {
    currentUser: "original", currentSessionID: "original-session", userSelectionRequestID: 0,
    isAllowedUser: () => true, fetchSessions: async () => { throw new Error("offline"); },
    fetchUserSettings: async () => ({}), console: { warn() {} }, setWorkspaceStatus() {},
  });
  assert.equal(await ctx.selectUser("alice"), false);
  assert.equal(ctx.currentUser, "original");
  assert.equal(ctx.currentSessionID, "original-session");
});

function browserFixture() {
  const replies = [];
  const deleted = [];
  const browser = {
    sessionID: "", address: { value: "" }, message: { textContent: "", classList: { add() {}, remove() {} }, hidden: false },
    frame: { hidden: false, src: "" },
  };
  const rect = { browser, browserRequestID: 0, browserStatusInput: { value: "" } };
  const ctx = loadFunctions(["navigateBrowserPane", "releaseBrowserProxySession"], {
    rectangles: [rect], normalizeBrowserAddress: (value) => value.startsWith("http") ? value : "",
    fetch(url, options) {
      if (options?.method === "DELETE") { deleted.push(url); return Promise.resolve({ ok: true }); }
      const reply = deferred(); replies.push(reply); return reply.promise;
    },
    encodeURIComponent, scheduleWorkspaceSave() {},
  });
  return { browser, ctx, deleted, rect, replies };
}

test("Browser pane navigation is latest-request-wins and releases stale proxies", async () => {
  const { browser, ctx, deleted, rect, replies } = browserFixture();
  const first = ctx.navigateBrowserPane(rect, "http://first/");
  const second = ctx.navigateBrowserPane(rect, "http://second/");
  replies[1].resolve({ ok: true, json: async () => ({ id: "second-id", path: "/second", url: "http://second/" }) });
  await second;
  replies[0].resolve({ ok: true, json: async () => ({ id: "first-id", path: "/first", url: "http://first/" }) });
  await first;
  assert.equal(browser.sessionID, "second-id");
  assert.equal(browser.frame.src, "/second");
  assert.deepEqual(deleted, ["/api/browser-proxy/first-id"]);
});

test("invalid navigation cancels a pending Browser request", async () => {
  const { ctx, deleted, rect, replies } = browserFixture();
  const pending = ctx.navigateBrowserPane(rect, "http://first/");
  await ctx.navigateBrowserPane(rect, "invalid");
  replies[0].resolve({ ok: true, json: async () => ({ id: "stale-id", path: "/stale" }) });
  await pending;
  assert.deepEqual(deleted, ["/api/browser-proxy/stale-id"]);
});

test("disposing a Browser pane releases both active and subsequently created proxies", async () => {
  const { ctx, deleted, rect, replies } = browserFixture();
  rect.browser.sessionID = "active-id";
  const pending = ctx.navigateBrowserPane(rect, "http://first/");
  const dispose = loadFunctions(["disposeBrowserPane"], {
    releaseBrowserProxySession: ctx.releaseBrowserProxySession,
  }).disposeBrowserPane;
  dispose(rect);
  replies[0].resolve({ ok: true, json: async () => ({ id: "late-id", path: "/late" }) });
  await pending;
  assert.deepEqual(deleted, ["/api/browser-proxy/active-id", "/api/browser-proxy/late-id"]);
});

test("file-open results are ignored after their source pane or workspace is gone", async () => {
  const read = deferred();
  const sourceRect = { width: 500, height: 400, x: 10, y: 20 };
  let created = 0;
  const ctx = loadFunctions(["openFileFromPaneFileBrowser"], {
    workspaceID: "old", rectangles: [sourceRect], textEditorPaneKind: "text-editor",
    editorPathKey: (value) => value, isTextEditorFilePath: () => true,
    readHostFile: () => read.promise, createRectangle: () => { created++; },
    console: { warn() {} }, setWorkspaceStatus() {},
  });
  const pending = ctx.openFileFromPaneFileBrowser("file.txt", sourceRect);
  ctx.workspaceID = "new";
  read.resolve({ path: "file.txt", text: "late" });
  await pending;
  assert.equal(created, 0);
});

test("an import cannot mutate or focus an editor removed while its file loads", async () => {
  const read = deferred();
  let focused = 0;
  let replaced = 0;
  const rect = { kind: "worksheet", editor: { focus() { focused++; } } };
  const ctx = loadFunctions(["openFileIntoEditor"], {
    workspaceID: "old", rectangles: [rect], textEditorPaneKind: "text-editor",
    readHostFile: () => read.promise, replaceEditorText: () => { replaced++; },
    console: { warn() {} }, setWorkspaceStatus() {}, scheduleWorkspaceSave() {},
  });
  const pending = ctx.openFileIntoEditor(rect, "file.txt");
  ctx.rectangles.splice(0);
  rect.editor = null;
  read.resolve({ path: "file.txt", text: "late" });
  await pending;
  assert.equal(replaced, 0);
  assert.equal(focused, 0);
});

test("background completion cannot alter a subsequently displayed workspace", async () => {
  const reply = deferred();
  let applied = 0;
  const ctx = loadFunctions(["uploadBackground", "backgroundURLFor"], {
    workspaceID: "old", backgroundRequestID: 0, backgroundRequestIDValue: 0,
    maxBackgroundBytes: 100, workspaceBackgroundMode: "fill",
    compressBackgroundImage: async () => ({ size: 10 }),
    fetch: () => reply.promise, applyWorkspaceBackground: () => { applied++; },
    setWorkspaceStatus() {}, console: { warn() {} }, Date,
  });
  const pending = ctx.uploadBackground({ type: "image/png" });
  ctx.workspaceID = "new";
  reply.resolve({ ok: true, json: async () => ({ version: "old-version" }) });
  await pending;
  assert.equal(applied, 0);
});
