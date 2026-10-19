import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { decodeGhosttyWebUnderlines } from "./ghostty-web-underlines.mjs";

test("both pinned cell decoders read the underline byte, once", async () => {
  const source = await fs.readFile(new URL("../node_modules/ghostty-web/dist/ghostty-web.js", import.meta.url), "utf8");
  const patched = decodeGhosttyWebUnderlines(source);
  assert.equal(decodeGhosttyWebUnderlines(patched), patched);
  assert.equal((patched.match(/underline: I\[w \+ 15\]/g) || []).length, 1);
  assert.equal((patched.match(/i\.underline = E\[D \+ 15\]/g) || []).length, 1);
  assert.throws(() => decodeGhosttyWebUnderlines(source.replace("i.grapheme_len = E[D + 14];", "i.grapheme_len = 0;")), /cell decoding changed/);
});
