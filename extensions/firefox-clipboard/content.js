(() => {
  if (window !== window.top || globalThis.tesseraClipboardContentLoaded) return;
  globalThis.tesseraClipboardContentLoaded = true;
  let gestureAt = -Infinity;
  const recordGesture = event => {
    if (event.isTrusted) gestureAt = Date.now();
  };
  window.addEventListener("click", recordGesture, true);
  window.addEventListener("keydown", recordGesture, true);

  window.addEventListener("message", async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== "tessera-clipboard-request-v1" ||
        typeof message.id !== "string" || message.id.length > 100 ||
        !["hello", "read", "write"].includes(message.operation)) return;
    let result;
    // A gesture permits one operation. Terminal writes have separate consent
    // enforced in the background; neither path permits unsolicited reads.
    if (message.operation !== "hello" && !(message.operation === "write" && message.terminal === true)) {
      if (!document.hasFocus() || Date.now() - gestureAt > 1500) {
        result = { ok: false, error: "Click Copy or Paste to use the clipboard bridge." };
      } else { gestureAt = -Infinity; }
    }
    if (!result) {
      try {
        result = await browser.runtime.sendMessage({
          operation: message.operation, text: message.text, terminal: message.terminal === true,
        });
      } catch { result = { ok: false, error: "Clipboard extension disconnected. Refresh this page." }; }
    }
    window.postMessage({ ...result, channel: "tessera-clipboard-response-v1", id: message.id }, location.origin);
  });
})();
