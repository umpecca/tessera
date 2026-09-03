import assert from "node:assert/strict";
import test from "node:test";

import { safeCodePointString } from "./unicode-codepoint.mjs";

test("converts valid Unicode scalar values", () => {
  assert.equal(safeCodePointString(0x41), "A");
  assert.equal(safeCodePointString(0x1f642), "🙂");
});

test("replaces invalid Unicode scalar values", () => {
  for (const value of [-1, 1.5, 0xd800, 0xdfff, 0x110000, 1789390]) {
    assert.equal(safeCodePointString(value), "�");
  }
});

test("supports a caller-specific fallback", () => {
  assert.equal(safeCodePointString(1789390, " "), " ");
});

