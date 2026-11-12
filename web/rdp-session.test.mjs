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
  const navigation = { workspaceID: "original", currentUser: "alice", signedInAccount: "alice" };
  const view = { attempt: 0, address: { value: "host.local:3389" }, connecting: false,
    screen: { hidden: true, clientWidth: 800, clientHeight: 600 },
    message: { clientWidth: 800, clientHeight: 600 }, canvas: {}, scale: {} };
  const rect = { id: "pane", rdp: view, rdpScaleMode: "fit" };
  const desktop = { rectangles: [rect] };
  const credentials = { username: "alice", password: "secret", domain: "", keep: true, sharp: false, fullSize: false };
  const certificate = { target: "host.local:3389", fingerprint: "ab".repeat(32), trustedFingerprint: "", allowPaneTrust: true };
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
  return { session, navigation, desktop, dialogs, rdpView, rect, view, platform, requests, effects, credentials, certificate };
}

test("RDP connection confirms trust, gathers credentials and creates the host session before attaching", async () => {
  const f = fixture();
  await f.session.connectRDPPane(f.rect);
  assert.deepEqual(f.requests.map(([path]) => path), ["/api/rdp-proxy/certificate", "/api/rdp-proxy/trust", "/api/rdp-kept"]);
  assert.deepEqual(f.requests[1][1], { workspaceId: "original", target: "host.local:3389", fingerprint: f.certificate.fingerprint, previousFingerprint: "" });
  const body = f.requests[2][1];
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
    assert.equal(f.requests.length, stage === "certificate" ? 1 : 2);
    assert.equal(f.effects.includes("save"), false);
    if (stage === "certificate") assert.equal(f.rect.rdpTrustedFingerprint, undefined);
  }
});

test("remembered account trust skips confirmation in new panes and overrides older pane pins", async () => {
  for (const paneFingerprint of [undefined, "cd".repeat(32)]) {
    const f = fixture();
    f.certificate.trustedFingerprint = f.certificate.fingerprint;
    f.rect.rdpTrustedTarget = f.certificate.target; f.rect.rdpTrustedFingerprint = paneFingerprint;
    f.dialogs.confirmRDPCertificate = () => assert.fail("already trusted for this account/target");
    await f.session.connectRDPPane(f.rect);
    assert.deepEqual(f.requests.map(([path]) => path), ["/api/rdp-proxy/certificate", "/api/rdp-kept"]);
    assert.equal(f.rect.rdpTrustedFingerprint, f.certificate.fingerprint);
  }
});

test("a changed account pin always warns, even when the pane already trusts the presented certificate", async () => {
  for (const accepted of [false, true]) {
    const f = fixture(), previous = "cd".repeat(32);
    f.certificate.trustedFingerprint = previous;
    f.rect.rdpTrustedTarget = f.certificate.target; f.rect.rdpTrustedFingerprint = f.certificate.fingerprint;
    let warning;
    f.dialogs.confirmRDPCertificate = async (_rect, _cert, trust) => { warning = trust; return accepted; };
    if (!accepted) f.dialogs.askRDPCredentials = () => assert.fail("changed certificate declined");
    await f.session.connectRDPPane(f.rect);
    assert.equal(warning, "changed");
    assert.equal(f.requests.length, accepted ? 3 : 1);
    if (accepted) assert.equal(f.requests[1][1].previousFingerprint, previous);
  }
});

test("matching legacy approvals are promoted only for a compatible pane owner", async () => {
  for (const allowPaneTrust of [true, false]) {
    const f = fixture(); f.certificate.allowPaneTrust = allowPaneTrust;
    f.rect.rdpTrustedTarget = f.certificate.target; f.rect.rdpTrustedFingerprint = f.certificate.fingerprint;
    let confirmations = 0;
    f.dialogs.confirmRDPCertificate = async (_rect, _cert, trust) => { confirmations++; assert.equal(trust, "new"); return false; };
    await f.session.connectRDPPane(f.rect);
    assert.equal(confirmations, allowPaneTrust ? 0 : 1);
    assert.equal(f.requests.some(([path]) => path.endsWith("/trust")), allowPaneTrust);
  }
});

test("unrelated legacy targets never grant trust", async () => {
  const f = fixture();
  f.rect.rdpTrustedTarget = "other.local:3389"; f.rect.rdpTrustedFingerprint = f.certificate.fingerprint;
  f.dialogs.confirmRDPCertificate = async (_rect, _cert, trust) => { assert.equal(trust, "new"); return false; };
  await f.session.connectRDPPane(f.rect);
  assert.equal(f.requests.length, 1);
});

