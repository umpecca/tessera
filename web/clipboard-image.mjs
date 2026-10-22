import { terminalKittyKeyEvent } from "./terminal-kitty-keyboard.mjs";

// Image paste. A terminal carries only text, and programs such as opencode
// paste an image by reading the host's clipboard themselves when they receive
// Ctrl+V. So an image pasted into a terminal goes to the server, which puts it
// on the host clipboard (internal/hostclipboard), and the terminal then gets
// the program's paste key.

export const hostClipboardEndpoint = "/api/host/clipboard";

// The image in a paste that carries no text. Text wins when there is both:
// copying an image from a web page also copies its address, and pasting that
// is what a terminal has always done.
export function pastedImage(dataTransfer) {
  if (!dataTransfer || dataTransfer.getData?.("text/plain")) return null;
  for (const item of dataTransfer.items || []) {
    if (item.kind === "file" && item.type?.startsWith("image/")) {
      const file = item.getAsFile?.();
      if (file) return file;
    }
  }
  for (const file of dataTransfer.files || []) {
    if (file.type?.startsWith("image/")) return file;
  }
  return null;
}

// What navigator.clipboard.read() returned, as { text } or { image }, or null.
export async function clipboardItemsContent(items) {
  for (const item of items || []) {
    if (item.types?.includes("text/plain")) {
      const text = await (await item.getType("text/plain")).text();
      if (text) return { text };
    }
  }
  for (const item of items || []) {
    const type = item.types?.find(candidate => candidate.startsWith("image/"));
    if (type) return { image: await item.getType(type) };
  }
  return null;
}

// Ctrl+V as the program asked to receive keys: the Kitty keyboard protocol
// when it turned that on, as opencode does, otherwise the control code.
export function terminalPasteKeys(term, { appleKeyboard = false } = {}) {
  const flags = term?.kittyKeyboardFlags?.() || 0;
  if (!flags || !term.encodeKeyEvent) return ["\x16"];
  const key = { code: "KeyV", key: "v", ctrlKey: true };
  const keys = [term.encodeKeyEvent(terminalKittyKeyEvent(key, { appleKeyboard, action: "press" }), flags)];
  // A program that asked for key releases (flag 2) would otherwise think
  // Ctrl+V is still held.
  if (flags & 2) {
    keys.push(term.encodeKeyEvent(terminalKittyKeyEvent(key, { appleKeyboard, action: "release" }), flags));
  }
  return keys.filter(Boolean);
}

// Puts an image on the host clipboard and returns the server's status.
export async function writeHostClipboardImage(image, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(hostClipboardEndpoint, {
    method: "POST",
    headers: { "Content-Type": image.type || "application/octet-stream" },
    body: image,
    credentials: "same-origin",
  });
  let status = {};
  try { status = await response.json(); } catch { /* A proxy error page. */ }
  if (!response.ok) {
    const error = new Error(status.reason || status.error || `The server answered ${response.status}`);
    error.status = status;
    throw error;
  }
  return status;
}

export async function readHostClipboardStatus(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(hostClipboardEndpoint, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`The server answered ${response.status}`);
  return response.json();
}

// One line for Settings → Diagnostics.
export function describeHostClipboard(status, { failed = false, now = Date.now() } = {}) {
  if (failed) return "Unknown: the server did not answer";
  if (!status) return "Checking…";
  if (!status.available) return `Not available: ${status.reason || "no host clipboard"}`;
  const working = `Working (${status.backend || "host clipboard"}, ${status.session || "desktop"} session)`;
  const last = status.lastWrite;
  if (!last) return `${working}. No image pasted yet.`;
  const ago = describeAgo(now - Date.parse(last.at));
  return last.ok
    ? `${working}. Last image paste succeeded ${ago}.`
    : `Available, but the last image paste failed ${ago}: ${last.error || "unknown error"}`;
}

function describeAgo(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
