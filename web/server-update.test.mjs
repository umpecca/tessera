import assert from "node:assert/strict";
import test from "node:test";

import { isExpectedServerVersion, isSystemdUpdateCheck, normalizeServerVersion } from "./server-update.mjs";

test("normalizes optional release tag prefixes", () => {
  assert.equal(normalizeServerVersion(" v1.2.3 "), "1.2.3");
  assert.equal(normalizeServerVersion("1.2.3"), "1.2.3");
});

test("accepts only the expected restarted server version", () => {
  assert.equal(isExpectedServerVersion({ version: "1.2.3" }, "v1.2.3"), true);
  assert.equal(isExpectedServerVersion({ version: "v1.2.2" }, "v1.2.3"), false);
  assert.equal(isExpectedServerVersion(null, "v1.2.3"), false);
});

test("recognizes only actionable systemd update checks", () => {
  assert.equal(isSystemdUpdateCheck({
    updateAvailable: true,
    updateMode: "systemd",
    updateCommand: "sudo systemd-run tessera",
  }), true);
  assert.equal(isSystemdUpdateCheck({ updateAvailable: false, updateMode: "systemd", updateCommand: "command" }), false);
  assert.equal(isSystemdUpdateCheck({ updateAvailable: true, updateMode: "direct", updateCommand: "command" }), false);
  assert.equal(isSystemdUpdateCheck({ updateAvailable: true, updateMode: "systemd", updateCommand: "" }), false);
  assert.equal(isSystemdUpdateCheck(null), false);
});
