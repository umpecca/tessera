import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultOLEDBorderSize,
  normalizeOLEDBorderSize,
} from "./oled-border-size.mjs";

test("normalizeOLEDBorderSize preserves valid values and rounds fractions", () => {
  assert.equal(normalizeOLEDBorderSize(1), 1);
  assert.equal(normalizeOLEDBorderSize(10), 10);
  assert.equal(normalizeOLEDBorderSize("14"), 14);
  assert.equal(normalizeOLEDBorderSize(14.6), 15);
});

test("normalizeOLEDBorderSize clamps values to the supported range", () => {
  assert.equal(normalizeOLEDBorderSize(0), 1);
  assert.equal(normalizeOLEDBorderSize(100), 20);
});

test("normalizeOLEDBorderSize uses the existing border size for invalid values", () => {
  assert.equal(normalizeOLEDBorderSize(undefined), defaultOLEDBorderSize);
  assert.equal(normalizeOLEDBorderSize("invalid"), defaultOLEDBorderSize);
});
