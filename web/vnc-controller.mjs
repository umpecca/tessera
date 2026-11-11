import { normalizeVNCTarget, vncWebSocketURL } from "./vnc-pane.mjs";

// Connection state belongs to the pane. The app supplies workspace identity,
// clipboard access and dialogs; noVNC loading and lifecycle stay here.
export class VNCController {
  constructor({ workspaceID, containsPane, changed, hideDialog, credentials, verify,
    readClipboard, writeClipboard, clipboardEntry, setStatus,
    location = globalThis.location, fetch = (...args) => globalThis.fetch(...args),
    loadModule = () => import("./vendor/vnc.js?v=novnc-1.7.0") }) {
    Object.assign(this, { workspaceID, containsPane, changed, hideDialog, credentials, verify,
      readClipboard, writeClipboard, clipboardEntry, setStatus, location, fetch, loadModule });
    this.modulePromise = null;
  }

  message(rect, text, error = false) {
    if (!rect.vnc) return;
    rect.vnc.message.textContent = text;
    rect.vnc.message.classList.toggle("is-error", error);
    rect.vnc.message.hidden = false;
  }

  controls(rect) {
    const view = rect.vnc;
    if (!view) return;
    const connected = Boolean(view.rfb);
    view.connect.textContent = connected ? "Disconnect" : "Connect";
    view.address.disabled = connected;
    view.ctrlAltDelete.disabled = !connected || rect.vncViewOnly;
    view.sendClipboard.disabled = !connected || rect.vncViewOnly;
    view.copyClipboard.disabled = !view.remoteClipboard;
  }

  preferences(rect) {
    const rfb = rect.vnc?.rfb;
    if (!rfb) return;
    rfb.viewOnly = rect.vncViewOnly;
    // Screen Sharing may send no cursor shape; keep its cursor visible.
    rfb.showDotCursor = true;
    rfb.scaleViewport = rect.vncScaleMode === "fit";
    rfb.clipViewport = rect.vncScaleMode === "one-to-one";
    rfb.resizeSession = false;
    rect.vnc.screen.classList.toggle("is-one-to-one", rect.vncScaleMode === "one-to-one");
    this.controls(rect);
  }

  async connect(rect) {
    const view = rect?.vnc;
    if (!view || view.rfb) return;
    const target = normalizeVNCTarget(view.address.value);
    if (!target) {
      this.message(rect, "Enter a host, host:port, or bracketed IPv6 address.", true);
      return;
    }
    const workspaceID = this.workspaceID();
    const attempt = view.attempt = (view.attempt || 0) + 1;
    const current = () => rect.vnc === view && view.attempt === attempt
      && this.containsPane(rect) && this.workspaceID() === workspaceID;
    view.connect.disabled = true;
    this.message(rect, `Connecting to ${target}...`);
    this.hideDialog(rect);
    try {
      this.modulePromise ??= this.loadModule();
      const [module, response] = await Promise.all([
        this.modulePromise,
        this.fetch("/api/vnc-proxy", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: workspaceID, target }),
        }),
      ]);
      const data = await response.json();
      if (!current()) return;
      if (!response.ok) throw new Error(data.error || `VNC proxy failed: ${response.status}`);
      rect.vncTarget = data.target || target;
      view.address.value = rect.vncTarget;
      if (rect.vncStatusInput) rect.vncStatusInput.value = rect.vncTarget;
      const rfb = new module.RFB(view.screen, vncWebSocketURL(data.path, this.location), {
        shared: true, credentials: { ...view.credentials }, wsProtocols: ["binary"],
      });
      view.rfb = rfb;
      view.intentionalDisconnect = false;
      const live = () => current() && view.rfb === rfb;
      rfb.addEventListener("connect", () => {
        if (!live()) return;
        view.screen.hidden = false;
        view.message.hidden = true;
        this.hideDialog(rect);
        this.controls(rect);
        rfb.focus({ preventScroll: true });
      });
      rfb.addEventListener("disconnect", event => {
        if (!live()) return;
        view.rfb = null;
        view.screen.hidden = true;
        this.hideDialog(rect);
        this.message(rect, view.intentionalDisconnect || event.detail.clean ? "Disconnected." : "The VNC connection closed unexpectedly.", !view.intentionalDisconnect && !event.detail.clean);
        view.intentionalDisconnect = false;
        this.controls(rect);
      });
      rfb.addEventListener("credentialsrequired", event => { if (live()) this.credentials(rect, rfb, event.detail.types); });
      rfb.addEventListener("serververification", event => { if (live()) void this.verify(rect, rfb, event.detail); });
      rfb.addEventListener("securityfailure", event => { if (live()) this.message(rect, event.detail.reason || "VNC authentication failed.", true); });
      rfb.addEventListener("clipboard", event => {
        if (!live()) return;
        view.remoteClipboard = event.detail.text || "";
        this.controls(rect);
      });
      this.preferences(rect);
      this.changed();
    } catch (error) {
      if (current()) this.message(rect, error.message || "Could not connect to the VNC server.", true);
    } finally {
      if (current()) {
        view.connect.disabled = false;
        this.controls(rect);
      }
    }
  }

  async sendClipboard(rect) {
    const view = rect.vnc, rfb = view?.rfb;
    if (!rfb || rect.vncViewOnly) return;
    try {
      const text = await this.readClipboard();
      if (rect.vnc !== view || view.rfb !== rfb) return;
      rfb.clipboardPasteFrom(text);
      rfb.focus({ preventScroll: true });
    } catch {
      if (rect.vnc === view && view.rfb === rfb) this.clipboardEntry(rect);
    }
  }

  async copyClipboard(rect) {
    const text = rect.vnc?.remoteClipboard;
    if (!text) return;
    if (!await this.writeClipboard(text)) {
      this.setStatus("error", "Clipboard blocked", "The remote text is available to Tessera's own Paste.");
    }
    rect.vnc?.rfb?.focus({ preventScroll: true });
  }

  disconnect(rect) {
    const view = rect?.vnc;
    if (!view?.rfb) return;
    view.intentionalDisconnect = true;
    view.rfb.disconnect();
  }

  dispose(rect) {
    const view = rect?.vnc;
    if (!view) return;
    view.attempt = (view.attempt || 0) + 1;
    view.intentionalDisconnect = true;
    view.rfb?.disconnect();
    view.credentials = {};
    view.remoteClipboard = "";
    view.rfb = null;
    rect.vnc = null;
  }
}
