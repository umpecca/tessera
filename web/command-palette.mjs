import { browseLocalPortHelpCommand } from "./browser-pane.mjs";

// Command construction, shortcut matching, ranking and presentation.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   browser: () => ReturnType<typeof import("./browser-view.mjs").createBrowser>,
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   connectivity: () => ReturnType<typeof import("./server-connectivity.mjs").createConnectivity>,
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   help: () => ReturnType<typeof import("./help-dialog.mjs").createHelp>,
 *   https: () => ReturnType<typeof import("./local-https-dialog.mjs").createHttps>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   phone: () => ReturnType<typeof import("./phone-workspace.mjs").createPhone>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   sessionList: () => ReturnType<typeof import("./session-list-view.mjs").createSessionList>,
 *   sessionsDialog: () => ReturnType<typeof import("./sessions-dialog.mjs").createSessionsDialog>,
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   windows: () => ReturnType<typeof import("./window-list-view.mjs").createWindows>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createPalette(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    commandPalette: undefined,
    commandPalettePanel: undefined,
    commandPaletteInput: undefined,
    commandPaletteList: undefined,
    paletteLauncher: undefined,
    paletteEntries: undefined,
    paletteSelection: undefined,
    paletteShortcutCodes: undefined,
  };

  function toggleCommandPalette() {
    if (feature.commandPalette.hidden) {
      feature.openCommandPalette();
    } else {
      feature.hideCommandPalette();
    }
  }

  function openCommandPalette() {
    if (!dependencies.navigation().userSelect.hidden) {
      return;
    }
    dependencies.menus().hideAllMenus();
    feature.commandPalette.hidden = false;
    feature.commandPaletteInput.value = "";
    feature.renderPaletteResults();
    feature.commandPaletteInput.focus();
  }

  function hideCommandPalette() {
    const restorePaneFocus = !feature.commandPalette.hidden && feature.commandPalette.contains(platform.document.activeElement);
    feature.commandPalette.hidden = true;
    if (restorePaneFocus) {
      dependencies.switcher().restorePaneFocusAfterOverlayDismiss(feature.commandPalette);
    }
  }

  // Every action the workspace menu offers, flattened into searchable commands,
  // plus jump-to-window entries (which also restore minimized panes).
  function buildPaletteCommands() {
    const commands = [];
    commands.push({ id: "help", label: "Help", hint: "shortcuts and commands", run: () => dependencies.help().openHelpModal() });
    commands.push({ ...browseLocalPortHelpCommand, run: () => {
      const active = dependencies.desktop().getActivePane();
      dependencies.help().openBrowserPortHelp(active?.kind === dependencies.browser().browserPaneKind ? active : null);
    } });
    commands.push({ id: "window-list", label: "Window List", hint: "Ctrl+L", run: () => dependencies.windows().openWindowList() });
    commands.push({ id: "session-list", label: "Session List", hint: "Ctrl/Cmd+;", run: () => void dependencies.sessionList().openSessionList() });
    commands.push(dependencies.phone().phoneView.active
      ? { id: "desktop-view", label: "Desktop View", aliases: ["windows"], hint: "this browser", run: () => dependencies.phone().setPhoneViewOverride("desktop") }
      : { id: "phone-view", label: "Phone View", aliases: ["mobile", "terminal list"], hint: "this browser", run: () => dependencies.phone().setPhoneViewOverride("phone") });
    commands.push({ id: "screensaver", label: "Screensaver", aliases: ["screen saver", "mosaic"], hint: "any key returns", run: () => dependencies.preferences().screensaver.open() });
    commands.push({
      id: "deskbar-button-toggle",
      label: dependencies.preferences().deskbarButtonEnabled ? "Hide Deskbar Button" : "Show Deskbar Button",
      hint: "interface",
      run: () => dependencies.deskbar().toggleDeskbarButton(),
    });
    // Keep Settings ahead of other equally ranked "se" prefix matches.
    commands.push({
      id: "save-clipboard",
      label: "Save Clipboard to File...",
      aliases: ["save clipboard", "paste to file", "save as"],
      hint: "text, images or files",
      run: () => dependencies.clipboard().openSaveClipboardDialog(),
    });
    if (dependencies.clipboard().lastClipboardSave.paths.length) {
      const count = dependencies.clipboard().lastClipboardSave.paths.length;
      commands.push({
        id: "delete-clipboard-save",
        label: "Delete Last Clipboard Save...",
        aliases: ["undo clipboard save", "remove saved clipboard"],
        hint: count === 1 ? dependencies.clipboard().lastClipboardSave.paths[0] : `${count} files`,
        run: () => void dependencies.clipboard().deleteLastClipboardSave(),
      });
    }
    commands.push({ id: "settings", label: "Settings...", aliases: ["preferences"], hint: "workspace", run: () => dependencies.settings().openSettingsModal() });
    commands.push({ id: "sessions", label: "Tessera Sessions...", hint: dependencies.navigation().currentSessionName || "manage", run: () => void dependencies.sessionsDialog().openSessionsModal() });
    commands.push({ id: "new-session", label: "Create Session...", hint: "session", run: () => dependencies.sessionsDialog().openSessionNameDialog("create") });
    if (dependencies.navigation().sessions.length > 1) {
      const current = dependencies.navigation().sessions.find((session) => session.id === dependencies.navigation().currentSessionID);
      if (current) {
        commands.push({
          id: "destroy-session",
          label: "Destroy Session...",
          hint: dependencies.navigation().currentSessionName || "delete",
          run: () => dependencies.sessionsDialog().openDestroySessionDialog(current),
        });
      }
    }
    for (const session of dependencies.navigation().sessions) {
      if (session.id !== dependencies.navigation().currentSessionID) {
        commands.push({ label: `Switch Session: ${session.name}`, hint: "session", run: () => void dependencies.navigation().switchSession(session) });
      }
    }
    commands.push({ id: "manage-shortcuts", label: "Shortcuts...", hint: "manage terminal launchers", run: dependencies.navigation().openShortcuts });
    for (const shortcut of dependencies.navigation().shortcutsUI.items) {
      commands.push({ id: `shortcut:${shortcut.id}`, label: `Create ${shortcut.name}`, aliases: [shortcut.name], code: shortcut.code, shortcut: true, hint: "terminal shortcut", run: () => dependencies.navigation().invokeShortcut(shortcut) });
    }
    commands.push({ id: "new-terminal", label: "New Terminal", hint: "create", run: () => dependencies.desktop().createTerminalPane() });
    commands.push({ id: "new-browser", label: "New Browser", hint: "localhost development server", run: () => dependencies.desktop().createBrowserPane() });
    commands.push({ id: "new-vnc", label: "New VNC", hint: "remote desktop", run: () => dependencies.desktop().createVNCPane() });
    commands.push({ id: "new-rdp", label: "New RDP", hint: "Windows remote desktop", run: () => dependencies.desktop().createRDPPane() });
    commands.push({ id: "next-window", label: "Next Window", hint: "Ctrl+]", run: () => dependencies.interactions().focusAdjacentPane(1) });
    commands.push({ id: "previous-window", label: "Previous Window", hint: "Ctrl+[", run: () => dependencies.interactions().focusAdjacentPane(-1) });
    const visiblePaneCount = dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending" && !rect.minimized).length;
    if (visiblePaneCount > 0) {
      commands.push({
        id: "arrange-out",
        label: dependencies.geometry().arrangeOutSnapshot ? "Back Arrange" : "Cascade Arrange",
        hint: "Alt+F7",
        run: () => dependencies.geometry().toggleArrangeWindows(),
      });
    }
    if (dependencies.desktop().rectangles.some((rect) => rect.kind === "terminal" && !rect.minimized && rect.terminal?.term)) {
      commands.push({
        id: "refresh-terminal-size",
        label: "Refresh Terminal Size",
        aliases: ["resize terminal", "fix terminal size", "refit terminals"],
        hint: "fit shells to this screen",
        run: () => dependencies.terminal().refreshTerminalSizes(),
      });
    }
    const dockTarget = dependencies.desktop().getActivePane();
    if (dockTarget) {
      if (dockTarget.kind === "terminal" && dockTarget.terminal?.term) {
        commands.push({
          id: "find-in-terminal",
          label: "Find in Terminal",
          aliases: ["search", "find", "search scrollback"],
          hint: dependencies.interactions().appleKeyboardLayout ? "⌘F" : "Ctrl+Shift+F",
          run: () => dependencies.terminal().openTerminalFind(dockTarget),
        });
        commands.push({
          id: "copy-last-output",
          label: "Copy Last Command Output",
          aliases: ["copy output", "select output"],
          hint: "OSC 133",
          run: () => void dependencies.menus().applyTerminalMenuAction("copy-output", dockTarget),
        });
        commands.push({
          id: "repair-terminal-view",
          label: "Repair Terminal View",
          hint: "refit and repaint",
          run: () => dependencies.terminal().repairTerminalView(dockTarget),
        });
      }
      commands.push({
        id: "rename-window",
        label: "Set Window Title...",
        aliases: ["rename", "rename window"],
        hint: "Ctrl+T",
        run: () => dependencies.desktop().openRenameWindowModal(dockTarget),
      });
      commands.push({
        id: "maximize-toggle",
        label: dockTarget.isFull ? "Restore Window" : "Maximize Window",
        hint: "Alt+F10",
        run: () => dependencies.geometry().toggleFullRestore(dockTarget),
      });
      commands.push({
        id: "minimize-toggle",
        label: dockTarget.minimized ? "Restore Window" : "Minimize Window",
        hint: "Alt+F9",
        run: () => dependencies.geometry().toggleMinimize(dockTarget),
      });
      for (const [action, id, label] of [["top", "dock-top", "Dock Top"], ["left", "dock-left", "Dock Left"], ["right", "dock-right", "Dock Right"], ["bottom", "dock-bottom", "Dock Bottom"]]) {
        commands.push({
          id,
          label,
          hint: dockTarget.title,
          run: () => dependencies.geometry().applyDockAction(action, dockTarget),
        });
      }
      commands.push({ id: "destroy-window", label: "Destroy Window", aliases: ["close", "close window"], hint: dockTarget.title, run: () => dependencies.geometry().destroyActivePane() });
    }
    commands.push({ id: "local-https", label: "Local HTTPS...", hint: "server and iPad certificates", run: () => void dependencies.https().openLocalHTTPSModal() });
    commands.push({ id: "update-server", label: "Update Server", hint: "server", run: () => void dependencies.connectivity().runServerUpdate() });
    if (dependencies.navigation().authMode !== "off") {
      commands.push({ id: "sign-out", label: "Sign Out", aliases: ["log out", "logout"], hint: dependencies.navigation().signedInAccount || "account", run: () => void dependencies.navigation().signOutOfTessera() });
    }
    if (dependencies.navigation().multiUser && dependencies.navigation().authMode !== "file") {
      for (const name of dependencies.navigation().userRoster) {
        if (name !== dependencies.navigation().currentUser) {
          commands.push({ label: `Switch user: ${name}`, hint: "user", run: () => void dependencies.navigation().jumpToUser(name) });
        }
      }
    }
    const panes = dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending");
    for (const rect of panes) {
      commands.push({
        label: dependencies.menus().workspaceMenuLabel(rect),
        hint: rect.minimized ? "window, minimized" : "window",
        run: () => {
          dependencies.geometry().setMinimized(rect, false);
          dependencies.desktop().setActivePane(rect, { raise: true, focus: true });
        },
      });
    }
    return commands;
  }

  // Stamps each command with its fixed code (or none, for dynamic entries).
  function assignPaletteShortcutCodes(commands) {
    for (const command of commands) {
      command.code = command.shortcut ? command.code : command.id ? feature.paletteShortcutCodes[command.id] || null : null;
    }
  }

  function findPaletteCodeMatch(query, commands) {
    const typedCode = query.trim().toUpperCase();
    return /^[A-Z]{1,2}$/.test(typedCode)
      ? commands.find((command) => command.code === typedCode) || null
      : null;
  }

  // Substring matches rank above in-order subsequence matches ("fuzzy"), and
  // earlier/tighter matches rank higher within each class.
  function paletteScore(query, label) {
    if (!query) {
      return 1;
    }
    const q = query.toLowerCase();
    const text = label.toLowerCase();
    const index = text.indexOf(q);
    if (index >= 0) {
      return 1000 - index;
    }
    let searchFrom = 0;
    let gaps = 0;
    for (const ch of q) {
      const found = text.indexOf(ch, searchFrom);
      if (found < 0) {
        return -1;
      }
      gaps += found - searchFrom;
      searchFrom = found + 1;
    }
    return 500 - gaps;
  }

  function renderPaletteResults() {
    const rawQuery = feature.commandPaletteInput.value;
    const query = rawQuery.trim();
    const allCommands = feature.buildPaletteCommands();
    feature.assignPaletteShortcutCodes(allCommands);

    // Exact codes rank first even when their letters don't match the label.
    // Typing only selects results; Enter or a click runs the selected command.
    const codeMatch = feature.findPaletteCodeMatch(query, allCommands);

    feature.paletteEntries = allCommands
      .map((command) => ({ command, score: command === codeMatch ? 2000 : Math.max(
        feature.paletteScore(query, command.label),
        ...(command.aliases || []).map(alias => feature.paletteScore(query, alias)),
      ) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.command);
    feature.paletteSelection = 0;

    feature.commandPaletteList.replaceChildren();
    if (feature.paletteEntries.length === 0) {
      const empty = platform.document.createElement("div");
      empty.className = "command-palette-empty";
      empty.textContent = "No matching commands";
      feature.commandPaletteList.appendChild(empty);
      return;
    }
    feature.paletteEntries.forEach((command, index) => {
      const row = platform.document.createElement("button");
      row.type = "button";
      row.className = "command-palette-item";
      if (index === feature.paletteSelection) {
        row.classList.add("is-selected");
      }
      const label = platform.document.createElement("span");
      label.textContent = command.label;
      const meta = platform.document.createElement("span");
      meta.className = "command-palette-item-meta";
      if (command.code) {
        const code = platform.document.createElement("span");
        code.className = "command-palette-code";
        code.textContent = command.code;
        meta.appendChild(code);
      }
      const hint = platform.document.createElement("span");
      hint.className = "command-palette-hint";
      hint.textContent = command.hint;
      meta.appendChild(hint);
      row.appendChild(label);
      row.appendChild(meta);
      row.addEventListener("pointermove", () => feature.setPaletteSelection(index));
      row.addEventListener("click", () => feature.runPaletteCommand(command));
      feature.commandPaletteList.appendChild(row);
    });
  }

  function handlePaletteKeyboard(event) {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      feature.movePaletteSelection(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      feature.runPaletteSelection();
    }
  }

  function setPaletteSelection(index) {
    feature.paletteSelection = index;
    const rows = feature.commandPaletteList.querySelectorAll(".command-palette-item");
    rows.forEach((row, rowIndex) => {
      row.classList.toggle("is-selected", rowIndex === index);
    });
  }

  function movePaletteSelection(direction) {
    if (feature.paletteEntries.length === 0) {
      return;
    }
    const next = (feature.paletteSelection + direction + feature.paletteEntries.length) % feature.paletteEntries.length;
    feature.setPaletteSelection(next);
    feature.commandPaletteList.querySelectorAll(".command-palette-item")[next]?.scrollIntoView({ block: "nearest" });
  }

  function runPaletteSelection() {
    const command = feature.paletteEntries[feature.paletteSelection];
    if (command) {
      feature.runPaletteCommand(command);
    }
  }

  function runPaletteCommand(command) {
    feature.hideCommandPalette();
    command.run();
  }

  function initializeCommandPalette() {
    feature.commandPalette = platform.document.createElement("div");
    feature.commandPalette.className = "command-palette";
    feature.commandPalette.hidden = true;
    feature.commandPalettePanel = platform.document.createElement("div");
    feature.commandPalettePanel.className = "command-palette-panel";
    feature.commandPaletteInput = platform.document.createElement("input");
    feature.commandPaletteInput.className = "command-palette-input";
    feature.commandPaletteInput.type = "text";
    feature.commandPaletteInput.placeholder = "Command, shortcut, or window name · Enter to run";
    feature.commandPaletteInput.autocomplete = "off";
    feature.commandPaletteInput.setAttribute("autocorrect", "off");
    feature.commandPaletteInput.setAttribute("writingsuggestions", "false");
    feature.commandPaletteInput.spellcheck = false;
    feature.commandPaletteInput.setAttribute("aria-label", "Command palette");
    feature.commandPaletteList = platform.document.createElement("div");
    feature.commandPaletteList.className = "command-palette-list";
    feature.commandPalettePanel.appendChild(feature.commandPaletteInput);
    feature.commandPalettePanel.appendChild(feature.commandPaletteList);
    feature.commandPalette.appendChild(feature.commandPalettePanel);
    platform.document.body.appendChild(feature.commandPalette);
    feature.commandPalette.addEventListener("pointerdown", (event) => {
      if (event.target === feature.commandPalette) {
        feature.hideCommandPalette();
      }
    });
    feature.commandPaletteInput.addEventListener("input", () => feature.renderPaletteResults());
    feature.commandPaletteInput.addEventListener("keydown", feature.handlePaletteKeyboard);
  }

  function initializePaletteLauncher() {
    feature.paletteLauncher = platform.document.createElement("button");
    feature.paletteLauncher.type = "button";
    feature.paletteLauncher.className = "palette-fab";
    feature.paletteLauncher.textContent = "≡";
    feature.paletteLauncher.title = "Commands (Ctrl+K)";
    feature.paletteLauncher.setAttribute("aria-label", "Open command palette");
    feature.paletteLauncher.addEventListener("click", () => feature.openCommandPalette());
    platform.document.body.appendChild(feature.paletteLauncher);
  }

  function initializePaletteEntries() {
    feature.paletteEntries = [];
    feature.paletteSelection = 0;
  }

  function initializePaletteShortcutCodes() {
    // Fixed, hand-picked codes for the static commands (identified by
    // `id`, since a toggle command's label changes but its code shouldn't).
    // Dynamic per-window/per-user entries have no `id` and so show no code —
    // a "fixed set" can't cover an unbounded, runtime-dependent list.
    feature.paletteShortcutCodes = {
      "help": "HP",
      "browse-local-port-help": "BL",
      "new-terminal": "NN",
      "repair-terminal-view": "RV",
      "new-browser": "NB",
      "new-vnc": "NV",
      "new-rdp": "NR",
      "manage-shortcuts": "CS",
      "next-window": "NX",
      "previous-window": "PW",
      "arrange-out": "OO",
      "maximize-toggle": "MM",
      "minimize-toggle": "MN",
      "dock-top": "DT",
      "dock-left": "DL",
      "dock-right": "DR",
      "dock-bottom": "DB",
      "destroy-window": "DD",
      "rename-window": "WT",
      "deskbar-button-toggle": "HB",
      "settings": "S",
      "sessions": "TS",
      "local-https": "LH",
      "update-server": "UP",
    };
  }

  Object.assign(feature, {
    toggleCommandPalette,
    openCommandPalette,
    hideCommandPalette,
    buildPaletteCommands,
    assignPaletteShortcutCodes,
    findPaletteCodeMatch,
    paletteScore,
    renderPaletteResults,
    handlePaletteKeyboard,
    setPaletteSelection,
    movePaletteSelection,
    runPaletteSelection,
    runPaletteCommand,
    initializeCommandPalette,
    initializePaletteLauncher,
    initializePaletteEntries,
    initializePaletteShortcutCodes,
  });
  return feature;
}
