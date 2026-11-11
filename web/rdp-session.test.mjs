import assert from "node:assert/strict";
import test from "node:test";
import { createRdp } from "./rdp-session.mjs";
import { createRdpDialogs } from "./rdp-dialogs.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const effects = [], requests = [];
  const navigation = { workspaceID: "original", currentUser: "alice" };
  const view = { attempt: 0, address: { value: "host.local:3389" }, connecting: false,
    screen: { hidden: true, clientWidth: 800, clientHeight: 600 },
    message: { clientWidth: 800, clientHeight: 600 }, canvas: {}, scale: {} };
  const rect = { id: "pane", rdp: view, rdpScaleMode: "fit" };
  const desktop = { rectangles: [rect] };
  const credentials = { username: "alice", password: "secret", domain: "", keep: true, sharp: false, fullSize: false };
  const certificate = { target: "host.local:3389", fingerprint: "ab".repeat(32) };
  const dialogs = { hideRDPDialog() {}, confirmRDPCertificate: async () => true, askRDPCredentials: async () => credentials };
  const rdpView = { updateRDPControls: () => effects.push("controls"), setRDPMessage: (_rect, text, error) => effects.push({ text, error }) };
  const platform = { window: { devicePixelRatio: 1, location: { protocol: "https:", host: "localhost" } },
    fetch: async (path, options) => {
      requests.push([path, options && JSON.parse(options.body)]);
      return { ok: true, json: async () => path.endsWith("certificate") ? certificate : {} };
    } };
  const session = createRdp({ desktop: () => desktop, navigation: () => navigation,
    rdpDialogs: () => dialogs, rdpView: () => rdpView, workspace: () => ({ scheduleWorkspaceSave: () => effects.push("save") }) }, platform);
  session.initializeRdpController();
  session.rdpKeptState = async () => ({ available: true, idleLimitSeconds: 60, session: null });
  session.rdpH264Available = async () => false;
  session.attachKeptRDP = async () => effects.push("attached");
  return { session, navigation, desktop, dialogs, rdpView, rect, view, platform, requests, effects, credentials };
}

test("RDP connection confirms trust, gathers credentials and creates the host session before attaching", async () => {
  const f = fixture();
  await f.session.connectRDPPane(f.rect);
  assert.deepEqual(f.requests.map(([path]) => path), ["/api/rdp-proxy/certificate", "/api/rdp-kept"]);
  const body = f.requests[1][1];
  assert.equal(body.workspaceId, "original");
  assert.equal(body.pane, "pane");
  assert.equal(body.password, "secret");
  assert.equal(body.username, "alice");
  assert.equal(f.credentials.password, "");
  assert.ok(f.effects.includes("attached"));
  assert.equal(f.view.connecting, false);
});

test("RDP refuses duplicate attempts and certificate refusal never requests credentials or a session", async () => {
  const f = fixture(), confirmation = deferred();
  f.dialogs.confirmRDPCertificate = () => confirmation.promise;
  f.dialogs.askRDPCredentials = () => assert.fail("certificate was refused");
  const pending = f.session.connectRDPPane(f.rect);
  await f.session.connectRDPPane(f.rect);
  confirmation.resolve(false);
  await pending;
  assert.equal(f.view.attempt, 1);
  assert.equal(f.requests.length, 1);
  assert.ok(f.effects.some(effect => effect.text === "Connection cancelled."));
  assert.equal(f.effects.includes("save"), false);
});

test("RDP stale credential and certificate completions cannot mutate replacement workspaces", async () => {
  for (const stage of ["certificate", "credentials"]) {
    const f = fixture(), waiting = deferred(), reached = deferred();
    const key = stage === "certificate" ? "confirmRDPCertificate" : "askRDPCredentials";
    f.dialogs[key] = () => { reached.resolve(); return waiting.promise; };
    const pending = f.session.connectRDPPane(f.rect);
    await reached.promise;
    f.navigation.workspaceID = "replacement";
    f.effects.length = 0;
    waiting.resolve(stage === "certificate" ? true : f.credentials);
    await pending;
    assert.equal(f.rect.rdpUsername, undefined);
    assert.equal(f.requests.length, 1);
    assert.equal(f.effects.includes("save"), false);
    if (stage === "certificate") assert.equal(f.rect.rdpTrustedFingerprint, undefined);
  }
});

test("RDP late host-session creation ends the original workspace's session, not its replacement", async () => {
  const f = fixture(), created = deferred(), creating = deferred();
  const fetch = f.session.rdpController.fetch;
  f.session.rdpController.fetch = async (path, options) => {
    if (path === "/api/rdp-kept") { creating.resolve(); await created.promise; }
    return fetch(path, options);
  };
  const pending = f.session.connectRDPPane(f.rect);
  await creating.promise;
  f.navigation.workspaceID = "replacement";
  f.desktop.rectangles = [];
  created.resolve();
  await pending;
  assert.deepEqual(f.requests.at(-1), ["/api/rdp-kept/disconnect", { workspaceId: "original", pane: "pane" }]);
  assert.equal(f.effects.includes("attached"), false);
});

test("RDP request failures restore controls and show the reason without attaching", async () => {
  const f = fixture();
  f.session.rdpProxyRequest = async () => { throw new Error("Host unavailable"); };
  await f.session.connectRDPPane(f.rect);
  assert.equal(f.view.connecting, false);
  assert.ok(f.effects.some(effect => effect.error && /Host unavailable/.test(effect.text)));
  assert.equal(f.effects.includes("attached"), false);
});

test("RDP rejoin credentials cannot launch a request after the workspace changes", async () => {
  const f = fixture(), waiting = deferred(), asking = deferred();
  f.session.rdpKeptState = async () => ({ available: true, session: { state: "lost", canRejoin: true, target: "host.local:3389" } });
  f.dialogs.askRDPCredentials = () => { asking.resolve(); return waiting.promise; };
  const pending = f.session.connectRDPPane(f.rect);
  await asking.promise;
  f.navigation.workspaceID = "replacement";
  waiting.resolve(f.credentials);
  await pending;
  assert.deepEqual(f.requests, []);
  assert.equal(f.effects.includes("attached"), false);
});

test("RDP dialogs settle once on submit/cancel and clean up their form callbacks", async () => {
  const dialogs = createRdpDialogs({}), listeners = {};
  const view = { dialog: { hidden: true, replaceChildren() {} } }, rect = { rdp: view };
  const cancel = { addEventListener: (type, callback) => { listeners[type] = callback; } };
  let focused = 0;
  const pending = dialogs.showRDPDialog(rect, cancel, () => "submitted", null, { focus() { focused++; } });
  view.dialog.onsubmit({ preventDefault() {} });
  assert.equal(await pending, "submitted");
  assert.equal(view.dialog.hidden, true);
  assert.equal(view.dialog.onsubmit, null);
  assert.equal(view.dialogResolve, null);
  assert.equal(focused, 1);
  const cancelled = dialogs.showRDPDialog(rect, cancel, () => assert.fail("cancelled"), "cancelled");
  listeners.click();
  assert.equal(await cancelled, "cancelled");
  assert.equal(view.dialogResolve, null);
});
