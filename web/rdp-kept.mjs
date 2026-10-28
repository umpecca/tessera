// The browser's side of RDP sessions kept on the host (task 238): finding out
// whether the host offers them, which one belongs to a window, and the
// requests that create, rejoin and end one.

export const rdpKeepPreferenceKey = "tessera.rdp-keep";

// The kept sessions the host lists for the signed-in user, and how long it
// keeps one with no viewer, or null when the host doesn't offer them to this
// page: sign-in is off, the page isn't HTTPS or loopback, or the feature is
// unavailable.
export async function fetchKeptRDPSessions(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl("/api/rdp-kept");
    if (!response.ok) return null;
    const data = await response.json();
    const idleLimitSeconds = Number(data?.idleLimitSeconds);
    return {
      sessions: Array.isArray(data?.sessions) ? data.sessions : [],
      idleLimitSeconds: Number.isFinite(idleLimitSeconds) && idleLimitSeconds > 0 ? idleLimitSeconds : 0,
    };
  } catch {
    return null;
  }
}

// The idle limit in words, such as "8 hours" or "90 minutes".
export function rdpIdleLimitText(seconds) {
  const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (seconds >= 3600 && seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  return plural(Math.max(1, Math.round(seconds / 60)), "minute");
}

// The keep checkbox's label, which says how long the host waits for a viewer.
export function rdpKeepLabelText(idleLimitSeconds) {
  const base = "Keep this session on the Tessera host, so it is still here when you come back";
  if (!idleLimitSeconds) return base;
  return `${base}. It ends after ${rdpIdleLimitText(idleLimitSeconds)} without a viewer`;
}

// The session kept for a window, which is keyed by its workspace and pane.
export function findKeptRDPSession(sessions, workspaceId, pane) {
  return sessions?.find((session) => session.workspaceId === workspaceId && session.pane === pane) || null;
}

// Whether new sessions should be kept: on unless the user turned it off.
export function readRDPKeepPreference(storage) {
  try {
    return storage?.getItem(rdpKeepPreferenceKey) !== "false";
  } catch {
    return true;
  }
}

export function saveRDPKeepPreference(storage, keep) {
  try {
    storage?.setItem(rdpKeepPreferenceKey, keep ? "true" : "false");
  } catch {
    // The choice just isn't remembered.
  }
}

// The request that keeps a new session; its fields are exactly the host's.
export function keptRDPCreateBody({ workspaceId, pane, target, fingerprint, credentials, size, h264 }) {
  return {
    workspaceId,
    pane,
    target,
    fingerprint,
    username: credentials.username,
    domain: credentials.domain,
    password: credentials.password,
    width: size.width,
    height: size.height,
    h264: Boolean(h264),
  };
}

// The request that rejoins a lost session, or ends one.
export function keptRDPPaneBody(workspaceId, pane, password) {
  return password === undefined ? { workspaceId, pane } : { workspaceId, pane, password };
}
