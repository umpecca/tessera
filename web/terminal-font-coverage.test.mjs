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

test("Commit Mono faces and redistribution license are bundled", () => {
  const regular = readFileSync(new URL("./assets/CommitMono-Regular.woff2", import.meta.url));
  const bold = readFileSync(new URL("./assets/CommitMono-Bold.woff2", import.meta.url));
  const license = readFileSync(new URL("./assets/CommitMono-OFL.txt", import.meta.url), "utf8");
  assert.ok(regular.length > 10_000, "Commit Mono regular face is unexpectedly small");
  assert.ok(bold.length > 10_000, "Commit Mono bold face is unexpectedly small");
  assert.match(license, /Copyright 2023 Commit Mono authors/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("Departure Mono face and redistribution license are bundled", () => {
  const regular = readFileSync(new URL("./assets/DepartureMono-Regular.woff2", import.meta.url));
  const license = readFileSync(new URL("./assets/DepartureMono-OFL.txt", import.meta.url), "utf8");
  assert.ok(regular.length > 10_000, "Departure Mono regular face is unexpectedly small");
  assert.match(license, /Copyright 2022–2024 Helena Zhang/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

const pixelFontAssets = [
  {
    family: "Spleen", faces: [["Spleen-8x16.woff2", 400]],
    license: "Spleen-LICENSE.txt", notices: [/Frederic Cambus/, /Redistribution and use in source and binary forms/],
  },
  {
    family: "Pixel Operator Mono", faces: [["PixelOperatorMono-Regular.ttf", 400], ["PixelOperatorMono-Bold.ttf", 700]],
    license: "PixelOperator-CC0.txt", notices: [/CC0 1\.0 Universal/],
  },
  {
    family: "scientifica", faces: [["scientifica-Regular.ttf", 400], ["scientifica-Bold.ttf", 700]],
    license: "scientifica-LICENSE.txt", notices: [/Akshay Oppiliappan/, /SIL OPEN FONT\s+LICENSE Version 1\.1/],
  },
  {
    family: "Cozette", faces: [["CozetteVector.woff2", 400]],
    license: "Cozette-LICENSE.txt", notices: [/MIT License/, /Copyright \(c\) 2020, Ines/],
  },
];

const addedFontAssets = [
  {
    family: "Hack", faces: [["Hack-Regular.woff2", 400], ["Hack-Bold.woff2", 700]],
    license: "Hack-LICENSE.txt", notices: [/Copyright 2018 Source Foundry Authors/, /MIT License/, /BITSTREAM VERA LICENSE/],
  },
  {
    family: "Cascadia Code", faces: [["CascadiaCode-Regular.woff2", 400], ["CascadiaCode-Bold.woff2", 700]],
    license: "CascadiaCode-OFL.txt", notices: [/Microsoft Corporation/, /SIL OPEN FONT LICENSE Version 1\.1/],
  },
  {
    family: "Iosevka", faces: [["Iosevka-Regular.woff2", 400], ["Iosevka-Bold.woff2", 700]],
    license: "Iosevka-OFL.txt", notices: [/Renzhi Li/, /SIL Open Font License v1\.1/],
  },
  {
    family: "Victor Mono", faces: [["VictorMono-Regular.woff2", 400], ["VictorMono-Bold.woff2", 700]],
    license: "VictorMono-OFL.txt", notices: [/Rune Bjørnerås/, /SIL OPEN FONT LICENSE Version 1\.1/],
  },
  {
    family: "Inconsolata", faces: [["Inconsolata-Regular.ttf", 400], ["Inconsolata-Bold.ttf", 700]],
    license: "Inconsolata-OFL.txt", notices: [/The Inconsolata Project Authors/, /SIL OPEN FONT LICENSE Version 1\.1/],
  },
];

for (const { family, faces, license, notices } of [...pixelFontAssets, ...addedFontAssets]) {
  test(`${family} has locally registered font files and redistribution notices`, () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const definitions = [...styles.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);
    assert.equal(definitions.filter(block => block.includes(`font-family: "${family}";`)).length, faces.length,
      `${family} must register only its terminal-compatible weights`);
    for (const [filename, weight] of faces) {
      const path = `./assets/${filename}`;
      const bytes = readFileSync(new URL(path, import.meta.url));
      assert.ok(bytes.length > 4_000, `${filename} is unexpectedly small`);
      const definition = definitions.find(block => block.includes(`url("/assets/${filename}")`));
      assert.ok(definition, `${filename} has no local @font-face`);
      assert.ok(definition.includes(`font-family: "${family}";`));
      assert.ok(definition.includes(`font-weight: ${weight};`));
      if (filename.endsWith(".woff2")) {
        assert.equal(bytes.toString("ascii", 0, 4), "wOF2", `${filename} is not WOFF2`);
        assert.equal(bytes.readUInt32BE(8), bytes.length, `${filename} has a truncated WOFF2 header`);
      } else {
        const codepoints = fontCodepoints(path);
        for (let codepoint = 0x20; codepoint <= 0x7e; codepoint++) {
          assert.ok(codepoints.has(codepoint), `${filename} is missing ASCII U+${codepoint.toString(16)}`);
        }
      }
    }
    const text = readFileSync(new URL(`./assets/${license}`, import.meta.url), "utf8");
    for (const notice of notices) assert.match(text, notice);
  });
}
