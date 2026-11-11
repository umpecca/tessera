import assert from "node:assert/strict";
import test from "node:test";
import { VNCController } from "./vnc-controller.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const instances = [], requests = [], effects = [];
  let workspace = "workspace", loads = 0;
  class RFB {
    constructor(screen, url, options) {
      Object.assign(this, { screen, url, options, listeners: {}, pasted: [], focuses: 0, disconnects: 0 });
      instances.push(this);
    }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    emit(type, detail = {}) { this.listeners[type]?.({ detail }); }
    focus() { this.focuses++; }
    disconnect() { this.disconnects++; }
    clipboardPasteFrom(text) { this.pasted.push(text); }
  }
  const node = () => ({ hidden: false, disabled: false, classList: { toggle() {} } });
  const view = { address: { value: "host.local:5901" }, message: node(), screen: node(), connect: node(),
    ctrlAltDelete: node(), sendClipboard: node(), copyClipboard: node(), credentials: { password: "secret" } };
  const rect = { id: "pane", vnc: view, vncScaleMode: "fit", vncViewOnly: false, vncStatusInput: {} };
  const controller = new VNCController({
    workspaceID: () => workspace, containsPane: pane => pane === rect,
    location: { protocol: "https:", host: "tessera.local" },
    changed: () => effects.push("changed"), hideDialog: () => effects.push("hide"),
    credentials: (...args) => effects.push(["credentials", ...args]),
    verify: (...args) => effects.push(["verify", ...args]),
    readClipboard: async () => "local text", writeClipboard: async () => true,
    clipboardEntry: () => effects.push("entry"), setStatus: (...args) => effects.push(["status", ...args]),
    loadModule: async () => { loads++; return { RFB }; },
    fetch: async (url, options) => {
      requests.push([url, JSON.parse(options.body)]);
      return { ok: true, json: async () => ({ path: "/api/vnc-proxy/socket", target: "host.local:5901" }) };
    }, ...overrides,
  });
  return { rect, view, controller, instances, requests, effects, get loads() { return loads; },
    workspace: value => { workspace = value; } };
}

test("VNC connects with captured workspace, preferences, credentials and application hooks", async () => {
  const f = fixture();
  await f.controller.connect(f.rect);
  const rfb = f.instances[0];
  assert.deepEqual(f.requests, [["/api/vnc-proxy", { workspaceId: "workspace", target: "host.local:5901" }]]);
  assert.equal(rfb.url, "wss://tessera.local/api/vnc-proxy/socket");
  assert.deepEqual(rfb.options, { shared: true, credentials: { password: "secret" }, wsProtocols: ["binary"] });
  assert.notEqual(rfb.options.credentials, f.view.credentials);
  assert.equal(rfb.scaleViewport, true);
  assert.equal(rfb.showDotCursor, true);
  assert.equal(rfb.resizeSession, false);
  rfb.emit("connect");
  assert.equal(f.view.message.hidden, true);
  assert.equal(f.view.connect.textContent, "Disconnect");
  rfb.emit("credentialsrequired", { types: ["password"] });
  rfb.emit("serververification", { fingerprint: "fingerprint" });
  assert.deepEqual(f.effects.filter(Array.isArray).map(effect => effect[0]), ["credentials", "verify"]);
  rfb.emit("clipboard", { text: "remote text" });
  assert.equal(f.view.remoteClipboard, "remote text");
  assert.equal(f.view.copyClipboard.disabled, false);
  f.rect.vncViewOnly = true;
  f.rect.vncScaleMode = "one-to-one";
  f.controller.preferences(f.rect);
  assert.equal(rfb.viewOnly, true);
  assert.equal(rfb.clipViewport, true);
  assert.equal(f.view.sendClipboard.disabled, true);
  f.controller.disconnect(f.rect);
  rfb.emit("disconnect", { clean: false });
  assert.equal(f.view.message.textContent, "Disconnected.");
  assert.equal(f.view.rfb, null);
  await f.controller.connect(f.rect);
  assert.equal(f.loads, 1, "noVNC is loaded once");
});

test("VNC pending requests cannot attach after disposal or a workspace change", async () => {
  for (const dispose of [false, true]) {
    const reply = deferred();
    const f = fixture({ fetch: () => reply.promise });
    const pending = f.controller.connect(f.rect);
    if (dispose) f.controller.dispose(f.rect);
    else f.workspace("replacement");
    reply.resolve({ ok: true, json: async () => ({ path: "/stale" }) });
    await pending;
    assert.equal(f.instances.length, 0);
    assert.equal(f.effects.includes("changed"), false);
    if (dispose) assert.deepEqual(f.view.credentials, {});
  }
});

test("VNC stale connection events cannot change replacement panes or show dialogs", async () => {
  const f = fixture();
  await f.controller.connect(f.rect);
  const old = f.instances[0];
  f.controller.dispose(f.rect);
  const replacement = { message: { textContent: "replacement" }, remoteClipboard: "new" };
  f.rect.vnc = replacement;
  f.effects.length = 0;
  for (const type of ["connect", "disconnect", "credentialsrequired", "serververification", "securityfailure", "clipboard"]) {
    old.emit(type, { clean: false, text: "stale", reason: "stale" });
  }
  assert.deepEqual(f.effects, []);
  assert.equal(replacement.message.textContent, "replacement");
  assert.equal(replacement.remoteClipboard, "new");
  assert.equal(old.disconnects, 1);
  assert.equal(f.view.remoteClipboard, "");
});

test("VNC clipboard awaits stay with their connection, with manual entry on read failure", async () => {
  const read = deferred();
  const f = fixture({ readClipboard: () => read.promise });
  await f.controller.connect(f.rect);
  const rfb = f.instances[0];
  const pending = f.controller.sendClipboard(f.rect);
  f.controller.dispose(f.rect);
  read.resolve("stale secret");
  await pending;
  assert.deepEqual(rfb.pasted, []);

  const live = fixture({ readClipboard: async () => { throw new Error("blocked"); }, writeClipboard: async () => false });
  await live.controller.connect(live.rect);
  await live.controller.sendClipboard(live.rect);
  assert.ok(live.effects.includes("entry"));
  live.view.remoteClipboard = "remote";
  await live.controller.copyClipboard(live.rect);
  assert.equal(live.effects.at(-1)[1], "error");
});

test("VNC proxy errors restore controls without saving the failed target", async () => {
  const f = fixture({ fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: "Refused" }) }) });
  await f.controller.connect(f.rect);
  assert.equal(f.view.message.textContent, "Refused");
  assert.equal(f.view.connect.disabled, false);
  assert.equal(f.view.address.disabled, false);
  assert.equal(f.effects.includes("changed"), false);
  f.view.address.value = "https://invalid/";
  await f.controller.connect(f.rect);
  assert.match(f.view.message.textContent, /Enter a host/);
});
