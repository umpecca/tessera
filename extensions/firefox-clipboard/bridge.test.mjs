import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

const policyContext = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(new URL("policy.js", import.meta.url), "utf8"), policyContext);
const policy = policyContext.TesseraClipboardPolicy;
const origin = "http://tessera.test:7331";
const sender = { frameId: 0, tab: { id: 1 }, url: `${origin}/users/default/sessions/test` };

test("only approved exact origins and Tessera top-level routes can access clipboard", () => {
  const sites = { [origin]: { terminal: false } };
  assert.equal(policy.allowed({ operation: "read" }, sender, sites), true);
  for (const other of [
    { ...sender, frameId: 1 }, { ...sender, tab: undefined },
    { ...sender, url: "http://tessera.test:7332/" },
    { ...sender, url: "https://tessera.test:7331/" },
    { ...sender, url: `${origin}/api/browser/proxy/anything` },
    { ...sender, url: "https://untrusted.test/" },
  ]) assert.equal(policy.allowed({ operation: "read" }, other, sites), false);
  delete sites[origin];
  assert.equal(policy.allowed({ operation: "read" }, sender, sites), false);
});

test("terminal writes require separate consent and text is bounded", () => {
  const sites = { [origin]: { terminal: false } };
  const write = { operation: "write", text: "hello", terminal: true };
  assert.equal(policy.allowed(write, sender, sites), false);
  sites[origin].terminal = true;
  assert.equal(policy.allowed(write, sender, sites), true);
  assert.equal(policy.allowed({ ...write, text: 42 }, sender, sites), false);
  assert.equal(policy.allowed({ ...write, text: "x".repeat(1024 * 1024 + 1) }, sender, sites), false);
  assert.equal(policy.allowed({ operation: "configure" }, sender, sites), false);
});

function contentFixture(frame = false) {
  const listeners = new Map(), calls = [], replies = [];
  let now = 5000;
  const win = { addEventListener: (name, listener) => listeners.set(name, listener), postMessage: reply => replies.push(reply) };
  win.top = frame ? {} : win;
  const context = vm.createContext({
    window: win, location: { origin }, document: { hasFocus: () => true },
    Date: { now: () => now },
    browser: { runtime: { sendMessage: async message => { calls.push(message); return { ok: true }; } } },
  });
  vm.runInContext(fs.readFileSync(new URL("content.js", import.meta.url), "utf8"), context);
  return { listeners, calls, replies, win, advance: () => { now += 2000; },
    send: (operation, extra = {}, eventExtra = {}) => listeners.get("message")({
      source: win, origin, data: { channel: "tessera-clipboard-request-v1", id: "test", operation, ...extra }, ...eventExtra,
    }),
  };
}

test("content bridge ignores child frames entirely", () => {
  assert.equal(contentFixture(true).listeners.size, 0);
});

test("unsolicited reads and synthetic gestures are refused; one trusted gesture permits one read", async () => {
  const f = contentFixture();
  await f.send("read");
  f.listeners.get("click")({ isTrusted: false });
  await f.send("read");
  assert.equal(f.calls.length, 0);
  f.listeners.get("click")({ isTrusted: true });
  await f.send("read");
  await f.send("read");
  assert.equal(f.calls.length, 1);
  f.listeners.get("keydown")({ isTrusted: true });
  f.advance();
  await f.send("read");
  assert.equal(f.calls.length, 1);
});

test("terminal writes reach background consent check but foreign messages do not", async () => {
  const f = contentFixture();
  await f.send("write", { terminal: true, text: "hello" });
  assert.equal(f.calls.length, 1);
  await f.send("write", { terminal: true }, { source: {} });
  await f.send("hello", {}, { origin: "http://other.test" });
  assert.equal(f.calls.length, 1);
});

async function backgroundFixture() {
  let handler;
  let sites = {};
  let clipboard = "external text";
  let field;
  let removed = 0;
  const extensionID = "clipboard-bridge@tessera.local";
  const popupURL = "moz-extension://test/popup.html";
  const context = vm.createContext({
    URL, console,
    document: {
      createElement: () => ({ style: {}, value: "", focus() {}, select() {}, remove() { removed++; } }),
      body: { appendChild: element => { field = element; } },
      execCommand: command => { if (command === "paste") field.value = clipboard; else clipboard = field.value; return true; },
    },
    browser: {
      runtime: {
        id: extensionID, getURL: () => popupURL, getManifest: () => ({ version: "0.1.0" }),
        onMessage: { addListener: listener => { handler = listener; } },
      },
      storage: { local: { get: async () => ({ sites: structuredClone(sites) }), set: async data => { sites = structuredClone(data.sites); } } },
      permissions: { contains: async () => true, onRemoved: { addListener() {} } },
      tabs: { query: async () => [] },
      contentScripts: { register: async () => ({ unregister: async () => {} }) },
    },
  });
  vm.runInContext(fs.readFileSync(new URL("policy.js", import.meta.url), "utf8"), context);
  vm.runInContext(fs.readFileSync(new URL("background.js", import.meta.url), "utf8"), context);
  await vm.runInContext("registrationWork", context);
  return {
    send: (message, from = { ...sender, id: extensionID }) => handler(message, from),
    popup: { id: extensionID, url: popupURL },
    clipboard: () => clipboard, removed: () => removed,
  };
}

test("only extension popup can configure consent and revocation blocks existing content scripts", async () => {
  const f = await backgroundFixture();
  const enable = { operation: "configure", origin, enabled: true };
  await f.send(enable);
  assert.equal((await f.send({ operation: "read" })).ok, false);
  assert.equal((await f.send(enable, f.popup)).ok, true);
  assert.equal((await f.send({ operation: "read" })).text, "external text");
  assert.equal(f.removed(), 1);
  assert.equal((await f.send({ operation: "configure", origin, enabled: false }, f.popup)).ok, true);
  assert.equal((await f.send({ operation: "read" })).ok, false);
  assert.equal(f.removed(), 1);
});

test("background independently enforces terminal consent and restores no clipboard fields", async () => {
  const f = await backgroundFixture();
  await f.send({ operation: "configure", origin, enabled: true }, f.popup);
  const write = { operation: "write", text: "terminal output", terminal: true };
  assert.equal((await f.send(write)).ok, false);
  assert.equal(f.clipboard(), "external text");
  await f.send({ operation: "configure", origin, enabled: true, terminal: true }, f.popup);
  assert.equal((await f.send(write)).ok, true);
  assert.equal(f.clipboard(), "terminal output");
  assert.equal(f.removed(), 1);
});
