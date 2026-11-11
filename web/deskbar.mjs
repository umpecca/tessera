

// Deskbar rendering, keyboard navigation and window selection.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   phone: () => ReturnType<typeof import("./phone-workspace.mjs").createPhone>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   sessionsDialog: () => ReturnType<typeof import("./sessions-dialog.mjs").createSessionsDialog>,
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   windows: () => ReturnType<typeof import("./window-list-view.mjs").createWindows>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createDeskbar(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    deskbarButton: undefined,
    deskbarPanel: undefined,
  };

  // The Deskbar lists windows and restores minimized panes in place.
  function toggleDeskbar() {
    if (feature.deskbarPanel.hidden) {
      feature.openDeskbar();
    } else {
      feature.hideDeskbar();
    }
  }

  function openDeskbar(options = {}) {
    dependencies.menus().hideAllMenus();
    feature.renderDeskbar();
    feature.deskbarPanel.hidden = false;
    feature.deskbarButton.setAttribute("aria-expanded", "true");
    if (Number.isInteger(options.focusWindow)) {
      platform.window.requestAnimationFrame(() => feature.focusDeskbarWindow(options.focusWindow));
    }
  }

  function hideDeskbar() {
    feature.deskbarPanel.hidden = true;
    feature.deskbarButton.setAttribute("aria-expanded", "false");
  }

  function toggleDeskbarButton() {
    dependencies.preferences().deskbarButtonEnabled = !dependencies.preferences().deskbarButtonEnabled;
    if (!dependencies.preferences().deskbarButtonEnabled) {
      feature.hideDeskbar();
    }
    feature.updateDeskbar();
    dependencies.workspace().scheduleUserSettingsSave();
  }

  function focusDeskbarWindow(index) {
    const buttons = Array.from(feature.deskbarPanel.querySelectorAll(".workspace-menu-name"));
    if (buttons.length === 0) {
      return;
    }
    const normalizedIndex = ((index % buttons.length) + buttons.length) % buttons.length;
    buttons[normalizedIndex].focus();
  }

  function handleDeskbarKeyboard(event) {
    const row = event.target.closest(".workspace-menu-row");
    if (!row || !feature.deskbarPanel.contains(row)) {
      if (event.key === "Escape") {
        event.preventDefault();
        feature.hideDeskbar();
        feature.deskbarButton.focus();
      }
      return;
    }

    const rows = Array.from(feature.deskbarPanel.querySelectorAll(".workspace-menu-row"));
    const rowIndex = rows.indexOf(row);
    const windowButton = row.querySelector(".workspace-menu-name");
    const destroyButton = row.querySelector(".workspace-menu-destroy");

    if (event.key === "ArrowRight" && event.target === windowButton) {
      event.preventDefault();
      destroyButton?.focus();
      return;
    }
    if (event.key === "ArrowLeft" && event.target === destroyButton) {
      event.preventDefault();
      windowButton?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      feature.focusDeskbarWindow(rowIndex + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      feature.focusDeskbarWindow(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      feature.focusDeskbarWindow(-1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      feature.hideDeskbar();
      feature.deskbarButton.focus();
    }
  }

  function updateDeskbar() {
    if (dependencies.phone().phoneView.active) dependencies.phone().phoneView.panesChanged();
    const activePane = dependencies.desktop().getActivePane();
    const hideForFocusedFullscreenPane = Boolean(activePane?.isFull && !activePane.minimized);
    feature.deskbarButton.hidden = !dependencies.preferences().deskbarButtonEnabled || hideForFocusedFullscreenPane;
    if (feature.deskbarButton.hidden) {
      feature.hideDeskbar();
    }
    const minimizedCount = dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending" && rect.minimized).length;
    feature.deskbarButton.dataset.minimizedCount = String(minimizedCount);
    const fileCount = dependencies.desktop().rectangles.reduce((count, rect) => count + (rect.filePendingCount || 0), 0);
    feature.deskbarButton.dataset.fileCount = String(fileCount);
    feature.deskbarButton.title = fileCount ? `${fileCount} pending file transfer${fileCount === 1 ? "" : "s"}` : "Window list";
    feature.deskbarButton.dataset.attention = String(dependencies.desktop().rectangles.some((rect) => rect.terminalAttention));
    feature.deskbarButton.setAttribute("aria-label", minimizedCount === 1
      ? "Window list, 1 minimized window"
      : minimizedCount > 1
        ? `Window list, ${minimizedCount} minimized windows`
        : "Window list");
    if (!feature.deskbarPanel.hidden) {
      feature.renderDeskbar();
    }
    if (!dependencies.windows().windowList.hidden) {
      dependencies.windows().renderWindowList();
    }
  }

  // The Deskbar keeps window recovery and a small set of workspace controls in
  // one corner, without duplicating the command palette as a general launcher.
  function renderDeskbar() {
    feature.deskbarPanel.replaceChildren();

    const title = platform.document.createElement("div");
    title.className = "deskbar-title";
    const titleText = platform.document.createElement("span");
    titleText.textContent = "Windows";
    title.appendChild(titleText);
    const minimizedCount = dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending" && rect.minimized).length;
    const count = platform.document.createElement("span");
    count.className = "deskbar-user";
    count.textContent = minimizedCount === 1 ? "1 minimized" : `${minimizedCount} minimized`;
    title.appendChild(count);
    feature.deskbarPanel.appendChild(title);
    const panes = dependencies.desktop().rectangles.filter((rect) => rect.kind !== "pending");
    if (panes.length === 0) {
      const empty = platform.document.createElement("button");
      empty.type = "button";
      empty.textContent = "No windows";
      empty.disabled = true;
      feature.deskbarPanel.appendChild(empty);
    }
    for (const rect of panes) {
      const row = platform.document.createElement("div");
      row.className = "workspace-menu-row";
      row.dataset.paneId = rect.id;
      if (rect.id === dependencies.desktop().activePaneID) {
        row.classList.add("is-active");
      }
      if (rect.minimized) {
        row.classList.add("is-minimized");
      }

      const button = platform.document.createElement("button");
      button.type = "button";
      button.className = "workspace-menu-name";
      button.textContent = dependencies.menus().workspaceMenuLabel(rect);
      button.title = rect.cwd ? `${button.textContent} (${rect.cwd})` : button.textContent;
      button.addEventListener("click", () => {
        feature.hideDeskbar();
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
        dependencies.desktop().destroyRectangle(rect, { closeServerTerminal: true });
      });

      row.appendChild(button);
      row.appendChild(destroyButton);
      feature.deskbarPanel.appendChild(row);
    }

    const separator = platform.document.createElement("div");
    separator.className = "dock-menu-separator";
    feature.deskbarPanel.appendChild(separator);
    const sessionsButton = platform.document.createElement("button");
    sessionsButton.type = "button";
    sessionsButton.className = "deskbar-settings";
    sessionsButton.textContent = dependencies.navigation().currentSessionName ? `Sessions (${dependencies.navigation().currentSessionName})...` : "Sessions...";
    sessionsButton.addEventListener("click", () => void dependencies.sessionsDialog().openSessionsModal());
    feature.deskbarPanel.appendChild(sessionsButton);
    // A phone that chose the desktop view needs a way back it can tap: the
    // palette wants a keyboard and the workspace menu a right-click.
    const phoneViewButton = platform.document.createElement("button");
    phoneViewButton.type = "button";
    phoneViewButton.className = "deskbar-settings";
    phoneViewButton.textContent = "Phone View";
    phoneViewButton.addEventListener("click", () => {
      feature.hideDeskbar();
      dependencies.phone().setPhoneViewOverride("phone");
    });
    feature.deskbarPanel.appendChild(phoneViewButton);
    const settingsButton = platform.document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "deskbar-settings";
    settingsButton.textContent = "Settings...";
    settingsButton.addEventListener("click", dependencies.settings().openSettingsModal);
    feature.deskbarPanel.appendChild(settingsButton);
  }

  function initializeDeskbarButton() {
    // The Deskbar is a compact, always-reachable recovery point for minimized
    // panes. The command palette stays separate as the keyboard-first action UI.
    feature.deskbarButton = platform.document.createElement("button");
    feature.deskbarButton.type = "button";
    feature.deskbarButton.className = "deskbar-button";
    feature.deskbarButton.title = "Windows";
    feature.deskbarButton.setAttribute("aria-label", "Window list");
    feature.deskbarButton.setAttribute("aria-haspopup", "true");
    feature.deskbarButton.setAttribute("aria-expanded", "false");
    feature.deskbarButton.dataset.minimizedCount = "0";
    feature.deskbarButton.addEventListener("click", () => feature.toggleDeskbar());
    feature.deskbarButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }
      event.preventDefault();
      feature.openDeskbar({ focusWindow: event.key === "ArrowDown" ? 0 : -1 });
    });
    platform.document.body.appendChild(feature.deskbarButton);
    feature.deskbarPanel = platform.document.createElement("div");
    feature.deskbarPanel.className = "dock-menu deskbar-panel";
    feature.deskbarPanel.hidden = true;
    feature.deskbarPanel.addEventListener("keydown", feature.handleDeskbarKeyboard);
    platform.document.body.appendChild(feature.deskbarPanel);
  }

  Object.assign(feature, {
    toggleDeskbar,
    openDeskbar,
    hideDeskbar,
    toggleDeskbarButton,
    focusDeskbarWindow,
    handleDeskbarKeyboard,
    updateDeskbar,
    renderDeskbar,
    initializeDeskbarButton,
  });
  return feature;
}
