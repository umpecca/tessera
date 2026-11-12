// iPad shell integration. These are explicit app actions, not a postMessage
// endpoint for embedded sites. Privileged pasteboard access stays in Swift.
export function nativeImportEntries(items) {
  if (!Array.isArray(items) || !items.length || items.length > 8) throw new Error("Import one to eight files.");
  let total = 0;
  return items.map(item => {
    const name = String(item?.name || "").split(/[\\/]/).at(-1);
    const type = typeof item?.type === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.type) ? item.type : "application/octet-stream";
    if (!name || [".", ".."].includes(name) || /[\x00-\x1f\x7f]/.test(name) || name.length > 255
        || typeof item.data !== "string" || !item.data.length || item.data.length % 4
        || item.data.length > 4 * Math.ceil(16 * 1024 * 1024 / 3) || /[^A-Za-z0-9+/=]/.test(item.data)) throw new Error("Invalid imported file or file larger than 16 MiB.");
    const bytes = Uint8Array.from(atob(item.data), char => char.charCodeAt(0));
    total += bytes.length;
    if (!bytes.length || bytes.length > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error("Imports are limited to 16 MiB per file and 32 MiB per batch.");
    return { name, blob: new Blob([bytes], { type }), kind: type.startsWith("image/") ? "image" : "file", include: true };
  });
}

export function nativeTerminalKey(payload) {
  const key = payload?.key;
  if (typeof key !== "string") return null;
  const special = /^(Escape|Tab|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Delete|F(?:[1-9]|1[0-2]))$/.test(key);
  if (!special && !(/^[a-z]$/i.test(key) && (payload.ctrlKey === true || payload.altKey === true))) return null;
  return { key, code: special ? key : `Key${key.toUpperCase()}`, ctrlKey: payload.ctrlKey === true, altKey: payload.altKey === true };
}

