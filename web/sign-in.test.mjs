import assert from "node:assert/strict";
import test from "node:test";

import { describeLastActive, SignInRecovery, signInURL, signOut } from "./sign-in.mjs";

function fakeTarget(responses) {
  const calls = [];
  const target = {
    location: { href: "http://host:7331/u/alice/s1?x=1", origin: "http://host:7331", pathname: "/u/alice/s1", search: "?x=1", assign() {} },
    fetch: async (input, init) => {
      calls.push([String(input?.url ?? input), init?.method || "GET"]);
      return { status: responses.shift() ?? 200, ok: true };
    },
  };
  return { target, calls };
}

function recovery(target, mode = "file") {
  const shown = [];
  const instance = new SignInRecovery({ target, doc: {}, config: () => ({ mode, account: "alice" }) });
  instance.showDialog = done => shown.push(done);
  instance.install();
  return { instance, shown };
}

test("builds a login URL that returns to the current page", () => {
  assert.equal(signInURL({ pathname: "/u/a", search: "?b=1" }), "/login?next=%2Fu%2Fa%3Fb%3D1");
});

test("an ended sign-in shows one dialog, then retries every waiting request", async () => {
  const { target, calls } = fakeTarget([401, 401, 200, 200]);
  const { shown } = recovery(target);
  const first = target.fetch("/api/workspace/a", { method: "PUT", body: "{}" });
  const second = target.fetch("/api/users");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(shown.length, 1, "one dialog for both requests");
  shown[0]();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ["/api/workspace/a", "/api/users", "/api/workspace/a", "/api/users"]);
});

test("does not intervene without sign-in, for other paths, or for the login call itself", async () => {
  for (const [mode, input] of [["off", "/api/users"], ["file", "/assets/x.png"], ["file", "http://elsewhere/api/users"], ["file", "/api/auth/login"]]) {
    const { target } = fakeTarget([401]);
    const { shown } = recovery(target, mode);
    assert.equal((await target.fetch(input)).status, 401);
    assert.equal(shown.length, 0);
  }
});

test("a streamed body is not sent twice", async () => {
  const { target, calls } = fakeTarget([401]);
  const { shown } = recovery(target);
  const pending = target.fetch("/api/terminal-files/upload", { method: "POST", body: { getReader() {} } });
  await new Promise(resolve => setTimeout(resolve, 0));
  shown[0]();
  assert.equal((await pending).status, 401);
  assert.equal(calls.length, 1);
});

test("signs out with a POST to /logout, then shows the login page", async () => {
  const calls = [];
  const target = {
    fetch: async (url, init) => { calls.push([url, init.method]); return { status: 204 }; },
    location: { assign(url) { calls.push(["assign", url]); } },
  };
  await signOut(target);
  assert.deepEqual(calls, [["/logout", "POST"], ["assign", "/login"]]);
});

test("describes when a device was last active", () => {
  assert.equal(describeLastActive(1000, 1060), "Active now");
  assert.equal(describeLastActive(1000, 1000 + 600), "10 minutes ago");
  assert.equal(describeLastActive(1000, 1000 + 7200), "2 hours ago");
  assert.equal(describeLastActive(1000, 1000 + 86400 * 3), "3 days ago");
});

test("a page loaded with sign-in off goes to the login page once sign-in is required", async () => {
  const { target } = fakeTarget([401, 401]);
  const visited = [];
  target.location.assign = url => visited.push(url);
  const { shown } = recovery(target, "off");
  assert.equal((await target.fetch("/api/users")).status, 401);
  await target.fetch("/api/workspace/a");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(shown.length, 0);
  assert.deepEqual(visited, ["/login?next=%2Fu%2Falice%2Fs1%3Fx%3D1"]);
});

test("a sign-in change made on this page holds the sign-in dialog", async () => {
  const { target } = fakeTarget([]);
  const { instance, shown } = recovery(target);
  let settle;
  instance.hold(new Promise(resolve => { settle = resolve; }));
  let resolved = false;
  void instance.ensureSignedIn().then(() => { resolved = true; });
  settle({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(shown.length, 0, "the page starts afresh instead");
  assert.equal(resolved, false);

  // A refused change leaves the usual dialog.
  instance.hold(Promise.resolve({ ok: false }));
  void instance.ensureSignedIn();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(shown.length, 1);
});
