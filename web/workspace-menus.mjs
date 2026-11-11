import { terminalColorModes } from "./terminal-colors.mjs";
import { terminalAttentionLabel } from "./terminal-attention.mjs";

// Workspace, pane-type, dock and terminal menus and their actions.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   browser: () => ReturnType<typeof import("./browser-view.mjs").createBrowser>,
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   directory: () => ReturnType<typeof import("./directory-dialog.mjs").createDirectory>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   help: () => ReturnType<typeof import("./help-dialog.mjs").createHelp>,
 *   https: () => ReturnType<typeof import("./local-https-dialog.mjs").createHttps>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   palette: () => ReturnType<typeof import("./command-palette.mjs").createPalette>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   rdp: () => ReturnType<typeof import("./rdp-session.mjs").createRdp>,
 *   sessionList: () => ReturnType<typeof import("./session-list-view.mjs").createSessionList>,
 *   sessionsDialog: () => ReturnType<typeof import("./sessions-dialog.mjs").createSessionsDialog>,
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   terminalInput: () => ReturnType<typeof import("./terminal-input-bridge.mjs").createTerminalInput>,
 *   vnc: () => ReturnType<typeof import("./vnc-view.mjs").createVnc>,
 *   windows: () => ReturnType<typeof import("./window-list-view.mjs").createWindows>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createMenus(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    contextMenuRect: undefined,
    terminalMenuRect: undefined,
    terminalMenuRow: undefined,
    workspaceMenuPoint: undefined,
    windowTypeRect: undefined,
    dockMenu: undefined,
    terminalMenu: undefined,
    workspaceMenu: undefined,
    windowTypeMenu: undefined,
  };

  function openDockMenu(event, rect, offsetY = 0) {
    event.preventDefault();
    event.stopPropagation();
    if (rect.kind === "pending") {
      feature.hideWindowTypeMenu({ finalizeDefault: false });
      feature.finalizePendingRectangle(rect, "terminal");
      return;
    }
    dependencies.desktop().setActivePane(rect, { raise: true });
    feature.hideTerminalMenu();
    feature.hideWorkspaceMenu();
    feature.hideWindowTypeMenu();
    feature.contextMenuRect = rect;
    feature.renderDockMenu(rect);
    feature.showMenuAt(feature.dockMenu, event.clientX, event.clientY + offsetY);
  }

  function openTerminalMenu(event, rect) {
    event.preventDefault();
    event.stopPropagation();
    dependencies.desktop().setActivePane(rect, { raise: true });
    feature.hideDockMenu();
    feature.hideWorkspaceMenu();
    feature.hideWindowTypeMenu();
    feature.terminalMenuRect = rect;
    const term = rect.terminal?.term;
    const position = term && rect.terminalContainer ? dependencies.terminalInput().terminalMousePosition(term, rect.terminalContainer, event) : null;
    feature.terminalMenuRow = position
      ? term.getScrollbackLength() - Math.round(term.viewportY) + position.row - 1
      : null;
    feature.renderTerminalMenu(rect);
    feature.showMenuAt(feature.terminalMenu, event.clientX, event.clientY);
  }

  function openWorkspaceMenu(event) {
    if (event.target !== dependencies.desktop().board) {
      return;
    }
    event.preventDefault();
    feature.openWorkspaceMenuAt(event.clientX, event.clientY);
  }

  function openWorkspaceMenuAt(clientX, clientY) {
    feature.workspaceMenuPoint = dependencies.interactions().boardClientPoint(clientX, clientY);
    feature.hideDockMenu();
    feature.hideTerminalMenu();
    feature.hideWindowTypeMenu();
    feature.renderWorkspaceMenu();
    feature.showMenuAt(feature.workspaceMenu, clientX, clientY);
  }

  function renderDockMenu(rect) {
    feature.dockMenu.replaceChildren();
    const actions = [
      ["top", "Dock Top"],
      ["left", "Dock Left"],
      ["right", "Dock Right"],
      ["bottom", "Dock Bottom"],
      [rect.isFull ? "restore" : "full", rect.isFull ? "Restore" : "Full"],
      [rect.minimized ? "unminimize" : "minimize", rect.minimized ? "Restore" : "Minimize"],
      ["destroy", "Destroy"],
    ];

    for (const [action, label] of actions) {
      const button = platform.document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (action === "destroy") {
        button.className = "is-danger";
      }
      button.addEventListener("click", () => {
        dependencies.geometry().applyDockAction(action, feature.contextMenuRect);
        feature.hideDockMenu();
      });
      feature.dockMenu.appendChild(button);
    }
    if (rect.kind === "terminal") feature.appendTerminalColorSetting(feature.dockMenu, rect, feature.hideDockMenu);
  }

  function renderWorkspaceMenu() {
    feature.workspaceMenu.replaceChildren();

    const terminalButton = platform.document.createElement("button");
    terminalButton.type = "button";
    terminalButton.textContent = "New Terminal";
    terminalButton.className = "is-command";
    terminalButton.addEventListener("click", () => {
      const point = feature.workspaceMenuPoint;
      feature.hideWorkspaceMenu();
      dependencies.desktop().createTerminalPane(point);
    });
    feature.workspaceMenu.appendChild(terminalButton);

    const browserButton = platform.document.createElement("button");
    browserButton.type = "button";
    browserButton.textContent = "New Browser";
    browserButton.className = "is-command";
    browserButton.addEventListener("click", () => {
      const point = feature.workspaceMenuPoint || { x: 80, y: dependencies.desktop().tabHeight + 56 };
      feature.hideWorkspaceMenu();
      dependencies.desktop().createBrowserPane(point);
    });
    feature.workspaceMenu.appendChild(browserButton);

    const vncButton = platform.document.createElement("button");
    vncButton.type = "button";
    vncButton.textContent = "New VNC";
    vncButton.className = "is-command";
    vncButton.addEventListener("click", () => {
      const point = feature.workspaceMenuPoint || { x: 80, y: dependencies.desktop().tabHeight + 56 };
      feature.hideWorkspaceMenu();
      dependencies.desktop().createVNCPane(point);
    });
    feature.workspaceMenu.appendChild(vncButton);

    const rdpButton = platform.document.createElement("button");
    rdpButton.type = "button";
    rdpButton.textContent = "New RDP";
    rdpButton.className = "is-command";
    rdpButton.addEventListener("click", () => {
      const point = feature.workspaceMenuPoint || { x: 80, y: dependencies.desktop().tabHeight + 56 };
      feature.hideWorkspaceMenu();
      dependencies.desktop().createRDPPane(point);
    });
    feature.workspaceMenu.appendChild(rdpButton);

    const shortcutsButton = dependencies.directory().directoryBrowserButton("Shortcuts...", dependencies.navigation().openShortcuts);
    feature.workspaceMenu.appendChild(shortcutsButton);

    const panes = dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending");
    if (panes.length === 0) {
      const empty = platform.document.createElement("button");
      empty.type = "button";
      empty.textContent = "No windows";
      empty.disabled = true;
      feature.workspaceMenu.appendChild(empty);
    }

    for (const rect of panes) {
      const row = platform.document.createElement("div");
      row.className = "workspace-menu-row";
      if (rect.id === dependencies.desktop().activePaneID) {
        row.classList.add("is-active");
      }

      const button = platform.document.createElement("button");
      button.type = "button";
      button.className = "workspace-menu-name";
      button.textContent = feature.workspaceMenuLabel(rect);
      button.title = rect.cwd ? `${button.textContent} (${rect.cwd})` : button.textContent;
      button.addEventListener("click", () => {
        feature.hideWorkspaceMenu();
        dependencies.geometry().setMinimized(rect, false);
        dependencies.desktop().setActivePane(rect, { raise: true, focus: true });
      });

      const destroyButton = platform.document.createElement("button");
      destroyButton.type = "button";
      destroyButton.className = "workspace-menu-destroy is-danger";
      destroyButton.textContent = "X";
      destroyButton.title = `Destroy ${button.textContent}`;
      destroyButton.setAttribute("aria-label", `Destroy ${button.textContent}`);
      destroyButton.addEventListener("click", () => {
        feature.hideWorkspaceMenu();
        dependencies.desktop().destroyRectangle(rect, { closeServerTerminal: true });
      });

      row.appendChild(button);
      row.appendChild(destroyButton);
      feature.workspaceMenu.appendChild(row);
    }

    const sessionSeparator = platform.document.createElement("div");
    sessionSeparator.className = "dock-menu-separator";
    feature.workspaceMenu.appendChild(sessionSeparator);
    const sessionsButton = platform.document.createElement("button");
    sessionsButton.type = "button";
    sessionsButton.textContent = dependencies.navigation().currentSessionName ? `Sessions (${dependencies.navigation().currentSessionName})...` : "Sessions...";
    sessionsButton.addEventListener("click", () => {
      feature.hideWorkspaceMenu();
      void dependencies.sessionsDialog().openSessionsModal();
    });
    feature.workspaceMenu.appendChild(sessionsButton);

    if (dependencies.navigation().multiUser || dependencies.navigation().authMode !== "off") {
      const userSeparator = platform.document.createElement("div");
      userSeparator.className = "dock-menu-separator";
      feature.workspaceMenu.appendChild(userSeparator);
    }
    if (dependencies.navigation().multiUser && dependencies.navigation().authMode !== "file") {
      const switchButton = platform.document.createElement("button");
      switchButton.type = "button";
      switchButton.textContent = dependencies.navigation().currentUser ? `Switch user (${dependencies.navigation().currentUser})...` : "Switch user...";
      switchButton.addEventListener("click", () => {
        feature.hideWorkspaceMenu();
        void dependencies.navigation().switchUser();
      });
      feature.workspaceMenu.appendChild(switchButton);
    }
    if (dependencies.navigation().authMode !== "off") {
      const signOutButton = platform.document.createElement("button");
      signOutButton.type = "button";
      signOutButton.textContent = dependencies.navigation().signedInAccount ? `Sign out (${dependencies.navigation().signedInAccount})` : "Sign out";
      signOutButton.addEventListener("click", () => {
        feature.hideWorkspaceMenu();
        void dependencies.navigation().signOutOfTessera();
      });
      feature.workspaceMenu.appendChild(signOutButton);
    }

    const paletteSeparator = platform.document.createElement("div");
    paletteSeparator.className = "dock-menu-separator";
    feature.workspaceMenu.appendChild(paletteSeparator);

    const paletteButton = platform.document.createElement("button");
    paletteButton.type = "button";
    paletteButton.className = "has-hint";
    const paletteLabel = platform.document.createElement("span");
    paletteLabel.textContent = "Command Palette";
    const paletteHint = platform.document.createElement("span");
    paletteHint.className = "menu-hint";
    paletteHint.textContent = "Ctrl+K";
    paletteButton.appendChild(paletteLabel);
    paletteButton.appendChild(paletteHint);
    paletteButton.addEventListener("click", () => {
      feature.hideWorkspaceMenu();
      dependencies.palette().openCommandPalette();
    });
    feature.workspaceMenu.appendChild(paletteButton);
  }

  function showWindowTypeMenu(rect, clientX, clientY) {
    if (!rect || rect.kind !== "pending" || !dependencies.desktop().rectangles.includes(rect)) {
      return;
    }
    feature.hideDockMenu();
    feature.hideTerminalMenu();
    feature.hideWorkspaceMenu();
    feature.hideDirectoryBrowser();
    feature.windowTypeRect = rect;
    feature.renderWindowTypeMenu();
    feature.showMenuAt(feature.windowTypeMenu, clientX, clientY);
  }

  function renderWindowTypeMenu() {
    feature.windowTypeMenu.replaceChildren();
    const actions = [
      ["terminal", "Terminal"],
      [dependencies.browser().browserPaneKind, "Browser"],
      [dependencies.vnc().vncPaneKind, "VNC"],
      [dependencies.rdp().rdpPaneKind, "RDP"],
    ];
    for (const [kind, label] of actions) {
      const button = platform.document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        const rect = feature.windowTypeRect;
        feature.hideWindowTypeMenu({ finalizeDefault: false });
        feature.finalizePendingRectangle(rect, kind);
      });
      feature.windowTypeMenu.appendChild(button);
    }
  }

  function finalizePendingRectangle(rect, kind) {
    if (!rect || rect.kind !== "pending" || !dependencies.desktop().rectangles.includes(rect)) {
      return;
    }
    const paneKind = kind === "terminal" || kind === dependencies.browser().browserPaneKind || kind === dependencies.vnc().vncPaneKind || kind === dependencies.rdp().rdpPaneKind
      ? kind
      : "terminal";
    const box = dependencies.geometry().rectangleBox(rect);
    const paneID = rect.id;
    const zIndex = rect.zIndex;
    const cwd = rect.cwd || "";
    dependencies.desktop().destroyRectangle(rect);
    const nextRect = dependencies.desktop().createRectangle(box.x, box.y, box.width, box.height, {
      id: paneID,
      kind: paneKind,
      cwd,
      zIndex,
    });
    dependencies.desktop().setActivePane(nextRect, { raise: true, focus: true });
    dependencies.workspace().scheduleWorkspaceSave();
  }

  function workspaceMenuLabel(rect) {
    const index = dependencies.desktop().rectangles.indexOf(rect);
    const name = rect.title.trim() || `Window ${index + 1}`;
    const kindSuffix = rect.kind === "terminal"
      ? " [terminal]"
      : rect.kind === dependencies.browser().browserPaneKind
          ? " [browser]"
        : rect.kind === dependencies.vnc().vncPaneKind
          ? " [vnc]"
        : rect.kind === dependencies.rdp().rdpPaneKind
          ? " [rdp]"
        : "";
    return `${name}${kindSuffix}${rect.filePendingCount ? ` [${rect.filePendingCount} file transfer${rect.filePendingCount === 1 ? "" : "s"}]` : ""}${terminalAttentionLabel(rect.terminalAttention)}`;
  }

  function appendTerminalColorSetting(menu, rect, hideMenu) {
    const label = platform.document.createElement("label");
    label.className = "terminal-image-setting";
    label.textContent = "Terminal colors";
    const select = platform.document.createElement("select");
    select.setAttribute("aria-label", "Terminal colors");
    const defaultLabel = `Use default (${terminalColorModes[dependencies.preferences().terminalColorMode].label})`;
    for (const [id, choice] of [["", { label: defaultLabel }], ...Object.entries(terminalColorModes)]) {
      const option = platform.document.createElement("option");
      option.value = id;
      option.textContent = choice.label;
      option.selected = id === (rect.terminalColorMode || "");
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      hideMenu();
      void dependencies.preferences().setPaneTerminalColorMode(rect, select.value);
    });
    label.appendChild(select);
    menu.appendChild(label);
  }

  function renderTerminalMenu(rect) {
    feature.terminalMenu.replaceChildren();
    const actions = [
      ["copy", "Copy"],
      ["copy-output", "Copy Command Output"],
      ["paste", "Paste"],
      ["find", "Find…"],
    ];
    const term = rect?.terminal?.term;
    const hasSelection = Boolean(term?.hasSelection?.() || term?.getSelection?.());
    const canReadClipboard = Boolean(dependencies.clipboard().clipboardBridge.status || platform.navigator.clipboard?.readText || platform.document.queryCommandSupported?.("paste"));
    const canPaste = canReadClipboard || dependencies.clipboard().clipboardText.length > 0;

    for (const [action, label] of actions) {
      const button = platform.document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.action = action;
      if (action === "copy") {
        button.disabled = !hasSelection;
      } else if (action === "copy-output") {
        // The output of the command under the pointer, found from its shell's
        // OSC 133 prompt marks.
        button.disabled = !term?.commandOutputAt?.(feature.terminalMenuRow);
      } else if (action === "paste") {
        button.disabled = !canPaste;
      }
      button.addEventListener("click", () => {
        const actionRect = feature.terminalMenuRect;
        const actionRow = feature.terminalMenuRow;
        feature.hideTerminalMenu();
        void feature.applyTerminalMenuAction(action, actionRect, { row: actionRow });
      });
      feature.terminalMenu.appendChild(button);
    }

    const separator = platform.document.createElement("div");
    separator.className = "dock-menu-separator";
    feature.terminalMenu.appendChild(separator);
    feature.appendTerminalColorSetting(feature.terminalMenu, rect, feature.hideTerminalMenu);
    const themeSeparator = platform.document.createElement("div");
    themeSeparator.className = "dock-menu-separator";
    feature.terminalMenu.appendChild(themeSeparator);
    const audioToggle = platform.document.createElement("button");
    audioToggle.type = "button";
    audioToggle.textContent = dependencies.terminal().terminalAudioPlayer.enabled ? "Disable terminal audio" : "Enable terminal audio";
    audioToggle.addEventListener("click", () => {
      feature.hideTerminalMenu();
      if (dependencies.terminal().terminalAudioPlayer.enabled) dependencies.terminal().terminalAudioPlayer.disable();
      else void dependencies.terminal().terminalAudioPlayer.enable().catch(() => dependencies.terminal().renderTerminalAudioStatus(rect, { kind: "enable", text: "Audio could not start. Enable again." }));
    });
    feature.terminalMenu.appendChild(audioToggle);
    const muteLabel = platform.document.createElement("label");
    muteLabel.className = "terminal-image-setting";
    const mute = platform.document.createElement("input");
    mute.type = "checkbox";
    const audioKey = rect?.terminal?.audioKey;
    mute.checked = Boolean(dependencies.terminal().terminalAudioPlayer.terminals.get(audioKey)?.muted);
    mute.disabled = !audioKey;
    mute.addEventListener("change", () => {
      dependencies.terminal().terminalAudioPlayer.setMuted(audioKey, mute.checked);
      try { platform.window.localStorage.setItem(audioKey, String(mute.checked)); } catch {}
      feature.hideTerminalMenu();
    });
    muteLabel.append(mute, platform.document.createTextNode("Mute terminal audio"));
    feature.terminalMenu.appendChild(muteLabel);
    const audioSeparator = platform.document.createElement("div");
    audioSeparator.className = "dock-menu-separator";
    feature.terminalMenu.appendChild(audioSeparator);
    const imageSettings = term?.imageSettings?.() || { memoryMiB: 64, showPlaceholders: true };
    const connected = rect?.terminal?.socket?.readyState === platform.WebSocket.OPEN && Boolean(rect.terminal.replica?.cursor.epoch);
    const budgetLabel = platform.document.createElement("label");
    budgetLabel.className = "terminal-image-setting";
    budgetLabel.textContent = "Image memory";
    budgetLabel.title = "Decoded image budget for this running shell, shared by all browsers.";
    const budget = platform.document.createElement("select");
    budget.setAttribute("aria-label", "Terminal image memory");
    budget.disabled = !connected;
    for (const memoryMiB of [16, 32, 64]) {
      const option = platform.document.createElement("option");
      option.value = String(memoryMiB);
      option.textContent = `${memoryMiB} MiB`;
      option.selected = imageSettings.memoryMiB === memoryMiB;
      budget.appendChild(option);
    }
    budget.addEventListener("change", () => {
      feature.sendTerminalImageAction(rect, { type: "image-settings", memoryMiB: Number(budget.value) });
      feature.hideTerminalMenu();
    });
    budgetLabel.appendChild(budget);
    feature.terminalMenu.appendChild(budgetLabel);
    const placeholderLabel = platform.document.createElement("label");
    placeholderLabel.className = "terminal-image-setting";
    const placeholders = platform.document.createElement("input");
    placeholders.type = "checkbox";
    placeholders.checked = imageSettings.showPlaceholders;
    placeholders.disabled = !connected;
    placeholders.addEventListener("change", () => {
      feature.sendTerminalImageAction(rect, { type: "image-settings", showPlaceholders: placeholders.checked });
      feature.hideTerminalMenu();
    });
    placeholderLabel.append(placeholders, platform.document.createTextNode("Show discarded image markers"));
    feature.terminalMenu.appendChild(placeholderLabel);
    const clear = platform.document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear terminal images";
    clear.disabled = !connected;
    clear.title = "Free retained images and markers in this shell, keeping text and scrollback.";
    clear.addEventListener("click", () => {
      feature.sendTerminalImageAction(rect, { type: "clear-images" });
      feature.hideTerminalMenu();
    });
    feature.terminalMenu.appendChild(clear);
  }

  function sendTerminalImageAction(rect, message) {
    const state = rect?.terminal;
    if (state?.socket?.readyState !== platform.WebSocket.OPEN || !state.replica?.cursor.epoch) return;
    state.socket.send(JSON.stringify(message));
  }

  async function applyTerminalMenuAction(action, rect, { row = null } = {}) {
    const term = rect?.terminal?.term;
    if (!term) {
      return;
    }

    if (action === "find") {
      dependencies.terminal().openTerminalFind(rect);
      return;
    }

    if (action === "copy-output") {
      // Selecting it shows what was copied. No row means the last command.
      const output = term.commandOutputAt?.(row);
      const text = output ? term.selectCommandOutput(row) : "";
      if (text) {
        // ghostty-web clears the selection on any click outside the terminal,
        // which includes the menu or palette click that got here. Copy now,
        // while Safari still counts the click, and show the selection again
        // once that click is done.
        platform.window.setTimeout(() => {
          if (!term.hasSelection?.()) term.selectRows(output.start, output.end);
        });
        await dependencies.clipboard().writeClipboardText(text);
      } else {
        dependencies.workspace().setWorkspaceStatus("error", "No command output",
          "Tessera finds a command's output from the prompt marks the shell sends (OSC 133). Shell integration (Settings → Terminal) sends them from zsh and bash in new terminals.",
          { autoHideMs: dependencies.clipboard().emptyCopyStatusHideMs });
      }
      term.focus();
      return;
    }

    if (action === "copy") {
      // Read first: focusing a contenteditable canvas terminal can alter the
      // browser/terminal selection on some WebKit builds.
      const text = term.getSelection?.() || "";
      if (text) {
        await dependencies.clipboard().writeClipboardText(text);
      } else {
        dependencies.clipboard().reportEmptyTerminalCopy(term);
      }
      term.focus();
      return;
    }

    if (action === "paste") {
      term.focus();
      try {
        const content = await dependencies.clipboard().readClipboardContent();
        if (rect.terminal?.term !== term) return;
        if (content?.image) {
          await dependencies.terminalInput().pasteImageIntoTerminal(rect, term, content.image);
        } else if (content?.text) {
          term.paste?.(content.text);
        }
        dependencies.clipboard().reportClipboardFallback(dependencies.interactions().appleKeyboardLayout ? "Cmd+V" : "Ctrl+V");
      } catch (error) {
        dependencies.workspace().setWorkspaceStatus("error", "Paste unavailable", error.message);
      }
      term.focus();
    }
  }

  function hideMenusWhenOutside(event) {
    if (!feature.dockMenu.hidden && !feature.dockMenu.contains(event.target)) {
      feature.hideDockMenu();
    }
    if (!feature.terminalMenu.hidden && !feature.terminalMenu.contains(event.target)) {
      feature.hideTerminalMenu();
    }
    if (!feature.workspaceMenu.hidden && !feature.workspaceMenu.contains(event.target)) {
      feature.hideWorkspaceMenu();
    }
    if (!feature.windowTypeMenu.hidden && !feature.windowTypeMenu.contains(event.target)) {
      feature.hideWindowTypeMenu();
    }
    if (!dependencies.deskbar().deskbarPanel.hidden && !dependencies.deskbar().deskbarPanel.contains(event.target) && !dependencies.deskbar().deskbarButton.contains(event.target)) {
      dependencies.deskbar().hideDeskbar();
    }
    if (!dependencies.directory().directoryBrowser.hidden && !dependencies.directory().directoryBrowser.contains(event.target)) {
      feature.hideDirectoryBrowser();
    }
  }

  function hideMenusOnEscape(event) {
    if (event.key === "Escape") {
      feature.hideAllMenus();
    }
  }

  function hideAllMenus() {
    dependencies.navigation().shortcutsUI.close();
    feature.hideFloatingMenus();
    feature.hideDirectoryBrowser();
    dependencies.palette().hideCommandPalette();
    dependencies.windows().hideWindowList();
    dependencies.sessionList().hideSessionList();
    dependencies.deskbar().hideDeskbar();
    dependencies.settings().hideSettingsModal();
    dependencies.https().hideLocalHTTPSModal();
    dependencies.help().hideHelpModal();
    dependencies.desktop().hideRenameWindowModal();
    dependencies.clipboard().saveClipboardDialog.close();
    dependencies.sessionsDialog().hideSessionsModal();
    dependencies.sessionsDialog().hideSessionActionModal();
  }

  function hideFloatingMenus() {
    feature.hideDockMenu();
    feature.hideTerminalMenu();
    feature.hideWorkspaceMenu();
    feature.hideWindowTypeMenu();
  }

  function hideDockMenu() {
    feature.dockMenu.hidden = true;
    feature.contextMenuRect = null;
  }

  function hideTerminalMenu() {
    feature.terminalMenu.hidden = true;
    feature.terminalMenuRect = null;
  }

  function hideWorkspaceMenu() {
    feature.workspaceMenu.hidden = true;
    feature.workspaceMenuPoint = null;
  }

  // Dismissing the window-type menu without picking a type (click outside,
  // Escape, or opening another menu) cancels the draw instead of defaulting
  // to a window kind — the user gets exactly what they chose, or nothing.
  function hideWindowTypeMenu(options = {}) {
    const rect = feature.windowTypeRect;
    feature.windowTypeMenu.hidden = true;
    feature.windowTypeRect = null;
    if (options.finalizeDefault === false) {
      return;
    }
    if (rect && rect.kind === "pending" && dependencies.desktop().rectangles.includes(rect)) {
      dependencies.desktop().destroyRectangle(rect, { selectNext: false });
    }
  }

  function hideDirectoryBrowser() {
    dependencies.directory().directoryBrowser.hidden = true;
    dependencies.directory().directoryBrowserRect = null;
    dependencies.directory().directoryBrowserPath = "";
  }

  function showMenuAt(menu, clientX, clientY) {
    menu.hidden = false;
    const menuBox = menu.getBoundingClientRect();
    const left = Math.min(clientX, platform.window.innerWidth - menuBox.width - 6);
    const top = Math.min(clientY, platform.window.innerHeight - menuBox.height - 6);
    menu.style.left = `${Math.max(6, left)}px`;
    menu.style.top = `${Math.max(6, top)}px`;
  }

  function initializeContextMenuRect() {
    feature.contextMenuRect = null;
    feature.terminalMenuRect = null;
    // The buffer row the terminal menu was opened over, for Copy Command Output.
    feature.terminalMenuRow = null;
    feature.workspaceMenuPoint = null;
    feature.windowTypeRect = null;
  }

  function initializeDockMenu() {
    feature.dockMenu = platform.document.createElement("div");
    feature.dockMenu.className = "dock-menu";
    feature.dockMenu.hidden = true;
    platform.document.body.appendChild(feature.dockMenu);
    feature.terminalMenu = platform.document.createElement("div");
    feature.terminalMenu.className = "dock-menu terminal-menu";
    feature.terminalMenu.hidden = true;
    platform.document.body.appendChild(feature.terminalMenu);
    feature.workspaceMenu = platform.document.createElement("div");
    feature.workspaceMenu.className = "dock-menu workspace-menu";
    feature.workspaceMenu.hidden = true;
    platform.document.body.appendChild(feature.workspaceMenu);
    feature.windowTypeMenu = platform.document.createElement("div");
    feature.windowTypeMenu.className = "dock-menu window-type-menu";
    feature.windowTypeMenu.hidden = true;
    platform.document.body.appendChild(feature.windowTypeMenu);
  }

  Object.assign(feature, {
    openDockMenu,
    openTerminalMenu,
    openWorkspaceMenu,
    openWorkspaceMenuAt,
    renderDockMenu,
    renderWorkspaceMenu,
    showWindowTypeMenu,
    renderWindowTypeMenu,
    finalizePendingRectangle,
    workspaceMenuLabel,
    appendTerminalColorSetting,
    renderTerminalMenu,
    sendTerminalImageAction,
    applyTerminalMenuAction,
    hideMenusWhenOutside,
    hideMenusOnEscape,
    hideAllMenus,
    hideFloatingMenus,
    hideDockMenu,
    hideTerminalMenu,
    hideWorkspaceMenu,
    hideWindowTypeMenu,
    hideDirectoryBrowser,
    showMenuAt,
    initializeContextMenuRect,
    initializeDockMenu,
  });
  return feature;
}
