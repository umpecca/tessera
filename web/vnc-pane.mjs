export const defaultVNCPort = 5900;
export const defaultVNCScaleMode = "fit";

export function normalizeVNCTarget(value) {
  let raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (!raw.includes("://")) {
    raw = `vnc://${raw}`;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "vnc:" || parsed.username || parsed.password || !parsed.hostname || parsed.pathname || parsed.search || parsed.hash) {
    return "";
  }
  const port = parsed.port ? Number(parsed.port) : defaultVNCPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "";
  }
  const hostname = parsed.hostname.toLowerCase();
  return `${hostname}:${port}`;
}

export function normalizeVNCScaleMode(value) {
  return value === "one-to-one" ? "one-to-one" : defaultVNCScaleMode;
}

export function vncCredentialFields(types) {
  const allowed = new Set(["username", "password", "target"]);
  return [...new Set(Array.isArray(types) ? types : [])].filter((type) => allowed.has(type));
}

export function vncWebSocketURL(path, locationLike) {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationLike.host}${path}`;
}
