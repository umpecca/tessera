export const defaultOLEDBorderSize = 10;
export const minimumOLEDBorderSize = 1;
export const maximumOLEDBorderSize = 20;

export function normalizeOLEDBorderSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultOLEDBorderSize;
  }
  return Math.max(minimumOLEDBorderSize, Math.min(maximumOLEDBorderSize, Math.round(parsed)));
}
