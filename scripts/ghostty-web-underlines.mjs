// ghostty-web decodes each 16-byte cell but skips its last byte, where
// Tessera's core puts the underline style and whether the underline has its
// own colour (internal/terminalcore/source/underline_api.zig). Decode it as
// cell.underline, and the colour as cell.underline_color (0xRRGGBB). Fail
// closed when the pinned decoders change.
const helper = "function tesseraUnderlineColor(t, i) { const at = t.exports.tessera_underline_colors?.(t.handle); return at ? new Uint32Array(t.memory.buffer, at, i + 1)[i] : 0; }\n";

export function decodeGhosttyWebUnderlines(source) {
  if (source.startsWith(helper)) return source;
  const replacements = [
    // History lines.
    ["        grapheme_len: I[w + 14]\n      });",
      "        grapheme_len: I[w + 14],\n        underline: I[w + 15],\n        underline_color: I[w + 15] & 8 ? tesseraUnderlineColor(this, i) : 0\n      });"],
    // The viewport, and Tessera's one-row reads.
    ["i.grapheme_len = E[D + 14];",
      "i.grapheme_len = E[D + 14], i.underline = E[D + 15], i.underline_color = E[D + 15] & 8 ? tesseraUnderlineColor(this, I) : 0;"],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error("Pinned ghostty-web cell decoding changed");
    source = source.replace(before, after);
  }
  return helper + source;
}
