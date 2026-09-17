import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Read Unicode cmap mappings directly, so the test can guard the actual
// shipped bytes without adding a font parser to Tessera's runtime dependencies.
function fontCodepoints(path) {
  const bytes = readFileSync(new URL(path, import.meta.url));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.getUint16(4);
  let cmapOffset = -1;
  for (let index = 0; index < tableCount; index++) {
    const record = 12 + index * 16;
    if (bytes.toString("ascii", record, record + 4) === "cmap") {
      cmapOffset = view.getUint32(record + 8);
      break;
    }
  }
  assert.ok(cmapOffset >= 0, `${path} has no cmap table`);
  const subtableCount = view.getUint16(cmapOffset + 2);
  const candidates = [];
  for (let index = 0; index < subtableCount; index++) {
    const record = cmapOffset + 4 + index * 8;
    const candidate = cmapOffset + view.getUint32(record + 4);
    const format = view.getUint16(candidate);
    if ((format === 4 || format === 12) && !candidates.some(item => item.offset === candidate)) {
      candidates.push({ format, offset: candidate });
    }
  }
  const codepoints = new Set();
  for (const candidate of candidates) {
    if (candidate.format === 12) {
      const groups = view.getUint32(candidate.offset + 12);
      for (let index = 0; index < groups; index++) {
        const group = candidate.offset + 16 + index * 12;
        const start = view.getUint32(group);
        const end = view.getUint32(group + 4);
        for (let codepoint = start; codepoint <= end; codepoint++) codepoints.add(codepoint);
      }
      continue;
    }
    const segments = view.getUint16(candidate.offset + 6) / 2;
    const endCodes = candidate.offset + 14;
    const startCodes = endCodes + segments * 2 + 2;
    const deltas = startCodes + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment++) {
      const start = view.getUint16(startCodes + segment * 2);
      const end = view.getUint16(endCodes + segment * 2);
      const delta = view.getInt16(deltas + segment * 2);
      const rangeOffset = view.getUint16(rangeOffsets + segment * 2);
      for (let codepoint = start; codepoint <= end && codepoint !== 0xffff; codepoint++) {
        let glyph = (codepoint + delta) & 0xffff;
        if (rangeOffset !== 0) {
          const address = rangeOffsets + segment * 2 + rangeOffset + (codepoint - start) * 2;
          glyph = view.getUint16(address);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) codepoints.add(codepoint);
      }
    }
  }
  assert.ok(candidates.length > 0, `${path} has no supported Unicode cmap`);
  return codepoints;
}

test("bundled symbol fallback covers the reported and representative terminal symbols", () => {
  const primary = fontCodepoints("./assets/JetBrainsMono-Variable.ttf");
  const symbols = fontCodepoints("./assets/NotoSansSymbols2-Regular.ttf");
  assert.equal(primary.has(0x23f5), false, "fixture no longer exercises a fallback glyph");
  for (const [codepoint, label] of [
    [0x23f5, "Claude auto-mode triangle"],
    [0x23f8, "technical pause symbol"],
    [0x25c9, "geometric fisheye"],
    [0x2702, "dingbat scissors"],
    [0x2b9e, "triangle-headed arrow"],
    [0x2801, "Braille dot"],
  ]) assert.ok(symbols.has(codepoint), `${label} U+${codepoint.toString(16)} is missing`);
});

test("selected monospace face keeps precedence for ordinary and terminal-native glyphs", () => {
  const primary = fontCodepoints("./assets/JetBrainsMono-Variable.ttf");
  for (const codepoint of [0x41, 0x2500, 0x2588, 0xe0b0]) {
    assert.ok(primary.has(codepoint), `primary face lost U+${codepoint.toString(16)}`);
  }
});

test("bundled symbol font carries its redistribution license", () => {
  const license = readFileSync(new URL("./assets/NotoSansSymbols2-OFL.txt", import.meta.url), "utf8");
  assert.match(license, /Copyright 2022 The Noto Project Authors/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("IBM Plex Mono faces and redistribution license are bundled", () => {
  const regular = readFileSync(new URL("./assets/IBMPlexMono-Regular.woff2", import.meta.url));
  const bold = readFileSync(new URL("./assets/IBMPlexMono-Bold.woff2", import.meta.url));
  const license = readFileSync(new URL("./assets/IBMPlexMono-OFL.txt", import.meta.url), "utf8");
  assert.ok(regular.length > 10_000, "IBM Plex Mono regular face is unexpectedly small");
  assert.ok(bold.length > 10_000, "IBM Plex Mono bold face is unexpectedly small");
  assert.match(license, /Copyright © 2017 IBM Corp/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});
