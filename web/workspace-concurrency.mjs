export function newWorkspaceRevision(random = globalThis.crypto) {
  // getRandomValues also works on HTTP LAN hosts where randomUUID is absent.
  return Array.from(random.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function workspaceSaveOutcome(currentRevision, status, serverRevision = "") {
  if (status === 409) {
    return { revision: currentRevision || "", suspended: true };
  }
  if (status >= 200 && status < 300 && serverRevision) {
    return { revision: serverRevision, suspended: false };
  }
  return { revision: currentRevision || "", suspended: false };
}

export function workspaceRevisionMatches(localRevision, serverRevision) {
  return Boolean(localRevision && serverRevision && localRevision === serverRevision);
}
