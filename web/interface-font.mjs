// The menu/body text hierarchy scales independently of terminal canvas metrics.
export const defaultInterfaceFontSize = 12;
export const minimumInterfaceFontSize = 10;
export const maximumInterfaceFontSize = 18;

export function normalizeInterfaceFontSize(value) {
  const size = Number(value);
  return Number.isInteger(size) && size >= minimumInterfaceFontSize && size <= maximumInterfaceFontSize
    ? size : defaultInterfaceFontSize;
}
