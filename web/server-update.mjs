export function normalizeServerVersion(version) {
  return String(version || "").trim().replace(/^v/u, "");
}

export function isExpectedServerVersion(health, expectedVersion) {
  const actual = normalizeServerVersion(health?.version);
  const expected = normalizeServerVersion(expectedVersion);
  return Boolean(actual && expected && actual === expected);
}

export function isSystemdUpdateCheck(check) {
  return Boolean(
    check?.updateAvailable
    && check.updateMode === "systemd"
    && typeof check.updateCommand === "string"
    && check.updateCommand.trim()
  );
}
