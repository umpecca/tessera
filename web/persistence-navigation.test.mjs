import { featureFixture } from "./application.test-support.mjs";
import assert from "node:assert/strict";

import test from "node:test";

function loadFunctions(names, globals = {}) {
  const fixtureContext = featureFixture(names, globals);
  return fixtureContext;
}
function navigationContext(overrides = {}) {
  const changes = [];
  const ctx = loadFunctions(["switchSession", "fetchWorkspace"], {
    sessionNavigationPending: false, currentSessionID: "old", currentSessionName: "Old",
    currentUser: "alice", workspaceID: "old",
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
