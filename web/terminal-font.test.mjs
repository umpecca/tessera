import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultTerminalFont,
  loadTerminalFont,
  normalizeTerminalFont,
  terminalFontDescriptors,
  terminalFontFamily,
  terminalFonts,
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
  assert.deepEqual(terminalFontDescriptors("commit-mono", 16), [
    '16px "Commit Mono", "Noto Sans Symbols 2", monospace',
    'bold 16px "Commit Mono", "Noto Sans Symbols 2", monospace',
  ]);
  assert.deepEqual(terminalFontDescriptors("departure-mono", 16), [
    '16px "Departure Mono", "Noto Sans Symbols 2", monospace',
    'bold 16px "Departure Mono", "Noto Sans Symbols 2", monospace',
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

for (const [id, label, family] of [
  ["spleen", "Spleen", "Spleen"],
  ["pixel-operator-mono", "Pixel Operator Mono", "Pixel Operator Mono"],
  ["scientifica", "scientifica", "scientifica"],
  ["cozette", "Cozette", "Cozette"],
]) {
  test(`${label} is selectable and loads both weights before terminal measurement`, async () => {
    assert.equal(normalizeTerminalFont(id), id);
    assert.equal(terminalFonts[id].label, label);
    assert.equal(terminalPrimaryFontFamily(id), `"${family}", monospace`);
    const descriptors = [
      `16px "${family}", ${terminalSymbolFontFamily}, monospace`,
      `bold 16px "${family}", ${terminalSymbolFontFamily}, monospace`,
    ];
    assert.deepEqual(terminalFontDescriptors(id, 16), descriptors);
    const pending = [], loaded = [];
    const loading = loadTerminalFont({ load: (...request) => {
      loaded.push(request);
      return new Promise(resolve => pending.push(resolve));
    } }, id, 16);
    assert.deepEqual(loaded, [
      ...descriptors.map(descriptor => [descriptor, "M"]),
      [`16px ${terminalSymbolFontFamily}`, terminalSymbolProbe],
      [`bold 16px ${terminalSymbolFontFamily}`, terminalSymbolProbe],
    ]);
    let ready = false;
    loading.then(() => { ready = true; });
    for (const resolve of pending.slice(0, -1)) resolve([]);
    await Promise.resolve();
    assert.equal(ready, false, "terminal must wait for every font load");
    pending.at(-1)([]);
    await loading;
    assert.equal(ready, true);
  });
}