export function createNativeApp(dependencies, platform = globalThis) {
  let active = true, restoreTimer = null, snapshotTimer = null, restoreCancelled = false;
  const listeners = [];
  let win;
  const key = () => `tessera.ipad-view.v1:${dependencies.navigation().currentUser}:${dependencies.navigation().workspaceID}`;
  const panes = () => dependencies.desktop().rectangles.filter(rect => rect.kind === "terminal" && rect.terminal?.term);

  function holdSize() {
    for (const rect of panes()) {
      rect.terminal.nativeUIHold = true;
      dependencies.terminal().terminalFits.cancelGridSize(rect.terminal);
      rect.terminal.mouseBridge?.cancelTouchGesture?.();
    }
  }

  function snapshot() {
    if (!dependencies.navigation().currentUser || !dependencies.navigation().workspaceID) return;
    const views = panes().slice(0, 128).map(rect => {
      const term = rect.terminal.term, manager = term.selectionManager;
      return { id: rect.id, viewport: Number(term.smoothScroll?.target ?? term.viewportY) || 0,
        history: term.getScrollbackLength?.() || 0, epoch: rect.terminal.replica?.cursor?.epoch,
        selection: term.hasSelection?.() && manager ? { start: manager.selectionStart, end: manager.selectionEnd } : null };
    });
    try { win.localStorage.setItem(key(), JSON.stringify({ at: Date.now(), views })); } catch { /* View state is best-effort, never a workspace save. */ }
  }

  function scheduleSnapshot() {
    win.clearTimeout(snapshotTimer);
    snapshotTimer = win.setTimeout(snapshot, 200);
  }

  function restore(attempt = 0) {
    if (restoreCancelled || !active || platform.document.hidden) return;
    const navigation = dependencies.navigation();
    if (!navigation.currentUser || !navigation.workspaceID || !panes().length) {
      if (attempt < 50) restoreTimer = win.setTimeout(() => restore(attempt + 1), 100);
      return;
    }
    let saved;
    try { saved = JSON.parse(win.localStorage.getItem(key()) || "null"); } catch { return; }
    if (!saved || !Array.isArray(saved.views) || saved.views.length > 128 || Date.now() - saved.at > 86400000) return;
    let pending = false;
    for (const view of saved.views) {
      const rect = panes().find(rect => rect.id === view.id);
      if (!rect) continue;
      const term = rect.terminal.term, cursor = rect.terminal.replica?.cursor;
      if (!cursor?.epoch) { pending = true; continue; }
      if (view.restored) continue;
      view.restored = true;
      if (typeof view.viewport === "number" && Number.isFinite(view.viewport) && view.viewport >= 0) {
        term.smoothScrollTo?.(Math.min(view.viewport, term.getScrollbackLength?.() || 0));
      }
      // Don't highlight different text after host scrollback was replaced/trimmed.
      if (view.epoch === cursor.epoch && view.history === term.getScrollbackLength?.() && view.selection) {
        const { start, end } = view.selection;
        const valid = point => Number.isInteger(point?.absoluteRow) && point.absoluteRow >= 0 && point.absoluteRow < view.history + term.rows
          && Number.isInteger(point.col) && point.col >= 0 && point.col < term.cols;
        if (valid(start) && valid(end) && term.selectionManager) {
          Object.assign(term.selectionManager, { selectionStart: start, selectionEnd: end, isSelecting: false });
          term.selectionManager.markCurrentSelectionDirty?.();
          term.requestRender?.();
        }
      }
    }
    try {
      if (pending && attempt < 50) win.localStorage.setItem(key(), JSON.stringify(saved));
      else win.localStorage.removeItem(key());
    } catch { /* Storage can be unavailable. */ }
    if (pending && attempt < 50) restoreTimer = win.setTimeout(() => restore(attempt + 1), 100);
  }

  function refreshPreference(highRefresh) {
    const preferences = dependencies.preferences();
    preferences.nativeFrameLimit = highRefresh === true ? 0 : 60;
    for (const rect of panes()) rect.terminal.term.setPaintFPSLimit?.(preferences.olderMacMode ? 30 : preferences.nativeFrameLimit);
  }

  async function perform(command, payload = {}) {
    if (command === "suspend") {
      dependencies.events().cancelForegroundFocus();
      snapshot(); holdSize(); active = false; win.tesseraNativeSuspended = true;
      platform.document.activeElement?.blur?.();
      return { ok: true };
    }
    if (command === "resume") {
      active = true; win.tesseraNativeSuspended = false;
      dependencies.connectivity().handleBrowserOnline();
      restore();
      if (payload.restoreFocus === true) dependencies.events().restoreForegroundFocus({ native: true });
      return { ok: true };
    }
    if (command === "holdSize") { dependencies.events().cancelForegroundFocus(); holdSize(); return { ok: true }; }
    if (command === "refreshPreference") { refreshPreference(payload.highRefresh); return { ok: true }; }
    if (!active || platform.document.hidden) return { ok: false };
    const commands = { palette: () => dependencies.palette().openCommandPalette(), windows: () => dependencies.windows().openWindowList(),
      sessions: () => dependencies.sessionList().openSessionList(), settings: () => dependencies.settings().openSettingsModal() };
    if (Object.hasOwn(commands, command)) { await commands[command](); return { ok: true }; }
    if (command === "key") {
      // Never send keys through a web dialog, editor or unrelated pane.
      if ([...platform.document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(node => node.getClientRects().length)) return { ok: false };
      const rect = dependencies.desktop().getActivePane(), init = nativeTerminalKey(payload);
      if (!rect || rect.kind !== "terminal" || !init) return { ok: false };
      dependencies.phone().sendPhoneKey(rect.id, init);
      return { ok: true };
    }
    if (command === "files") {
      const entries = nativeImportEntries(payload.items), dialog = dependencies.clipboard().saveClipboardDialog;
      if (!dialog.element.hidden) {
        if (dialog.saving) throw new Error("Wait for the current file save to finish before importing more files.");
        if (dialog.entries.reduce((sum, entry) => sum + entry.blob.size, 0) + entries.reduce((sum, entry) => sum + entry.blob.size, 0) > 32 * 1024 * 1024) throw new Error("The import review is limited to 32 MiB.");
        dialog.add(entries);
      } else {
        dependencies.menus().hideAllMenus();
        const pane = dependencies.desktop().getActivePane();
        dialog.open({ current: pane?.kind === "terminal" ? pane.cwd || "" : "", entries, title: "Import Files to Host" });
      }
      return { ok: true };
    }
    return { ok: false };
  }

  function measureRefreshRate(duration = 3000) {
    if (platform.document.hidden || !active) return Promise.reject(new Error("Keep the workspace visible while measuring."));
    duration = Math.max(250, Math.min(5000, Number(duration) || 3000));
    return new Promise((resolve, reject) => {
      let first = null, frames = 0, frame;
      const timeout = win.setTimeout(() => { win.cancelAnimationFrame(frame); reject(new Error("Frame measurement interrupted.")); }, duration + 1500);
      const sample = time => {
        if (platform.document.hidden || !active) { win.clearTimeout(timeout); reject(new Error("Frame measurement interrupted.")); return; }
        if (first === null) first = time;
        else frames++;
        if (time - first >= duration) { win.clearTimeout(timeout); resolve({ fps: frames * 1000 / (time - first), frames, milliseconds: time - first }); }
        else frame = win.requestAnimationFrame(sample);
      };
      frame = win.requestAnimationFrame(sample);
    });
  }

  function initialize() {
    win = platform.window;
    if (win.tesseraNativeDevice !== "ipad" || win.top !== win) return;
    win.tesseraNativeApp = Object.freeze({ perform, measureRefreshRate });
    const listen = (target, type, action, options) => { target.addEventListener(type, action, options); listeners.push(() => target.removeEventListener(type, action, options)); };
    listen(win, "pagehide", snapshot);
    listen(win, "wheel", scheduleSnapshot, { passive: true });
    listen(win, "pointerup", scheduleSnapshot, { passive: true });
    listen(platform.document, "keydown", () => { restoreCancelled = true; win.clearTimeout(restoreTimer); }, { capture: true });
    restore();
  }

  function dispose() {
    if (!win) return;
    for (const remove of listeners.splice(0)) remove();
    win.clearTimeout(restoreTimer); win.clearTimeout(snapshotTimer);
    delete win.tesseraNativeApp;
  }
  return { initialize, perform, snapshot, restore, holdSize, refreshPreference, measureRefreshRate, dispose };
}
