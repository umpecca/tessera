

// Session list selection and focus/keyboard interaction.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   sessionsDialog: () => ReturnType<typeof import("./sessions-dialog.mjs").createSessionsDialog>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createSessionList(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    sessionList: undefined,
    sessionListPanel: undefined,
    sessionListTitle: undefined,
    sessionListHeading: undefined,
    sessionListManage: undefined,
    sessionListClose: undefined,
    sessionListItems: undefined,
    sessionListHint: undefined,
    sessionListStatus: undefined,
    sessionListEntries: undefined,
    sessionListSelection: undefined,
  };

  function toggleSessionList() {
    if (feature.sessionList.hidden) {
      void feature.openSessionList();
    } else {
      feature.hideSessionList();
    }
  }

  async function openSessionList() {
    if (!dependencies.navigation().userSelect.hidden) {
      return;
    }
    dependencies.menus().hideAllMenus();
    feature.sessionList.hidden = false;
    feature.sessionListStatus.textContent = "";
    // Show the sessions already loaded at once, then refresh them in place.
    feature.renderSessionList(null);
    platform.window.requestAnimationFrame(() => {
      if (!feature.sessionList.hidden) feature.sessionListPanel.focus();
    });
    try {
      await dependencies.navigation().refreshSessions();
    } catch (error) {
      platform.console.warn(error);
      if (!feature.sessionList.hidden) feature.sessionListStatus.textContent = "Could not refresh sessions.";
      return;
    }
    if (!feature.sessionList.hidden) feature.renderSessionList();
  }

  function hideSessionList() {
    const restorePaneFocus = !feature.sessionList.hidden && feature.sessionList.contains(platform.document.activeElement);
    feature.sessionList.hidden = true;
    if (restorePaneFocus) {
      dependencies.switcher().restorePaneFocusAfterOverlayDismiss(feature.sessionList);
    }
  }

  // Sessions arrive most recently opened first, so the current session leads
  // and the one before it is second. A fresh list selects that previous
  // session: Ctrl/Cmd+; then Enter flips between the last two.
  function renderSessionList(selectedSessionID = feature.sessionListEntries[feature.sessionListSelection]?.id) {
    const focused = feature.sessionListItems.contains(platform.document.activeElement);
    feature.sessionListEntries = [...dependencies.navigation().sessions];
    let index = feature.sessionListEntries.findIndex((session) => session.id === selectedSessionID);
    if (index < 0) index = feature.sessionListEntries.findIndex((session) => session.id !== dependencies.navigation().currentSessionID);
    feature.sessionListSelection = Math.max(0, index);
    feature.sessionListItems.replaceChildren();

    if (feature.sessionListEntries.length === 0) {
      const empty = platform.document.createElement("div");
      empty.className = "command-palette-empty";
      empty.textContent = "No sessions";
      feature.sessionListItems.appendChild(empty);
      return;
    }

    feature.sessionListEntries.forEach((session, index) => {
      const current = session.id === dependencies.navigation().currentSessionID;
      const row = platform.document.createElement("div");
      row.className = "command-palette-item window-list-item session-list-item";
      row.dataset.sessionId = session.id;
      const name = platform.document.createElement("button");
      name.type = "button";
      name.className = "window-list-name";
      name.textContent = `${index + 1}. ${session.name}`;
      name.setAttribute("aria-label", current ? `${name.textContent} (current)` : name.textContent);
      name.addEventListener("click", () => feature.selectSessionListEntry(index));
      row.appendChild(name);
      if (current) {
        const state = platform.document.createElement("span");
        state.className = "session-list-state";
        state.textContent = "Current";
        row.appendChild(state);
      }
      row.addEventListener("pointermove", () => feature.setSessionListSelection(index));
      row.addEventListener("focusin", () => feature.setSessionListSelection(index));
      feature.sessionListItems.appendChild(row);
    });
    feature.setSessionListSelection(feature.sessionListSelection);
    if (focused) {
      feature.sessionListItems.querySelectorAll(".window-list-name")[feature.sessionListSelection]?.focus({ preventScroll: true });
    }
  }

  function containSessionListFocus(event) {
    if (!feature.sessionList.hidden && !feature.sessionList.contains(event.target)) feature.sessionListPanel.focus();
  }

  function setSessionListSelection(index) {
    if (feature.sessionListEntries.length === 0) {
      return;
    }
    feature.sessionListSelection = (index + feature.sessionListEntries.length) % feature.sessionListEntries.length;
    const rows = feature.sessionListItems.querySelectorAll(".session-list-item");
    rows.forEach((row, rowIndex) => row.classList.toggle("is-selected", rowIndex === feature.sessionListSelection));
    rows[feature.sessionListSelection]?.scrollIntoView({ block: "nearest" });
  }

  function selectSessionListEntry(index = feature.sessionListSelection) {
    const session = feature.sessionListEntries[index];
    if (!session) {
      return;
    }
    feature.hideSessionList();
    if (session.id !== dependencies.navigation().currentSessionID) void dependencies.navigation().switchSession(session);
  }

  function handleSessionListKeyboard(event) {
    if (event.defaultPrevented) return;
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const controls = [...feature.sessionListPanel.querySelectorAll("button:not(:disabled)")];
      const current = controls.indexOf(platform.document.activeElement);
      if (current < 0 || (event.shiftKey ? current === 0 : current === controls.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      feature.setSessionListSelection(feature.sessionListSelection + (event.key === "ArrowDown" ? 1 : -1));
      feature.sessionListItems.querySelectorAll(".window-list-name")[feature.sessionListSelection]?.focus();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && event.target === feature.sessionListPanel) {
      event.preventDefault();
      feature.selectSessionListEntry();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      feature.hideSessionList();
    }
  }

  function initializeSessionList() {
    // Session List switches sessions from the keyboard the way Window List
    // switches windows. The Sessions dialog still creates, renames and destroys.
    feature.sessionList = platform.document.createElement("div");
    feature.sessionList.className = "command-palette window-list session-list";
    feature.sessionList.hidden = true;
    feature.sessionListPanel = platform.document.createElement("div");
    feature.sessionListPanel.className = "command-palette-panel window-list-panel";
    feature.sessionListPanel.tabIndex = 0;
    feature.sessionListPanel.setAttribute("role", "dialog");
    feature.sessionListPanel.setAttribute("aria-modal", "true");
    feature.sessionListPanel.setAttribute("aria-labelledby", "session-list-title");
    feature.sessionListPanel.setAttribute("aria-describedby", "session-list-hint");
    feature.sessionListTitle = platform.document.createElement("div");
    feature.sessionListTitle.className = "window-list-title";
    feature.sessionListHeading = platform.document.createElement("span");
    feature.sessionListHeading.id = "session-list-title";
    feature.sessionListHeading.className = "session-list-heading";
    feature.sessionListHeading.textContent = "Session List";
    feature.sessionListManage = platform.document.createElement("button");
    feature.sessionListManage.type = "button";
    feature.sessionListManage.className = "session-list-manage";
    feature.sessionListManage.textContent = "Manage...";
    feature.sessionListManage.addEventListener("click", () => void dependencies.sessionsDialog().openSessionsModal());
    feature.sessionListClose = platform.document.createElement("button");
    feature.sessionListClose.type = "button";
    feature.sessionListClose.className = "settings-close";
    feature.sessionListClose.textContent = "X";
    feature.sessionListClose.setAttribute("aria-label", "Close session list");
    feature.sessionListClose.addEventListener("click", feature.hideSessionList);
    feature.sessionListTitle.append(feature.sessionListHeading, feature.sessionListManage, feature.sessionListClose);
    feature.sessionListItems = platform.document.createElement("div");
    feature.sessionListItems.className = "command-palette-list window-list-items";
    feature.sessionListHint = platform.document.createElement("p");
    feature.sessionListHint.id = "session-list-hint";
    feature.sessionListHint.className = "window-list-hint";
    feature.sessionListHint.textContent = "Most recent first · ↑/↓ selects · Enter opens";
    feature.sessionListStatus = platform.document.createElement("div");
    feature.sessionListStatus.className = "window-list-status";
    feature.sessionListStatus.setAttribute("role", "status");
    feature.sessionListPanel.append(feature.sessionListTitle, feature.sessionListItems, feature.sessionListHint, feature.sessionListStatus);
    feature.sessionList.appendChild(feature.sessionListPanel);
    platform.document.body.appendChild(feature.sessionList);
    feature.sessionList.addEventListener("pointerdown", (event) => {
      if (event.target === feature.sessionList) {
        feature.hideSessionList();
      }
    });
    feature.sessionListPanel.addEventListener("keydown", feature.handleSessionListKeyboard);
  }

  function initializeSessionListEntries() {
    feature.sessionListEntries = [];
    feature.sessionListSelection = 0;
  }

  Object.assign(feature, {
    toggleSessionList,
    openSessionList,
    hideSessionList,
    renderSessionList,
    containSessionListFocus,
    setSessionListSelection,
    selectSessionListEntry,
    handleSessionListKeyboard,
    initializeSessionList,
    initializeSessionListEntries,
  });
  return feature;
}
