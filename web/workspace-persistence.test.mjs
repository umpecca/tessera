import assert from "node:assert/strict";
import test from "node:test";
import { WorkspacePersistence } from "./workspace-persistence.mjs";
import { workspaceDocument } from "./workspace-document.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests = [], replies = [], statuses = [], conflicts = [], errors = [], tasks = new Map();
  const state = { value: "original text", loading: false };
  let nextTimer = 0, nextRevision = 0;
  const timers = {
    setTimeout(fn, delay) { const id = ++nextTimer; tasks.set(id, { fn, delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
  };
  const persistence = new WorkspacePersistence({
    getDocument: (revision, savedContent) => workspaceDocument({
      id: persistence.id, revision, name: "Work", activePaneID: "pane", backgroundMode: "fill", defaultPaneFontSize: 14,
      panes: [{ id: "pane", kind: "terminal", fontSize: 14, archivedContent: { bufferText: state.value } }],
    }, savedContent),
    isLoading: () => state.loading,
    setStatus: (...args) => statuses.push(args),
    onConflict: () => conflicts.push(true),
    reportError: error => errors.push(error), timers,
    newRevision: () => `token-${++nextRevision}`,
    fetch(url, options) {
      requests.push({ url, ...options, body: options.body && JSON.parse(options.body) });
      const reply = deferred(); replies.push(reply); return reply.promise;
    },
  });
  persistence.reset("workspace", "initial");
  function runTimer() {
    const [id, { fn, delay }] = [...tasks][0];
    assert.equal(delay, 250);
    tasks.delete(id);
    fn();
  }
  return { persistence, state, requests, replies, statuses, conflicts, errors, tasks, runTimer };
}

function response(status = 200, revision = "saved") {
  return { status, ok: status >= 200 && status < 300, json: async () => ({ revision }) };
}

test("workspace edits debounce into one save of the latest document", async () => {
  const f = fixture(), p = f.persistence;
  p.schedule();
  f.state.value = "latest";
  p.schedule();
  assert.equal(f.tasks.size, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(p.pending, true);
  f.runTimer();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/workspace/workspace");
  assert.equal(f.requests[0].body.panes[0].bufferText, "latest");
  f.replies[0].resolve(response());
  await p.savePromise;
  assert.equal(p.revision, "saved");
  assert.equal(p.pending, false);
  assert.deepEqual(f.statuses.at(-1), ["saved", "Saved"]);
});

test("all workspace flush waiters include queued edits and fail if the final save fails", async () => {
  const f = fixture(), p = f.persistence;
  const autosave = p.save();
  f.state.value = "latest";
  p.schedule();
  const flush = p.flush();
  const rejected = assert.rejects(flush, /could not be saved/);
  f.replies[0].resolve(response(200, "revision-1"));
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].body.revision, "revision-1");
  assert.equal(f.requests[1].body.panes[0].bufferText, "latest");
  assert.notEqual(p.savePromise, null, "flush must still wait for latest edit");
  f.replies[1].resolve(response(503));
  await rejected;
  assert.equal(await autosave, false);
  assert.equal(p.revision, "revision-1");
  assert.equal(p.savedPaneContent.get("pane").bufferText, "original text");
});

test("workspace conflicts suspend autosave and prevent navigation and exit saves", async () => {
  const f = fixture(), p = f.persistence;
  const save = p.save();
  p.schedule();
  f.replies[0].resolve(response(409));
  assert.equal(await save, false);
  assert.equal(p.suspended, true);
  assert.equal(p.revision, "initial");
  assert.equal(f.conflicts.length, 1);
  assert.equal(f.tasks.size, 0);
  p.schedule(); p.saveOnExit();
  assert.equal(await p.save(), false);
  assert.equal(await p.revalidate(), false);
  await assert.rejects(p.flush(), /saving is paused/);
  assert.equal(f.requests.length, 1);
});

test("failed workspace saves keep archived content available for a retry", async () => {
  const f = fixture(), p = f.persistence;
  const first = p.save();
  f.replies[0].reject(new Error("offline"));
  assert.equal(await first, false);
  assert.equal(p.savedPaneContent.size, 0);
  assert.equal(p.revision, "initial");
  assert.equal(p.savePromise, null);
  assert.deepEqual(f.statuses.at(-1), ["error", "Save failed", "offline"]);
  const retry = p.save();
  assert.equal(f.requests[1].body.panes[0].bufferText, "original text");
  f.replies[1].resolve(response());
  assert.equal(await retry, true);
  const unchanged = p.save();
  assert.equal(f.requests[2].body.panes[0].bufferTextUnchanged, true);
  assert.equal(f.requests[2].body.panes[0].bufferText, undefined);
  f.replies[2].resolve(response());
  await unchanged;
});

test("exit saves accept their own pending revision and carry reverted content", async () => {
  const f = fixture(), p = f.persistence;
  const first = p.save();
  f.replies[0].resolve(response(200, "loaded-revision"));
  await first;
  f.state.value = "changed";
  const pending = p.save();
  const inFlight = p.inFlightRevision;
  f.state.value = "original text";
  p.saveOnExit();
  const exit = f.requests[2];
  assert.equal(exit.keepalive, true);
  assert.equal(exit.body.revision, "loaded-revision");
  assert.equal(exit.body.alternateRevision, inFlight);
  assert.notEqual(exit.body.nextRevision, inFlight);
  assert.equal(exit.body.panes[0].bufferText, "original text");
  assert.equal(exit.body.panes[0].bufferTextUnchanged, undefined);
  assert.equal(exit.body.panes[0].editorTabsUnchanged, undefined);
  f.replies[1].resolve(response());
  f.replies[2].resolve(response());
  await pending;
});

test("exit saves preserve oversized UTF-8 documents without requesting keepalive", () => {
  const f = fixture(), p = f.persistence;
  p.saveOnExit();
  assert.equal(f.requests.length, 0, "an idle workspace does not save on exit");
  f.state.value = "é".repeat(32 * 1024);
  p.schedule(); p.saveOnExit();
  assert.equal(f.requests[0].keepalive, false);
  assert.equal(f.requests[0].body.panes[0].bufferText, f.state.value);
  assert.equal(f.tasks.size, 0);
});

test("disconnect cancels the timer and revalidates before resuming queued saves", async () => {
  const f = fixture(), p = f.persistence;
  p.schedule(); p.markDisconnected();
  assert.equal(f.tasks.size, 0);
  assert.equal(p.needsRevalidation, true);
  p.schedule();
  assert.equal(await p.save(), false);
  await assert.rejects(p.flush(), /saving is paused/);
  p.saveOnExit();
  assert.equal(f.requests.length, 0);
  const revalidate = p.revalidate();
  assert.equal(f.requests[0].cache, "no-store");
  f.replies[0].resolve(response(200, "initial"));
  assert.equal(await revalidate, true);
  assert.equal(p.needsRevalidation, false);
  assert.equal(f.tasks.size, 1);
  f.runTimer();
  f.replies[1].resolve(response());
  await p.savePromise;
});

test("reconnect refuses changed revisions and retries transient failures", async () => {
  const f = fixture(), p = f.persistence;
  p.markDisconnected();
  const offline = p.revalidate();
  f.replies[0].reject(new Error("offline"));
  assert.equal(await offline, false);
  assert.equal(p.needsRevalidation, true);
  const changed = p.revalidate();
  f.replies[1].resolve(response(200, "another-browser"));
  assert.equal(await changed, false);
  assert.equal(p.suspended, true);
  assert.equal(f.conflicts.length, 1);
});

test("loading a workspace blocks scheduling, saving, flushing and exit saves", async () => {
  const f = fixture(), p = f.persistence;
  f.state.loading = true;
  p.schedule(); p.markDisconnected(); p.saveOnExit();
  assert.equal(await p.save(), false);
  await assert.rejects(p.flush(), /saving is paused/);
  assert.equal(p.needsRevalidation, false);
  assert.equal(f.requests.length, 0);
  assert.equal(f.tasks.size, 0);
});

test("workspace reset isolates stale save responses from the next workspace", async () => {
  for (const status of [200, 409, 503]) {
    const f = fixture(), p = f.persistence;
    const old = p.save();
    p.schedule();
    p.reset("another/workspace", "fresh");
    assert.equal(f.tasks.size, 0);
    assert.equal(p.savedPaneContent.size, 0);
    const next = p.save();
    assert.equal(f.requests[1].url, "/api/workspace/another%2Fworkspace");
    f.replies[0].resolve(response(status, "stale"));
    assert.equal(await old, false);
    assert.equal(p.revision, "fresh");
    assert.equal(p.suspended, false);
    assert.equal(f.conflicts.length, 0);
    assert.notEqual(p.savePromise, null, "old completion must not clear a new save");
    assert.equal(p.inFlightRevision, f.requests[1].body.nextRevision);
    f.replies[1].resolve(response(200, "new-ack"));
    assert.equal(await next, true);
    assert.equal(p.revision, "new-ack");
  }
});

test("workspace reset ignores stale reconnect checks", async () => {
  const f = fixture(), p = f.persistence;
  p.markDisconnected();
  const pending = p.revalidate();
  p.reset("another", "fresh");
  f.replies[0].resolve(response(200, "initial"));
  assert.equal(await pending, false);
  assert.equal(p.revision, "fresh");
  assert.equal(p.suspended, false);
  assert.equal(f.conflicts.length, 0);
});
