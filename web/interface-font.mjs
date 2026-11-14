// The menu/body text hierarchy scales independently of terminal canvas metrics.
// Styles are drawn at the 12px base; the default is scaled up from it.
export const baseInterfaceFontSize = 12;
export const defaultInterfaceFontSize = 14;
export const minimumInterfaceFontSize = 10;
export const maximumInterfaceFontSize = 18;

export function normalizeInterfaceFontSize(value) {
  const size = Number(value);
  return Number.isInteger(size) && size >= minimumInterfaceFontSize && size <= maximumInterfaceFontSize
    ? size : defaultInterfaceFontSize;
}
