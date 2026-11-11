// Browser/desktop event registration and application startup wiring.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   browser: () => ReturnType<typeof import("./browser-view.mjs").createBrowser>,
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   connectivity: () => ReturnType<typeof import("./server-connectivity.mjs").createConnectivity>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   rdpView: () => ReturnType<typeof import("./rdp-view.mjs").createRdpView>,
 *   sessionList: () => ReturnType<typeof import("./session-list-view.mjs").createSessionList>,
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   vnc: () => ReturnType<typeof import("./vnc-view.mjs").createVnc>,
 *   windows: () => ReturnType<typeof import("./window-list-view.mjs").createWindows>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createEvents(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    controlClickPending: undefined,
  };

  function registerFocus() {
    platform.window.addEventListener("focus", () => {
      dependencies.connectivity().checkForBrowserWake();
      void dependencies.clipboard().refreshClipboardBridgeAndPrompt();
      dependencies.terminal().updateTerminalFocus();
    });
  }

  function registerDesktopEvents() {
    dependencies.desktop().board.addEventListener("pointerdown", dependencies.interactions().startDrawing);
    dependencies.desktop().board.addEventListener("pointerdown", (event) => {
      if (event.button === 1) dependencies.interactions().startDrawing(event);
    }, { capture: true });
    dependencies.desktop().board.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, { capture: true });
    dependencies.desktop().board.addEventListener("lostpointercapture", (event) => {
      if (dependencies.interactions().interaction?.type === "draw" && dependencies.interactions().interaction.id === event.pointerId) {
        dependencies.interactions().finishInteraction({ pointerId: event.pointerId, type: "pointercancel" });
      }
    });
    // macOS turns Control-click into a contextmenu event. Only a real secondary
    // button opens Tessera's menus, so swallow the Control-click variant before
    // any menu handler (or the native menu) sees it. Terminals decide for
    // themselves, since a mouse-aware program should still hear the click.
    feature.controlClickPending = false;
    platform.document.addEventListener("pointerdown", (event) => {
      feature.controlClickPending = dependencies.interactions().appleKeyboardLayout && event.button === 0 && event.ctrlKey;
    }, { capture: true });
    platform.document.addEventListener("contextmenu", (event) => {
      if (event.target?.closest?.(".terminal-container")) {
        feature.controlClickPending = false;
        return;
      }
      const controlClick = feature.controlClickPending || (dependencies.interactions().appleKeyboardLayout && event.button === 0 && event.ctrlKey);
      feature.controlClickPending = false;
      if (!controlClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    dependencies.desktop().board.addEventListener("contextmenu", dependencies.menus().openWorkspaceMenu);
    platform.document.addEventListener("pointerdown", dependencies.menus().hideMenusWhenOutside);
    platform.document.addEventListener("keydown", dependencies.menus().hideMenusOnEscape);
    platform.document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && dependencies.interactions().interaction?.type === "draw" && dependencies.interactions().interaction.button === 1) {
        event.preventDefault();
        event.stopPropagation();
        dependencies.interactions().finishInteraction({ pointerId: dependencies.interactions().interaction.id, type: "pointercancel" });
        dependencies.menus().hideAllMenus();
      }
    }, { capture: true });
    platform.document.addEventListener("keydown", dependencies.settings().handleSettingsKeyboard, { capture: true });
    platform.document.addEventListener("focusin", dependencies.settings().containSettingsFocus);
    platform.document.addEventListener("focusin", dependencies.windows().containWindowListFocus);
    platform.document.addEventListener("focusin", dependencies.sessionList().containSessionListFocus);
    platform.document.addEventListener("keydown", dependencies.interactions().handlePaneKeyboardShortcuts, { capture: true });
    platform.document.addEventListener("keyup", dependencies.switcher().handleWindowSwitcherKeyup, { capture: true });
    platform.document.addEventListener("visibilitychange", dependencies.connectivity().handleDocumentVisibilityChange);
    platform.window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      dependencies.connectivity().browserWakePending = true;
      dependencies.connectivity().checkForBrowserWake();
    });
    // pagehide is the one teardown event that also fires when a tab is discarded
    // or frozen, where unload does not.
    platform.window.addEventListener("pagehide", dependencies.workspace().saveWorkspaceOnExit);
    platform.window.addEventListener("pagehide", dependencies.preferences().saveUserSettingsOnExit);
    platform.window.addEventListener("pagehide", () => {
      dependencies.navigation().shortcutsUI.close();
      for (const rect of dependencies.desktop().rectangles) {
        dependencies.vnc().disposeVNCPane(rect);
        dependencies.rdpView().disposeRDPPane(rect);
        rect.terminal?.files?.dispose();
      }
    });
    platform.window.addEventListener("pointermove", dependencies.interactions().continueInteraction);
    platform.window.addEventListener("pointerup", dependencies.interactions().finishInteraction);
    platform.window.addEventListener("pointercancel", dependencies.interactions().finishInteraction);
    // Focus moving into a Browser pane's frame blurs this page too. The switcher
    // then stays up as for any other window, until its timer or the modifier's
    // release, which the frame relays.
    platform.window.addEventListener("blur", () => {
      platform.window.setTimeout(() => {
        if (!platform.document.activeElement?.classList.contains("browser-frame")) dependencies.switcher().hideWindowSwitcher();
      }, 0);
    });
    platform.window.addEventListener("blur", () => dependencies.terminal().updateTerminalFocus());
    platform.window.addEventListener("blur", () => {
      if (dependencies.interactions().interaction?.type === "draw" && dependencies.interactions().interaction.button === 1) {
        dependencies.interactions().finishInteraction({ pointerId: dependencies.interactions().interaction.id, type: "pointercancel" });
      }
    });
    platform.window.addEventListener("resize", dependencies.menus().hideAllMenus);
    platform.window.addEventListener("popstate", () => void dependencies.navigation().handleSessionHistoryNavigation());
    platform.window.addEventListener("message", dependencies.browser().handleBrowserPaneMessage);

  }

  Object.assign(feature, {
    registerFocus,
    registerDesktopEvents,
  });
  return feature;
}
