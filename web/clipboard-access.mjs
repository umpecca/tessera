import { createClipboardBridge, firefoxClipboardExtensionRecommendation } from "./clipboard-bridge.mjs";
import { emptyTerminalCopyGuidance } from "./terminal-input.mjs";
import { clipboardItemsContent, readHostClipboardStatus } from "./clipboard-image.mjs";
import { clipboardSaveEntries, deleteSavedFiles, LastClipboardSave, SaveClipboardDialog, textSaveEntry } from "./save-clipboard.mjs";

// Clipboard fallback, queued terminal writes, saving and setup prompts.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createClipboard(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    clipboardText: undefined,
    clipboardBridge: undefined,
    clipboardPromptCheckID: undefined,
    clipboardPromptDismissed: undefined,
    clipboardPromptSnoozeKey: undefined,
    hostClipboardStatus: undefined,
    hostClipboardStatusFailed: undefined,
    clipboardSetupPrompt: undefined,
    clipboardSetupCopy: undefined,
    clipboardSetupTitle: undefined,
    clipboardSetupMessage: undefined,
    clipboardSetupActions: undefined,
    clipboardSetupButton: undefined,
    clipboardSetupDismiss: undefined,
    lastClipboardSave: undefined,
    saveClipboardDialog: undefined,
    emptyCopyStatusHideMs: undefined,
    clipboardWriteTimeoutMs: undefined,
    terminalClipboardWrites: undefined,
    clipboardReadFellBack: undefined,
  };

  async function refreshHostClipboardStatus() {
    try {
      feature.hostClipboardStatus = await readHostClipboardStatus();
      feature.hostClipboardStatusFailed = false;
    } catch {
      feature.hostClipboardStatusFailed = true;
    }
  }

  async function refreshClipboardBridgeAndPrompt() {
    const checkID = ++feature.clipboardPromptCheckID;
    const connected = await feature.clipboardBridge.check();
    if (checkID !== feature.clipboardPromptCheckID) return;
    if (connected) {
      feature.clipboardSetupPrompt.hidden = true;
      return;
    }

    const recommendation = firefoxClipboardExtensionRecommendation({
      userAgent: platform.navigator.userAgent,
      isSecureContext: platform.window.isSecureContext,
      clipboard: platform.navigator.clipboard,
    });
    if (!recommendation || feature.clipboardPromptDismissed) return;
    try {
      if (Number(platform.window.localStorage.getItem(feature.clipboardPromptSnoozeKey)) > platform.Date.now()) return;
    } catch {
      // Storage may be unavailable in hardened browser profiles.
    }
    feature.clipboardSetupMessage.textContent = recommendation;
    feature.clipboardSetupPrompt.hidden = false;
  }

  // A copy that found no selection did nothing at all, and the keystroke that
  // asked for it was consumed either way. Say so, and name the way to make a
  // selection, rather than leaving the key looking broken.
  function reportEmptyTerminalCopy(term) {
    let mouseTracking = false;
    try {
      mouseTracking = Boolean(term?.hasMouseTracking?.());
    } catch {
      mouseTracking = false;
    }
    dependencies.workspace().setWorkspaceStatus("error", "Nothing to copy", emptyTerminalCopyGuidance(mouseTracking), {
      // Nothing is broken and nothing needs answering — the next copy either
      // works or says this again, so it should not sit in the corner.
      autoHideMs: feature.emptyCopyStatusHideMs,
    });
  }

  // This browser refused to read the clipboard, so whatever was pasted came from
  // Tessera's own last copy rather than the system clipboard. Say so instead of
  // letting stale text look like a normal paste.
  function reportClipboardFallback(acceleratorName) {
    if (!feature.clipboardReadFellBack) {
      return;
    }
    feature.clipboardReadFellBack = false;
    dependencies.workspace().setWorkspaceStatus(
      "error",
      "Clipboard blocked",
      `This browser would not read the clipboard, so Tessera's own last copy was used. Use ${acceleratorName} to paste from the system clipboard.`,
    );
  }

  // Resolves true when the promise settled in time and false when it did not. A
  // rejection still propagates, so a refused write stays distinguishable from a
  // stalled one.
  function settledWithin(promise, milliseconds) {
    let timer = null;
    const expiry = new Promise((resolve) => {
      timer = platform.window.setTimeout(() => resolve(false), milliseconds);
    });
    return Promise.race([promise.then(() => true), expiry])
      .finally(() => platform.window.clearTimeout(timer));
  }

  // Returns whether the text reached the real system clipboard. Tessera's own
  // buffer is updated either way, so pasting back inside Tessera still works
  // when the browser refuses the write.
  async function writeClipboardText(text, { terminal = false } = {}) {
    feature.clipboardText = text;
    if (feature.clipboardBridge?.kind === "native" && !terminal) {
      try { await feature.clipboardBridge.writeText(text); return true; }
      catch (error) {
        dependencies.workspace().setWorkspaceStatus("error", "Copy failed", error.message);
        return false;
      }
    }
    if (feature.clipboardBridge.status && (!terminal || feature.clipboardBridge.status.terminal)) {
      try {
        await feature.clipboardBridge.writeText(text, terminal);
        return true;
      } catch {
        // Retain the ordinary browser and internal-buffer fallbacks.
      }
    }
    if (platform.navigator.clipboard?.writeText) {
      try {
        if (await feature.settledWithin(platform.navigator.clipboard.writeText(text), feature.clipboardWriteTimeoutMs)) {
          return true;
        }
      } catch {
        // Fall through to the synchronous copy fallback below.
      }
    }
    return feature.copyTextWithHiddenField(text);
  }

  function applyTerminalClipboardWrite(text) {
    feature.terminalClipboardWrites = feature.terminalClipboardWrites
      .then(async () => {
        if (await feature.writeClipboardText(text, { terminal: true })) {
          return;
        }
        dependencies.workspace().setWorkspaceStatus(
          "error",
          "Clipboard blocked",
          "A Terminal program copied text, but this browser would not write the system clipboard. The text is available to Tessera's own Paste.",
        );
      })
      .catch(() => {});
    return feature.terminalClipboardWrites;
  }

  // The clipboard for Save Clipboard to File. read() offers images as well as
  // text; where it is missing or refused, fall back to text alone.
  async function readClipboardForSave() {
    if (feature.clipboardBridge?.kind === "native") return clipboardSaveEntries(await feature.clipboardBridge.read());
    if (platform.navigator.clipboard?.read) {
      try {
        return await clipboardSaveEntries(await platform.navigator.clipboard.read());
      } catch {
        // Refused or unsupported: try text.
      }
    }
    const text = await feature.readClipboardText();
    return text ? [textSaveEntry(text)] : [];
  }

  function openSaveClipboardDialog() {
    dependencies.menus().hideAllMenus();
    const pane = dependencies.desktop().getActivePane();
    feature.saveClipboardDialog.open({ current: pane?.kind === "terminal" ? pane.cwd || "" : "" });
  }

  async function deleteLastClipboardSave() {
    const paths = feature.lastClipboardSave.paths;
    if (!paths.length) return;
    const what = paths.length === 1 ? "this file" : `these ${paths.length} files`;
    if (!platform.window.confirm(`Delete ${what}, saved from the clipboard?\n\n${paths.join("\n")}`)) return;
    try {
      const { deleted, kept } = await deleteSavedFiles(paths);
      feature.lastClipboardSave.set([], "");
      const text = deleted.length === 1 ? `Deleted ${deleted[0]}` : `Deleted ${deleted.length} files`;
      if (!kept.length) {
        dependencies.workspace().setWorkspaceStatus("saved", text);
        return;
      }
      const reasons = kept.map(file => `${file.path}: ${file.reason}`).join("; ");
      dependencies.workspace().setWorkspaceStatus("error", deleted.length ? `${text}, kept ${kept.length}` : `Kept ${kept.length === 1 ? "the file" : `all ${kept.length} files`}`, reasons);
    } catch (error) {
      dependencies.workspace().setWorkspaceStatus("error", "Delete failed", error.message);
    }
  }

  async function readClipboardText({ allowFocus = true } = {}) {
    feature.clipboardReadFellBack = false;
    // A denied/cancelled native paste must never become Tessera's last copy.
    if (feature.clipboardBridge?.kind === "native") return feature.clipboardBridge.readText();
    if (feature.clipboardBridge.status) {
      try { return await feature.clipboardBridge.readText(); }
      catch { /* Continue with the browser and internal-buffer fallbacks. */ }
    }
    if (platform.navigator.clipboard?.readText) {
      try {
        return await platform.navigator.clipboard.readText();
      } catch {
        // Fall through to the synchronous paste fallback below.
      }
    }
    const pastedText = allowFocus ? feature.pasteTextWithHiddenField() : null;
    if (pastedText !== null) {
      return pastedText;
    }
    feature.clipboardReadFellBack = true;
    return feature.clipboardText;
  }

  async function readClipboardContent() {
    feature.clipboardReadFellBack = false;
    if (feature.clipboardBridge?.kind === "native") return clipboardItemsContent(await feature.clipboardBridge.read());
    const text = await feature.readClipboardText();
    if (text) return { text };
    if (!feature.clipboardReadFellBack && platform.navigator.clipboard?.read) {
      try { return await clipboardItemsContent(await platform.navigator.clipboard.read()); }
      catch { /* Browser image reading can be unsupported or declined. */ }
    }
    return null;
  }

  function copyTextWithHiddenField(text) {
    // Selecting the field takes focus, and an OSC 52 copy can land while a TUI
    // has the keyboard, so give focus back where it was.
    const previouslyFocused = platform.document.activeElement;
    const field = platform.document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-1000px";
    field.style.top = "0";
    platform.document.body.appendChild(field);
    field.select();
    let copied = false;
    try {
      copied = platform.document.execCommand("copy");
    } catch {
      copied = false;
    }
    field.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus();
    }
    return copied;
  }

  function pasteTextWithHiddenField() {
    const field = platform.document.createElement("textarea");
    field.style.position = "fixed";
    field.style.left = "-1000px";
    field.style.top = "0";
    platform.document.body.appendChild(field);
    field.focus();
    let pasted = false;
    try {
      pasted = platform.document.execCommand("paste");
    } catch {
      pasted = false;
    }
    const text = pasted ? field.value : null;
    field.remove();
    return text;
  }

  function initializeClipboardText() {
    feature.clipboardText = "";
  }

  function initializeClipboardBridge() {
    feature.clipboardBridge = createClipboardBridge(platform.window);
    feature.clipboardPromptCheckID = 0;
    feature.clipboardPromptDismissed = false;
    feature.clipboardPromptSnoozeKey = "tessera.clipboard-extension-prompt-snoozed-until.v1";
  }

  function initializeHostClipboardStatus() {
    // The server's last answer about its host clipboard, for Diagnostics.
    feature.hostClipboardStatus = null;
    feature.hostClipboardStatusFailed = false;
  }

  function initializeClipboardSetupPrompt() {
    feature.clipboardSetupPrompt = platform.document.createElement("aside");
    feature.clipboardSetupPrompt.className = "clipboard-setup-prompt";
    feature.clipboardSetupPrompt.hidden = true;
    feature.clipboardSetupPrompt.setAttribute("role", "region");
    feature.clipboardSetupPrompt.setAttribute("aria-labelledby", "clipboard-setup-prompt-title");
    feature.clipboardSetupCopy = platform.document.createElement("div");
    feature.clipboardSetupTitle = platform.document.createElement("strong");
    feature.clipboardSetupTitle.id = "clipboard-setup-prompt-title";
    feature.clipboardSetupTitle.textContent = "Enable reliable clipboard access";
    feature.clipboardSetupMessage = platform.document.createElement("span");
    feature.clipboardSetupCopy.append(feature.clipboardSetupTitle, feature.clipboardSetupMessage);
    feature.clipboardSetupActions = platform.document.createElement("div");
    feature.clipboardSetupActions.className = "clipboard-setup-prompt-actions";
    feature.clipboardSetupButton = platform.document.createElement("button");
    feature.clipboardSetupButton.type = "button";
    feature.clipboardSetupButton.textContent = "Set up clipboard";
    feature.clipboardSetupButton.addEventListener("click", () => {
      feature.clipboardPromptDismissed = true;
      feature.clipboardSetupPrompt.hidden = true;
      dependencies.settings().openSettingsModal({ clipboard: true });
    });
    feature.clipboardSetupDismiss = platform.document.createElement("button");
    feature.clipboardSetupDismiss.type = "button";
    feature.clipboardSetupDismiss.textContent = "Remind me later";
    feature.clipboardSetupDismiss.addEventListener("click", () => {
      feature.clipboardPromptDismissed = true;
      feature.clipboardSetupPrompt.hidden = true;
      try {
        platform.window.localStorage.setItem(feature.clipboardPromptSnoozeKey, String(platform.Date.now() + 24 * 60 * 60 * 1000));
      } catch {
        // The in-memory dismissal still prevents repeated prompts on this page.
      }
    });
    feature.clipboardSetupActions.append(feature.clipboardSetupButton, feature.clipboardSetupDismiss);
    feature.clipboardSetupPrompt.append(feature.clipboardSetupCopy, feature.clipboardSetupActions);
    platform.document.body.appendChild(feature.clipboardSetupPrompt);
  }

  function initializeLastClipboardSave() {
    feature.lastClipboardSave = new LastClipboardSave();
    feature.saveClipboardDialog = new SaveClipboardDialog({
      readClipboard: feature.readClipboardForSave,
      pasteKey: dependencies.interactions().appleKeyboardLayout ? "Cmd+V" : "Ctrl+V",
      confirmReplace: async (name) => platform.window.confirm(`${name} already exists in this folder. Replace it?`),
      onSaved: ({ saved, skipped, directory }) => {
        feature.lastClipboardSave.set(saved, directory);
        const text = saved.length === 1 ? `Saved ${saved[0]}` : `Saved ${saved.length} files to ${directory}`;
        dependencies.workspace().setWorkspaceStatus("saved", text, skipped.length ? `${text}. Kept existing: ${skipped.join(", ")}` : text);
      },
      onClose: () => dependencies.desktop().getActivePane()?.terminal?.term?.focus?.(),
    });
    platform.document.body.appendChild(feature.saveClipboardDialog.element);
  }

  function initializeEmptyCopyStatusHideMs() {
    feature.emptyCopyStatusHideMs = 4000;
    // Chrome leaves clipboard.writeText() pending — neither resolved nor rejected —
    // while its window does not hold focus. An OSC 52 copy hits that easily, since
    // it arrives over the terminal socket rather than from a keystroke, and awaiting
    // it forever loses the copy with no error to report and stalls every write
    // queued behind it. Give up instead and take the fallback path.
    feature.clipboardWriteTimeoutMs = 1500;
    // OSC 52 copies arrive from the PTY rather than from a keystroke, and a
    // browser that requires a user gesture — or an unfocused window — will refuse
    // the write. Say so once rather than leaving the operator to discover it by
    // pasting something stale into another application.
    feature.terminalClipboardWrites = Promise.resolve();
    // True when the last read could not reach the real clipboard and fell back to
    // whatever Tessera itself last copied. Callers surface that, so a blocked read
    // never looks like a successful paste of someone else's text.
    feature.clipboardReadFellBack = false;
  }

  Object.assign(feature, {
    refreshHostClipboardStatus,
    refreshClipboardBridgeAndPrompt,
    reportEmptyTerminalCopy,
    reportClipboardFallback,
    settledWithin,
    writeClipboardText,
    applyTerminalClipboardWrite,
    readClipboardForSave,
    openSaveClipboardDialog,
    deleteLastClipboardSave,
    readClipboardText,
    readClipboardContent,
    copyTextWithHiddenField,
    pasteTextWithHiddenField,
    initializeClipboardText,
    initializeClipboardBridge,
    initializeHostClipboardStatus,
    initializeClipboardSetupPrompt,
    initializeLastClipboardSave,
    initializeEmptyCopyStatusHideMs,
  });
  return feature;
}
