import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultTerminalFont,
  loadTerminalFont,
  normalizeTerminalFont,
  terminalFontDescriptors,
  terminalFontFamily,
  terminalPrimaryFontFamily,
  terminalSymbolFontFamily,
  terminalSymbolProbe,
} from "./terminal-font.mjs";

test("normalizes terminal font IDs to the JetBrains Mono default", () => {
  assert.equal(normalizeTerminalFont("fira-code"), "fira-code");
  assert.equal(normalizeTerminalFont("ibm-plex-mono"), "ibm-plex-mono");
  assert.equal(normalizeTerminalFont("JetBrains Mono"), defaultTerminalFont);
  assert.equal(normalizeTerminalFont(""), defaultTerminalFont);
});

test("returns regular and bold browser font descriptors", () => {
  assert.equal(terminalPrimaryFontFamily("jetbrains-mono"), '"JetBrains Mono", monospace');
  assert.equal(terminalPrimaryFontFamily("fira-code"), '"Fira Code", monospace');
  assert.equal(terminalPrimaryFontFamily("ibm-plex-mono"), '"IBM Plex Mono", monospace');
  assert.equal(terminalFontFamily("jetbrains-mono"), '"JetBrains Mono", "Noto Sans Symbols 2", monospace');
  assert.deepEqual(terminalFontDescriptors("fira-code", 16), [
    '16px "Fira Code", "Noto Sans Symbols 2", monospace',
    'bold 16px "Fira Code", "Noto Sans Symbols 2", monospace',
  ]);
  assert.deepEqual(terminalFontDescriptors("ibm-plex-mono", 16), [
    '16px "IBM Plex Mono", "Noto Sans Symbols 2", monospace',
    'bold 16px "IBM Plex Mono", "Noto Sans Symbols 2", monospace',
  ]);
});

test("waits for regular, bold, and deterministic symbol fallback faces", async () => {
  const loaded = [];
  await loadTerminalFont({ load: async (...request) => loaded.push(request) }, "jetbrains-mono", 15);
  assert.deepEqual(loaded, [
    ['15px "JetBrains Mono", "Noto Sans Symbols 2", monospace', "M"],
    ['bold 15px "JetBrains Mono", "Noto Sans Symbols 2", monospace', "M"],
    [`15px ${terminalSymbolFontFamily}`, terminalSymbolProbe],
    [`bold 15px ${terminalSymbolFontFamily}`, terminalSymbolProbe],
  ]);
});
