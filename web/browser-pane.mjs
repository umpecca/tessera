export const browseLocalPortHelpCommand = Object.freeze({
  id: "browse-local-port-help",
  label: "Browse Local Port Help",
  hint: "localhost proxy guide",
});

export const browserLocalPortExamples = Object.freeze([
  Object.freeze({
    label: "Flask",
    command: "flask --app app run --host 127.0.0.1 --port 5000",
    address: "localhost:5000",
  }),
  Object.freeze({
    label: "Vite",
    command: "npm run dev -- --host 127.0.0.1 --port 5173",
    address: "localhost:5173",
  }),
  Object.freeze({
    label: "Python files",
    command: "python -m http.server 8000 --bind 127.0.0.1",
    address: "localhost:8000",
  }),
]);

export function normalizeBrowserAddress(value) {
  let raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (!raw.includes("://")) {
    raw = `http://${raw}`;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }
  if (parsed.username || parsed.password || !isLoopbackBrowserHost(parsed.hostname)) {
    return "";
  }
  parsed.hash = "";
  return parsed.href;
}

export function browserHelpAddress(currentAddress) {
  return normalizeBrowserAddress(currentAddress) || "localhost:5000";
}

export function isLoopbackBrowserHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") {
    return true;
  }
  const parts = host.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 127;
}
