const helperName = "tesseraStringFromCodePoint";
const helperSource = `
function ${helperName}(...codepoints) {
  return String.fromCodePoint(...codepoints.map((codepoint) =>
    Number.isInteger(codepoint) &&
    codepoint >= 0 &&
    codepoint <= 0x10ffff &&
    !(codepoint >= 0xd800 && codepoint <= 0xdfff)
      ? codepoint
      : 0xfffd
  ));
}
`;

export function guardGhosttyWebCodepoints(source) {
  if (source.includes(`function ${helperName}(`)) {
    return source;
  }

  const calls = source.match(/String\.fromCodePoint/g) ?? [];
  if (calls.length === 0) {
    throw new Error("ghostty-web contains no String.fromCodePoint calls to guard");
  }

  return `${helperSource}\n${source.replaceAll("String.fromCodePoint", helperName)}`;
}

