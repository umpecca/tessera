import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeVNCTarget,
  normalizeVNCScaleMode,
  vncCredentialFields,
  vncWebSocketURL,
} from "./vnc-pane.mjs";

test("normalizes VNC host, port, and IPv6 targets", () => {
  assert.equal(normalizeVNCTarget("example.com"), "example.com:5900");
  assert.equal(normalizeVNCTarget("EXAMPLE.com:5901"), "example.com:5901");
  assert.equal(normalizeVNCTarget("[2001:db8::1]"), "[2001:db8::1]:5900");
  assert.equal(normalizeVNCTarget("vnc://desktop.local:5999"), "desktop.local:5999");
});

test("rejects malformed VNC targets and embedded credentials", () => {
  for (const value of ["", "host:0", "host:65536", "host:abc", "2001:db8::1", "http://host", "vnc://user:secret@host", "vnc://host/path"]) {
    assert.equal(normalizeVNCTarget(value), "", value);
  }
});

test("normalizes display preferences and requested credential fields", () => {
  assert.equal(normalizeVNCScaleMode("one-to-one"), "one-to-one");
  assert.equal(normalizeVNCScaleMode("other"), "fit");
  assert.deepEqual(vncCredentialFields(["password", "username", "password", "unsupported"]), ["password", "username"]);
});

test("builds same-host websocket URLs", () => {
  assert.equal(vncWebSocketURL("/api/vnc-proxy/connect?session=x", { protocol: "https:", host: "desk.test" }), "wss://desk.test/api/vnc-proxy/connect?session=x");
  assert.equal(vncWebSocketURL("/vnc", { protocol: "http:", host: "localhost:7331" }), "ws://localhost:7331/vnc");
});
