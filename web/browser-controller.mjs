import { normalizeBrowserAddress } from "./browser-pane.mjs";

// Owns proxy capabilities and asynchronous navigation, not window management
// or iframe keyboard/pointer routing.
export class BrowserController {
  constructor({ containsPane, changed, beforeDispose = () => {}, window = globalThis.window,
    fetch = (...args) => globalThis.fetch(...args) }) {
    Object.assign(this, { containsPane, changed, beforeDispose, window, fetch });
  }

  async navigate(rect, value) {
    const browser = rect?.browser;
    if (!browser) return;
    const requestID = ++rect.browserRequestID;
    const normalized = normalizeBrowserAddress(value);
    if (!normalized) {
      browser.message.textContent = "Use a loopback HTTP address such as localhost:5000.";
      browser.message.classList.add("is-error");
      browser.message.hidden = false;
      browser.frame.hidden = true;
      return;
    }
    browser.address.value = normalized;
    browser.message.textContent = `Connecting to ${normalized}...`;
    browser.message.classList.remove("is-error");
    browser.message.hidden = false;
    browser.frame.hidden = true;
    try {
      const response = await this.fetch("/api/browser-proxy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: normalized, pane: rect.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `browser proxy failed: ${response.status}`);
      if (requestID !== rect.browserRequestID || rect.browser !== browser || !this.containsPane(rect)) {
        this.release(data.id);
        return;
      }
      const previousSessionID = browser.sessionID;
      browser.sessionID = data.id;
      rect.browserUrl = data.url || normalized;
      browser.address.value = rect.browserUrl;
      if (rect.browserStatusInput) rect.browserStatusInput.value = rect.browserUrl;
      browser.frame.src = data.path;
      browser.frame.hidden = false;
      browser.message.hidden = true;
      this.changed();
      if (previousSessionID && previousSessionID !== browser.sessionID) this.release(previousSessionID);
    } catch (error) {
      if (requestID !== rect.browserRequestID || rect.browser !== browser) return;
      browser.message.textContent = error.message || "Could not open development server.";
      browser.message.classList.add("is-error");
      browser.message.hidden = false;
      browser.frame.hidden = true;
    }
  }

  release(sessionID) {
    if (!sessionID) return;
    void this.fetch(`/api/browser-proxy/${encodeURIComponent(sessionID)}`, { method: "DELETE" }).catch(() => {});
  }

  dispose(rect) {
    const browser = rect?.browser;
    if (!browser) return;
    this.beforeDispose(rect);
    const sessionID = browser.sessionID;
    rect.browserRequestID += 1;
    browser.sessionID = "";
    browser.frame.src = "about:blank";
    rect.browser = null;
    this.release(sessionID);
  }

  async clearSiteData(rect) {
    const browser = rect?.browser;
    if (!browser?.sessionID) return;
    let origin = rect.browserUrl;
    try { origin = new URL(origin).origin; } catch { /* the address as typed */ }
    if (!this.window.confirm(`Clear the localStorage, sessionStorage and cookies Tessera keeps for ${origin}?`)) return;
    const response = await this.fetch(`/api/browser-proxy/${encodeURIComponent(browser.sessionID)}/site-data`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) {
      this.window.alert("Could not clear the site data.");
      return;
    }
    if (rect.browser === browser) browser.frame.contentWindow?.postMessage("tessera-browser-reload", "*");
  }
}
