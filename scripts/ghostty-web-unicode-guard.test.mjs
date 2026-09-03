import assert from "node:assert/strict";
import test from "node:test";

import { guardGhosttyWebCodepoints } from "./ghostty-web-unicode-guard.mjs";

async function loadGuardedFixture() {
  const source = `
    export const single = (value) => String.fromCodePoint(value);
    export const grapheme = (values) => String.fromCodePoint(...values);
  `;
  const guarded = guardGhosttyWebCodepoints(source);
  return import(`data:text/javascript,${encodeURIComponent(guarded)}`);
}

test("preserves valid BMP, astral, and grapheme code points", async () => {
  const fixture = await loadGuardedFixture();

  assert.equal(fixture.single(0x41), "A");
  assert.equal(fixture.single(0x1f642), "🙂");
  assert.equal(fixture.grapheme([0x65, 0x301]), "é");
});

test("replaces every invalid Unicode scalar value", async () => {
  const fixture = await loadGuardedFixture();

  assert.equal(fixture.single(-1), "�");
  assert.equal(fixture.single(0xd800), "�");
  assert.equal(fixture.single(0x110000), "�");
  assert.equal(fixture.single(1.5), "�");
  assert.equal(fixture.grapheme([0x41, 1789390, 0x42]), "A�B");
});

test("fails the build when the expected conversion boundary disappears", () => {
  assert.throws(
    () => guardGhosttyWebCodepoints("export const value = 1;"),
    /contains no String\.fromCodePoint calls/,
  );
});

test("does not apply the guard twice", () => {
  const once = guardGhosttyWebCodepoints("String.fromCodePoint(0x41);");
  assert.equal(guardGhosttyWebCodepoints(once), once);
});

