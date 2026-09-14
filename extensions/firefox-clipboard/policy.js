/* Shared by the extension background and popup; no page-provided authority. */
globalThis.TesseraClipboardPolicy = {
  maxTextLength: 1024 * 1024,
  origin(url) {
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
    } catch { return null; }
  },
  pattern(origin) {
    const url = new URL(origin);
    // Firefox host permissions cover every port. The background separately
    // checks the exact scheme/hostname/port on every clipboard request.
    return `${url.protocol}//${url.hostname}/*`;
  },
  allowed(message, sender, sites) {
    const origin = this.origin(sender.url);
    if (sender.frameId !== 0 || !sender.tab || !origin || !Object.hasOwn(sites, origin)) return false;
    const pathname = new URL(sender.url).pathname;
    if (pathname !== "/" && !/^\/users\/[^/]+\/sessions\/[^/]+\/?$/.test(pathname)) return false;
    if (!message || !["hello", "read", "write"].includes(message.operation)) return false;
    if (message.operation === "write") {
      if (typeof message.text !== "string" || message.text.length > this.maxTextLength) return false;
      if (message.terminal === true && sites[origin].terminal !== true) return false;
    }
    return true;
  },
};
