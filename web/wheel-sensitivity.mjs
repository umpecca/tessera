export const defaultWheelSensitivity = 1;
export const wheelSensitivityOptions = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function normalizeWheelSensitivity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 4
    ? parsed
    : defaultWheelSensitivity;
}

export function wheelDeltaUnits(delta, deltaMode, lineSize, pageSize) {
  if (deltaMode === 1) {
    return delta;
  }
  if (deltaMode === 2) {
    return delta * pageSize;
  }
  return delta / lineSize;
}

