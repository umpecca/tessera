// This protocol carries clipboard text only between an approved top-level
// Tessera page and its extension. It is not an authentication boundary against
// scripts already running in that trusted page.
export class ClipboardBridge {
  constructor(host = window, timeoutMs = 1500) {
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.session = Math.random().toString(36).slice(2);
    this.status = null;
    this.onMessage = event => {
      if (event.source !== host || event.origin !== host.location.origin ||
          event.data?.channel !== "tessera-clipboard-response-v1") return;
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      host.clearTimeout(pending.timer);
      if (event.data.ok === true) pending.resolve(event.data);
      else pending.reject(new Error(event.data.error || "Clipboard extension refused the request."));
    };
    host.addEventListener("message", this.onMessage);
  }

  request(operation, options = {}) {
    if (this.pending.size >= 16) return Promise.reject(new Error("Clipboard bridge is busy."));
    const id = `${this.session}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = this.host.setTimeout(() => {
        this.pending.delete(id);
        this.status = null;
        reject(new Error("Clipboard extension did not respond."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.host.postMessage({ ...options, channel: "tessera-clipboard-request-v1", id, operation }, this.host.location.origin);
    });
  }

  async check() {
    try {
      const response = await this.request("hello");
      this.status = typeof response.version === "string"
        ? { version: response.version, terminal: response.terminal === true } : null;
    } catch { this.status = null; }
    return this.status;
  }

  async readText() {
    const response = await this.request("read");
    if (typeof response.text !== "string" || response.text.length > 1024 * 1024) {
      throw new Error("Invalid clipboard bridge response.");
    }
    return response.text;
  }

  async writeText(text, terminal = false) {
    await this.request("write", { text, terminal });
  }

  dispose() {
    this.host.removeEventListener("message", this.onMessage);
    for (const pending of this.pending.values()) {
      this.host.clearTimeout(pending.timer);
      pending.reject(new Error("Clipboard bridge closed."));
    }
    this.pending.clear();
    this.status = null;
  }
}

const maxNativeTextBytes = 1024 * 1024;
const maxNativeImageBytes = 16 * 1024 * 1024;

// WebKit enforces the origin/frame/foreground boundary in native code, not by
// trusting this page's user agent or request fields. This transport never uses
// window.postMessage and never exposes the pasteboard to embedded web content.
export class NativeClipboardBridge {
  constructor(host, timeoutMs = 120000) {
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.kind = "native";
    this.status = null;
    this.pending = new Set();
    this.closed = false;
  }

  request(operation, options = {}) {
    if (this.closed) return Promise.reject(new Error("Native clipboard bridge closed."));
    if (this.pending.size >= 16) return Promise.reject(new Error("Native clipboard bridge is busy."));
    return new Promise((resolve, reject) => {
      const pending = { reject };
      const finish = (error, value) => {
        if (!this.pending.delete(pending)) return;
        this.host.clearTimeout(pending.timer);
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(value);
      };
      pending.timer = this.host.setTimeout(() => finish(new Error("Native clipboard request expired.")), this.timeoutMs);
      this.pending.add(pending);
      try {
        Promise.resolve(this.host.webkit.messageHandlers.tesseraClipboard.postMessage({ ...options, operation }))
          .then(value => finish(null, value), error => finish(error));
      } catch (error) { finish(error); }
    });
  }

  async check() {
    try {
      const response = await this.request("hello");
      this.status = !this.closed && response?.native === true && response?.version === "1.0.0"
        ? { version: response.version, terminal: false, native: true, images: response.images === true } : null;
    } catch { this.status = null; }
    return this.status;
  }

  validateText(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > maxNativeTextBytes) {
      throw new Error("Invalid native clipboard text (1 MiB maximum).");
    }
    return text;
  }

  async readText() {
    return this.validateText((await this.request("readText"))?.text);
  }

  // ClipboardItem-shaped objects work over HTTP too, where ClipboardItem itself
  // may be absent. Existing image-paste and Save Clipboard paths consume these.
  async read() {
    const response = await this.request("read");
    const text = this.validateText(response?.text);
    const blobs = new Map();
    if (text) blobs.set("text/plain", new Blob([text], { type: "text/plain" }));
    if (response.image != null) {
      const { type, data } = response.image;
      if (type !== "image/png" || typeof data !== "string" || !data.length || data.length % 4
          || data.length > 4 * Math.ceil(maxNativeImageBytes / 3) || /[^A-Za-z0-9+/=]/.test(data)) {
        throw new Error("Invalid native clipboard image.");
      }
      const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
      if (bytes.length > maxNativeImageBytes || bytes.length < 8
          || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
        throw new Error("Invalid native clipboard PNG.");
      }
      blobs.set(type, new Blob([bytes], { type }));
    }
    return blobs.size ? [{ types: [...blobs.keys()], getType: async type => {
      if (!blobs.has(type)) throw new Error("Clipboard format unavailable.");
      return blobs.get(type);
    } }] : [];
  }

  async writeText(text, terminal = false) {
    if (terminal) throw new Error("Terminal-initiated native clipboard writes are disabled.");
    const response = await this.request("writeText", { text: this.validateText(text) });
    if (response?.ok !== true) throw new Error("Native clipboard write failed.");
  }

  async writeImage(image) {
    if (!image || !["image/png", "image/jpeg"].includes(image.type) || !image.size || image.size > maxNativeImageBytes) {
      throw new Error("Invalid native clipboard image (PNG/JPEG, 16 MiB maximum).");
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const response = await this.request("writeImage", { data: btoa(binary) });
    if (response?.ok !== true) throw new Error("Native clipboard image write failed.");
  }

  dispose() {
    this.closed = true;
    for (const pending of this.pending) {
      this.host.clearTimeout(pending.timer);
      pending.reject(new Error("Native clipboard bridge closed."));
    }
    this.pending.clear();
    this.status = null;
  }
}

export function createClipboardBridge(host = window) {
  return host.top === host && typeof host.webkit?.messageHandlers?.tesseraClipboard?.postMessage === "function"
    ? new NativeClipboardBridge(host) : new ClipboardBridge(host);
}

export function clipboardBridgeNeedsUpdate(installed, bundled) {
  if (!/^\d+\.\d+\.\d+$/.test(installed) || !/^\d+\.\d+\.\d+$/.test(bundled)) return false;
  const current = installed.split(".").map(Number);
  const next = bundled.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

export function firefoxClipboardExtensionRecommendation(environment = {}) {
  const userAgent = environment.userAgent || "";
  const match = /\bFirefox\/(\d+)/i.exec(userAgent);
  if (!match) return "";

  const clipboard = environment.clipboard;
  const hasNativeClipboard = environment.isSecureContext === true &&
    typeof clipboard?.readText === "function" &&
    typeof clipboard?.writeText === "function";
  if (Number(match[1]) <= 115) {
    return "Firefox 115 ESR needs the Tessera Clipboard extension for reliable Copy and Paste.";
  }
  if (!hasNativeClipboard) {
    return "Firefox cannot use its native Clipboard API on this connection. The Tessera Clipboard extension enables Copy and Paste here.";
  }
  return "";
}
