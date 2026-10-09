import assert from "node:assert/strict";
import test from "node:test";
import { TerminalFiles } from "./terminal-files.mjs";

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.events = new Map(); this.hidden = false;
    this.classList = { add() {} }; this.removed = false;
    if (tag === "iframe") this.contentDocument = { body: globalThis.document.body, createElement: type => new Element(type) };
  }
  append(...children) { this.children.push(...children); for (const child of children) if(child.tag === "iframe") queueMicrotask(() => child.events.get("load")?.()); }
  setAttribute() {}
  addEventListener(type, listener) { this.events.set(type, listener); }
  remove() { this.removed = true; }
  click() { this.events.get("click")?.(); }
  submit() { this.submitted = true; }
}
function fixture(fetchImpl = async () => ({ ok: true, json: async () => ({ ticket: "secret" }) })) {
  const body = new Element("body");
  const previous = globalThis.document;
  globalThis.document = { body, createElement: tag => new Element(tag) };
  const sent = [], counts = [];
  const files = new TerminalFiles({ workspaceId: "workspace", paneId: "pane", container: body,
    send: message => sent.push(message), onPending: n => counts.push(n), fetchImpl });
  files.receive({ type: "file-events", epoch: "epoch" });
  return { files, body, sent, counts, cleanup() { files.dispose(); globalThis.document = previous; } };
}
const request = (id = "id", operation = "upload") => ({ type: "terminal-file", epoch: "epoch", action: "request", id, operation,
  directory: "/destination", files: [{ name: "file", bytes: 4 }], bytes: 4 });

test("live requests are bounded, epoch scoped, and subscriptions contain no replay cursor", () => {
  const f = fixture();
  try {
    const messages = []; f.files.subscribe({ send: message => messages.push(JSON.parse(message)) });
    assert.equal(messages[0].type, "file-events"); assert.equal(messages[0].clientId, f.files.clientId);
    for (let n = 0; n < 9; n++) f.files.receive(request(String(n)));
    assert.equal(f.files.requests.size, 4);
    f.files.receive({ ...request("stale"), epoch: "old" }); assert.equal(f.files.requests.size, 4);
    f.files.receive({ type: "terminal-file", epoch: "epoch", action: "reset" });
    assert.equal(f.files.requests.size, 0); assert.equal(f.counts.at(-1), 0);
    assert.equal(f.sent.length, 4);
  } finally { f.cleanup(); }
});

test("file selection opens synchronously and does not claim until files were chosen", () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new Error("unexpected request"); });
  try {
    f.files.receive(request()); const item = f.files.requests.get("id"); item.action.click();
    const input = item.card.children.find(child => child.tag === "input");
    assert.equal(input.type, "file"); assert.equal(input.multiple, true); assert.equal(calls, 0);
  } finally { f.cleanup(); }
});

test("cancellation while claiming cancels the resulting ticket before any upload", async () => {
  let resolve; const posts = [];
  const f = fixture(async (url, options) => {
    posts.push([url, JSON.parse(options.body)]);
    if (url.endsWith("claim")) return await new Promise(done => { resolve = done; });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  try {
    f.files.receive(request()); const item = f.files.requests.get("id");
    const pending = f.files.claim(item, [{ name: "a", size: 3 }]); f.files.cancel(item);
    resolve({ ok: true, json: async () => ({ ticket: "secret" }) });
    await assert.rejects(pending, /cancelled/);
    assert.equal(posts.at(-1)[0], "/api/terminal-files/cancel");
    assert.equal(f.files.requests.size, 0);
  } finally { f.cleanup(); }
});

test("another browser's claim dismisses invitations; active owners keep their progress", async () => {
  const f = fixture();
  try {
    f.files.receive(request("other")); f.files.receive({ type: "terminal-file", epoch: "epoch", id: "other", action: "claimed" });
    assert.equal(f.files.requests.size, 0);
    f.files.receive(request()); const item = f.files.requests.get("id"); await f.files.claim(item);
    f.files.receive({ type: "terminal-file", epoch: "epoch", id: "id", action: "claimed" });
    assert.equal(f.files.requests.size, 1);
    f.files.receive({ type: "terminal-file", epoch: "epoch", id: "id", action: "progress", bytes: 12 });
    assert.equal(item.text.textContent, "Transferred 12 bytes");
    f.files.disconnect(); assert.equal(f.files.requests.size, 0);
  } finally { f.cleanup(); }
});

test("native downloads use a ticket form rather than fetching file bodies", async () => {
  const urls = []; const f = fixture(async url => { urls.push(url); return { ok: true, json: async () => ({ ticket: "secret" }) }; });
  try {
    f.files.receive(request("zip", "download")); await f.files.download(f.files.requests.get("zip"));
    assert.deepEqual(urls, ["/api/terminal-files/claim"]);
    const form = f.body.children.find(child => child.tag === "form");
    assert.equal(form.action, "/api/terminal-files/download"); assert.equal(form.method, "POST"); assert.equal(form.submitted, true);
    assert.equal(form.children[0].value, "secret");
  } finally { f.cleanup(); }
});

test("losing an asynchronous claim removes the invitation without starting a transfer", async () => {
  const f = fixture(async () => ({ ok: false, status: 410, json: async () => ({ error: "request is unavailable" }) }));
  try {
    f.files.receive(request()); const item = f.files.requests.get("id");
    await assert.rejects(f.files.claim(item), /unavailable/);
    assert.equal(f.files.requests.size, 0); assert.equal(item.card.removed, true);
    f.files.error(item, "unavailable"); assert.equal(f.files.requests.size, 0);
  } finally { f.cleanup(); }
});
