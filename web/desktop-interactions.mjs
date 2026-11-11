import { terminalFindShortcut } from "./terminal-find.mjs";
import { adjacentWindowPane } from "./window-switcher.mjs";

// Pointer drawing, moving and resizing with cancellation.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   connectivity: () => ReturnType<typeof import("./server-connectivity.mjs").createConnectivity>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   directory: () => ReturnType<typeof import("./directory-dialog.mjs").createDirectory>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   help: () => ReturnType<typeof import("./help-dialog.mjs").createHelp>,
 *   https: () => ReturnType<typeof import("./local-https-dialog.mjs").createHttps>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   palette: () => ReturnType<typeof import("./command-palette.mjs").createPalette>,
 *   phone: () => ReturnType<typeof import("./phone-workspace.mjs").createPhone>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   sessionList: () => ReturnType<typeof import("./session-list-view.mjs").createSessionList>,
 *   sessionsDialog: () => ReturnType<typeof import("./sessions-dialog.mjs").createSessionsDialog>,
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   windows: () => ReturnType<typeof import("./window-list-view.mjs").createWindows>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createInteractions(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    interaction: undefined,
    appleKeyboardLayout: undefined,
  };

  function startDrawing(event, { capture = true } = {}) {
    if (feature.interaction || (event.button !== 1 && (event.button !== 0 || event.target !== dependencies.desktop().board))) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dependencies.menus().hideAllMenus();

    const point = feature.boardPoint(event);
    const cwd = dependencies.desktop().activeRect?.cwd || "";
    feature.interaction = {
      type: "draw",
      id: event.pointerId,
      button: event.button,
      rect: null,
      cwd,
      startX: point.x,
      startY: point.y,
    };
    if (event.button === 0) feature.createDrawnRectangle(feature.interaction);
    if (capture) dependencies.desktop().board.setPointerCapture(event.pointerId);
  }

  function createDrawnRectangle(draw) {
    if (dependencies.desktop().activeRect || dependencies.desktop().activePaneID) dependencies.desktop().clearActivePane();
    draw.rect = dependencies.desktop().createRectangle(draw.startX, draw.startY, 1, 1, {
      kind: "pending", cwd: draw.cwd, zIndex: dependencies.desktop().nextZIndex,
    });
    dependencies.desktop().nextZIndex += 1;
  }

  function startMoving(event, rect, captureElement = rect.element) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dependencies.menus().hideFloatingMenus();
    dependencies.desktop().setActivePane(rect, { raise: true, focus: true });

    const point = feature.boardPoint(event);
    feature.interaction = {
      type: "move",
      id: event.pointerId,
      rect,
      startX: point.x,
      startY: point.y,
      original: { ...rect },
    };
    // Capture title-bar drags on the tab itself so click/double-click events
    // retain that target instead of being redirected to the window body.
    captureElement.setPointerCapture(event.pointerId);
    dependencies.preferences().windowWobble.start(rect.element, rect.x, rect.y, point.x - rect.x, point.y - rect.y);
  }

  function startResizing(event, rect, handle) {
    dependencies.preferences().windowWobble.stop();
    if (dependencies.preferences().themeID === "oled-terminal" && rect.oledMoveMode && event.button === 0) {
      feature.startMoving(event, rect);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dependencies.menus().hideFloatingMenus();
    dependencies.geometry().clearFullState(rect);
    dependencies.desktop().setActivePane(rect, { raise: true, focus: true });

    const point = feature.boardPoint(event);
    feature.interaction = {
      type: "resize",
      id: event.pointerId,
      rect,
      handle,
      startX: point.x,
      startY: point.y,
      original: { ...rect },
    };
    rect.element.setPointerCapture(event.pointerId);
  }

  function setOLEDMoveMode(rect, enabled) {
    if (!rect) {
      return;
    }
    if (enabled) {
      for (const other of dependencies.desktop().rectangles) {
        if (other !== rect && other.oledMoveMode) {
          other.oledMoveMode = false;
          other.element.dataset.oledMoveMode = "false";
        }
      }
    }
    rect.oledMoveMode = Boolean(enabled);
    rect.element.dataset.oledMoveMode = rect.oledMoveMode ? "true" : "false";
  }

  function continueInteraction(event) {
    if (!feature.interaction || feature.interaction.id !== event.pointerId) {
      return;
    }

    const point = feature.boardPoint(event);
    if (feature.interaction.type === "draw") {
      if (!feature.interaction.rect) {
        if (Math.hypot(point.x - feature.interaction.startX, point.y - feature.interaction.startY) < 6) return;
        feature.createDrawnRectangle(feature.interaction);
      }
      const box = feature.boxFromDrag(feature.interaction.startX, feature.interaction.startY, point.x, point.y, event.shiftKey);
      feature.clampIntoBoard(box);
      dependencies.geometry().setRectangle(feature.interaction.rect, box);
      return;
    }

    if (feature.interaction.type === "move") {
      const dx = point.x - feature.interaction.startX;
      const dy = point.y - feature.interaction.startY;
      if (feature.interaction.rect.isFull && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        dependencies.geometry().clearFullState(feature.interaction.rect);
      }
      const next = {
        ...feature.interaction.original,
        x: feature.interaction.original.x + dx,
        y: feature.interaction.original.y + dy,
      };
      feature.clampIntoBoard(next);
      dependencies.geometry().setRectangle(feature.interaction.rect, next);
      dependencies.preferences().windowWobble.move(feature.interaction.rect.x, feature.interaction.rect.y);
      return;
    }

    if (feature.interaction.type === "resize") {
      const next = feature.resizeBox(feature.interaction.original, feature.interaction.handle, point.x - feature.interaction.startX, point.y - feature.interaction.startY, event.shiftKey);
      feature.clampIntoBoard(next);
      dependencies.geometry().setRectangle(feature.interaction.rect, next);
    }
  }

  function finishInteraction(event) {
    if (!feature.interaction || feature.interaction.id !== event.pointerId) {
      return;
    }

    const finishedInteraction = feature.interaction;
    feature.interaction = null;

    if (finishedInteraction.type === "draw") {
      if (!finishedInteraction.rect) return;
      if (event.type === "pointercancel" || finishedInteraction.rect.width < 6 || finishedInteraction.rect.height < 6) {
        dependencies.desktop().destroyRectangle(finishedInteraction.rect, { selectNext: false });
        return;
      }
      dependencies.menus().showWindowTypeMenu(finishedInteraction.rect, event.clientX, event.clientY);
      return;
    }

    if (finishedInteraction.type === "move") {
      feature.setOLEDMoveMode(finishedInteraction.rect, false);
      if (event.type === "pointercancel") dependencies.preferences().windowWobble.stop();
      else dependencies.preferences().windowWobble.release();
    }

  }

  function handlePaneKeyboardShortcuts(event) {
    if (event.defaultPrevented || dependencies.phone().phoneKeyEvents.has(event)) {
      return;
    }
    if (!dependencies.connectivity().serverConnectionModal.hidden) {
      return;
    }

    const shortcut = feature.paneShortcutAction(event);
    if (!shortcut) {
      return;
    }
    event.preventDefault();
    if (!shortcut.propagate) {
      event.stopPropagation();
    }
    shortcut.run();
  }

  // Resolves a keystroke to its window-management action. Shared by the
  // document-level handler and by keystrokes relayed out of browser-pane
  // iframes, which never reach this document on their own.
  function paneShortcutAction(keys) {
    // Dialogs and pickers own keyboard input, including relayed iframe keys.
    if ([dependencies.settings().settingsModal, dependencies.https().localHTTPSModal, dependencies.desktop().renameWindowModal, dependencies.sessionsDialog().sessionsModal, dependencies.sessionsDialog().sessionActionModal,
      dependencies.connectivity().serverUpdateModal, dependencies.connectivity().serverConnectionModal, dependencies.workspace().workspaceConflictModal, dependencies.help().helpModal,
      dependencies.directory().directoryBrowser, dependencies.navigation().userSelect, dependencies.navigation().shortcutsUI.element, dependencies.preferences().screensaver.element, dependencies.clipboard().saveClipboardDialog.element].some((overlay) => !overlay.hidden)) {
      return null;
    }
    const primary = (keys.ctrlKey || keys.metaKey) && !keys.altKey && !keys.shiftKey;
    const alt = keys.altKey && !keys.ctrlKey && !keys.metaKey && !keys.shiftKey;

    if (primary && (keys.key === "l" || keys.key === "L")) {
      return { run: dependencies.windows().toggleWindowList };
    }
    if (primary && (keys.key === "k" || keys.key === "K")) {
      return { run: dependencies.palette().toggleCommandPalette };
    }
    if (primary && !keys.repeat && !keys.isComposing && (keys.key === ";" || keys.code === "Semicolon")) {
      return { run: dependencies.sessionList().toggleSessionList };
    }
    if (primary && (keys.key === "t" || keys.key === "T")) {
      return { run: () => dependencies.desktop().openRenameWindowModal(dependencies.desktop().getActivePane()) };
    }
    if (!dependencies.palette().commandPalette.hidden || !dependencies.windows().windowList.hidden || !dependencies.sessionList().sessionList.hidden) {
      return null;
    }
    const find = terminalFindShortcut(keys, { appleKeyboard: feature.appleKeyboardLayout });
    const findPane = find ? dependencies.desktop().getActivePane() : null;
    if (findPane?.kind === "terminal" && findPane.terminal?.term) {
      return { run: () => (find === "open" ? dependencies.terminal().openTerminalFind(findPane) : dependencies.terminal().moveTerminalFind(findPane, find === "older")) };
    }
    if ((keys.ctrlKey || keys.metaKey) && keys.shiftKey && !keys.altKey
      && (keys.key === "ArrowUp" || keys.key === "ArrowDown")) {
      return { run: () => dependencies.windows().moveWindowInOrder(dependencies.desktop().getActivePane(), keys.key === "ArrowUp" ? -1 : 1, { showSwitcher: true }) };
    }
    if (primary && (keys.key === "]" || keys.code === "BracketRight")) {
      return { run: () => feature.focusAdjacentPane(1, { showSwitcher: true }) };
    }
    if (primary && (keys.key === "[" || keys.code === "BracketLeft")) {
      return { run: () => feature.focusAdjacentPane(-1, { showSwitcher: true }) };
    }
    const fontSizeShortcut = (keys.ctrlKey || keys.metaKey) && !keys.altKey && (!keys.shiftKey || keys.key === "+");
    if (fontSizeShortcut && (keys.key === "+" || keys.key === "=" || keys.code === "NumpadAdd")) {
      return { run: () => dependencies.desktop().adjustActivePaneFontSize(1) };
    }
    if (fontSizeShortcut && (keys.key === "-" || keys.key === "_" || keys.code === "NumpadSubtract")) {
      return { run: () => dependencies.desktop().adjustActivePaneFontSize(-1) };
    }
    if (primary && (keys.key === "0" || keys.code === "Numpad0")) {
      return { run: dependencies.desktop().resetActivePaneFontSize };
    }
    if (alt && keys.key === "F10") {
      return { run: () => dependencies.geometry().toggleFullRestore(dependencies.desktop().getActivePane()), propagate: true };
    }
    if (alt && keys.key === "F9") {
      return { run: () => dependencies.geometry().toggleMinimize(dependencies.desktop().getActivePane()), propagate: true };
    }
    if (alt && keys.key === "F7") {
      return { run: dependencies.geometry().toggleArrangeWindows, propagate: true };
    }
    return null;
  }

  function focusAdjacentPane(direction, options = {}) {
    const next = adjacentWindowPane(dependencies.desktop().rectangles, dependencies.desktop().getActivePane(), direction);
    if (!next) {
      return;
    }
    dependencies.desktop().setActivePane(next, { raise: true, focus: true });
    if (options.showSwitcher) {
      dependencies.switcher().showWindowSwitcher();
    }
  }

  function focusTopVisiblePane() {
    const next = dependencies.desktop().rectangles
      .filter((rect) => rect.kind !== "pending" && !rect.minimized)
      .sort((a, b) => b.zIndex - a.zIndex)[0] || null;
    if (next) {
      dependencies.desktop().setActivePane(next, { raise: false, focus: true });
    } else {
      dependencies.desktop().clearActivePane();
    }
  }

  function boxFromDrag(startX, startY, pointerX, pointerY, square) {
    let dx = pointerX - startX;
    let dy = pointerY - startY;
    if (square) {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = dx < 0 ? -side : side;
      dy = dy < 0 ? -side : side;
    }

    const x = Math.min(startX, startX + dx);
    const y = Math.min(startY, startY + dy);
    return {
      x,
      y,
      width: Math.abs(dx),
      height: Math.abs(dy),
    };
  }

  function resizeBox(original, handle, dx, dy, square) {
    let left = original.x;
    let top = original.y;
    let right = original.x + original.width;
    let bottom = original.y + original.height;

    if (handle.includes("w")) {
      left += dx;
    }
    if (handle.includes("e")) {
      right += dx;
    }
    if (handle.includes("n")) {
      top += dy;
    }
    if (handle.includes("s")) {
      bottom += dy;
    }

    if (right - left < 16) {
      handle.includes("w") ? (left = right - 16) : (right = left + 16);
    }
    if (bottom - top < 16) {
      handle.includes("n") ? (top = bottom - 16) : (bottom = top + 16);
    }

    if (square) {
      const side = Math.max(right - left, bottom - top);
      if (handle.includes("w")) {
        left = right - side;
      } else {
        right = left + side;
      }
      if (handle.includes("n")) {
        top = bottom - side;
      } else {
        bottom = top + side;
      }
    }

    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }

  function clampIntoBoard(rect) {
    const bounds = dependencies.desktop().board.getBoundingClientRect();
    const visibleX = Math.min(56, rect.width, bounds.width);
    const visibleY = Math.min(56, rect.height, bounds.height);
    const titleVisible = 12;

    const minX = visibleX - rect.width;
    const maxX = bounds.width - visibleX;
    // The floor keeps a sliver of the title tab grabbable when a window is
    // dragged mostly above the board; OLED Terminal has no tab, so it should
    // allow panes flush against the top edge instead of leaving a gap.
    const minY = Math.max(visibleY - rect.height, dependencies.geometry().dockTopInset() - titleVisible);
    const maxY = bounds.height - visibleY;

    rect.x = Math.min(Math.max(minX, rect.x), maxX);
    rect.y = Math.min(Math.max(minY, rect.y), maxY);
  }

  function boardPoint(event) {
    return feature.boardClientPoint(event.clientX, event.clientY);
  }

  function boardClientPoint(clientX, clientY) {
    const bounds = dependencies.desktop().board.getBoundingClientRect();
    return {
      x: clientX - bounds.left,
      y: clientY - bounds.top,
    };
  }

  function initializeInteraction() {
    feature.interaction = null;
  }

  function initializeAppleKeyboardLayout() {
    // Which modifier the platform pastes with, since that decides whether the
    // browser will deliver a paste event on its own. userAgentData is the modern
    // signal; navigator.platform is deprecated but still the only one in some
    // builds, and the user agent string is the last resort.
    feature.appleKeyboardLayout = /mac|iphone|ipad/i.test(
      platform.navigator.userAgentData?.platform || platform.navigator.platform || platform.navigator.userAgent || "",
    );
  }

  Object.assign(feature, {
    startDrawing,
    createDrawnRectangle,
    startMoving,
    startResizing,
    setOLEDMoveMode,
    continueInteraction,
    finishInteraction,
    handlePaneKeyboardShortcuts,
    paneShortcutAction,
    focusAdjacentPane,
    focusTopVisiblePane,
    boxFromDrag,
    resizeBox,
    clampIntoBoard,
    boardPoint,
    boardClientPoint,
    initializeInteraction,
    initializeAppleKeyboardLayout,
  });
  return feature;
}
