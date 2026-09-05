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

test("all workspace flush waiters include queued edits and fail if the final save fails", async () => {
  const first = deferred();
  const second = deferred();
  let requests = 0;
  const ctx = loadFunctions(["saveWorkspace", "flushWorkspaceSave"], {
    isLoadingWorkspace: false, workspaceSaveSuspended: false, workspaceNeedsRevalidation: false,
    workspaceSavePromise: null, workspaceSaveQueued: false, saveTimer: null,
    window: { clearTimeout() {} },
    performWorkspaceSave: () => ++requests === 1 ? first.promise : second.promise,
  });
  const autosave = ctx.saveWorkspace();
  const flush = ctx.flushWorkspaceSave();
  const rejected = assert.rejects(flush, /could not be saved/);
  first.resolve(true);
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.notEqual(ctx.workspaceSavePromise, null, "flush must still wait for latest edit");
  second.resolve(false);
  await rejected;
  assert.equal(await autosave, false);
});

test("paused persistence prevents leaving a workspace", async () => {
  const ctx = loadFunctions(["flushWorkspaceSave"], {
    isLoadingWorkspace: false, workspaceSaveSuspended: true, workspaceNeedsRevalidation: false,
  });
  await assert.rejects(ctx.flushWorkspaceSave(), /saving is paused/);
});

function navigationContext(overrides = {}) {
  const changes = [];
  const ctx = loadFunctions(["switchSession", "fetchWorkspace"], {
    sessionNavigationPending: false, currentSessionID: "old", currentSessionName: "Old",
    currentUser: "alice", workspaceID: "old", workspaceRevision: "old-revision",
    flushWorkspaceSave: async () => {},
    fetch: async () => ({ ok: true, json: async () => ({ id: "new", revision: "new-revision", panes: [] }) }),
    userAPIPath: () => "/api/users/alice/sessions",
    loadWorkspace(workspace) { changes.push("panes"); ctx.workspaceID = workspace.id; },
    refreshSessions: async () => {}, syncRunningCommands: async () => {}, hideSessionsModal() {},
    sessionRoute: (user, id) => `/${user}/${id}`,
    window: { history: { pushState(a, b, route) { changes.push(route); }, replaceState(a, b, route) { changes.push(route); } } },
    console: { warn() {} }, setWorkspaceStatus() {}, ...overrides,
  });
  return { ctx, changes };
}

test("failed save leaves the session, panes and URL intact without fetching a target", async () => {
  const { ctx, changes } = navigationContext({
    flushWorkspaceSave: async () => { throw new Error("save failed"); },
    fetch: () => assert.fail("navigation proceeded"),
  });
  assert.equal(await ctx.switchSession({ id: "new", name: "New" }), false);
  assert.equal(ctx.currentSessionID, "old");
  assert.equal(ctx.workspaceID, "old");
  assert.deepEqual(changes, []);
});

test("failed target fetch keeps old panes and restores a Back/Forward URL", async () => {
  const { ctx, changes } = navigationContext({ fetch: async () => ({ ok: false, status: 503 }) });
  assert.equal(await ctx.switchSession({ id: "new", name: "New" }, { historyMode: "none" }), false);
  assert.equal(ctx.currentSessionID, "old");
  assert.equal(ctx.workspaceID, "old");
  assert.deepEqual(changes, ["/alice/old"]);
});

test("successful navigation saves again after fetching, then commits panes and route together", async () => {
  let saves = 0;
  const { ctx, changes } = navigationContext({ flushWorkspaceSave: async () => { saves++; } });
  await ctx.switchSession({ id: "new", name: "New" });
  assert.equal(saves, 2);
  assert.equal(ctx.currentSessionID, "new");
  assert.equal(ctx.workspaceID, "new");
  assert.deepEqual(changes, ["panes", "/alice/new"]);
});

test("settings saves serialize, and flushing waits for the newest settings", async () => {
  const requests = [];
  const replies = [];
  let value = "first";
  const ctx = loadFunctions(["saveUserSettings", "flushUserSettingsSave"], {
    userSettingsSaveTimer: null, userSettingsSavePromise: null, userSettingsDirty: true,
    currentUser: "alice", userSettingsRevision: "initial", userSettingsInFlightRevision: "",
    window: { clearTimeout() {} }, userAPIPath: () => "/alice/settings",
    userSettingsPayload: () => ({ value, revision: ctx.userSettingsRevision }),
    newWorkspaceRevision: () => `token-${requests.length}`,
    fetch(url, options) { requests.push(JSON.parse(options.body)); const response = deferred(); replies.push(response); return response.promise; },
  });
  const save = ctx.saveUserSettings();
  value = "latest";
  ctx.userSettingsDirty = true;
  const flush = ctx.flushUserSettingsSave();
  assert.equal(requests.length, 1);
  replies[0].resolve({ ok: true, json: async () => ({ revision: "revision-1" }) });
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].value, "latest");
  assert.equal(requests[1].revision, "revision-1");
  replies[1].resolve({ ok: true, json: async () => ({ revision: "revision-2" }) });
  await Promise.all([save, flush]);
  assert.equal(ctx.userSettingsRevision, "revision-2");
  assert.equal(ctx.userSettingsDirty, false);
});

test("settings exit flush sends current values and its own pending revision with keepalive", () => {
  let request;
  const ctx = loadFunctions(["saveUserSettingsOnExit"], {
    currentUser: "alice", userSettingsDirty: true, userSettingsSavePromise: {},
    userSettingsInFlightRevision: "pending", userSettingsPayload: () => ({ themeId: "new", revision: "initial" }),
    newWorkspaceRevision: () => "final", userAPIPath: () => "/alice/settings",
    fetch(url, options) { request = options; return Promise.resolve(); },
  });
  ctx.saveUserSettingsOnExit();
  assert.equal(request.keepalive, true);
  assert.deepEqual(JSON.parse(request.body), { themeId: "new", revision: "initial", nextRevision: "final", alternateRevision: "pending" });
});

test("failed settings saves stay dirty and reject a navigation flush", async () => {
  const ctx = loadFunctions(["saveUserSettings", "flushUserSettingsSave"], {
    userSettingsSaveTimer: null, userSettingsSavePromise: null, userSettingsDirty: true,
    currentUser: "alice", userSettingsRevision: "initial", userSettingsInFlightRevision: "",
    window: { clearTimeout() {} }, userAPIPath: () => "/alice/settings",
    userSettingsPayload: () => ({ revision: "initial" }), newWorkspaceRevision: () => "token",
    fetch: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(ctx.flushUserSettingsSave(), /503/);
  assert.equal(ctx.userSettingsDirty, true);
  assert.equal(ctx.userSettingsRevision, "initial");
  assert.equal(ctx.userSettingsSavePromise, null);
});

test("navigation aborts if edits made during target loading cannot be saved", async () => {
  let saves = 0;
  const { ctx, changes } = navigationContext({ flushWorkspaceSave: async () => {
    if (++saves === 2) throw new Error("latest edit failed to save");
  } });
  assert.equal(await ctx.switchSession({ id: "new", name: "New" }), false);
  assert.equal(ctx.currentSessionID, "old");
  assert.equal(ctx.workspaceID, "old");
  assert.deepEqual(changes, []);
});
