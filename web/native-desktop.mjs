// The native host injects only a mode flag. This bridge can acknowledge closing;
// it cannot execute commands, read files, or access the system clipboard.
export function installNativeClose(win, flush) {
  if (win.__tesseraDesktop !== true) return;
  const bridge = win.webkit?.messageHandlers?.tesseraLifecycle;
  if (!bridge) return;
  let closing = false;
  win.addEventListener("tessera:native-close", async () => {
    if (closing) return;
    closing = true;
    if (!win.confirm("Quit Tessera Desktop? Running terminals and audio will stop. Workspace data and archived documents will be retained.")) {
      closing = false;
      bridge.postMessage("cancel");
      return;
    }
    try {
      await flush();
      bridge.postMessage("saved");
    } catch {
      bridge.postMessage("save-failed");
    } finally {
      closing = false;
    }
  });
  bridge.postMessage("ready");
}
