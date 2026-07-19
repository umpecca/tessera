import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWheelSensitivity, wheelDeltaUnits } from "./wheel-sensitivity.mjs";

test("normalizes wheel sensitivity within the supported range", () => {
  assert.equal(normalizeWheelSensitivity(0.25), 0.25);
  assert.equal(normalizeWheelSensitivity("1.5"), 1.5);
  assert.equal(normalizeWheelSensitivity(4), 4);
  assert.equal(normalizeWheelSensitivity(0), 1);
  assert.equal(normalizeWheelSensitivity(5), 1);
  assert.equal(normalizeWheelSensitivity("fast"), 1);
});

test("converts pixel, line, and page wheel deltas to surface units", () => {
  assert.equal(wheelDeltaUnits(40, 0, 20, 24), 2);
  assert.equal(wheelDeltaUnits(3, 1, 20, 24), 3);
  assert.equal(wheelDeltaUnits(1, 2, 20, 24), 24);
});

