export const defaultTerminalFont = "jetbrains-mono";

export const terminalFonts = Object.freeze({
  "jetbrains-mono": Object.freeze({
    label: "JetBrains Mono",
    family: '"JetBrains Mono", monospace',
  }),
  "fira-code": Object.freeze({
    label: "Fira Code",
    family: '"Fira Code", monospace',
  }),
});

export function normalizeTerminalFont(value) {
  return terminalFonts[value] ? value : defaultTerminalFont;
}

export function terminalFontFamily(value) {
  return terminalFonts[normalizeTerminalFont(value)].family;
}

export function terminalFontDescriptors(value, fontSize) {
  const size = Number.isFinite(Number(fontSize)) ? Number(fontSize) : 14;
  const family = terminalFontFamily(value);
  return [`${size}px ${family}`, `bold ${size}px ${family}`];
}

export async function loadTerminalFont(fontSet, value, fontSize) {
  if (!fontSet?.load) {
    return;
  }
  await Promise.all(terminalFontDescriptors(value, fontSize).map((descriptor) => fontSet.load(descriptor)));
}
