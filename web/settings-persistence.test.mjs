import assert from "node:assert/strict";
import test from "node:test";
import { SettingsPersistence } from "./settings-persistence.mjs";

function fixture() {
  const requests = [], replies = [], tasks = new Map(), errors = [];
  const state = { value: "first" };
  let timer = 0, token = 0;
  const persistence = new SettingsPersistence({
    getDocument: () => ({ themeId: state.value }),
    newRevision: () => `token-${++token}`,
    onError: error => errors.push(error),
    timers: {
      setTimeout(fn, delay) { tasks.set(++timer, { fn, delay }); return timer; },
      clearTimeout(id) { tasks.delete(id); },
    },
    fetch(url, options) {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      replies.push({ resolve, reject });
      return promise;
    },
  });
  persistence.reset("alice", "initial");
  return { persistence, state, requests, replies, tasks, errors };
}

function response(status = 200, revision = "saved") {
  return { status, ok: status >= 200 && status < 300, json: async () => ({ revision }) };
}

test("settings saves serialize, and flushing waits for the newest settings", async () => {
  const f = fixture(), p = f.persistence;
  p.schedule();
  const save = p.save();
  f.state.value = "latest";
  p.schedule();
  const flush = p.save();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/users/alice/settings");
  f.replies[0].resolve(response(200, "revision-1"));
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].body.themeId, "latest");
  assert.equal(f.requests[1].body.revision, "revision-1");
  assert.equal(f.requests[1].keepalive, true);
  f.replies[1].resolve(response(200, "revision-2"));
  await Promise.all([save, flush]);
  assert.equal(p.revision, "revision-2");
  assert.equal(p.dirty, false);
  assert.equal(p.savePromise, null);
});

test("settings exit flush sends current values and its own pending revision with keepalive", async () => {
  const f = fixture(), p = f.persistence;
  p.schedule();
  const pending = p.save();
  const inFlight = p.inFlightRevision;
  f.state.value = "latest";
  p.saveOnExit();
  assert.equal(f.requests[1].keepalive, true);
  assert.deepEqual(f.requests[1].body, {
    themeId: "latest", revision: "initial", nextRevision: "token-2", alternateRevision: inFlight,
  });
  f.replies[0].resolve(response());
  f.replies[1].resolve(response());
  await pending;
});

test("failed settings saves stay dirty and reject a navigation flush", async () => {
  for (const status of [409, 503]) {
    const f = fixture(), p = f.persistence;
    p.schedule();
    const pending = p.save();
    const rejected = assert.rejects(pending, status === 409 ? /Settings changed in another browser/ : /503/);
    f.replies[0].resolve(response(status));
    await rejected;
    assert.equal(p.dirty, true);
    assert.equal(p.revision, "initial");
    assert.equal(p.savePromise, null);
    assert.equal(p.inFlightRevision, "");
    const retry = p.save();
    assert.equal(f.requests[1].body.revision, "initial");
    f.replies[1].resolve(response());
    await retry;
    assert.equal(p.dirty, false);
  }
});

test("settings debounce reports asynchronous failures without dropping dirty state", async () => {
  const f = fixture(), p = f.persistence;
  p.schedule(); p.schedule();
  assert.equal(f.tasks.size, 1);
  const [{ fn, delay }] = [...f.tasks.values()];
  assert.equal(delay, 250);
  fn();
  f.replies[0].reject(new Error("offline"));
  await new Promise(setImmediate);
  assert.equal(f.errors[0].message, "offline");
  assert.equal(p.dirty, true);
});

test("settings reset ignores old account responses without clearing a newer save", async () => {
  for (const status of [200, 409, 503]) {
    const f = fixture(), p = f.persistence;
    p.schedule();
    const old = p.save();
    p.reset("bob smith", "bob-revision");
    f.state.value = "bob-theme";
    p.schedule();
    const next = p.save();
    assert.equal(f.requests[1].url, "/api/users/bob%20smith/settings");
    f.replies[0].resolve(response(status, "alice-ack"));
    await old;
    assert.equal(p.revision, "bob-revision");
    assert.notEqual(p.savePromise, null);
    assert.equal(p.inFlightRevision, f.requests[1].body.nextRevision);
    f.replies[1].resolve(response(200, "bob-ack"));
    await next;
    assert.equal(p.revision, "bob-ack");
    assert.equal(p.dirty, false);
  }
});

test("resetting settings clears pending timers and no selected account never saves", async () => {
  const f = fixture(), p = f.persistence;
  p.schedule();
  p.reset(null, "");
  p.schedule(); p.saveOnExit();
  await p.save();
  assert.equal(f.tasks.size, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(p.dirty, false);
});
