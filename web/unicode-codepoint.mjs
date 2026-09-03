export function safeCodePointString(codepoint, fallback = "�") {
  if (
    !Number.isInteger(codepoint) ||
    codepoint < 0 ||
    codepoint > 0x10ffff ||
    (codepoint >= 0xd800 && codepoint <= 0xdfff)
  ) {
    return fallback;
  }
  return String.fromCodePoint(codepoint);
}

