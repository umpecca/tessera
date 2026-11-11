import { PhoneView, normalizePhoneViewOverride, phoneFontShrink, phoneFontSize, readingLines, phoneViewPathOverride, phoneViewStorageKey, isPhoneDevice, shouldUsePhoneView } from "./phone-view.mjs";
import { terminalMouseMessage, terminalPasteText } from "./terminal-input.mjs";
import { workspaceRevisionMatches } from "./workspace-concurrency.mjs";
import { focusPane } from "./pane-activation.mjs";
import { terminalPasteKeys, writeHostClipboardImage } from "./clipboard-image.mjs";
import { newWorkspaceRevision } from "./workspace-concurrency.mjs";

// Phone workspace integration, fonts, reading view, input and attachments.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   sessionsDialog: () => ReturnType<typeof import("./sessions-dialog.mjs").createSessionsDialog>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createPhone(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    phoneViewOverride: undefined,
    coarsePointer: undefined,
    phoneDevice: undefined,
    otherDisplaySettings: undefined,
    phoneViewRoot: undefined,
    phoneView: undefined,
    phoneKeyEvents: undefined,
    phoneWorkspaceRefresh: undefined,
    phoneFontStoragePrefix: undefined,
    minimumPhoneFontSize: undefined,
    maximumPhoneFontSize: undefined,
    phoneReadingRows: undefined,
    phoneClipboardPaste: undefined,
  };

  function savePhoneViewOverride() {
    try {
      platform.window.localStorage.setItem(phoneViewStorageKey, feature.phoneViewOverride);
    } catch {
      // Browser storage is unavailable; the choice lasts until reload.
    }
  }

  function setPhoneViewOverride(value) {
    feature.phoneViewOverride = normalizePhoneViewOverride(value);
    feature.savePhoneViewOverride();
    feature.updatePhoneView();
  }

  // The phone view follows the screen unless this browser chose a view.
  function updatePhoneView() {
    if (!dependencies.navigation().currentUser) return;
    const wanted = shouldUsePhoneView({ width: platform.window.innerWidth, coarsePointer: feature.coarsePointer.matches, override: feature.phoneViewOverride, phone: feature.phoneDevice, tablet: platform.window.tesseraNativeDevice === "ipad" });
    if (wanted === feature.phoneView.active) return;
    dependencies.menus().hideAllMenus();
    if (wanted) {
      feature.phoneView.enter();
      void feature.refreshPhoneWorkspace();
    } else {
      feature.phoneView.leave();
      // Terminals were measured for the phone layout, or not at all.
      for (const rect of dependencies.desktop().rectangles) {
        if (rect.kind === "terminal" && !rect.minimized) dependencies.terminal().requestTerminalFit(rect);
      }
    }
    dependencies.terminal().scheduleTerminalVisibilityUpdate();
    dependencies.terminal().updateTerminalFocus();
    dependencies.deskbar().updateDeskbar();
  }

  function refreshPhoneWorkspace() {
    feature.phoneWorkspaceRefresh ??= (async () => {
      try {
        if (!feature.phoneView.active || dependencies.workspace().isLoadingWorkspace) return !dependencies.workspace().workspacePersistence.suspended;
        if (dependencies.workspace().workspacePersistence.pending) await dependencies.workspace().saveWorkspace();
        if (dependencies.workspace().workspacePersistence.suspended) return false;
        const id = dependencies.navigation().workspaceID;
        const workspace = await dependencies.workspace().fetchWorkspace(id);
        if (id !== dependencies.navigation().workspaceID || workspaceRevisionMatches(dependencies.workspace().workspacePersistence.revision, workspace.revision)) return true;
        if (dependencies.workspace().workspacePersistence.pending || dependencies.workspace().isLoadingWorkspace) return true;
        const open = feature.phoneView.openPaneID;
        dependencies.workspace().loadWorkspace(workspace);
        if (open && dependencies.desktop().rectangles.some((rect) => rect.id === open)) feature.phoneView.open(open);
        return true;
      } catch (error) {
        platform.console.warn(error);
        return !dependencies.workspace().workspacePersistence.suspended;
      } finally {
        feature.phoneWorkspaceRefresh = null;
      }
    })();
    return feature.phoneWorkspaceRefresh;
  }

  function showPhoneTerminal(paneID) {
    feature.phoneClipboardPaste = null;
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    if (!rect) return;
    dependencies.menus().hideAllMenus();
    for (const other of dependencies.desktop().rectangles) other.element.classList.toggle("is-phone-open", other === rect);
    // Looking at a terminal is not an edit: saving it would put this phone's
    // copy of the workspace in the way of the desk's next save.
    dependencies.desktop().setActivePane(rect, { raise: false, save: false });
    feature.syncPhoneTerminalInput(paneID);
    platform.window.requestAnimationFrame(() => {
      if (feature.phoneView.openPaneID !== rect.id) return;
      if (rect.kind === "terminal") {
        feature.setPhoneTerminalFit(rect.id, true);
        dependencies.terminal().requestTerminalFit(rect);
        feature.applyPhoneTerminalFont(rect);
      }
      dependencies.terminal().scheduleTerminalVisibilityUpdate();
      dependencies.terminal().updateTerminalFocus();
    });
  }

  // A terminal opened on a phone takes the phone's size (Fit to this phone)
  // for as long as it shows the terminal, and the host gives it back after.
  // Turned off, the phone shows the shell at whatever size it has, so looking
  // in never reflows what the desk shows.
  function phoneViewWanted() {
    return Boolean(dependencies.navigation().currentUser) && shouldUsePhoneView({ width: platform.window.innerWidth, coarsePointer: feature.coarsePointer.matches, override: feature.phoneViewOverride, phone: feature.phoneDevice, tablet: platform.window.tesseraNativeDevice === "ipad" });
  }

  function terminalWatchesSize(state) {
    return Boolean(platform.window?.tesseraNativeSuspended || state?.nativeUIHold || state?.phoneComposeHold) || (feature.phoneViewWanted() && (!state?.phoneFit || feature.phoneView?.mode === "scroll" || Boolean(state.phoneModeHold)));
  }

  // Composing is local text editing, not a request to resize/reflow the PTY.
  // Keep the existing bitmap and pan its last rows above the keyboard instead.
  function holdPhoneComposeViewport(paneID, held) {
    const rect = dependencies.desktop().rectangles.find(candidate => candidate.id === paneID);
    const state = rect?.kind === "terminal" ? rect.terminal : null;
    if (!state || Boolean(state.phoneComposeHold) === held) return;
    state.phoneComposeHold = held;
    dependencies.terminal().terminalFits.cancelGridSize(state);
    if (held) {
      state.phoneComposeScrollTop = rect.terminalContainer?.scrollTop || 0;
    } else {
      if (rect.terminalContainer) rect.terminalContainer.scrollTop = state.phoneComposeScrollTop || 0;
      // Re-measure after the animation has settled, not from the keyboard's
      // intermediate height. An unchanged grid does not send another resize.
      dependencies.terminal().requestTerminalFit(rect);
    }
  }

  function followPhoneComposeViewport(paneID) {
    const rect = dependencies.desktop().rectangles.find(candidate => candidate.id === paneID);
    const container = rect?.terminalContainer;
    if (!rect?.terminal?.phoneComposeHold || !container) return;
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  }

  function changePhoneInteractionMode(paneID) {
    feature.phoneClipboardPaste = null;
    const state = dependencies.desktop().rectangles.find(rect => rect.id === paneID)?.terminal;
    if (!state) return;
    state.phoneModeHold = true;
    dependencies.terminal().terminalFits.cancelGridSize(state);
    state.mouseBridge?.cancelTouchGesture?.();
  }

  // The open terminal's font, sized so the shell's columns fill the phone's
  // width, then larger by the zoom asked for (the screen then scrolls
  // sideways). Only this browser's view changes; the pane's saved size stays.
  function applyPhoneTerminalFont(rect) {
    const state = rect?.kind === "terminal" ? rect.terminal : null;
    const term = state?.term;
    if (!term || feature.phoneView.openPaneID !== rect.id) return;
    if (state.phoneFit) {
      const size = feature.phoneTerminalFontSize(rect);
      if (term.options.fontSize !== size) {
        term.options.fontSize = size;
        dependencies.terminal().requestTerminalFit(rect);
      }
      return;
    }
    const container = rect.terminalContainer;
    const style = platform.window.getComputedStyle(container);
    const width = container.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
    // The font that fits the width is found once for these columns and this
    // width; Larger and Smaller multiply it.
    const fitKey = `${term.cols}:${width}`;
    const zoom = state.phoneZoom || 1;
    const key = `${fitKey}:${zoom}`;
    if (state.phoneFontKey === key) return;
    if (state.phoneFitKey !== fitKey) {
      const metrics = term.renderer?.getMetrics?.();
      if (!metrics?.width || width <= 0) return;
      state.phoneFitFont = phoneFontSize({ columns: term.cols, width, fontSize: term.options.fontSize, cellWidth: metrics.width, largest: rect.fontSize * 3 });
      state.phoneFitKey = fitKey;
    }
    state.phoneFontKey = key;
    const size = Math.max(4, Math.min(rect.fontSize * 3, Math.floor(state.phoneFitFont * zoom * 4) / 4));
    if (size !== term.options.fontSize) {
      term.options.fontSize = size;
      dependencies.terminal().requestTerminalFit(rect);
    }
    if (zoom === 1) feature.shrinkPhoneTerminalFont(rect, key, width);
  }

  // Cells round to whole pixels, so the size just set can come out a little
  // too wide. Step down until the columns fit, never back up: measuring and
  // computing afresh each time swung between two sizes for ever.
  function shrinkPhoneTerminalFont(rect, key, width, steps = 0) {
    platform.window.requestAnimationFrame(() => {
      const state = rect.terminal, term = state?.term;
      if (!term || state.phoneFontKey !== key || feature.phoneView.openPaneID !== rect.id || steps > 40) return;
      const metrics = term.renderer?.getMetrics?.();
      const next = phoneFontShrink({ columns: term.cols, width, fontSize: term.options.fontSize, cellWidth: metrics?.width || 0 });
      if (next === null) return;
      term.options.fontSize = next;
      state.phoneFitFont = next;
      dependencies.terminal().requestTerminalFit(rect);
      feature.shrinkPhoneTerminalFont(rect, key, width, steps + 1);
    });
  }

  function phoneTerminalFontSize(rect) {
    let stored = null;
    try { stored = platform.window.localStorage.getItem(`${feature.phoneFontStoragePrefix}${dependencies.navigation().workspaceID}:${rect.id}`); } catch { /* the default */ }
    const size = Number(stored);
    return stored && Number.isFinite(size) ? Math.max(feature.minimumPhoneFontSize, Math.min(feature.maximumPhoneFontSize, Math.round(size))) : dependencies.preferences().defaultPaneFontSize;
  }

  function stepPhoneTerminalFontSize(paneID, step) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    if (rect?.kind !== "terminal") return;
    const size = Math.max(feature.minimumPhoneFontSize, Math.min(feature.maximumPhoneFontSize, feature.phoneTerminalFontSize(rect) + step));
    try { platform.window.localStorage.setItem(`${feature.phoneFontStoragePrefix}${dependencies.navigation().workspaceID}:${rect.id}`, String(size)); } catch { /* lasts for this view */ }
    feature.applyPhoneTerminalFont(rect);
  }

  function phoneTerminalView(paneID) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
    if (!term) return null;
    return {
      cols: term.cols, rows: term.rows,
      background: term.options?.theme?.background || rect.terminalContainer?.style?.background || "",
      fitted: Boolean(rect.terminal.phoneFit),
      fontSize: feature.phoneTerminalFontSize(rect),
      zoom: rect.terminal.phoneZoom || 1,
      alternate: term.buffer?.active?.type === "alternate",
      mouseTracking: Boolean(term.hasMouseTracking?.()),
    };
  }

  function setPhoneTerminalZoom(paneID, factor) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    if (!rect?.terminal?.term || rect.terminal.phoneFit) return;
    rect.terminal.phoneZoom = Math.min(4, Math.max(1, (rect.terminal.phoneZoom || 1) * factor));
    feature.applyPhoneTerminalFont(rect);
  }

  function scrollPhoneTerminalPage(paneID, direction) {
    if (feature.phoneView?.mode !== "scroll" || feature.phoneView.openPaneID !== paneID || ![-1, 1].includes(direction)) return;
    const rect = dependencies.desktop().rectangles.find(candidate => candidate.id === paneID);
    const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
    if (!term || term.buffer?.active?.type === "alternate" || term.wasmTerm?.isAlternateScreen?.()) return;
    const lineHeight = term.renderer?.getMetrics?.().height || 20;
    const visibleRows = Math.max(1, Math.min(term.rows, Math.floor((rect.terminalContainer?.clientHeight || term.rows * lineHeight) / lineHeight)));
    term.scrollLines(direction * Math.max(1, visibleRows - 2));
    term.requestRender?.();
  }

  function setPhoneTerminalFit(paneID, on) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    const state = rect?.kind === "terminal" ? rect.terminal : null;
    if (!state?.term || Boolean(state.phoneFit) === on) return;
    state.phoneModeHold = false;
    state.phoneFit = on;
    state.phoneFontKey = "";
    if (on) {
      feature.applyPhoneTerminalFont(rect);
      state.sentCols = 0;
      state.sentRows = 0;
      dependencies.terminal().requestTerminalFit(rect);
      platform.window.requestAnimationFrame(() => {
        if (state.phoneFit) dependencies.terminal().terminalFits.sendGridSize(state);
      });
      return;
    }
    feature.releasePhoneTerminalSize(state);
    feature.applyPhoneTerminalFont(rect);
  }

  function releasePhoneTerminalSize(state, { later = false } = {}) {
    state.sentCols = 0;
    state.sentRows = 0;
    if (state.socket?.readyState === platform.WebSocket.OPEN) state.socket.send(JSON.stringify({ type: "release-size", ...(later ? { later: true } : {}) }));
  }

  function phoneReadingText(paneID) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
    const buffer = term?.buffer?.active;
    if (!buffer || buffer.type === "alternate") return null;
    const marks = term.semanticMarks?.() || new Uint8Array(0);
    const rows = [];
    for (let index = Math.max(0, buffer.length - feature.phoneReadingRows); index < buffer.length; index++) {
      rows.push({ text: buffer.getLine(index)?.translateToString(false) ?? "", continues: Boolean((marks[index] ?? 0) & 8) });
    }
    return readingLines(rows);
  }

  // Only an explicit Type action may make the canvas a keyboard target.
  // Interact still forwards application mouse presses without focusing input.
  function syncPhoneTerminalInput(paneID, { selecting = feature.phoneView?.selecting, direct = feature.phoneView?.input?.direct } = {}) {
    const view = feature.phoneView;
    const rect = dependencies.desktop().rectangles.find(candidate => candidate.id === paneID);
    const suppressed = Boolean(view?.active && view.openPaneID === paneID && (selecting || view.mode === "scroll" || !direct));
    rect?.terminal?.term?.selectionIntegration?.setInputSuppressed?.(suppressed);
  }

  function changePhoneSelection(paneID, on) {
    feature.changePhoneInteractionMode(paneID);
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    rect?.terminal?.term?.clearSelection?.();
    feature.syncPhoneTerminalInput(paneID, { selecting: on });
  }

  async function copyPhoneSelection(paneID) {
    if (!feature.phoneView?.active || feature.phoneView.openPaneID !== paneID) return false;
    const term = dependencies.desktop().rectangles.find(rect => rect.id === paneID)?.terminal?.term;
    // Read before the button click bubbles to upstream's document click handler.
    const text = term?.getSelection?.() || "";
    if (!text) {
      feature.phoneView.input?.showNotice("Drag across terminal text first.");
      return false;
    }
    try {
      const copied = await dependencies.clipboard().writeClipboardText(text);
      if (feature.phoneView.active && feature.phoneView.openPaneID === paneID) {
        feature.phoneView.input?.showNotice(copied ? "Copied." : "Saved in Tessera; system clipboard unavailable.");
      }
      return copied;
    } catch (error) {
      if (feature.phoneView.active && feature.phoneView.openPaneID === paneID) feature.phoneView.input?.showNotice(`Copy failed: ${error.message}`);
      return false;
    }
  }

  async function pastePhoneClipboard(paneID) {
    const view = feature.phoneView;
    if (!view?.active || view.openPaneID !== paneID || view.mode === "scroll") return false;
    const rect = dependencies.desktop().rectangles.find(candidate => candidate.id === paneID);
    const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
    if (!term) return false;
    const request = {};
    feature.phoneClipboardPaste = request;
    const current = () => feature.phoneClipboardPaste === request && view.active && view.openPaneID === paneID
      && view.mode !== "scroll" && dependencies.desktop().rectangles.find(candidate => candidate.id === paneID)?.terminal?.term === term;
    try {
      // Read during the button gesture, but never focus a hidden paste field:
      // that fallback summons iOS's keyboard. Native/browser reads still work.
      const clipboard = dependencies.clipboard();
      const text = terminalPasteText(await clipboard.readClipboardText({ allowFocus: false }));
      if (!current()) return false;
      if (!text) {
        view.input?.showNotice(clipboard.clipboardReadFellBack ? "Clipboard unavailable. Copy text in Tessera first, or paste using the compose field." : "No text on the clipboard.");
        return false;
      }
      view.setSelecting(false);
      term.scrollToBottom?.();
      term.paste(text); // Bracketed paste when requested; never append Enter.
      view.input?.showNotice(clipboard.clipboardReadFellBack ? "Pasted Tessera's last copy; system clipboard unavailable." : "Pasted.");
      return true;
    } catch (error) {
      if (current()) view.input?.showNotice(`Paste unavailable: ${error.message}`);
      return false;
    } finally {
      if (feature.phoneClipboardPaste === request) feature.phoneClipboardPaste = null;
    }
  }

  // Explicit TUI navigation while selecting on the normal canvas.
  // Only send wheel reports to an alternate-screen, mouse-aware application;
  // never fall back to arrow keys or text if it exits or disables the mouse.
  function scrollPhoneSelection(paneID, direction) {
    if (!feature.phoneView?.active || feature.phoneView.openPaneID !== paneID
        || !feature.phoneView.selecting || ![-1, 1].includes(direction)) return false;
    const rect = dependencies.desktop().rectangles.find(candidate => candidate.id === paneID);
    const state = rect?.kind === "terminal" ? rect.terminal : null;
    const term = state?.term;
    if (!term || term.buffer?.active?.type !== "alternate" || !term.hasMouseTracking?.()
        || state.socket?.readyState !== platform.WebSocket.OPEN) return false;
    const col = Math.max(1, Math.floor(term.cols / 2)), row = Math.max(1, Math.floor(term.rows / 2));
    const code = direction < 0 ? 64 : 65;
    term.clearSelection?.();
    for (let step = 0; step < 5; step++) state.socket.send(terminalMouseMessage(`\x1b[<${code};${col};${row}M`));
    return true;
  }

  // Text from the phone's compose field goes in as a paste, bracketed when the
  // program asked for that, so a multi-line prompt arrives as one message and
  // a shell doesn't run it line by line. Enter follows separately, as a key
  // would, after the program has taken the paste.
  function sendPhoneText(paneID, text, { enter }) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
    if (!term) return;
    term.scrollToBottom();
    const pasted = terminalPasteText(text);
    if (pasted) term.paste(pasted);
    if (enter) platform.window.setTimeout(() => feature.sendPhoneKey(paneID, { key: "Enter", code: "Enter" }), pasted ? 40 : 0);
  }

  // A key from the phone's key row reaches the terminal as a key event, so it
  // is encoded as the same key from a keyboard would be.
  function sendPhoneKey(paneID, init) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    const container = rect?.kind === "terminal" ? rect.terminalContainer : null;
    if (!container || !rect.terminal?.term) return;
    rect.terminal.term.scrollToBottom();
    for (const type of ["keydown", "keyup"]) {
      const event = new platform.KeyboardEvent(type, { ...init, bubbles: true, cancelable: true });
      feature.phoneKeyEvents.add(event);
      container.dispatchEvent(event);
    }
  }

  // An image from the phone, kept on the host so its path can go to a program.
  async function uploadPhoneAttachment(file) {
    const response = await platform.fetch(`/api/host/attachments?${new URLSearchParams({ name: file.name || "image" })}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
      credentials: "same-origin",
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 413) throw new Error("it is larger than the host accepts");
    if (!response.ok || !data.path) throw new Error(data.error || `the host answered ${response.status}`);
    return data;
  }

  // An image from the phone put on the host's clipboard, then the program's
  // paste key, as pasting an image into a terminal on the desk does.
  async function pastePhoneImage(paneID, file) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
    if (!term) throw new Error("the terminal is gone");
    try {
      dependencies.clipboard().hostClipboardStatus = await writeHostClipboardImage(file);
      dependencies.clipboard().hostClipboardStatusFailed = false;
    } catch (error) {
      if (error.status?.session) dependencies.clipboard().hostClipboardStatus = error.status;
      throw error;
    }
    for (const keys of terminalPasteKeys(term, { appleKeyboard: dependencies.interactions().appleKeyboardLayout })) dependencies.terminal().sendTerminalKeys(rect, keys);
  }

  async function loadSnippets() {
    const response = await platform.fetch(dependencies.navigation().userAPIPath("snippets"), { cache: "no-store" });
    if (!response.ok) throw new Error(`Snippets could not be loaded (${response.status}).`);
    return response.json();
  }

  async function saveSnippets(doc) {
    const response = await platform.fetch(dependencies.navigation().userAPIPath("snippets"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `Snippets could not be saved (${response.status}).`), { status: response.status });
    return data;
  }

  function hidePhoneTerminal(paneID) {
    feature.phoneClipboardPaste = null;
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    if (!rect) return;
    rect.element.classList.remove("is-phone-open");
    if (rect.kind === "terminal" && rect.terminal?.term) {
      rect.terminal.mouseBridge?.cancelTouchGesture?.();
      rect.terminal.term.selectionIntegration?.setInputSuppressed?.(false);
      feature.setPhoneTerminalFit(paneID, false);
      rect.terminal.phoneZoom = 1;
      rect.terminal.phoneFontKey = "";
      rect.terminal.phoneFitKey = "";
      rect.terminal.phoneModeHold = false;
      rect.terminal.phoneComposeHold = false;
      rect.terminal.term.options.fontSize = rect.fontSize;
    }
    if (rect.element.contains(platform.document.activeElement)) platform.document.activeElement.blur();
    dependencies.terminal().scheduleTerminalVisibilityUpdate();
    dependencies.terminal().updateTerminalFocus();
  }

  function initializePhoneViewOverride() {
    // On a phone the workspace shows as a list of its terminals, and one at a
    // time full screen. This browser can choose either view; /m chooses this one.
    feature.phoneViewOverride = "";
    try {
      feature.phoneViewOverride = normalizePhoneViewOverride(platform.window.localStorage.getItem(phoneViewStorageKey));
    } catch {
      // Browser storage is unavailable; the screen decides.
    }
    if (phoneViewPathOverride(platform.window.location.pathname)) {
      feature.phoneViewOverride = "phone";
      feature.savePhoneViewOverride();
      platform.window.history.replaceState(platform.window.history.state, "", "/");
    }
    feature.coarsePointer = platform.window.matchMedia("(pointer: coarse)");
    // A phone shows its own theme, Deskbar button and other display settings,
    // and keeps the desktop's to send back when it saves.
    feature.phoneDevice = isPhoneDevice({
      coarsePointer: feature.coarsePointer.matches, screenWidth: platform.window.screen.width, screenHeight: platform.window.screen.height,
    });
    feature.otherDisplaySettings = null;
    feature.phoneViewRoot = platform.document.createElement("div");
    platform.document.body.appendChild(feature.phoneViewRoot);
    feature.phoneView = new PhoneView(feature.phoneViewRoot, {
      panes: () => dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending")
        .map((rect) => ({ id: rect.id, kind: rect.kind, title: rect.title, cwd: rect.cwd })),
      workspaceID: () => dependencies.navigation().workspaceID,
      sessionName: () => dependencies.navigation().currentSessionName,
      onOpen: (paneID) => feature.showPhoneTerminal(paneID),
      onBack: (paneID) => feature.hidePhoneTerminal(paneID),
      onModeChange: (paneID) => feature.changePhoneInteractionMode(paneID),
      onComposeViewport: (paneID, held) => feature.holdPhoneComposeViewport(paneID, held),
      followComposeViewport: (paneID) => feature.followPhoneComposeViewport(paneID),
      scrollPage: (paneID, direction) => feature.scrollPhoneTerminalPage(paneID, direction),
      onInterrupt: (paneID) => {
        const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
        if (rect?.kind === "terminal") dependencies.terminal().sendTerminalInput(rect.terminal?.socket, "\x03");
      },
      onRename: async (paneID) => {
        if (!await feature.refreshPhoneWorkspace()) return;
        dependencies.desktop().openRenameWindowModal(dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID));
      },
      onClose: async (paneID) => {
        if (!await feature.refreshPhoneWorkspace()) return;
        const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
        if (rect) dependencies.geometry().closeWindowFromTitleBar(rect);
      },
      onNewTerminal: async () => {
        if (!await feature.refreshPhoneWorkspace()) return;
        feature.phoneView.open(dependencies.desktop().createTerminalPane().id);
      },
      onShellsChanged: () => void feature.refreshPhoneWorkspace(),
      onSessions: () => void dependencies.sessionsDialog().openSessionsModal(),
      onDesktop: () => feature.setPhoneViewOverride("desktop"),
      terminalView: (paneID) => feature.phoneTerminalView(paneID),
      setZoom: (paneID, factor) => feature.setPhoneTerminalZoom(paneID, factor),
      stepFontSize: (paneID, step) => feature.stepPhoneTerminalFontSize(paneID, step),
      setFit: (paneID, on) => feature.setPhoneTerminalFit(paneID, on),
      refreshTerminal: (paneID) => feature.applyPhoneTerminalFont(dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID)),
      readingText: (paneID) => feature.phoneReadingText(paneID),
      onSelectionChange: (paneID, on) => feature.changePhoneSelection(paneID, on),
      copySelection: (paneID) => feature.copyPhoneSelection(paneID),
      pasteClipboard: (paneID) => feature.pastePhoneClipboard(paneID),
      scrollSelection: (paneID, direction) => feature.scrollPhoneSelection(paneID, direction),
      storage: {
        get(key) { try { return platform.window.localStorage.getItem(key); } catch { return null; } },
        set(key, value) { try { platform.window.localStorage.setItem(key, value); } catch { /* the choice lasts until reload */ } },
      },
      input: {
        sendText: (paneID, text, options) => feature.sendPhoneText(paneID, text, options),
        sendKey: (paneID, init) => feature.sendPhoneKey(paneID, init),
        typeDirectly: (paneID) => focusPane(dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID)),
        onDirectChange: (paneID, direct) => feature.syncPhoneTerminalInput(paneID, { direct }),
        loadSnippets: () => feature.loadSnippets(),
        saveSnippets: (doc) => feature.saveSnippets(doc),
        newID: () => newWorkspaceRevision(),
        attachFile: (file) => feature.uploadPhoneAttachment(file),
        pasteImage: (paneID, file) => feature.pastePhoneImage(paneID, file),
        storage: {
          get(key) { try { return platform.window.localStorage.getItem(key); } catch { return null; } },
          set(key, value) { try { platform.window.localStorage.setItem(key, value); } catch { /* the draft lasts until reload */ } },
          remove(key) { try { platform.window.localStorage.removeItem(key); } catch { /* nothing kept */ } },
        },
      },
    });
    // Keys the phone view sends a terminal, which are the terminal's even when
    // they look like a window shortcut (Ctrl then L clears the screen).
    feature.phoneKeyEvents = new WeakSet();
  }

  function initializePhoneWorkspaceRefresh() {
    // The open terminal fills the screen below the phone view's header. Its
    // window keeps its saved place and size for the desktop view.
    // The phone view lists this page's copy of the workspace, and the desk can
    // change the workspace while the phone looks at it: a window opened there
    // would be missing from the list, and the phone's next save would be refused
    // as stale. So the phone takes the newest copy when it may have fallen
    // behind, and always before it changes anything. Changes of its own still
    // waiting to be saved go first, and meet a conflict as they would anyway.
    feature.phoneWorkspaceRefresh = null;
    // Each terminal has a font size of its own on this phone, for the fitted
    // screen and the text view, apart from the desk's. It starts at the phone's
    // default and lives in this browser.
    feature.phoneFontStoragePrefix = "tessera.phone-font.v1:";
    feature.minimumPhoneFontSize = 6;
    feature.maximumPhoneFontSize = 32;
    // The last rows the terminal holds, as text for the phone's text view, or
    // null while a full-screen program has the screen.
    feature.phoneReadingRows = 2000;
  }

  function registerEvents() {
    platform.window.addEventListener("resize", feature.updatePhoneView);
    feature.coarsePointer.addEventListener?.("change", feature.updatePhoneView);
  }

  Object.assign(feature, {
    savePhoneViewOverride,
    setPhoneViewOverride,
    updatePhoneView,
    refreshPhoneWorkspace,
    showPhoneTerminal,
    phoneViewWanted,
    terminalWatchesSize,
    holdPhoneComposeViewport,
    followPhoneComposeViewport,
    changePhoneInteractionMode,
    applyPhoneTerminalFont,
    shrinkPhoneTerminalFont,
    phoneTerminalFontSize,
    stepPhoneTerminalFontSize,
    phoneTerminalView,
    scrollPhoneTerminalPage,
    setPhoneTerminalZoom,
    setPhoneTerminalFit,
    releasePhoneTerminalSize,
    phoneReadingText,
    changePhoneSelection,
    syncPhoneTerminalInput,
    copyPhoneSelection,
    pastePhoneClipboard,
    scrollPhoneSelection,
    sendPhoneText,
    sendPhoneKey,
    uploadPhoneAttachment,
    pastePhoneImage,
    loadSnippets,
    saveSnippets,
    hidePhoneTerminal,
    initializePhoneViewOverride,
    initializePhoneWorkspaceRefresh,
    registerEvents,
  });
  return feature;
}
