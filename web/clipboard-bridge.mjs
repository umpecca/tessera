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

export function clipboardBridgeNeedsUpdate(installed, bundled) {
  if (!/^\d+\.\d+\.\d+$/.test(installed) || !/^\d+\.\d+\.\d+$/.test(bundled)) return false;
  const current = installed.split(".").map(Number);
  const next = bundled.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}
