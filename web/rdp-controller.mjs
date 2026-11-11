import { fetchKeptRDPSessions, findKeptRDPSession, keptRDPPaneBody } from "./rdp-kept.mjs";

// Request/cache and teardown ownership; IronRDP rendering and connection UI
// remain application effects supplied through callbacks.
export class RDPController {
  constructor({ context, hideDialog, message, controls, cancelPointer, closeVideo,
    timers = globalThis, now = () => Date.now(), fetch = (...args) => globalThis.fetch(...args),
    debug = (...args) => console.debug(...args) }) {
    Object.assign(this, { context, hideDialog, message, controls, cancelPointer, closeVideo,
      timers, now, fetch, debug });
    this.cache = null;
    this.capability = null;
  }

  key() {
    const { user, workspaceID } = this.context();
    return JSON.stringify([user, workspaceID]);
  }

  get available() { return this.capability?.key === this.key() ? this.capability.available : null; }

  invalidate() { this.cache = null; }

  async request(path, body) {
    const response = await this.fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `RDP proxy failed: ${response.status}`);
    return data;
  }

  sessions({ fresh = false } = {}) {
    const key = this.key();
    if (fresh || !this.cache || this.cache.key !== key || this.now() - this.cache.at > 1500) {
      const cache = { key, at: this.now() };
      cache.listing = fetchKeptRDPSessions(this.fetch).then(listing => {
        if (this.cache === cache && this.key() === key) this.capability = { key, available: listing !== null };
        return listing;
      });
      this.cache = cache;
    }
    return this.cache.listing;
  }

  async state(rect, options) {
    const { workspaceID } = this.context();
    const listing = await this.sessions(options);
    return { available: listing !== null, idleLimitSeconds: listing?.idleLimitSeconds || 0,
      session: findKeptRDPSession(listing?.sessions, workspaceID, rect.id) };
  }

  end(rect, workspaceID = this.context().workspaceID) {
    this.invalidate();
    return this.request("/api/rdp-kept/disconnect", keptRDPPaneBody(workspaceID, rect.id))
      .catch(error => { this.debug("RDP kept session end:", error); });
  }

  disconnect(rect) {
    const view = rect?.rdp;
    if (!view) return;
    if (view.session) {
      view.intentionalDisconnect = true;
      if (view.kept) void this.end(rect);
      view.session.shutdown();
    } else if (view.connecting) {
      view.attempt += 1;
      view.connecting = false;
      this.hideDialog(rect);
      this.message(rect, "Connection cancelled.");
      this.controls(rect);
    }
  }

  detach(rect) {
    const view = rect?.rdp;
    if (!view?.session || !view.kept) return;
    view.intentionalDisconnect = true;
    view.detached = true;
    this.invalidate();
    view.session.shutdown();
  }

  dispose(rect) {
    const view = rect?.rdp;
    if (!view) return;
    view.attempt += 1;
    view.intentionalDisconnect = true;
    this.hideDialog(rect);
    this.timers.clearTimeout(view.resizeTimer);
    this.timers.clearInterval(view.wiggleTimer);
    this.timers.clearTimeout(view.hideTimer);
    view.resizeObserver?.disconnect();
    view.canvasObserver?.disconnect();
    this.cancelPointer(view);
    this.closeVideo(view);
    view.stats?.close();
    view.stats = null;
    try { view.session?.shutdown(); } catch { /* already ended */ }
    view.session = null;
    view.remoteClipboard = "";
    view.lastSentClipboard = "";
    rect.rdp = null;
  }
}
