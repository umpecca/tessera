import test from "node:test";
import assert from "node:assert/strict";
import {
  ClipboardBridge,
  clipboardBridgeNeedsUpdate,
  firefoxClipboardExtensionRecommendation,
} from "./clipboard-bridge.mjs";

function fixture(timeout = 30) {
  const listeners = new Set();
  const requests = [];
  const host = {
    location: { origin: "http://tessera.test:7331" }, setTimeout, clearTimeout,
    addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn),
    postMessage: message => requests.push(message),
  };
  const bridge = new ClipboardBridge(host, timeout);
  function reply(request, data, overrides = {}) {
    for (const listener of listeners) listener({
      source: host, origin: host.location.origin,
      data: { channel: "tessera-clipboard-response-v1", id: request.id, ...data }, ...overrides,
    });
  }
  return { bridge, host, requests, reply };
}

test("detects extension and separately reports terminal permission", async () => {
  const { bridge, requests, reply } = fixture();
  const check = bridge.check();
  reply(requests[0], { ok: true, version: "0.1.0", terminal: false });
  assert.deepEqual(await check, { version: "0.1.0", terminal: false });
  bridge.dispose();
});

test("correlates overlapping replies and preserves empty clipboard text", async () => {
  const { bridge, requests, reply } = fixture();
  const first = bridge.readText(), second = bridge.readText();
  reply(requests[1], { ok: true, text: "" });
  reply(requests[0], { ok: true, text: "first" });
  assert.equal(await first, "first");
  assert.equal(await second, "");
  bridge.dispose();
});

test("rejects foreign frame, origin and unknown request replies", async () => {
  const { bridge, requests, reply } = fixture();
  const read = bridge.readText();
  reply(requests[0], { ok: true, text: "bad" }, { source: {} });
  reply(requests[0], { ok: true, text: "bad" }, { origin: "http://other.test" });
  reply({ id: "unknown" }, { ok: true, text: "bad" });
  assert.equal(bridge.pending.size, 1);
  reply(requests[0], { ok: true, text: "good" });
  assert.equal(await read, "good");
  bridge.dispose();
});

test("extension removal times out cleanly and late replies do not restore status", async () => {
  const { bridge, requests, reply } = fixture(5);
  bridge.status = { version: "0.1.0" };
  await assert.rejects(bridge.readText(), /did not respond/);
  reply(requests[0], { ok: true, text: "late" });
  assert.equal(bridge.status, null);
  assert.equal(bridge.pending.size, 0);
  bridge.dispose();
});

test("denial and malformed clipboard data do not masquerade as a successful paste", async () => {
  const { bridge, requests, reply } = fixture();
  const denied = bridge.readText();
  reply(requests[0], { ok: false, error: "Permission removed" });
  await assert.rejects(denied, /Permission removed/);
  const malformed = bridge.readText();
  reply(requests[1], { ok: true });
  await assert.rejects(malformed, /Invalid/);
  bridge.dispose();
});

test("numeric extension updates never propose downgrades", () => {
  assert.equal(clipboardBridgeNeedsUpdate("0.1.0", "0.10.0"), true);
  assert.equal(clipboardBridgeNeedsUpdate("1.0.0", "0.10.0"), false);
  assert.equal(clipboardBridgeNeedsUpdate("0.1.0", "0.1.0"), false);
  assert.equal(clipboardBridgeNeedsUpdate("invalid", "0.1.0"), false);
});

test("recommends the extension only for Firefox versions and connections that need it", () => {
  const clipboard = { readText() {}, writeText() {} };
  assert.match(firefoxClipboardExtensionRecommendation({
    userAgent: "Mozilla/5.0 Firefox/115.37", isSecureContext: true, clipboard,
  }), /115 ESR/);
  assert.match(firefoxClipboardExtensionRecommendation({
    userAgent: "Mozilla/5.0 Firefox/142.0", isSecureContext: false, clipboard,
  }), /this connection/);
  assert.equal(firefoxClipboardExtensionRecommendation({
    userAgent: "Mozilla/5.0 Firefox/142.0", isSecureContext: true, clipboard,
  }), "");
  assert.equal(firefoxClipboardExtensionRecommendation({
    userAgent: "Mozilla/5.0 Chrome/140.0", isSecureContext: false,
  }), "");
});
