import assert from "node:assert/strict";
import test from "node:test";
import { RDPController } from "./rdp-controller.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const response = body => ({ ok: true, json: async () => body });

test("RDP listings share requests, expire, refresh, and stay scoped to account/workspace", async () => {
  const requests = [];
  let user = "alice", workspaceID = "first", now = 0;
  const controller = new RDPController({ context: () => ({ user, workspaceID }), now: () => now,
    fetch: () => { const request = deferred(); requests.push(request); return request.promise; } });
  const first = controller.sessions();
  assert.equal(controller.sessions(), first);
  const state = controller.state({ id: "pane" });
  workspaceID = "second";
  const second = controller.sessions();
  requests[1].resolve(response({ sessions: [{ workspaceId: "second", pane: "pane" }] }));
  await second;
  assert.equal(controller.available, true);
  requests[0].resolve(response({ sessions: [{ workspaceId: "first", pane: "pane" }], idleLimitSeconds: 60 }));
  assert.equal((await state).session.workspaceId, "first", "state captures identity before awaiting the listing");
  assert.equal(controller.sessions(), second, "late completion must not replace a newer cache");
  now = 1501;
  assert.notEqual(controller.sessions(), second);
  const fresh = controller.sessions({ fresh: true });
  assert.equal(requests.length, 4);
  user = "bob";
  assert.equal(controller.available, null);
  assert.notEqual(controller.sessions(), fresh);
  assert.equal(requests.length, 5);
  for (const request of requests) request.resolve(response({}));
  await controller.sessions();
  controller.invalidate();
  assert.equal(controller.available, true, "invalidating a listing must retain host capability for pane deletion");
});

test("RDP stale listings cannot change current host capability after refresh or invalidation", async () => {
  const replies = [];
  const controller = new RDPController({ context: () => ({ user: "alice", workspaceID: "w" }),
    fetch: () => { const reply = deferred(); replies.push(reply); return reply.promise; } });
  const old = controller.sessions();
  const fresh = controller.sessions({ fresh: true });
  replies[1].resolve(response({}));
  await fresh;
  replies[0].resolve({ ok: false });
  await old;
  assert.equal(controller.available, true);
  const invalidated = controller.sessions({ fresh: true });
  controller.invalidate();
  replies[2].resolve({ ok: false });
  await invalidated;
  assert.equal(controller.available, true);
});

test("RDP requests preserve error details and ending a kept session captures its workspace", async () => {
  const calls = [], debug = [];
  let workspaceID = "original";
  const controller = new RDPController({ context: () => ({ workspaceID }),
    debug: (...args) => debug.push(args),
    fetch: async (url, options) => {
      calls.push([url, options]);
      return { ok: false, status: 503, json: async () => { throw new Error("HTML response"); } };
    } });
  await assert.rejects(controller.request("/certificate", {}), /RDP proxy failed: 503/);
  const ended = controller.end({ id: "pane" });
  workspaceID = "replacement";
  await ended;
  assert.deepEqual(JSON.parse(calls[1][1].body), { workspaceId: "original", pane: "pane" });
  assert.equal(debug.length, 1, "teardown tolerates a missing host");
});

test("RDP cancellation invalidates attempts and refreshes the connection UI", () => {
  const effects = [];
  const controller = new RDPController({ context: () => ({}), hideDialog: () => effects.push("hide"),
    message: (_, text) => effects.push(text), controls: () => effects.push("controls") });
  const rect = { rdp: { attempt: 3, connecting: true } };
  controller.disconnect(rect);
  assert.equal(rect.rdp.attempt, 4);
  assert.equal(rect.rdp.connecting, false);
  assert.deepEqual(effects, ["hide", "Connection cancelled.", "controls"]);
  controller.disconnect(rect);
  assert.equal(effects.length, 3);
});

test("RDP disposal closes observers, timers, input, video and stats but never ends a kept host session", () => {
  const effects = [];
  const effect = name => () => effects.push(name);
  const controller = new RDPController({ context: () => ({}), hideDialog: effect("dialog"),
    cancelPointer: effect("pointer"), closeVideo: effect("video"),
    timers: { clearTimeout: id => effects.push(id), clearInterval: id => effects.push(id) },
    fetch: () => { throw new Error("must not end a host session"); } });
  const view = { attempt: 1, kept: true, resizeTimer: "resize", wiggleTimer: "wiggle", hideTimer: "hide",
    resizeObserver: { disconnect: effect("resizeObserver") }, canvasObserver: { disconnect: effect("canvasObserver") },
    stats: { close: effect("stats") }, remoteClipboard: "secret", lastSentClipboard: "secret",
    session: { shutdown() { effects.push("shutdown"); throw new Error("already closed"); } } };
  const rect = { rdp: view };
  controller.dispose(rect);
  controller.dispose(rect);
  assert.equal(rect.rdp, null);
  assert.equal(view.attempt, 2);
  assert.equal(view.intentionalDisconnect, true);
  assert.equal(view.session, null);
  assert.equal(view.stats, null);
  assert.equal(view.remoteClipboard, "");
  assert.equal(view.lastSentClipboard, "");
  assert.deepEqual(effects, ["dialog", "resize", "wiggle", "hide", "resizeObserver", "canvasObserver", "pointer", "video", "stats", "shutdown"]);
});
