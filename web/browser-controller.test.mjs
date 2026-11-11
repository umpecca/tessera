import assert from "node:assert/strict";
import test from "node:test";
import { BrowserController } from "./browser-controller.mjs";

function fixture() {
  const requests = [], effects = [], replies = [];
  const view = { sessionID: "old/id", address: {}, frame: { contentWindow: { postMessage: (...args) => effects.push(args) } },
    message: { classList: { add() {}, remove() {} } } };
  const rect = { id: "pane", browser: view, browserRequestID: 0, browserUrl: "http://localhost:3000/path" };
  const controller = new BrowserController({ containsPane: () => true, changed: () => effects.push("changed"),
    beforeDispose: () => effects.push("dispose"),
    window: { confirm: text => { effects.push(text); return true; }, alert: text => effects.push(text) },
    fetch: (url, options) => { requests.push([url, options]); return new Promise(resolve => replies.push(resolve)); } });
  return { view, rect, controller, requests, effects, replies };
}

test("Browser successful navigation releases the previous capability only after installing its replacement", async () => {
  const f = fixture();
  const pending = f.controller.navigate(f.rect, "localhost:3001");
  f.replies[0]({ ok: true, json: async () => ({ id: "new", path: "/proxy/new" }) });
  await pending;
  assert.equal(f.view.frame.src, "/proxy/new");
  assert.equal(f.view.sessionID, "new");
  assert.equal(f.rect.browserUrl, "http://localhost:3001/");
  assert.deepEqual(f.requests[1], ["/api/browser-proxy/old%2Fid", { method: "DELETE" }]);
  assert.deepEqual(f.effects, ["changed"]);
  f.replies[1]({ ok: true });
});

test("Browser clear-site-data confirmation, reload, failures and disposal stay with their view", async () => {
  const f = fixture();
  const pending = f.controller.clearSiteData(f.rect);
  assert.match(f.effects[0], /for http:\/\/localhost:3000\?/);
  assert.deepEqual(f.requests[0], ["/api/browser-proxy/old%2Fid/site-data", { method: "DELETE" }]);
  f.replies[0]({ ok: true });
  await pending;
  assert.deepEqual(f.effects[1], ["tessera-browser-reload", "*"]);
  const failure = f.controller.clearSiteData(f.rect);
  f.replies[1]({ ok: false });
  await failure;
  assert.equal(f.effects.at(-1), "Could not clear the site data.");
  const stale = f.controller.clearSiteData(f.rect);
  f.controller.dispose(f.rect);
  f.replies[2]({ ok: true });
  await stale;
  assert.equal(f.effects.filter(Array.isArray).length, 1, "disposal suppresses late iframe reloads");
  assert.equal(f.view.frame.src, "about:blank");
  assert.equal(f.rect.browser, null);
  f.replies[3]({ ok: true });
});

test("Browser navigation errors preserve the existing capability for later teardown", async () => {
  const f = fixture();
  const pending = f.controller.navigate(f.rect, "localhost:3000");
  f.replies[0]({ ok: false, json: async () => ({ error: "Not listening" }) });
  await pending;
  assert.equal(f.view.message.textContent, "Not listening");
  assert.equal(f.view.frame.hidden, true);
  assert.equal(f.view.sessionID, "old/id");
  assert.deepEqual(f.effects, []);
});
