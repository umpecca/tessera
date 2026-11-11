export const defaultTerminalFont = "jetbrains-mono";
export const terminalSymbolFontFamily = '"Noto Sans Symbols 2"';
export const terminalSymbolProbe = "⏵⏸⮞⣿";

export const terminalFonts = Object.freeze({
  "jetbrains-mono": Object.freeze({
    label: "JetBrains Mono",
    family: '"JetBrains Mono", monospace',
  }),
  "fira-code": Object.freeze({
    label: "Fira Code",
    family: '"Fira Code", monospace',
  }),
  "ibm-plex-mono": Object.freeze({
    label: "IBM Plex Mono",
    family: '"IBM Plex Mono", monospace',
  }),
  "commit-mono": Object.freeze({
    label: "Commit Mono",
    family: '"Commit Mono", monospace',
  }),
  "departure-mono": Object.freeze({
    label: "Departure Mono",
    family: '"Departure Mono", monospace',
  }),
  spleen: Object.freeze({
    label: "Spleen",
    family: '"Spleen", monospace',
  }),
  "pixel-operator-mono": Object.freeze({
    label: "Pixel Operator Mono",
    family: '"Pixel Operator Mono", monospace',
  }),
  scientifica: Object.freeze({
    label: "scientifica",
    family: '"scientifica", monospace',
  }),
  cozette: Object.freeze({
    label: "Cozette",
    family: '"Cozette", monospace',
  }),
});

export function normalizeTerminalFont(value) {
  return terminalFonts[value] ? value : defaultTerminalFont;
}

export function terminalPrimaryFontFamily(value) {
  return terminalFonts[normalizeTerminalFont(value)].family;
}

export function terminalFontFamily(value) {
  const primary = terminalPrimaryFontFamily(value).replace(/, monospace$/, "");
  // Keep terminal symbols independent of the operating system. In particular,
  // Firefox 115 on High Sierra otherwise falls back to an old macOS face whose
  // canvas advance widths can overlap adjacent terminal cells.
  return `${primary}, ${terminalSymbolFontFamily}, monospace`;
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
  const size = Number.isFinite(Number(fontSize)) ? Number(fontSize) : 14;
  await Promise.all([
    ...terminalFontDescriptors(value, size).map((descriptor) => fontSet.load(descriptor, "M")),
    fontSet.load(`${size}px ${terminalSymbolFontFamily}`, terminalSymbolProbe),
    fontSet.load(`bold ${size}px ${terminalSymbolFontFamily}`, terminalSymbolProbe),
  ]);
}
