export function normalizeServerVersion(version) {
  return String(version || "").trim().replace(/^v/u, "");
}

export function isExpectedServerVersion(health, expectedVersion) {
  const actual = normalizeServerVersion(health?.version);
  const expected = normalizeServerVersion(expectedVersion);
  return Boolean(actual && expected && actual === expected);
}

