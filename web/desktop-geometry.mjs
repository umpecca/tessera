

// Pane placement, docking, maximize/restore and arrange snapshots.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createGeometry(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    arrangeOutSnapshot: undefined,
    isArrangingWindows: undefined,
  };

  function setRectangle(rect, next, { save = true } = {}) {
    const x = Math.round(next.x);
    const y = Math.round(next.y);
    const width = Math.max(1, Math.round(next.width));
    const height = Math.max(1, Math.round(next.height));
    // Creation and pane-type changes pass the pane itself to force layout.
    const sizeChanged = rect === next || rect.width !== width || rect.height !== height;
    if (rect.x === x && rect.y === y && !sizeChanged) {
      return;
    }
    rect.x = x;
    rect.y = y;
    rect.width = width;
    rect.height = height;
    rect.element.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    dependencies.terminal().scheduleTerminalVisibilityUpdate();
    if (sizeChanged) {
      rect.element.style.width = `${rect.width}px`;
      rect.element.style.height = `${rect.height}px`;
      dependencies.terminal().requestTerminalFit(rect);
    }
    if (!feature.isArrangingWindows) {
      feature.arrangeOutSnapshot = null;
    }
    if (save) {
      dependencies.workspace().scheduleWorkspaceSave();
    }
  }

  function applyDockAction(action, rect) {
    if (!rect) {
      return;
    }
    dependencies.preferences().windowWobble.stop(rect.element);

    if (action === "destroy") {
      dependencies.desktop().destroyRectangle(rect, { closeServerTerminal: true });
      return;
    }

    if (action === "minimize") {
      feature.setMinimized(rect, true);
      return;
    }

    if (action === "unminimize") {
      feature.setMinimized(rect, false);
      dependencies.desktop().setActivePane(rect, { raise: true, focus: true });
      return;
    }

    dependencies.desktop().setActivePane(rect, { raise: true, focus: true });

    if (action === "restore") {
      if (rect.restoreBox) {
        feature.setRectangle(rect, rect.restoreBox);
      }
      feature.clearFullState(rect);
      return;
    }

    if (action === "full") {
      // A maximized pane must be expanded, not rolled up.
      if (rect.minimized) {
        feature.setMinimized(rect, false);
      }
      if (!rect.isFull) {
        rect.restoreBox = feature.rectangleBox(rect);
      }
      rect.isFull = true;
      feature.applyFullGeometry(rect);
      dependencies.desktop().updateWindowControls(rect);
      return;
    }

    if (action === "top" || action === "left" || action === "right" || action === "bottom") {
      // A docked pane must be visible and at its own size, not rolled up or
      // still carrying a stale "full" restore box.
      if (rect.minimized) {
        feature.setMinimized(rect, false);
      }
      feature.clearFullState(rect);
      const bounds = dependencies.desktop().board.getBoundingClientRect();
      feature.setDockedPaneGeometry(rect, action, bounds);
    }
  }

  function dockTopInset() {
    return dependencies.preferences().themeID === "oled-terminal" || dependencies.preferences().themeID === "operator" ? 0 : dependencies.desktop().tabHeight;
  }

  function dockedPaneBox(action, bounds, inset = feature.dockTopInset()) {
    const usableHeight = Math.max(16, bounds.height - inset);
    const halfWidth = Math.max(16, Math.floor(bounds.width / 2));
    const halfHeight = Math.max(16, Math.floor(usableHeight / 2));
    if (action === "top") {
      return { x: 0, y: inset, width: bounds.width, height: halfHeight };
    }
    if (action === "left") {
      return { x: 0, y: inset, width: halfWidth, height: usableHeight };
    }
    if (action === "right") {
      return { x: bounds.width - halfWidth, y: inset, width: halfWidth, height: usableHeight };
    }
    return { x: 0, y: bounds.height - halfHeight, width: bounds.width, height: halfHeight };
  }

  function setDockedPaneGeometry(rect, action, bounds = dependencies.desktop().board.getBoundingClientRect()) {
    feature.setRectangle(rect, feature.dockedPaneBox(action, bounds));
  }

  function sameRectangleBox(rect, box) {
    return rect.x === box.x && rect.y === box.y && rect.width === box.width && rect.height === box.height;
  }

  // Docked panes from every theme use one of two exact geometry families: the
  // normal title-tab inset or the OLED/Operator edge-to-edge layout. Operator
  // reserves its title height within the pane rather than above its saved box.
  // Recognizing either form lets existing saved docks update on theme changes.
  function reflowDockedPanesForTheme() {
    const bounds = dependencies.desktop().board.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) {
      return;
    }
    const insetBoxes = [0, dependencies.desktop().tabHeight].flatMap((inset) => (
      ["top", "left", "right", "bottom"].map((action) => ({ action, box: feature.dockedPaneBox(action, bounds, inset) }))
    ));
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "pending" || rect.minimized || rect.isFull) {
        continue;
      }
      const match = insetBoxes.find(({ box }) => feature.sameRectangleBox(rect, box));
      if (match) {
        const themedBox = feature.dockedPaneBox(match.action, bounds);
        if (!feature.sameRectangleBox(rect, themedBox)) {
          feature.setRectangle(rect, themedBox);
        }
      }
    }
  }

  function toggleFullRestore(rect) {
    feature.applyDockAction(rect?.isFull ? "restore" : "full", rect);
  }

  // Maximize is an attribute ("this pane fills the board"), not a fixed size:
  // this always measures the board fresh, so a maximized pane fills whatever
  // screen it's actually being viewed on — including a different device's
  // screen after the workspace reloads, or the browser window being resized
  // while a pane is maximized.
  function applyFullGeometry(rect, options = {}) {
    // A maximized window starts at the visible desktop origin.
    feature.pinWorkspaceScroll();
    const bounds = dependencies.desktop().board.getBoundingClientRect();
    feature.setRectangle(rect, { x: 0, y: 0, width: bounds.width, height: bounds.height }, options);
  }

  // Re-fills every maximized pane when the viewport changes size, so "full"
  // keeps meaning "fills the board" instead of freezing at whatever size it
  // happened to be maximized at. Each screen fits a maximized pane to itself,
  // and what is saved is only that the pane is maximized, so fitting it is not
  // an edit: saving here would have every device that shows the workspace
  // rewrite it at its own size whenever its viewport moves (an iPad toolbar
  // collapsing is enough), and push the others into save conflicts.
  function reapplyFullGeometryForViewport() {
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind !== "pending" && rect.isFull && !rect.minimized) {
        feature.applyFullGeometry(rect, { save: false });
      }
    }
  }

  // The workspace never scrolls: windows move, the page and board stay put.
  // iPadOS scrolls the page anyway to keep a focused terminal's caret clear of
  // the keyboard or the hardware keyboard's shortcut bar, and focusing an
  // offscreen control can scroll the overflow-hidden board. Either shifts
  // every window up until something scrolls it back, so put it back at once.
  function pinWorkspaceScroll() {
    if (platform.window.scrollX || platform.window.scrollY) platform.window.scrollTo(0, 0);
    if (dependencies.desktop().board.scrollLeft || dependencies.desktop().board.scrollTop) {
      dependencies.desktop().board.scrollLeft = 0;
      dependencies.desktop().board.scrollTop = 0;
    }
  }

  // Tiles every visible pane into a near-square grid so all of their contents
  // are on screen at once, remembering each pane's prior box so Back Arrange
  // can undo it.
  function toggleArrangeWindows() {
    if (feature.arrangeOutSnapshot) {
      feature.arrangeWindowsBack();
    } else {
      feature.arrangeWindowsOut();
    }
  }

  function arrangeWindowsOut() {
    const panes = dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending" && !rect.minimized);
    if (panes.length === 0) {
      return;
    }

    if (!feature.arrangeOutSnapshot) {
      feature.arrangeOutSnapshot = panes.map((rect) => ({ id: rect.id, box: feature.rectangleBox(rect) }));
    }

    const bounds = dependencies.desktop().board.getBoundingClientRect();
    const inset = dependencies.preferences().themeID === "operator" ? 0 : dependencies.desktop().tabHeight;
    const usableHeight = Math.max(16, bounds.height - inset);
    const columns = Math.ceil(Math.sqrt(panes.length));
    const rows = Math.ceil(panes.length / columns);
    const cellWidth = Math.max(16, Math.floor(bounds.width / columns));
    const cellHeight = Math.max(16, Math.floor(usableHeight / rows));

    feature.isArrangingWindows = true;
    panes.forEach((rect, index) => {
      feature.clearFullState(rect);
      const column = index % columns;
      const row = Math.floor(index / columns);
      feature.setRectangle(rect, {
        x: column * cellWidth,
        y: inset + row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      });
    });
    feature.isArrangingWindows = false;
    dependencies.workspace().scheduleWorkspaceSave();
  }

  // Restores every pane's box from the last Cascade Arrange, if nothing has moved,
  // resized, docked, or otherwise repositioned a window since.
  function arrangeWindowsBack() {
    if (!feature.arrangeOutSnapshot) {
      return;
    }
    const snapshot = feature.arrangeOutSnapshot;
    feature.isArrangingWindows = true;
    for (const { id, box } of snapshot) {
      const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === id);
      if (rect) {
        feature.setRectangle(rect, box);
      }
    }
    feature.isArrangingWindows = false;
    feature.arrangeOutSnapshot = null;
    dependencies.workspace().scheduleWorkspaceSave();
  }

  function destroyActivePane() {
    const active = dependencies.desktop().getActivePane();
    if (active) {
      dependencies.desktop().destroyRectangle(active, { closeServerTerminal: true });
    }
  }

  function closeWindowFromTitleBar(rect) {
    if (rect.kind === "terminal" && rect.terminalStatus?.state !== "exited"
        && !platform.window.confirm(`Close "${rect.title}"? This ends its shell and any running processes.`)) {
      return;
    }
    dependencies.desktop().destroyRectangle(rect, { closeServerTerminal: true });
  }

  // Minimize hides the pane but keeps its live terminal intact. The
  // Deskbar is the persistent visual handle that restores it.
  function setMinimized(rect, on) {
    dependencies.preferences().windowWobble.stop(rect?.element);
    if (!rect) {
      return;
    }
    const next = Boolean(on);
    if (rect.minimized === next) {
      return;
    }
    rect.minimized = next;
    rect.element.classList.toggle("is-minimized", next);
    dependencies.terminal().scheduleTerminalVisibilityUpdate();
    dependencies.terminal().updatePaneRenderState(rect);
    if (next) {
      rect.element.setAttribute("aria-hidden", "true");
    } else {
      rect.element.removeAttribute("aria-hidden");
      platform.window.requestAnimationFrame(() => {
        dependencies.terminal().requestTerminalFit(rect);
      });
    }
    dependencies.desktop().updateWindowControls(rect);
    dependencies.deskbar().updateDeskbar();
    if (next && dependencies.desktop().activePaneID === rect.id) {
      dependencies.interactions().focusTopVisiblePane();
    }
    dependencies.workspace().scheduleWorkspaceSave();
  }

  function toggleMinimize(rect) {
    if (!rect) {
      return;
    }
    dependencies.desktop().setActivePane(rect, { raise: true });
    feature.setMinimized(rect, !rect.minimized);
  }

  function rectangleBox(rect) {
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  // Parses a saved restoreBox (opaque JSON text) and keeps its position on
  // whatever board it's loaded into, in case the saved box came from a
  // larger screen.
  function parseRestoreBox(raw) {
    if (!raw) {
      return null;
    }
    try {
      const box = JSON.parse(raw);
      if (!box || typeof box.x !== "number" || typeof box.y !== "number" || typeof box.width !== "number" || typeof box.height !== "number") {
        return null;
      }
      dependencies.interactions().clampIntoBoard(box);
      return box;
    } catch {
      return null;
    }
  }

  function clearFullState(rect) {
    rect.isFull = false;
    rect.restoreBox = null;
    dependencies.desktop().updateWindowControls(rect);
  }

  function initializeArrangeOutSnapshot() {
    // "Cascade Arrange" snapshots every visible pane's box before its first tile;
    // "Back Arrange" restores it. Repeating Cascade Arrange preserves that snapshot.
    // Any geometry change outside of arranging (move, resize, dock, maximize, a
    // new window) drops the snapshot via setRectangle.
    feature.arrangeOutSnapshot = null;
    feature.isArrangingWindows = false;
  }

  function registerViewportResize() {
    platform.window.addEventListener("resize", feature.reapplyFullGeometryForViewport);
  }

  function registerViewportScroll() {
    platform.window.addEventListener("scroll", feature.pinWorkspaceScroll, { passive: true });
    dependencies.desktop().board.addEventListener("scroll", feature.pinWorkspaceScroll, { passive: true });
    platform.window.visualViewport?.addEventListener("scroll", feature.pinWorkspaceScroll);
    platform.window.visualViewport?.addEventListener("resize", feature.pinWorkspaceScroll);
    // The window "resize" event doesn't fire for every way the board's own box
    // can change size (browser chrome changes, OS-level display/zoom changes,
    // some devtools/embedded viewport changes) — a ResizeObserver on the board
    // itself catches those too, since it fires on the actual box change rather
    // than a specific event source.
    new platform.ResizeObserver(feature.reapplyFullGeometryForViewport).observe(dependencies.desktop().board);
  }

  Object.assign(feature, {
    setRectangle,
    applyDockAction,
    dockTopInset,
    dockedPaneBox,
    setDockedPaneGeometry,
    sameRectangleBox,
    reflowDockedPanesForTheme,
    toggleFullRestore,
    applyFullGeometry,
    reapplyFullGeometryForViewport,
    pinWorkspaceScroll,
    toggleArrangeWindows,
    arrangeWindowsOut,
    arrangeWindowsBack,
    destroyActivePane,
    closeWindowFromTitleBar,
    setMinimized,
    toggleMinimize,
    rectangleBox,
    parseRestoreBox,
    clearFullState,
    initializeArrangeOutSnapshot,
    registerViewportResize,
    registerViewportScroll,
  });
  return feature;
}
