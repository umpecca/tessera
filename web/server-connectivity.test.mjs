import assert from "node:assert/strict";
import test from "node:test";

import { createConnectivity } from "./server-connectivity.mjs";
import { serverConnectionWakeGrace } from "./server-connection.mjs";

class Element {
  constructor(tagName) {
    this.tagName = tagName; this.children = []; this.hidden = false; this.textContent = ""; this.disabled = false;
    this.attributes = {}; this.listeners = {}; this.classList = { add() {} };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  querySelectorAll() { return []; }
  focus() {}
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
}

function fixture() {
  let now = 1_000;
  const timers = [], reloads = [], resumed = [];
  const health = { ok: true };
  const persistence = { needsRevalidation: false, suspended: false };
  const platform = {
    document: { body: new Element("body"), createElement: tag => new Element(tag), activeElement: null, hidden: false },
    window: {
      setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
      clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      requestAnimationFrame: callback => callback(),
      location: { reload: () => reloads.push(true) },
      addEventListener() {},
    },
    performance: { now: () => now },
    Date: { now: () => now },
    navigator: { onLine: true },
    AbortSignal: { timeout: () => undefined },
    fetch: async () => { if (!health.ok) throw new Error("down"); return { ok: true }; },
  };
  const dependencies = {
    workspace: () => ({
      workspacePersistence: persistence,
      markWorkspaceDisconnected: () => { persistence.needsRevalidation = true; },
      revalidateWorkspaceRevision: async () => { persistence.needsRevalidation = false; persistence.revalidated = true; return true; },
    }),
    terminal: () => ({ resumeTerminalConnections: () => resumed.push(true) }),
    phone: () => ({ phoneView: { restoreViewport() {} } }),
    desktop: () => ({ rectangles: [] }),
    preferences: () => ({}),
  };
  const connectivity = createConnectivity(dependencies, platform);
  connectivity.initializeServerHealthPollInterval();
  connectivity.initializeServerConnectionState();
  connectivity.initializeServerHealthMonitorTimer();
  connectivity.initializeServerUpdateModal();
  connectivity.initializeWakeRecoveryStatus();
  return {
    connectivity, health, persistence, reloads, resumed, timers,
    advance: ms => { now += ms; },
    modal: () => connectivity.serverConnectionModal,
    status: () => connectivity.wakeRecoveryStatus,
  };
}

test("failures right after waking show only the compact status, then the dialog once the grace ends", async () => {
  const f = fixture();
  f.connectivity.startServerConnectionGrace();
  f.health.ok = false;
  await f.connectivity.checkServerConnection({ force: true });
  assert.equal(f.modal().hidden, true);
  assert.equal(f.status().hidden, false);
  assert.equal(f.status().textContent, "Reconnecting…");
  f.advance(5_000);
  await f.connectivity.checkServerConnection();
  assert.equal(f.modal().hidden, true);
  f.connectivity.handleBrowserOffline();
  assert.equal(f.modal().hidden, true, "an offline event inside the grace stays quiet too");
  f.advance(serverConnectionWakeGrace);
  await f.connectivity.checkServerConnection();
  assert.equal(f.modal().hidden, false);
  assert.equal(f.status().hidden, true, "the dialog replaces the compact status");
});

test("recovery closes the dialog without reloading and revalidates the workspace", async () => {
  const f = fixture();
  f.health.ok = false;
  await f.connectivity.checkServerConnection();
  await f.connectivity.checkServerConnection();
  assert.equal(f.modal().hidden, false);
  assert.equal(f.persistence.needsRevalidation, true);
  f.health.ok = true;
  await f.connectivity.checkServerConnection();
  assert.equal(f.modal().hidden, true);
  assert.equal(f.status().textContent, "Reconnected");
  assert.equal(f.status().hidden, false);
  assert.equal(f.persistence.revalidated, true);
  assert.equal(f.resumed.length, 1);
  assert.equal(f.reloads.length, 0);
  f.timers.at(-1).callback();
  assert.equal(f.status().hidden, true);
  await f.connectivity.checkServerConnection();
  assert.equal(f.modal().hidden, true, "later healthy polls stay silent");
  assert.equal(f.resumed.length, 1);
});

test("a quiet grace recovery replaces Reconnecting with Reconnected", async () => {
  const f = fixture();
  f.connectivity.startServerConnectionGrace();
  f.health.ok = false;
  await f.connectivity.checkServerConnection({ force: true });
  f.health.ok = true;
  await f.connectivity.checkServerConnection();
  assert.equal(f.modal().hidden, true);
  assert.equal(f.status().textContent, "Reconnected");
  assert.equal(f.reloads.length, 0);
});

test("Reconnect closes the dialog on success instead of reloading", async () => {
  const f = fixture();
  f.health.ok = false;
  f.connectivity.handleBrowserOffline();
  assert.equal(f.modal().hidden, false);
  f.health.ok = true;
  const reconnect = f.modal().find(element => element.textContent === "Reconnect");
  reconnect.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.modal().hidden, true);
  assert.equal(f.reloads.length, 0);
  f.health.ok = false;
  await f.connectivity.checkServerConnection({ manual: true, force: true });
  assert.equal(f.modal().hidden, false, "a failed Reconnect keeps the dialog");
});

test("the server update fallback still offers Reload Tessera", () => {
  const f = fixture();
  f.connectivity.showServerConnectionModal("updated");
  const reload = f.modal().find(element => element.textContent === "Reload Tessera");
  reload.listeners.click();
  assert.equal(f.reloads.length, 1);
});