test("old-server responses keep per-pane trust without calling an unavailable trust endpoint", async () => {
  const f = fixture(); delete f.certificate.trustedFingerprint; delete f.certificate.allowPaneTrust;
  await f.session.connectRDPPane(f.rect);
  assert.deepEqual(f.requests.map(([path]) => path), ["/api/rdp-proxy/certificate", "/api/rdp-kept"]);
  assert.equal(f.rect.rdpTrustedFingerprint, f.certificate.fingerprint);
});

test("stale certificate dialogs cannot save approval after a user/account change in the same workspace", async () => {
  for (const key of ["currentUser", "signedInAccount"]) {
    const f = fixture(), waiting = deferred(), asking = deferred();
    f.dialogs.confirmRDPCertificate = () => { asking.resolve(); return waiting.promise; };
    const pending = f.session.connectRDPPane(f.rect); await asking.promise;
    f.navigation[key] = "bob"; waiting.resolve(true); await pending;
    assert.equal(f.requests.length, 1); assert.equal(f.rect.rdpTrustedFingerprint, undefined);
  }
});

test("failed/conflicting trust writes stop before credentials and do not update pane trust", async () => {
  const f = fixture(), request = f.session.rdpProxyRequest;
  f.session.rdpProxyRequest = (path, body) => path.endsWith("/trust")
    ? Promise.reject(new Error("Trust changed in another window")) : request(path, body);
  f.dialogs.askRDPCredentials = () => assert.fail("trust must save first");
  await f.session.connectRDPPane(f.rect);
  assert.equal(f.rect.rdpTrustedFingerprint, undefined);
  assert.ok(f.effects.some(effect => effect.error && /Trust changed/.test(effect.text)));
});

test("late trust-save completion cannot request credentials or mutate a replaced pane", async () => {
  const f = fixture(), waiting = deferred(), saving = deferred(), request = f.session.rdpProxyRequest;
  f.session.rdpProxyRequest = (path, body) => {
    if (path.endsWith("/trust")) { saving.resolve(); return waiting.promise; }
    return request(path, body);
  };
  f.dialogs.askRDPCredentials = () => assert.fail("pane was replaced");
  const pending = f.session.connectRDPPane(f.rect); await saving.promise;
  f.desktop.rectangles = []; waiting.resolve({}); await pending;
  assert.equal(f.rect.rdpTrustedFingerprint, undefined);
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

test("in-page presentation overflow shuts down and offers an explicit reconnect", { timeout: 1000 }, async () => {
  for (const beforeConnect of [false, true]) {
    const f = fixture();
    f.credentials.keep = false;
    f.session.rdpH264Available = async () => true;
    let callback, shutdowns = 0;
    const running = deferred();
    const connected = { shutdown() { shutdowns++; running.resolve({}); }, run: () => running.promise };
    const overflow = () => callback(new Uint8Array(), new Uint16Array(8 * 1024 * 1024 + 4), 0, 16);
    class Builder {
      proxyAddress() {} destination() {} serverDomain() {} username() {} password() {}
      authToken() {} desktopSize() {} renderCanvas() {} setCursorStyleCallbackContext() {}
      setCursorStyleCallback() {} remoteClipboardChangedCallback() {} forceClipboardUpdateCallback() {}
      extension() {}
      async connect() { if (beforeConnect) overflow(); return connected; }
    }
    f.session.loadRDPModule = async () => ({
      Backend: { SessionBuilder: Builder, DesktopSize: class {} },
      displayControl() {}, enableServerPointer() {}, enableEgfx() {},
      h264FrameCallback(fn) { callback = fn; },
    });
    f.platform.window.clearTimeout = () => {};
    f.rdpView.layoutRDPCanvas = () => {};
    f.session.activateRDPSession = (_rect, view, session) => { view.session = session; };
    await f.session.connectRDPPane(f.rect);
    assert.equal(typeof callback, "function");
    if (!beforeConnect) {
      const finished = f.session.runRDPSession(f.rect, f.view, connected);
      overflow();
      await finished;
      assert.equal(f.view.session, null);
    }
    assert.equal(shutdowns, 1);
    assert.ok(f.effects.some(effect => effect.error && /Choose Connect.*Full color/.test(effect.text)));
  }
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
