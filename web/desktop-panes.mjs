import { terminalColorModes } from "./terminal-colors.mjs";
import { normalizeBrowserAddress } from "./browser-pane.mjs";
import { normalizeVNCScaleMode } from "./vnc-pane.mjs";
import { normalizeRDPResolution, normalizeRDPScaleMode } from "./rdp-pane.mjs";
import { focusPane, paneNeedsRaise } from "./pane-activation.mjs";
import { terminalAttentionLabel } from "./terminal-attention.mjs";

// Pane identity, mounting, selection, titles, font sizes and destruction.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   browser: () => ReturnType<typeof import("./browser-view.mjs").createBrowser>,
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   directory: () => ReturnType<typeof import("./directory-dialog.mjs").createDirectory>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   rdp: () => ReturnType<typeof import("./rdp-session.mjs").createRdp>,
 *   rdpView: () => ReturnType<typeof import("./rdp-view.mjs").createRdpView>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   vnc: () => ReturnType<typeof import("./vnc-view.mjs").createVnc>,
 *   windows: () => ReturnType<typeof import("./window-list-view.mjs").createWindows>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createDesktop(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    board: undefined,
    tabHeight: undefined,
    rectangles: undefined,
    activeRect: undefined,
    activePaneID: undefined,
    nextZIndex: undefined,
    renameWindowModal: undefined,
  };

  function createRectangle(x, y, width, height, options = {}) {
    if (["file-browser", "worksheet", "text-editor"].includes(options.kind)) options = { ...options, kind: "terminal" };
    const element = platform.document.createElement("div");
    element.className = "rectangle";
    element.dataset.paneId = options.id || "";
    element.tabIndex = -1;
    element.addEventListener("pointerdown", (event) => {
      if (event.target === element) {
        dependencies.interactions().startMoving(event, rect);
      }
    });

    const rect = {
      id: options.id || feature.newPaneID(),
      kind: options.kind || "terminal",
      x,
      y,
      width,
      height,
      element,
      zIndex: options.zIndex || 0,
      title: options.title || feature.defaultPaneTitle(options.kind || "terminal"),
      // Archived documents from retired panes stay opaque and survive layout saves.
      archivedContent: {
        bufferText: options.text || "",
        editorTabs: options.editorTabs || "",
        editorMode: options.editorMode || "",
        lastExportPath: options.lastExportPath || "",
      },
      fontSize: feature.normalizePaneFontSize(options.fontSize),
      terminalColorMode: Object.hasOwn(terminalColorModes, options.terminalColorMode) ? options.terminalColorMode : "",
      cwd: options.cwd || "",
      oledMoveMode: false,
      terminal: null,
      terminalContainer: null,
      terminalStatusBadge: null,
      terminalStatus: null,
      terminalStatusTimer: null,
      terminalStartupCommand: options.terminalStartupCommand || "",
      body: null,
      titleInput: null,
      fontSizeValue: null,
      fontSizeDecreaseButton: null,
      fontSizeIncreaseButton: null,
      fontSizeIndicator: null,
      fontSizeIndicatorTimer: null,
      browserStatusInput: null,
      browserUrl: options.browserUrl || "",
      browser: null,
      browserRequestID: 0,
      vncTarget: options.vncTarget || "",
      vncViewOnly: Boolean(options.vncViewOnly),
      vncScaleMode: normalizeVNCScaleMode(options.vncScaleMode),
      vnc: null,
      rdpTarget: options.rdpTarget || "",
      rdpUsername: options.rdpUsername || "",
      rdpDomain: options.rdpDomain || "",
      rdpScaleMode: normalizeRDPScaleMode(options.rdpScaleMode),
      rdpTrustedTarget: options.rdpTrustedTarget || "",
      rdpTrustedFingerprint: options.rdpTrustedFingerprint || "",
      rdpFullSize: Boolean(options.rdpFullSize),
      rdpWiggle: Boolean(options.rdpWiggle),
      rdpWiggleAlways: Boolean(options.rdpWiggleAlways),
      rdpResolution: normalizeRDPResolution(options.rdpResolution),
      rdp: null,
      isFull: Boolean(options.isFull),
      minimized: Boolean(options.minimized),
      restoreBox: options.restoreBox || null,
      minButton: null,
      maxButton: null,
    };
    element.dataset.paneId = rect.id;
    element.addEventListener("lostpointercapture", (event) => {
      if (dependencies.interactions().interaction?.rect === rect && dependencies.interactions().interaction.id === event.pointerId) {
        dependencies.interactions().finishInteraction({ pointerId: event.pointerId, type: "pointercancel" });
      }
    });
    element.dataset.paneKind = rect.kind;
    element.dataset.oledMoveMode = "false";
    element.classList.toggle("is-full", rect.isFull);
    element.classList.toggle("is-minimized", rect.minimized);
    if (rect.minimized) {
      element.setAttribute("aria-hidden", "true");
    }

    function toggleFromTitleBar(event) {
      event.preventDefault();
      event.stopPropagation();
      dependencies.menus().hideFloatingMenus();
      dependencies.geometry().toggleFullRestore(rect);
    }

    const tab = platform.document.createElement("div");
    tab.className = "window-tab";
    tab.addEventListener("pointerdown", (event) => {
      if (event.target === title && !title.readOnly) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dependencies.interactions().startMoving(event, rect, tab);
    });
    tab.addEventListener("dblclick", (event) => {
      if (event.button !== 0 || controls.contains(event.target)) {
        return;
      }
      if (event.target === title && !title.readOnly) {
        return;
      }
      toggleFromTitleBar(event);
    }, { capture: true });

    const grip = platform.document.createElement("div");
    grip.className = "window-grip";
    grip.addEventListener("pointerdown", (event) => {
      if (dependencies.preferences().themeID === "operator") return; // The dotted grip drags; right-click still opens the window menu.
      if (event.button === 0) {
        // Keep the menu below the grip so a second click still lands on the
        // title bar and can complete a double-click.
        dependencies.menus().openDockMenu(event, rect, feature.tabHeight);
      }
    });
    grip.addEventListener("contextmenu", (event) => dependencies.menus().openDockMenu(event, rect));

    const title = platform.document.createElement("input");
    title.className = "window-title";
    title.type = "text";
    title.value = rect.title;
    title.readOnly = true;
    title.spellcheck = false;
    title.setAttribute("writingsuggestions", "false");
    title.setAttribute("aria-label", "Window title");
    rect.titleInput = title;
    title.addEventListener("pointerdown", (event) => {
      if (!title.readOnly) {
        event.stopPropagation();
        dependencies.menus().hideFloatingMenus();
        feature.setActivePane(rect, { raise: true });
      }
    });
    title.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      feature.startTitleRename(rect, title);
    });
    title.addEventListener("blur", () => {
      title.readOnly = true;
      title.classList.remove("is-renaming");
    });
    title.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        title.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        title.value = rect.title;
        title.blur();
      }
    });
    title.addEventListener("input", () => {
      rect.title = title.value;
      rect.ownTitle = undefined;
      dependencies.deskbar().updateDeskbar();
      dependencies.workspace().scheduleWorkspaceSave();
    });

    const controls = platform.document.createElement("div");
    controls.className = "window-controls";
    const minButton = platform.document.createElement("button");
    minButton.type = "button";
    minButton.className = "window-control window-control-min";
    const maxButton = platform.document.createElement("button");
    maxButton.type = "button";
    maxButton.className = "window-control window-control-max";
    const closeButton = platform.document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "window-control window-control-close";
    closeButton.dataset.glyph = "close";
    closeButton.title = "Close";
    closeButton.setAttribute("aria-label", "Close window");
    rect.minButton = minButton;
    rect.maxButton = maxButton;
    for (const [button, run] of [[minButton, () => dependencies.geometry().toggleMinimize(rect)], [maxButton, () => dependencies.geometry().toggleFullRestore(rect)], [closeButton, () => dependencies.geometry().closeWindowFromTitleBar(rect)]]) {
      // Keep clicks on the buttons from starting a tab drag or triggering the
      // tab's double-click (maximize) handler.
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("dblclick", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        run();
      });
    }
    controls.appendChild(minButton);
    controls.appendChild(maxButton);
    controls.appendChild(closeButton);

    const status = platform.document.createElement("div");
    status.className = "window-status";

    const fontSizeControl = platform.document.createElement("div");
    fontSizeControl.className = "window-font-size";
    fontSizeControl.setAttribute("aria-label", "Font size");
    const fontSizeDecreaseButton = platform.document.createElement("button");
    fontSizeDecreaseButton.className = "window-font-size-button";
    fontSizeDecreaseButton.type = "button";
    fontSizeDecreaseButton.textContent = "A−";
    fontSizeDecreaseButton.title = "Decrease font size";
    fontSizeDecreaseButton.setAttribute("aria-label", "Decrease font size");
    const fontSizeValue = platform.document.createElement("output");
    fontSizeValue.className = "window-font-size-value";
    const fontSizeIncreaseButton = platform.document.createElement("button");
    fontSizeIncreaseButton.className = "window-font-size-button";
    fontSizeIncreaseButton.type = "button";
    fontSizeIncreaseButton.textContent = "A+";
    fontSizeIncreaseButton.title = "Increase font size";
    fontSizeIncreaseButton.setAttribute("aria-label", "Increase font size");
    for (const [button, delta] of [[fontSizeDecreaseButton, -1], [fontSizeIncreaseButton, 1]]) {
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        feature.setPaneFontSize(rect, rect.fontSize + delta);
      });
    }
    fontSizeControl.append(fontSizeDecreaseButton, fontSizeValue, fontSizeIncreaseButton);
    rect.fontSizeValue = fontSizeValue;
    rect.fontSizeDecreaseButton = fontSizeDecreaseButton;
    rect.fontSizeIncreaseButton = fontSizeIncreaseButton;

    const cwdLabel = platform.document.createElement("span");
    cwdLabel.className = "window-status-label";
    cwdLabel.textContent =  rect.kind === dependencies.browser().browserPaneKind
          ? "url"
        : rect.kind === dependencies.vnc().vncPaneKind || rect.kind === dependencies.rdp().rdpPaneKind
          ? "target"
        : "cwd";

    const cwdInput = platform.document.createElement("input");
    cwdInput.className = "window-cwd";
    cwdInput.type = "text";
    cwdInput.value =  rect.kind === dependencies.browser().browserPaneKind
        ? rect.browserUrl
      : rect.kind === dependencies.vnc().vncPaneKind
        ? rect.vncTarget
      : rect.kind === dependencies.rdp().rdpPaneKind
        ? rect.rdpTarget
        : rect.cwd;
    cwdInput.placeholder =  rect.kind === dependencies.browser().browserPaneKind
          ? "localhost:8080"
        : rect.kind === dependencies.vnc().vncPaneKind
          ? "host:5900"
        : rect.kind === dependencies.rdp().rdpPaneKind
          ? "host:3389"
        : "host default";
    cwdInput.readOnly = true;
    cwdInput.spellcheck = false;
    cwdInput.setAttribute("aria-label",  rect.kind === dependencies.browser().browserPaneKind
          ? "Browser address"
        : rect.kind === dependencies.vnc().vncPaneKind
          ? "VNC target"
        : rect.kind === dependencies.rdp().rdpPaneKind
          ? "RDP target"
        : "Pane working directory");
    cwdInput.addEventListener("pointerdown", (event) => {
      if (rect.kind === dependencies.browser().browserPaneKind || rect.kind === dependencies.vnc().vncPaneKind || rect.kind === dependencies.rdp().rdpPaneKind) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dependencies.menus().hideFloatingMenus();
      feature.setActivePane(rect, { raise: true });
      dependencies.directory().openDirectoryBrowser(rect, rect.cwd);
    });
    cwdInput.addEventListener("keydown", (event) => {
      if (rect.kind === dependencies.browser().browserPaneKind || rect.kind === dependencies.vnc().vncPaneKind || rect.kind === dependencies.rdp().rdpPaneKind) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        feature.setActivePane(rect, { raise: true });
        dependencies.directory().openDirectoryBrowser(rect, rect.cwd);
      }
    });
    cwdInput.addEventListener("input", () => {
      feature.setPaneCwd(rect, cwdInput.value, { fromField: true });
    });

    const body = platform.document.createElement("div");
    body.className = "window-body";
    rect.body = body;
    body.setAttribute("aria-label", rect.kind === "terminal"
      ? "Terminal"
      : rect.kind === dependencies.browser().browserPaneKind
          ? "Browser"
        : rect.kind === dependencies.vnc().vncPaneKind
          ? "VNC remote desktop"
        : rect.kind === dependencies.rdp().rdpPaneKind
          ? "RDP remote desktop"
        : rect.kind === "pending"
          ? "New window"
          : "Terminal");
    body.addEventListener("pointerdown", () => {
      dependencies.menus().hideFloatingMenus();
    }, { capture: true });
    // A right-click on an OLED border arms this explicit move mode. Keep it
    // ahead of terminal mouse reporting.
    body.addEventListener("pointerdown", (event) => {
      if (dependencies.preferences().themeID === "oled-terminal" && rect.oledMoveMode && event.button === 0) {
        dependencies.interactions().startMoving(event, rect);
      }
    }, { capture: true });
    body.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      feature.setActivePane(rect, { raise: true });
      if (rect.kind === "terminal") {
        dependencies.terminal().claimTerminalSize(rect);
        rect.terminal?.term?.focus();
      }
    });
    body.addEventListener("focusin", () => feature.setActivePane(rect, { raise: true }));

    tab.appendChild(grip);
    const attention = platform.document.createElement("span");
    attention.className = "window-attention";
    attention.hidden = true;
    rect.attentionMark = attention;
    tab.appendChild(attention);
    const progress = platform.document.createElement("div");
    progress.className = "window-progress";
    progress.hidden = true;
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.appendChild(platform.document.createElement("div")).className = "window-progress-bar";
    rect.progressBar = progress;
    tab.appendChild(progress);
    tab.appendChild(title);
    tab.appendChild(controls);
    feature.updateWindowControls(rect);
    if (rect.kind === "terminal") {
      status.appendChild(fontSizeControl);
      feature.updatePaneFontSizeUI(rect);
    }
    status.appendChild(cwdLabel);
    status.appendChild(cwdInput);
    element.appendChild(tab);
    element.appendChild(body);
    element.appendChild(status);
    if (rect.kind === dependencies.browser().browserPaneKind) {
      rect.browserStatusInput = cwdInput;
    } else if (rect.kind === dependencies.vnc().vncPaneKind) {
      rect.vncStatusInput = cwdInput;
    } else if (rect.kind === dependencies.rdp().rdpPaneKind) {
      rect.rdpStatusInput = cwdInput;
    } else if (rect.kind !== dependencies.browser().browserPaneKind) {
      rect.cwdInput = cwdInput;
    }
    feature.setPaneCwd(rect, rect.cwd, { silent: true });

    if (rect.kind === "terminal") {
      body.classList.add("is-terminal");
      const terminalContainer = platform.document.createElement("div");
      terminalContainer.className = "terminal-container";
      // Ghostty makes this surface editable for keyboard input. Browser writing
      // assistants must not treat its painted output as a prose text field.
      terminalContainer.spellcheck = false;
      terminalContainer.setAttribute("writingsuggestions", "false");
      terminalContainer.setAttribute("autocorrect", "off");
      terminalContainer.setAttribute("autocapitalize", "off");
      body.appendChild(terminalContainer);
      rect.terminalContainer = terminalContainer;
      void dependencies.terminal().startTerminal(rect);
    } else if (rect.kind === dependencies.browser().browserPaneKind) {
      dependencies.browser().mountBrowserPane(rect);
    } else if (rect.kind === dependencies.vnc().vncPaneKind) {
      dependencies.vnc().mountVNCPane(rect);
    } else if (rect.kind === dependencies.rdp().rdpPaneKind) {
      dependencies.rdpView().mountRDPPane(rect);
    } else {
      body.classList.add("is-pending");
    }

    const resizeTargets = [
      ["nw", "corner"],
      ["ne", "corner"],
      ["se", "corner"],
      ["sw", "corner"],
      ["n", "edge"],
      ["e", "edge"],
      ["w", "edge"],
      ["s", "edge"],
    ];
    for (const [handle, kind] of resizeTargets) {
      const node = platform.document.createElement("div");
      node.className = kind === "edge" ? `resize-edge resize-edge-${handle}` : `resize-handle handle-${handle}`;
      node.addEventListener("pointerdown", (event) => dependencies.interactions().startResizing(event, rect, handle));
      node.addEventListener("contextmenu", (event) => {
        if (dependencies.preferences().themeID !== "oled-terminal") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        feature.setActivePane(rect, { raise: true });
        dependencies.interactions().setOLEDMoveMode(rect, !rect.oledMoveMode);
      });
      element.appendChild(node);
    }

    feature.rectangles.push(rect);
    feature.board.appendChild(element);
    dependencies.geometry().setRectangle(rect, rect);
    if (rect.isFull) {
      // A pane loaded already-maximized fills whatever board it's on now,
      // not the literal size it was saved at (which may be from a different
      // screen entirely).
      dependencies.geometry().applyFullGeometry(rect);
    }
    rect.element.style.zIndex = String(rect.zIndex);
    feature.nextZIndex = Math.max(feature.nextZIndex, rect.zIndex + 1);
    dependencies.deskbar().updateDeskbar();
    return rect;
  }

  function startTitleRename(rect, title) {
    dependencies.menus().hideFloatingMenus();
    feature.setActivePane(rect, { raise: true });
    title.readOnly = false;
    title.classList.add("is-renaming");
    title.focus({ preventScroll: true });
    title.select();
    platform.requestAnimationFrame(() => {
      if (platform.document.activeElement === title && !title.readOnly) {
        title.select();
      }
    });
  }

  function normalizePaneFontSize(fontSize) {
    const parsed = Number(fontSize);
    if (!Number.isFinite(parsed)) {
      return dependencies.preferences().defaultPaneFontSize;
    }
    return Math.max(dependencies.preferences().minimumPaneFontSize, Math.min(dependencies.preferences().maximumPaneFontSize, Math.round(parsed)));
  }

  function setPaneFontSize(rect, fontSize) {
    if (!rect || (rect.kind !== "terminal")) {
      return;
    }
    rect.fontSize = feature.normalizePaneFontSize(fontSize);
    feature.updatePaneFontSizeUI(rect);
    if (rect.kind === "terminal" && rect.terminal?.term) {
      rect.terminal.term.options.fontSize = rect.fontSize;
      dependencies.terminal().requestTerminalFit(rect);
    } else {
    }
    dependencies.workspace().scheduleWorkspaceSave();
  }

  function adjustActivePaneFontSize(delta) {
    const rect = feature.getActivePane();
    if (rect) {
      feature.setPaneFontSize(rect, rect.fontSize + delta);
      feature.showPaneFontSizeIndicator(rect);
    }
  }

  function resetActivePaneFontSize() {
    const rect = feature.getActivePane();
    if (rect) {
      feature.setPaneFontSize(rect, dependencies.preferences().defaultPaneFontSize);
      feature.showPaneFontSizeIndicator(rect);
    }
  }

  function showPaneFontSizeIndicator(rect) {
    if (!rect.body || (rect.kind !== "terminal")) {
      return;
    }
    if (rect.fontSizeIndicator?.parentElement !== rect.body) {
      const indicator = platform.document.createElement("div");
      indicator.className = "window-font-size-indicator";
      indicator.setAttribute("role", "status");
      indicator.setAttribute("aria-atomic", "true");
      rect.body.appendChild(indicator);
      rect.fontSizeIndicator = indicator;
    }
    const indicator = rect.fontSizeIndicator;
    const percentage = Math.round(rect.fontSize / dependencies.preferences().defaultPaneFontSize * 100);
    indicator.setAttribute("aria-hidden", "false");
    indicator.textContent = `Text size ${percentage}%`;
    indicator.classList.add("is-visible");
    platform.window.clearTimeout(rect.fontSizeIndicatorTimer);
    rect.fontSizeIndicatorTimer = platform.window.setTimeout(() => {
      indicator.classList.remove("is-visible");
      indicator.setAttribute("aria-hidden", "true");
      rect.fontSizeIndicatorTimer = null;
    }, 1200);
  }

  function updatePaneFontSizeUI(rect) {
    if (!rect) {
      return;
    }
    rect.fontSize = feature.normalizePaneFontSize(rect.fontSize);
    if (rect.fontSizeValue) {
      rect.fontSizeValue.value = String(rect.fontSize);
      rect.fontSizeValue.textContent = `${rect.fontSize}px`;
    }
    if (rect.fontSizeDecreaseButton) {
      rect.fontSizeDecreaseButton.disabled = rect.fontSize <= dependencies.preferences().minimumPaneFontSize;
    }
    if (rect.fontSizeIncreaseButton) {
      rect.fontSizeIncreaseButton.disabled = rect.fontSize >= dependencies.preferences().maximumPaneFontSize;
    }
  }

  function setActivePane(rect, options = {}) {
    if (!rect || !feature.rectangles.includes(rect)) {
      feature.clearActivePane();
      return;
    }
    const wasActive = feature.activePaneID === rect.id;
    const needsRaise = Boolean(options.raise) && paneNeedsRaise(feature.rectangles, rect);
    if (wasActive && !needsRaise) {
      if (options.focus) {
        focusPane(rect);
      } else if (options.focusElement) {
        rect.element.focus({ preventScroll: true });
      }
      return;
    }
    feature.clearActivePaneClass();
    feature.activeRect = rect;
    feature.activePaneID = rect.id;
    feature.board.dataset.activePaneId = feature.activePaneID;
    rect.element.dataset.activePane = "true";
    rect.element.classList.add("is-selected");
    dependencies.terminal().setTerminalCursorBlink(rect, true);
    if (needsRaise) {
      rect.zIndex = feature.nextZIndex;
      feature.nextZIndex += 1;
      rect.element.style.zIndex = String(rect.zIndex);
      dependencies.terminal().scheduleTerminalVisibilityUpdate();
    }
    if (options.focus) {
      focusPane(rect);
    } else if (options.focusElement) {
      rect.element.focus({ preventScroll: true });
    }
    if ((!wasActive || needsRaise) && options.save !== false) {
      dependencies.workspace().scheduleWorkspaceSave();
    }
    dependencies.deskbar().updateDeskbar();
    dependencies.terminal().updateTerminalFocus();
  }

  function applyTerminalWindowTitle(rect, title) {
    if (rect.kind !== "terminal" || !feature.rectangles.includes(rect)) return;
    // A program can keep reporting titles while the user types a custom name.
    if (!rect.titleInput.readOnly || (!feature.renameWindowModal.hidden && feature.renameWindowModal.dataset.paneId === rect.id)) return;
    if (!title.trim()) {
      // The program's title is gone: popped off the title stack (CSI 23 t) to
      // none, as when Vim exits, or cleared by a reset. The pane gets back the
      // name it had before programs titled it, if this page saw that name.
      if (rect.ownTitle === undefined) return;
      title = rect.ownTitle;
      rect.ownTitle = undefined;
    } else if (rect.ownTitle === undefined) {
      rect.ownTitle = rect.title;
    }
    if (title === rect.title) return;
    rect.title = title;
    rect.titleInput.value = title;
    // Programs animate their titles (Claude Code spins one several times a
    // second), so this neither saves nor rebuilds the open window lists: a
    // save per frame never lets autosave settle and races other browsers into
    // conflicts, and a rebuilt list swaps its buttons out from under a click.
    // The shared terminal core retains the title for the next attachment, and
    // the next save of anything else carries it along.
    feature.updatePaneTitleLabels(rect);
  }

  // Rewrites a pane's name wherever an open list already shows it.
  function updatePaneTitleLabels(rect) {
    const suffix = `${rect.minimized ? " (minimized)" : ""}${terminalAttentionLabel(rect.terminalAttention)}`;
    if (!dependencies.switcher().windowSwitcher.hidden) {
      for (const row of dependencies.switcher().windowSwitcherList.children) {
        if (row.dataset.paneId === rect.id) {
          row.querySelector(".window-switcher-name").textContent = `${rect.title.trim()}${suffix}`;
        }
      }
    }
    if (!dependencies.deskbar().deskbarPanel.hidden) {
      for (const row of dependencies.deskbar().deskbarPanel.querySelectorAll(".workspace-menu-row")) {
        if (row.dataset.paneId !== rect.id) continue;
        const button = row.querySelector(".workspace-menu-name");
        button.textContent = dependencies.menus().workspaceMenuLabel(rect);
        button.title = rect.cwd ? `${button.textContent} (${rect.cwd})` : button.textContent;
      }
    }
    if (!dependencies.windows().windowList.hidden) {
      const index = dependencies.windows().windowListEntries.indexOf(rect);
      for (const row of dependencies.windows().windowListItems.querySelectorAll(".window-list-item")) {
        if (row.dataset.paneId !== rect.id) continue;
        const name = row.querySelector(".window-list-name");
        name.textContent = `${index + 1}. ${dependencies.menus().workspaceMenuLabel(rect)}${suffix}`;
        name.setAttribute("aria-label", name.textContent);
        for (const move of row.querySelectorAll(".window-list-move")) {
          move.setAttribute("aria-label", `Move ${dependencies.menus().workspaceMenuLabel(rect)} ${move.dataset.windowListAction}`);
        }
      }
    }
  }

  function openRenameWindowModal(rect) {
    if (!rect || !feature.rectangles.includes(rect)) {
      return;
    }
    dependencies.menus().hideAllMenus();
    feature.renameWindowModal.replaceChildren();
    feature.renameWindowModal.dataset.paneId = rect.id;

    const panel = platform.document.createElement("section");
    panel.className = "settings-panel rename-window-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "rename-window-title");

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "rename-window-title";
    title.textContent = "Set Window Title";
    titleBar.appendChild(title);

    const content = platform.document.createElement("div");
    content.className = "settings-content rename-window-content";
    const label = platform.document.createElement("label");
    label.htmlFor = "rename-window-input";
    label.textContent = "Window title";
    const input = platform.document.createElement("input");
    input.id = "rename-window-input";
    input.className = "rename-window-input";
    input.type = "text";
    input.value = rect.title;
    input.spellcheck = false;

    const actions = platform.document.createElement("div");
    actions.className = "rename-window-actions";
    const cancelButton = platform.document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "settings-background-button";
    cancelButton.textContent = "Cancel";
    const renameButton = platform.document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "settings-background-button";
    renameButton.textContent = "Set Title";

    const save = () => {
      if (!feature.rectangles.includes(rect)) {
        feature.hideRenameWindowModal();
        return;
      }
      rect.title = input.value;
      rect.ownTitle = undefined;
      rect.titleInput.value = rect.title;
      dependencies.deskbar().updateDeskbar();
      dependencies.workspace().scheduleWorkspaceSave();
      feature.hideRenameWindowModal();
      feature.setActivePane(rect, { raise: true, focus: true });
    };
    cancelButton.addEventListener("click", feature.hideRenameWindowModal);
    renameButton.addEventListener("click", save);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        feature.hideRenameWindowModal();
      }
    });

    actions.append(cancelButton, renameButton);
    content.append(label, input, actions);
    panel.append(titleBar, content);
    feature.renameWindowModal.appendChild(panel);
    feature.renameWindowModal.hidden = false;
    input.focus();
    input.select();
  }

  function hideRenameWindowModal() {
    feature.renameWindowModal.hidden = true;
    feature.renameWindowModal.replaceChildren();
  }

  function clearActivePane() {
    feature.clearActivePaneClass();
    feature.activeRect = null;
    feature.activePaneID = "";
    delete feature.board.dataset.activePaneId;
    dependencies.workspace().scheduleWorkspaceSave();
    dependencies.deskbar().updateDeskbar();
    dependencies.terminal().updateTerminalFocus();
  }

  function clearActivePaneClass() {
    if (feature.activeRect) {
      feature.activeRect.element.classList.remove("is-selected");
      delete feature.activeRect.element.dataset.activePane;
      dependencies.terminal().setTerminalCursorBlink(feature.activeRect, false);
    }
  }

  function getActivePane() {
    return feature.rectangles.find((rect) => rect.id === feature.activePaneID) || null;
  }

  function setPaneCwd(rect, cwd, options = {}) {
    if (!rect) {
      return;
    }
    const nextCwd = cwd || "";
    const changed = rect.cwd !== nextCwd;
    rect.cwd = nextCwd;
    rect.element.dataset.cwd = nextCwd;
    if (rect.cwdInput && !options.fromField) {
      rect.cwdInput.value = nextCwd;
    }
    if (rect.cwdInput) {
      rect.cwdInput.title = nextCwd || "Use host default working directory";
    }
    if (changed && !options.silent) {
      dependencies.workspace().scheduleWorkspaceSave();
    }
  }

  function newPaneID() {
    if (platform.crypto.randomUUID) {
      return `pane-${platform.crypto.randomUUID()}`;
    }
    return `pane-${platform.Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function defaultPaneTitle(kind) {
    const base = kind === "terminal"
      ? "Terminal"
      : kind === dependencies.browser().browserPaneKind
          ? "Browser"
        : kind === dependencies.vnc().vncPaneKind
          ? "VNC"
        : kind === dependencies.rdp().rdpPaneKind
          ? "RDP"
        : "Window";
    if (dependencies.preferences().themeID === "operator") return base;
    let highest = 0;
    for (const rect of feature.rectangles) {
      const match = rect.title.trim().match(new RegExp(`^${base} (\\d+)$`));
      if (match) {
        highest = Math.max(highest, Number(match[1]));
      }
    }
    return `${base} ${highest + 1}`;
  }

  // A new terminal takes half the board each way, centered, unless it opens
  // where someone right-clicked the desktop, which keeps that corner.
  function createTerminalPane(point = null, options = {}) {
    const box = feature.centeredPaneBox(feature.board.getBoundingClientRect());
    if (point) {
      box.x = point.x;
      box.y = Math.max(point.y, feature.tabHeight);
    }
    const rect = feature.createRectangle(box.x, box.y, box.width, box.height, {
      kind: "terminal",
      cwd: options.cwd ?? feature.activeRect?.cwd ?? "",
      title: options.title,
      terminalStartupCommand: options.terminalStartupCommand,
    });
    dependencies.interactions().clampIntoBoard(rect);
    dependencies.geometry().setRectangle(rect, rect);
    feature.setActivePane(rect, { raise: true, focus: true });
    dependencies.workspace().scheduleWorkspaceSave();
    return rect;
  }

  // A loopback address in a terminal names the Tessera host, not the device
  // looking at it, so a link to one (OSC 8 or detected in the text) opens in a
  // Browser window, which reaches the host's ports. A window already showing
  // it comes forward. Anything else opens in a new tab.
  function openTerminalLink(url) {
    const local = normalizeBrowserAddress(url);
    if (!local) {
      platform.window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const open = feature.rectangles.find(rect => rect.kind === dependencies.browser().browserPaneKind && rect.browser && rect.browserUrl === local);
    if (open) {
      feature.setActivePane(open, { raise: true, focus: true });
      return;
    }
    const point = feature.paneSpawnPoint();
    void dependencies.browser().navigateBrowserPane(feature.createBrowserPane(point), local);
  }

  // A new Browser, VNC or RDP window offers localhost on a usual port (8080 for
  // a development server), focused and selected: Enter connects, typing
  // replaces it.
  function prefillPaneAddress(address, value) {
    if (!address) return;
    if (!address.value) address.value = value;
    address.focus();
    address.select();
  }

  function createBrowserPane(point = null) {
    const box = feature.paneBox(point, 720, 480);
    const rect = feature.createRectangle(box.x, box.y, box.width, box.height, {
      kind: dependencies.browser().browserPaneKind,
    });
    dependencies.interactions().clampIntoBoard(rect);
    dependencies.geometry().setRectangle(rect, rect);
    feature.setActivePane(rect, { raise: true, focus: true });
    feature.prefillPaneAddress(rect.browser?.address, "localhost:8080");
    dependencies.workspace().scheduleWorkspaceSave();
    return rect;
  }

  function createVNCPane(point = null) {
    const box = feature.paneBox(point, 720, 480);
    const rect = feature.createRectangle(box.x, box.y, box.width, box.height, {
      kind: dependencies.vnc().vncPaneKind,
    });
    dependencies.interactions().clampIntoBoard(rect);
    dependencies.geometry().setRectangle(rect, rect);
    feature.setActivePane(rect, { raise: true, focus: true });
    feature.prefillPaneAddress(rect.vnc?.address, "localhost:5900");
    dependencies.workspace().scheduleWorkspaceSave();
    return rect;
  }

  function createRDPPane(point = null) {
    const box = feature.paneBox(point, 720, 480);
    const rect = feature.createRectangle(box.x, box.y, box.width, box.height, {
      kind: dependencies.rdp().rdpPaneKind,
    });
    dependencies.interactions().clampIntoBoard(rect);
    dependencies.geometry().setRectangle(rect, rect);
    feature.setActivePane(rect, { raise: true, focus: true });
    feature.prefillPaneAddress(rect.rdp?.address, "localhost:3389");
    dependencies.workspace().scheduleWorkspaceSave();
    return rect;
  }

  // Where a new window goes: at a point, at the size given, or with no point
  // centered at half the board each way (centeredPaneBox).
  function paneBox(point, width, height) {
    if (!point) return feature.centeredPaneBox(feature.board.getBoundingClientRect());
    return { x: point.x, y: Math.max(point.y, feature.tabHeight), width, height };
  }

  // A cascading spawn point for windows opened from elsewhere, such as a link
  // in a terminal.
  // Half the board's width and height, centered. Small screens keep a usable
  // window rather than an exact half.
  function centeredPaneBox(bounds) {
    const width = Math.min(bounds.width, Math.max(360, Math.round(bounds.width / 2)));
    const height = Math.min(bounds.height, Math.max(220, Math.round(bounds.height / 2)));
    return {
      x: Math.round((bounds.width - width) / 2),
      y: Math.max(feature.tabHeight, Math.round((bounds.height - height) / 2)),
      width,
      height,
    };
  }

  function paneSpawnPoint() {
    const count = feature.rectangles.filter((rect) => rect.kind !== "pending").length;
    const step = count % 6;
    return { x: 48 + step * 32, y: feature.tabHeight + 40 + step * 28 };
  }

  // Keeps the title-bar buttons' glyphs and tooltips in sync with the pane's
  // maximized/minimized state. The glyphs are CSS triangles keyed off
  // data-glyph: "down" minimize, "up" maximize/expand, "restore" two-headed.
  function updateWindowControls(rect) {
    if (!rect) {
      return;
    }
    rect.element.classList.toggle("is-full", rect.isFull);
    if (!rect.minButton || !rect.maxButton) {
      return;
    }
    rect.minButton.dataset.glyph = rect.minimized ? "up" : "down";
    rect.minButton.title = rect.minimized ? "Restore" : "Minimize";
    rect.minButton.setAttribute("aria-label", rect.minimized ? "Restore window" : "Minimize window");
    // A minimized window has no on-canvas controls until the Deskbar restores it.
    rect.maxButton.hidden = rect.minimized;
    rect.maxButton.dataset.glyph = rect.isFull ? "restore" : "up";
    rect.maxButton.title = rect.isFull ? "Restore" : "Maximize";
    rect.maxButton.setAttribute("aria-label", rect.isFull ? "Restore window" : "Maximize window");
    dependencies.deskbar().updateDeskbar();
  }

  function destroyRectangle(rect, options = {}) {
    dependencies.preferences().windowWobble.stop(rect.element);
    const index = feature.rectangles.indexOf(rect);
    const wasActive = feature.activePaneID === rect.id;
    if (index >= 0) {
      feature.rectangles.splice(index, 1);
    }
    if (dependencies.interactions().interaction?.rect === rect) {
      dependencies.interactions().interaction = null;
    }
    if (dependencies.menus().contextMenuRect === rect) {
      dependencies.menus().contextMenuRect = null;
    }
    if (dependencies.menus().terminalMenuRect === rect) {
      dependencies.menus().terminalMenuRect = null;
    }
    if (dependencies.menus().windowTypeRect === rect) {
      dependencies.menus().windowTypeRect = null;
      dependencies.menus().windowTypeMenu.hidden = true;
    }
    if (wasActive) {
      feature.activeRect = null;
      feature.activePaneID = "";
      delete feature.board.dataset.activePaneId;
    }
    dependencies.terminal().disposeTerminal(rect, { closeServer: options.closeServerTerminal });
    dependencies.browser().disposeBrowserPane(rect);
    dependencies.vnc().disposeVNCPane(rect);
    // Closing the window ends the session the host keeps for it; the other
    // places that dispose of the pane only detach, so the session lives on.
    if (rect.rdp && dependencies.rdp().rdpController.available) void dependencies.rdp().endKeptRDP(rect);
    dependencies.rdpView().disposeRDPPane(rect);
    platform.window.clearTimeout(rect.fontSizeIndicatorTimer);
    rect.fontSizeIndicatorTimer = null;
    rect.element.remove();
    dependencies.terminal().scheduleTerminalVisibilityUpdate();
    if (wasActive && options.selectNext !== false) {
      dependencies.interactions().focusTopVisiblePane();
    }
    dependencies.deskbar().updateDeskbar();
    dependencies.workspace().scheduleWorkspaceSave();
  }

  function initializeBoard() {
    feature.board = platform.document.querySelector("#board");
    feature.tabHeight = 24;
    feature.rectangles = [];
    feature.activeRect = null;
  }

  function initializeActivePaneID() {
    feature.activePaneID = "";
  }

  function initializeNextZIndex() {
    feature.nextZIndex = 1;
  }

  function initializeRenameWindowModal() {
    feature.renameWindowModal = platform.document.createElement("div");
    feature.renameWindowModal.className = "settings-modal rename-window-modal";
    feature.renameWindowModal.hidden = true;
    feature.renameWindowModal.addEventListener("pointerdown", (event) => {
      if (event.target === feature.renameWindowModal) {
        feature.hideRenameWindowModal();
      }
    });
    platform.document.body.appendChild(feature.renameWindowModal);
  }

  Object.assign(feature, {
    createRectangle,
    startTitleRename,
    normalizePaneFontSize,
    setPaneFontSize,
    adjustActivePaneFontSize,
    resetActivePaneFontSize,
    showPaneFontSizeIndicator,
    updatePaneFontSizeUI,
    setActivePane,
    applyTerminalWindowTitle,
    updatePaneTitleLabels,
    openRenameWindowModal,
    hideRenameWindowModal,
    clearActivePane,
    clearActivePaneClass,
    getActivePane,
    setPaneCwd,
    newPaneID,
    defaultPaneTitle,
    createTerminalPane,
    openTerminalLink,
    prefillPaneAddress,
    createBrowserPane,
    createVNCPane,
    createRDPPane,
    paneBox,
    centeredPaneBox,
    paneSpawnPoint,
    updateWindowControls,
    destroyRectangle,
    initializeBoard,
    initializeActivePaneID,
    initializeNextZIndex,
    initializeRenameWindowModal,
  });
  return feature;
}
