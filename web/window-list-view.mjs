import { moveWindowPane, placeWindowPaneBefore } from "./window-switcher.mjs";

// Window list selection, drag ordering and keyboard interaction.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   palette: () => ReturnType<typeof import("./command-palette.mjs").createPalette>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createWindows(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    windowList: undefined,
    windowListPanel: undefined,
    windowListTitle: undefined,
    windowListHeading: undefined,
    windowListClose: undefined,
    windowListItems: undefined,
    windowListHint: undefined,
    windowListStatus: undefined,
    windowListEntries: undefined,
    windowListSelection: undefined,
    windowListDrag: undefined,
  };

  function toggleWindowList() {
    if (feature.windowList.hidden) {
      feature.openWindowList();
    } else {
      feature.hideWindowList();
    }
  }

  function openWindowList() {
    if (!dependencies.navigation().userSelect.hidden) {
      return;
    }
    dependencies.menus().hideAllMenus();
    feature.windowList.hidden = false;
    feature.windowListStatus.textContent = "";
    feature.renderWindowList(dependencies.desktop().activePaneID);
    platform.window.requestAnimationFrame(() => {
      if (!feature.windowList.hidden) feature.windowListPanel.focus();
    });
  }

  function hideWindowList() {
    feature.clearWindowListDrag();
    const restorePaneFocus = !feature.windowList.hidden && feature.windowList.contains(platform.document.activeElement);
    feature.windowList.hidden = true;
    if (restorePaneFocus) {
      dependencies.switcher().restorePaneFocusAfterOverlayDismiss(feature.windowList);
    }
  }

  function renderWindowList(selectedPaneID = feature.windowListEntries[feature.windowListSelection]?.id || dependencies.desktop().activePaneID) {
    feature.clearWindowListDrag();
    const focused = feature.windowListItems.contains(platform.document.activeElement) ? platform.document.activeElement : null;
    const focusedPaneID = focused?.closest(".window-list-item")?.dataset.paneId;
    const focusedAction = focused?.dataset.windowListAction;
    feature.windowListEntries = dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending");
    const selectedIndex = feature.windowListEntries.findIndex((rect) => rect.id === selectedPaneID);
    const activeIndex = feature.windowListEntries.findIndex((rect) => rect.id === dependencies.desktop().activePaneID);
    feature.windowListSelection = selectedIndex >= 0 ? selectedIndex : Math.max(0, activeIndex);
    feature.windowListItems.replaceChildren();

    if (feature.windowListEntries.length === 0) {
      const empty = platform.document.createElement("div");
      empty.className = "command-palette-empty";
      empty.textContent = "No windows";
      feature.windowListItems.appendChild(empty);
      return;
    }

    feature.windowListEntries.forEach((rect, index) => {
      const row = platform.document.createElement("div");
      row.className = "command-palette-item window-list-item";
      row.dataset.paneId = rect.id;
      row.addEventListener("pointerdown", (event) => feature.startWindowListDrag(event, rect));
      row.addEventListener("click", (event) => {
        if (row.dataset.suppressClick) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
      const grip = platform.document.createElement("span");
      grip.className = "window-list-grip";
      grip.textContent = "⠿";
      grip.title = "Drag to reorder window";
      grip.setAttribute("aria-hidden", "true");
      const name = platform.document.createElement("button");
      name.type = "button";
      name.className = "window-list-name";
      name.dataset.windowListAction = "focus";
      name.textContent = `${index + 1}. ${dependencies.menus().workspaceMenuLabel(rect)}${rect.minimized ? " (minimized)" : ""}`;
      name.title = rect.minimized ? "Drag to reorder, or click to restore and focus" : "Drag to reorder, or click to focus";
      name.setAttribute("aria-label", name.textContent);
      name.addEventListener("click", () => feature.selectWindowListEntry(index));
      const actions = platform.document.createElement("div");
      actions.className = "window-list-actions";
      for (const [direction, text, action] of [[-1, "↑", "up"], [1, "↓", "down"]]) {
        const move = platform.document.createElement("button");
        move.type = "button";
        move.className = "window-list-move";
        move.dataset.windowListAction = action;
        move.textContent = text;
        move.title = `Move ${action} in window order`;
        move.setAttribute("aria-label", `Move ${dependencies.menus().workspaceMenuLabel(rect)} ${action}`);
        move.disabled = direction < 0 ? index === 0 : index === feature.windowListEntries.length - 1;
        move.addEventListener("click", () => {
          feature.setWindowListSelection(index);
          feature.moveWindowInOrder(rect, direction);
        });
        actions.appendChild(move);
      }
      row.addEventListener("pointermove", () => {
        if (!feature.windowListDrag) feature.setWindowListSelection(index);
      });
      row.addEventListener("focusin", () => feature.setWindowListSelection(index));
      row.append(grip, name, actions);
      feature.windowListItems.appendChild(row);
    });
    feature.setWindowListSelection(feature.windowListSelection);
    if (focusedPaneID) {
      const row = [...feature.windowListItems.querySelectorAll(".window-list-item")].find(row => row.dataset.paneId === focusedPaneID);
      const control = row?.querySelector(`[data-window-list-action="${focusedAction}"]`);
      (control && !control.disabled ? control : row?.querySelector(".window-list-name") || feature.windowListPanel).focus({ preventScroll: true });
    }
  }

  function moveWindowInOrder(rect, direction, options = {}) {
    const moved = moveWindowPane(dependencies.desktop().rectangles, rect, direction);
    return feature.finishWindowOrderMove(rect, moved, options);
  }

  function finishWindowOrderMove(rect, moved, options = {}) {
    if (moved) {
      dependencies.deskbar().updateDeskbar();
      dependencies.workspace().scheduleWorkspaceSave();
      if (!feature.windowList.hidden) {
        const index = feature.windowListEntries.indexOf(rect);
        feature.windowListStatus.textContent = `${dependencies.menus().workspaceMenuLabel(rect)} moved to ${index + 1} of ${feature.windowListEntries.length}.`;
      }
    }
    if (rect && rect.kind !== "pending" && options.showSwitcher) dependencies.switcher().showWindowSwitcher({ includeMinimized: true });
    return moved;
  }

  function startWindowListDrag(event, rect) {
    if (event.button !== 0 || !event.isPrimary || event.target.closest(".window-list-actions")
      || !feature.windowListEntries.includes(rect)) return;
    feature.clearWindowListDrag();
    feature.windowListDrag = { paneID: rect.id, beforePaneID: null, valid: false, started: false,
      pointerID: event.pointerId, startX: event.clientX, startY: event.clientY,
      clientX: event.clientX, clientY: event.clientY, row: event.currentTarget, scrollFrame: null };
  }

  function clearWindowListDropIndicator() {
    if (feature.windowListDrag) feature.windowListDrag.valid = false;
    feature.windowListItems.querySelectorAll(".window-list-item").forEach(row => {
      row.classList.remove("is-drop-before", "is-drop-after");
    });
  }

  function clearWindowListDrag() {
    if (feature.windowListDrag) {
      const { pointerID, scrollFrame, row, started } = feature.windowListDrag;
      if (scrollFrame !== null) platform.cancelAnimationFrame(scrollFrame);
      if (feature.windowListItems.hasPointerCapture(pointerID)) feature.windowListItems.releasePointerCapture(pointerID);
      if (started) {
        // The following click must not open the window after a drag or cancel.
        row.dataset.suppressClick = "true";
        platform.setTimeout(() => delete row.dataset.suppressClick, 0);
      }
    }
    feature.clearWindowListDropIndicator();
    feature.windowListItems.querySelectorAll(".is-dragging").forEach(row => row.classList.remove("is-dragging"));
    feature.windowListItems.classList.remove("is-reordering");
    feature.windowListDrag = null;
  }

  function updateWindowListDrop(event) {
    if (!feature.windowListDrag || feature.windowList.hidden || event.pointerId !== feature.windowListDrag.pointerID) return;
    if (feature.windowListDrag.canceled) return;
    if (!feature.windowListDrag.started) {
      if (Math.hypot(event.clientX - feature.windowListDrag.startX, event.clientY - feature.windowListDrag.startY) < 5) return;
      feature.windowListDrag.started = true;
      feature.setWindowListSelection(feature.windowListEntries.findIndex(pane => pane.id === feature.windowListDrag.paneID));
      feature.windowListItems.setPointerCapture(event.pointerId);
      feature.windowListDrag.row.classList.add("is-dragging");
      feature.windowListItems.classList.add("is-reordering");
    }
    event.preventDefault();
    feature.windowListDrag.clientX = event.clientX;
    feature.windowListDrag.clientY = event.clientY;
    feature.updateWindowListDropIndicator();
    if (feature.windowListDrag.scrollFrame === null) feature.windowListDrag.scrollFrame = platform.requestAnimationFrame(feature.scrollWindowListDrag);
  }

  function updateWindowListDropIndicator() {
    feature.clearWindowListDropIndicator();
    const { clientX, clientY } = feature.windowListDrag;
    const listBounds = feature.windowListItems.getBoundingClientRect();
    if (clientX < listBounds.left || clientX > listBounds.right || clientY < listBounds.top || clientY > listBounds.bottom) return;
    const rows = [...feature.windowListItems.querySelectorAll(".window-list-item")];
    const before = rows.find(row => {
      const bounds = row.getBoundingClientRect();
      return clientY < bounds.top + bounds.height / 2;
    });
    feature.windowListDrag.beforePaneID = before?.dataset.paneId || null;
    feature.windowListDrag.valid = rows.length > 0;
    if (before) before.classList.add("is-drop-before");
    else rows.at(-1)?.classList.add("is-drop-after");
  }

  function scrollWindowListDrag() {
    if (!feature.windowListDrag) return;
    feature.windowListDrag.scrollFrame = null;
    if (!feature.windowListDrag.valid) return;
    const bounds = feature.windowListItems.getBoundingClientRect();
    const y = feature.windowListDrag.clientY;
    const amount = y < bounds.top + 24 ? -6 : y > bounds.bottom - 24 ? 6 : 0;
    const previous = feature.windowListItems.scrollTop;
    feature.windowListItems.scrollTop += amount;
    if (feature.windowListItems.scrollTop !== previous) {
      feature.updateWindowListDropIndicator();
      feature.windowListDrag.scrollFrame = platform.requestAnimationFrame(feature.scrollWindowListDrag);
    }
  }

  function dropWindowListEntry(event) {
    if (!feature.windowListDrag || event.pointerId !== feature.windowListDrag.pointerID) return;
    const started = feature.windowListDrag.started;
    if (started && !feature.windowListDrag.canceled) {
      event.preventDefault();
      feature.windowListDrag.clientX = event.clientX;
      feature.windowListDrag.clientY = event.clientY;
      feature.updateWindowListDropIndicator();
    }
    const { paneID, beforePaneID, valid } = feature.windowListDrag;
    feature.clearWindowListDrag();
    if (!started || !valid || feature.windowList.hidden) return;
    const rect = dependencies.desktop().rectangles.find(pane => pane.id === paneID);
    const before = beforePaneID === null ? null : dependencies.desktop().rectangles.find(pane => pane.id === beforePaneID);
    feature.finishWindowOrderMove(rect, placeWindowPaneBefore(dependencies.desktop().rectangles, rect, before));
    const row = [...feature.windowListItems.querySelectorAll(".window-list-item")].find(row => row.dataset.paneId === paneID);
    row?.querySelector(".window-list-name")?.focus({ preventScroll: true });
  }

  function containWindowListFocus(event) {
    if (!feature.windowList.hidden && dependencies.palette().commandPalette.hidden
      && ![...platform.document.querySelectorAll(".settings-modal")].some(modal => !modal.hidden)
      && !feature.windowList.contains(event.target)) feature.windowListPanel.focus();
  }

  function setWindowListSelection(index) {
    if (feature.windowListEntries.length === 0) {
      return;
    }
    feature.windowListSelection = (index + feature.windowListEntries.length) % feature.windowListEntries.length;
    const rows = feature.windowListItems.querySelectorAll(".window-list-item");
    rows.forEach((row, rowIndex) => row.classList.toggle("is-selected", rowIndex === feature.windowListSelection));
    rows[feature.windowListSelection]?.scrollIntoView({ block: "nearest" });
  }

  function selectWindowListEntry(index = feature.windowListSelection) {
    const rect = feature.windowListEntries[index];
    if (!rect) {
      return;
    }
    feature.hideWindowList();
    dependencies.geometry().setMinimized(rect, false);
    dependencies.desktop().setActivePane(rect, { raise: true, focus: true });
  }

  function handleWindowListKeyboard(event) {
    if (event.defaultPrevented) return;
    if (feature.windowListDrag?.started) {
      if (event.key === "Escape") {
        feature.windowListDrag.canceled = true;
        feature.clearWindowListDropIndicator();
        feature.windowListItems.querySelectorAll(".is-dragging").forEach(row => row.classList.remove("is-dragging"));
        feature.windowListItems.classList.remove("is-reordering");
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const controls = [...feature.windowListPanel.querySelectorAll("button:not(:disabled)")];
      const current = controls.indexOf(platform.document.activeElement);
      if (current < 0 || (event.shiftKey ? current === 0 : current === controls.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (event.altKey || (event.shiftKey && !event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (event.ctrlKey || event.metaKey) {
        feature.moveWindowInOrder(feature.windowListEntries[feature.windowListSelection], direction);
      } else {
        feature.setWindowListSelection(feature.windowListSelection + direction);
        feature.windowListItems.querySelectorAll(".window-list-name")[feature.windowListSelection]?.focus();
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && event.target === feature.windowListPanel) {
      event.preventDefault();
      feature.selectWindowListEntry();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      feature.hideWindowList();
    }
  }

  function initializeWindowList() {
    feature.windowList = platform.document.createElement("div");
    feature.windowList.className = "command-palette window-list";
    feature.windowList.hidden = true;
    feature.windowListPanel = platform.document.createElement("div");
    feature.windowListPanel.className = "command-palette-panel window-list-panel";
    feature.windowListPanel.tabIndex = 0;
    feature.windowListPanel.setAttribute("role", "dialog");
    feature.windowListPanel.setAttribute("aria-modal", "true");
    feature.windowListPanel.setAttribute("aria-labelledby", "window-list-title");
    feature.windowListPanel.setAttribute("aria-describedby", "window-list-hint");
    feature.windowListTitle = platform.document.createElement("div");
    feature.windowListTitle.className = "window-list-title";
    feature.windowListHeading = platform.document.createElement("span");
    feature.windowListHeading.id = "window-list-title";
    feature.windowListHeading.textContent = "Window List";
    feature.windowListClose = platform.document.createElement("button");
    feature.windowListClose.type = "button";
    feature.windowListClose.className = "settings-close";
    feature.windowListClose.textContent = "X";
    feature.windowListClose.setAttribute("aria-label", "Close window list");
    feature.windowListClose.addEventListener("click", feature.hideWindowList);
    feature.windowListTitle.append(feature.windowListHeading, feature.windowListClose);
    feature.windowListItems = platform.document.createElement("div");
    feature.windowListItems.className = "command-palette-list window-list-items";
    platform.document.addEventListener("pointermove", feature.updateWindowListDrop);
    platform.document.addEventListener("pointerup", feature.dropWindowListEntry);
    platform.document.addEventListener("pointercancel", (event) => {
      if (feature.windowListDrag?.pointerID === event.pointerId) feature.clearWindowListDrag();
    });
    feature.windowListItems.addEventListener("lostpointercapture", (event) => {
      if (feature.windowListDrag?.pointerID === event.pointerId) feature.clearWindowListDrag();
    });
    feature.windowListHint = platform.document.createElement("p");
    feature.windowListHint.id = "window-list-hint";
    feature.windowListHint.className = "window-list-hint";
    feature.windowListHint.textContent = "Drag rows to reorder · ↑/↓ selects · Enter opens · Ctrl/Cmd+↑/↓ reorders";
    feature.windowListStatus = platform.document.createElement("div");
    feature.windowListStatus.className = "window-list-status";
    feature.windowListStatus.setAttribute("role", "status");
    feature.windowListPanel.append(feature.windowListTitle, feature.windowListItems, feature.windowListHint, feature.windowListStatus);
    feature.windowList.appendChild(feature.windowListPanel);
    platform.document.body.appendChild(feature.windowList);
    feature.windowList.addEventListener("pointerdown", (event) => {
      if (event.target === feature.windowList) {
        feature.hideWindowList();
      }
    });
    feature.windowListPanel.addEventListener("keydown", feature.handleWindowListKeyboard);
  }

  function initializeWindowListEntries() {
    feature.windowListEntries = [];
    feature.windowListSelection = 0;
    feature.windowListDrag = null;
  }

  Object.assign(feature, {
    toggleWindowList,
    openWindowList,
    hideWindowList,
    renderWindowList,
    moveWindowInOrder,
    finishWindowOrderMove,
    startWindowListDrag,
    clearWindowListDropIndicator,
    clearWindowListDrag,
    updateWindowListDrop,
    updateWindowListDropIndicator,
    scrollWindowListDrag,
    dropWindowListEntry,
    containWindowListFocus,
    setWindowListSelection,
    selectWindowListEntry,
    handleWindowListKeyboard,
    initializeWindowList,
    initializeWindowListEntries,
  });
  return feature;
}
