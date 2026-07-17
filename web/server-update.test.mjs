import assert from "node:assert/strict";
import test from "node:test";

import { isExpectedServerVersion, normalizeServerVersion } from "./server-update.mjs";

test("normalizes optional release tag prefixes", () => {
  assert.equal(normalizeServerVersion(" v1.2.3 "), "1.2.3");
  assert.equal(normalizeServerVersion("1.2.3"), "1.2.3");
});

test("accepts only the expected restarted server version", () => {
  assert.equal(isExpectedServerVersion({ version: "1.2.3" }, "v1.2.3"), true);
  assert.equal(isExpectedServerVersion({ version: "v1.2.2" }, "v1.2.3"), false);
  assert.equal(isExpectedServerVersion(null, "v1.2.3"), false);
});

