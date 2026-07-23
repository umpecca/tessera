import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultTerminalFont,
  loadTerminalFont,
  normalizeTerminalFont,
  terminalFontDescriptors,
  terminalFontFamily,
} from "./terminal-font.mjs";

test("normalizes terminal font IDs to the JetBrains Mono default", () => {
  assert.equal(normalizeTerminalFont("fira-code"), "fira-code");
  assert.equal(normalizeTerminalFont("JetBrains Mono"), defaultTerminalFont);
  assert.equal(normalizeTerminalFont(""), defaultTerminalFont);
});

test("returns regular and bold browser font descriptors", () => {
  assert.equal(terminalFontFamily("jetbrains-mono"), '"JetBrains Mono", monospace');
  assert.deepEqual(terminalFontDescriptors("fira-code", 16), [
    '16px "Fira Code", monospace',
    'bold 16px "Fira Code", monospace',
  ]);
});

test("waits for regular and bold terminal faces", async () => {
  const loaded = [];
  await loadTerminalFont({ load: async (descriptor) => loaded.push(descriptor) }, "jetbrains-mono", 15);
  assert.deepEqual(loaded, [
    '15px "JetBrains Mono", monospace',
    'bold 15px "JetBrains Mono", monospace',
  ]);
});
