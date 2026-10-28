import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchKeptRDPSessions,
  findKeptRDPSession,
  keptRDPCreateBody,
  keptRDPPaneBody,
  rdpKeepPreferenceKey,
  rdpIdleLimitText,
  rdpKeepLabelText,
  readRDPKeepPreference,
  saveRDPKeepPreference,
} from "./rdp-kept.mjs";

const reply = (ok, body) => async () => ({ ok, json: async () => body });

test("lists kept sessions, or null when the host doesn't offer them", async () => {
  const sessions = [{ workspaceId: "w", pane: "p", state: "active" }];
  assert.deepEqual(await fetchKeptRDPSessions(reply(true, { sessions, idleLimitSeconds: 28800 })), {
    sessions,
    idleLimitSeconds: 28800,
  });
  assert.deepEqual(await fetchKeptRDPSessions(reply(true, {})), { sessions: [], idleLimitSeconds: 0 });
  assert.deepEqual(await fetchKeptRDPSessions(reply(true, { idleLimitSeconds: "soon" })), { sessions: [], idleLimitSeconds: 0 });
  assert.equal(await fetchKeptRDPSessions(reply(false, { error: "needs sign-in" })), null);
  assert.equal(await fetchKeptRDPSessions(async () => { throw new Error("offline"); }), null);
  assert.equal(await fetchKeptRDPSessions(async () => ({ ok: true, json: async () => { throw new Error("html"); } })), null);
});

test("finds the session kept for a window", () => {
  const sessions = [
    { workspaceId: "w1", pane: "p", state: "active" },
    { workspaceId: "w2", pane: "p", state: "lost" },
  ];
  assert.equal(findKeptRDPSession(sessions, "w2", "p").state, "lost");
  assert.equal(findKeptRDPSession(sessions, "w2", "other"), null);
  assert.equal(findKeptRDPSession(null, "w2", "p"), null);
});

test("remembers whether to keep sessions, on by default", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readRDPKeepPreference(storage), true);
  saveRDPKeepPreference(storage, false);
  assert.equal(values.get(rdpKeepPreferenceKey), "false");
  assert.equal(readRDPKeepPreference(storage), false);
  saveRDPKeepPreference(storage, true);
  assert.equal(readRDPKeepPreference(storage), true);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readRDPKeepPreference(broken), true);
  saveRDPKeepPreference(broken, false);
  assert.equal(readRDPKeepPreference(undefined), true);
});

// The fields of rdpKeptRequest in internal/httpapi/rdp_kept.go, which the host
// decodes strictly: an unknown field is refused.
const hostFields = ["domain", "fingerprint", "h264", "height", "pane", "password", "pixelRatio", "scaleFactor", "scaledHeight", "scaledWidth", "target", "username", "width", "workspaceId"];

test("builds the create request with exactly the host's fields", () => {
  const body = keptRDPCreateBody({
    workspaceId: "w",
    pane: "pane-1",
    target: "mac.local:3389",
    fingerprint: "ab".repeat(32),
    credentials: { username: "jane", domain: "", password: "secret" },
    size: { width: 2432, height: 1280 },
    h264: true,
    pixelRatio: 2,
    scaled: { width: 1920, height: 1048, scale: 200 },
  });
  assert.deepEqual(Object.keys(body).sort(), hostFields);
  assert.deepEqual([body.width, body.height, body.h264, body.pixelRatio, body.username, body.password], [2432, 1280, true, 2, "jane", "secret"]);
  const plain = keptRDPCreateBody({ credentials: {}, size: {}, h264: undefined });
  assert.equal(plain.h264, false);
  assert.equal(plain.pixelRatio, 0);
  assert.deepEqual([body.scaledWidth, body.scaledHeight, body.scaleFactor], [1920, 1048, 200]);
  assert.deepEqual([plain.scaledWidth, plain.scaledHeight, plain.scaleFactor], [0, 0, 0]);
});

test("builds the rejoin and disconnect requests", () => {
  assert.deepEqual(keptRDPPaneBody("w", "p", "pw"), { workspaceId: "w", pane: "p", password: "pw" });
  assert.deepEqual(keptRDPPaneBody("w", "p"), { workspaceId: "w", pane: "p" });
  for (const field of Object.keys(keptRDPPaneBody("w", "p", "pw"))) assert.ok(hostFields.includes(field), field);
});

test("describes the idle limit", () => {
  assert.equal(rdpIdleLimitText(28800), "8 hours");
  assert.equal(rdpIdleLimitText(3600), "1 hour");
  assert.equal(rdpIdleLimitText(5400), "90 minutes");
  assert.equal(rdpIdleLimitText(60), "1 minute");
  assert.equal(rdpIdleLimitText(90), "2 minutes");
  assert.match(rdpKeepLabelText(28800), /ends after 8 hours without a viewer$/);
  assert.doesNotMatch(rdpKeepLabelText(0), /ends after/);
});
