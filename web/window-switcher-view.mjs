import { focusPane } from "./pane-activation.mjs";
import { windowSwitcherEntries } from "./window-switcher.mjs";
import { terminalAttentionLabel } from "./terminal-attention.mjs";

// Transient window-switcher presentation and overlay focus restoration.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   help: () => ReturnType<typeof import("./help-dialog.mjs").createHelp>,
 *   https: () => ReturnType<typeof import("./local-https-dialog.mjs").createHttps>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   palette: () => ReturnType<typeof import("./command-palette.mjs").createPalette>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   sessionList: () => ReturnType<typeof import("./session-list-view.mjs").createSessionList>,
 *   sessionsDialog: () => ReturnType<typeof import("./sessions-dialog.mjs").createSessionsDialog>,
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   windows: () => ReturnType<typeof import("./window-list-view.mjs").createWindows>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createSwitcher(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    windowSwitcher: undefined,
    windowSwitcherPanel: undefined,
    windowSwitcherHeader: undefined,
    windowSwitcherTitle: undefined,
    windowSwitcherPosition: undefined,
    windowSwitcherList: undefined,
    windowSwitcherHideTimer: undefined,
  };

  function restorePaneFocusAfterOverlayDismiss(overlay) {
    platform.window.requestAnimationFrame(() => {
      // One overlay can hand off to another in the same tick (running Window
      // List from the command palette). The overlay that is still open owns
      // keyboard focus, so returning it to the pane would swallow its arrow keys.
      if ([dependencies.palette().commandPalette, dependencies.windows().windowList, dependencies.sessionList().sessionList, dependencies.settings().settingsModal, dependencies.https().localHTTPSModal,
        dependencies.desktop().renameWindowModal, dependencies.sessionsDialog().sessionsModal, dependencies.sessionsDialog().sessionActionModal, dependencies.help().helpModal, dependencies.navigation().shortcutsUI.element, dependencies.preferences().screensaver.element].some(modal => !modal.hidden)) {
        return;
      }
      const focused = platform.document.activeElement;
      if (overlay.hidden && (overlay.contains(focused) || focused === platform.document.body)) {
        focusPane(dependencies.desktop().getActivePane());
      }
    });
  }

  function showWindowSwitcher(options = {}) {
    const entries = windowSwitcherEntries(dependencies.desktop().rectangles, dependencies.desktop().activePaneID, options);
    if (entries.length === 0) {
      feature.hideWindowSwitcher();
      return;
    }

    feature.windowSwitcherList.replaceChildren();
    let activeRow = null;
    for (const entry of entries) {
      const row = platform.document.createElement("div");
      row.className = "window-switcher-item";
      row.dataset.paneId = entry.id;
      if (entry.active) {
        row.classList.add("is-selected");
        activeRow = row;
        feature.windowSwitcherPosition.textContent = `${entry.position} of ${entry.total}`;
      }
      const order = platform.document.createElement("span");
      order.className = "window-switcher-order";
      order.textContent = String(entry.position);
      const name = platform.document.createElement("span");
      name.className = "window-switcher-name";
      name.textContent = `${entry.name}${entry.pane.minimized ? " (minimized)" : ""}${terminalAttentionLabel(entry.pane.terminalAttention)}`;
      row.append(order, name);
      feature.windowSwitcherList.appendChild(row);
    }

    feature.windowSwitcher.hidden = false;
    platform.window.clearTimeout(feature.windowSwitcherHideTimer);
    feature.windowSwitcherHideTimer = platform.window.setTimeout(feature.hideWindowSwitcher, 1200);
    activeRow?.scrollIntoView({ block: "nearest" });
  }

  function hideWindowSwitcher() {
    platform.window.clearTimeout(feature.windowSwitcherHideTimer);
    feature.windowSwitcherHideTimer = null;
    feature.windowSwitcher.hidden = true;
  }

  function handleWindowSwitcherKeyup(event) {
    if (event.key === "Control" || event.key === "Meta") {
      feature.hideWindowSwitcher();
    }
  }

  function initializeWindowSwitcher() {
    feature.windowSwitcher = platform.document.createElement("div");
    feature.windowSwitcher.className = "window-switcher";
    feature.windowSwitcher.hidden = true;
    feature.windowSwitcherPanel = platform.document.createElement("section");
    feature.windowSwitcherPanel.className = "window-switcher-panel";
    feature.windowSwitcherPanel.setAttribute("role", "status");
    feature.windowSwitcherPanel.setAttribute("aria-live", "polite");
    feature.windowSwitcherHeader = platform.document.createElement("div");
    feature.windowSwitcherHeader.className = "window-switcher-header";
    feature.windowSwitcherTitle = platform.document.createElement("span");
    feature.windowSwitcherTitle.textContent = "Windows";
    feature.windowSwitcherPosition = platform.document.createElement("span");
    feature.windowSwitcherPosition.className = "window-switcher-position";
    feature.windowSwitcherHeader.append(feature.windowSwitcherTitle, feature.windowSwitcherPosition);
    feature.windowSwitcherList = platform.document.createElement("div");
    feature.windowSwitcherList.className = "window-switcher-list";
    feature.windowSwitcherPanel.append(feature.windowSwitcherHeader, feature.windowSwitcherList);
    feature.windowSwitcher.appendChild(feature.windowSwitcherPanel);
    platform.document.body.appendChild(feature.windowSwitcher);
  }

  function initializeWindowSwitcherHideTimer() {
    feature.windowSwitcherHideTimer = null;
  }

  Object.assign(feature, {
    restorePaneFocusAfterOverlayDismiss,
    showWindowSwitcher,
    hideWindowSwitcher,
    handleWindowSwitcherKeyup,
    initializeWindowSwitcher,
    initializeWindowSwitcherHideTimer,
  });
  return feature;
}
