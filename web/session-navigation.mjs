import { ShortcutsModal } from "./shortcuts.mjs";
import { SignInRecovery, signOut } from "./sign-in.mjs";
import { normalizeTerminalTERM, normalizeTerminalRowSpacing } from "./terminal-settings.mjs";
import { normalizeTerminalFont } from "./terminal-font.mjs";
import { normalizeTerminalColorMode } from "./terminal-colors.mjs";
import { focusPane } from "./pane-activation.mjs";
import { terminalIsCovered } from "./terminal-visibility.mjs";
import { normalizeWheelSensitivity } from "./wheel-sensitivity.mjs";

// Account/session routes, startup and navigation transactions.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   background: () => ReturnType<typeof import("./workspace-background.mjs").createBackground>,
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   connectivity: () => ReturnType<typeof import("./server-connectivity.mjs").createConnectivity>,
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   https: () => ReturnType<typeof import("./local-https-dialog.mjs").createHttps>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   palette: () => ReturnType<typeof import("./command-palette.mjs").createPalette>,
 *   phone: () => ReturnType<typeof import("./phone-workspace.mjs").createPhone>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   sessionsDialog: () => ReturnType<typeof import("./sessions-dialog.mjs").createSessionsDialog>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createNavigation(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    workspaceID: undefined,
    multiUser: undefined,
    userRoster: undefined,
    authMode: undefined,
    signedInAccount: undefined,
    signInRecovery: undefined,
    currentUser: undefined,
    userSelectionRequestID: undefined,
    sessions: undefined,
    currentSessionID: undefined,
    currentSessionName: undefined,
    userStorageKey: undefined,
    userSelect: undefined,
    shortcutsUI: undefined,
  };

  function readStoredUser() {
    try {
      return platform.localStorage.getItem(feature.userStorageKey) || "";
    } catch {
      return "";
    }
  }

  function persistUser(name) {
    try {
      if (name) {
        platform.localStorage.setItem(feature.userStorageKey, name);
      } else {
        platform.localStorage.removeItem(feature.userStorageKey);
      }
    } catch {
      // localStorage unavailable; selection still applies for this session
    }
  }

  function sessionRoute(userID, sessionID) {
    return `/users/${encodeURIComponent(userID)}/sessions/${encodeURIComponent(sessionID)}`;
  }

  function parseSessionRoute(pathname = platform.window.location.pathname) {
    const match = pathname.match(/^\/users\/([^/]+)\/sessions\/([^/]+)\/?$/);
    if (!match) {
      return null;
    }
    try {
      return { userID: decodeURIComponent(match[1]), sessionID: decodeURIComponent(match[2]) };
    } catch {
      return null;
    }
  }

  function isAllowedUser(name) {
    return feature.multiUser ? feature.userRoster.includes(name) : name === "default";
  }

  function userAPIPath(resource, user = feature.currentUser || "default") {
    return `/api/users/${encodeURIComponent(user)}/${resource}`;
  }

  // startApp decides between single-user and multi-user startup. A failed or
  // disabled /api/users falls back to the single default workspace so the app
  // still loads.
  async function startApp() {
    try {
      const response = await platform.fetch("/api/users");
      if (response.ok) {
        const config = await response.json();
        feature.multiUser = Boolean(config.enabled) && Array.isArray(config.users) && config.users.length > 0;
        feature.userRoster = feature.multiUser ? config.users : [];
        feature.authMode = typeof config.auth === "string" ? config.auth : "off";
        feature.signedInAccount = typeof config.signedIn === "string" ? config.signedIn : "";
      }
    } catch (error) {
      platform.console.warn(error);
    }

    const routed = feature.parseSessionRoute();
    if (routed && feature.isAllowedUser(routed.userID)) {
      return feature.selectUser(routed.userID, { sessionID: routed.sessionID, historyMode: "replace" });
    }

    if (!feature.multiUser) {
      return feature.selectUser("default", { historyMode: "replace" });
    }
    if (feature.authMode === "file" && feature.signedInAccount) {
      return feature.selectUser(feature.signedInAccount, { historyMode: "replace" });
    }

    const stored = feature.readStoredUser();
    if (stored && feature.userRoster.includes(stored)) {
      return feature.selectUser(stored, { historyMode: "replace" });
    } else {
      feature.showUserSelect();
      return true;
    }
  }

  async function openStartupWorkspace() {
    try {
      if (!await feature.startApp()) {
        feature.showStartupFailure();
        return;
      }
      if (feature.currentUser) await feature.waitForStartupWorkspace();
      else dependencies.preferences().applyTheme(dependencies.preferences().defaultThemeID, { save: false });
      // Keep a fallback for an unavailable early script: a loaded app must still
      // release the gate and remain usable.
      if (platform.window.tesseraStartup) platform.window.tesseraStartup.finish();
      else {
        delete platform.document.documentElement.dataset.startup;
        platform.document.getElementById("startup").hidden = true;
        dependencies.desktop().board.removeAttribute("inert");
        dependencies.desktop().board.removeAttribute("aria-busy");
      }
      dependencies.phone().updatePhoneView();
      if (feature.currentUser && !dependencies.phone().phoneView.active) focusPane(dependencies.desktop().activeRect);
      void dependencies.clipboard().refreshClipboardBridgeAndPrompt();
      dependencies.https().showIPadHTTPGuidanceIfNeeded();
    } catch (error) {
      platform.console.warn(error);
      feature.showStartupFailure();
    } finally {
      dependencies.connectivity().startServerConnectionMonitor();
    }
  }

  function showStartupFailure() {
    if (platform.window.tesseraStartup) {
      platform.window.tesseraStartup.fail();
      return;
    }
    platform.document.documentElement.dataset.startup = "error";
    platform.document.getElementById("startup-message").textContent = "Tessera could not open your workspace. Please reload to try again.";
    platform.document.getElementById("startup-reload").hidden = false;
  }

  async function waitForStartupWorkspace() {
    const deadline = platform.performance.now() + 3000;
    if (dependencies.background().workspaceHasBackground) {
      const image = new platform.Image();
      image.src = dependencies.background().backgroundURL(dependencies.background().workspaceBackgroundVersion);
      let timeout;
      await Promise.race([
        image.decode().catch(() => {}),
        new Promise(resolve => { timeout = platform.window.setTimeout(resolve, 3000); }),
      ]);
      platform.window.clearTimeout(timeout);
    }
    // Visibility:hidden preserves pane dimensions, so fits and initial snapshot
    // paints can finish behind the gate. Hidden/covered terminals need not attach.
    while (!platform.document.hidden && platform.performance.now() < deadline) {
      const ready = dependencies.desktop().rectangles.every(rect => {
        if (rect.kind !== "terminal" || rect.minimized || terminalIsCovered(rect, dependencies.desktop().rectangles)) return true;
        const state = rect.terminal;
        return Boolean(state?.replica?.cursor?.epoch && !state.replica.needsSnapshot
          && !state.term.fullRedrawPending) || Boolean(rect.terminalStatus);
      });
      if (ready) break;
      await new Promise(resolve => platform.window.setTimeout(resolve, 25));
    }
  }

  async function selectUser(name, options = {}) {
    if (!feature.isAllowedUser(name)) {
      return false;
    }
    const requestID = ++feature.userSelectionRequestID;
    try {
      const [nextSessions, settings, nextShortcuts] = await Promise.all([feature.fetchSessions(name), feature.fetchUserSettings(name), feature.fetchUserShortcuts(name)]);
      const requested = nextSessions.find((session) => session.id === options.sessionID);
      const target = requested || nextSessions[0];
      if (!target) throw new Error("No sessions");
      const workspace = await dependencies.workspace().fetchWorkspace(target.id);
      if (requestID !== feature.userSelectionRequestID) return false;
      const activated = await platform.fetch(`${feature.userAPIPath("sessions", name)}/${encodeURIComponent(target.id)}/activate`, { method: "POST" });
      if (!activated.ok) throw new Error(`activate session failed: ${activated.status}`);
      if (requestID !== feature.userSelectionRequestID) return false;
      feature.currentUser = name;
      feature.sessions = nextSessions;
      feature.applyUserSettings(settings);
      feature.shortcutsUI.setDocument(name, nextShortcuts);
      feature.currentSessionID = target.id;
      feature.currentSessionName = target.name;
      dependencies.workspace().loadWorkspace(workspace);
      feature.persistUser(name);
      feature.hideUserSelect();
      const route = feature.sessionRoute(name, target.id);
      if (options.historyMode === "push") platform.window.history.pushState({}, "", route);
      else if (options.historyMode !== "none") platform.window.history.replaceState({}, "", route);
      return true;
    } catch (error) {
      if (requestID === feature.userSelectionRequestID) {
        platform.console.warn(error);
        dependencies.workspace().setWorkspaceStatus("error", "Could not switch user", error.message);
      }
      return false;
    }
  }

  // Save what is pending before the sign-in ends; later saves would be refused.
  async function signOutOfTessera() {
    try { await dependencies.workspace().flushAllPersistence(); } catch (error) { platform.console.warn(error); }
    await signOut(platform.window);
  }

  async function switchUser() {
    await dependencies.workspace().flushAllPersistence();
    feature.userSelectionRequestID += 1;
    feature.currentUser = null;
    dependencies.preferences().settingsPersistence.reset(null, "");
    feature.currentSessionID = "";
    feature.currentSessionName = "";
    feature.sessions = [];
    feature.persistUser("");
    dependencies.workspace().clearRectanglesForLoad();
    platform.window.history.pushState({}, "", "/");
    dependencies.workspace().setWorkspaceStatus("idle", "Select user");
    feature.showUserSelect();
  }

  // Direct switch to a named user (from the command palette), skipping the
  // selection screen.
  async function jumpToUser(name) {
    if (!feature.userRoster.includes(name) || name === feature.currentUser) {
      return;
    }
    await dependencies.workspace().flushAllPersistence();
    await feature.selectUser(name, { historyMode: "push" });
  }

  async function refreshSessions() {
    feature.sessions = await feature.fetchSessions(feature.currentUser || "default");
    return feature.sessions;
  }

  async function fetchSessions(user) {
    const response = await platform.fetch(feature.userAPIPath("sessions", user));
    if (!response.ok) {
      throw new Error(`load sessions failed: ${response.status}`);
    }
    const payload = await response.json();
    return Array.isArray(payload.sessions) ? payload.sessions : [];
  }

  async function fetchUserShortcuts(user) {
    const response = await platform.fetch(feature.userAPIPath("shortcuts", user));
    if (!response.ok) throw new Error(`Load shortcuts failed (${response.status}).`);
    return response.json();
  }

  function openShortcuts() {
    dependencies.menus().hideAllMenus();
    feature.shortcutsUI.open();
  }

  function invokeShortcut(shortcut) {
    dependencies.menus().hideAllMenus();
    feature.shortcutsUI.invoke(shortcut);
  }

  async function fetchUserSettings(user) {
    const response = await platform.fetch(feature.userAPIPath("settings", user));
    if (!response.ok) {
      throw new Error(`load user settings failed: ${response.status}`);
    }
    return response.json();
  }

  function applyUserSettings(settings) {
    dependencies.preferences().settingsPersistence.reset(feature.currentUser, settings.revision || "");
    const display = dependencies.phone().phoneDevice && settings.phone ? settings.phone : settings;
    dependencies.phone().otherDisplaySettings = dependencies.phone().phoneDevice ? dependencies.preferences().displaySettingsOf(settings) : settings.phone || null;
    dependencies.preferences().defaultPaneFontSize = dependencies.desktop().normalizePaneFontSize(display.defaultPaneFontSize);
    dependencies.preferences().setInterfaceFontSize(display.interfaceFontSize, { save: false });
    dependencies.preferences().defaultTheme = dependencies.preferences().themes[display.defaultTheme] ? display.defaultTheme : dependencies.preferences().defaultThemeID;
    dependencies.preferences().deskbarButtonEnabled = display.deskbarButtonEnabled !== false;
    dependencies.preferences().terminalWheelSensitivity = normalizeWheelSensitivity(display.terminalWheelSensitivity);
    dependencies.preferences().terminalTerm = normalizeTerminalTERM(settings.terminalTerm);
    dependencies.preferences().terminalShellIntegration = settings.terminalShellIntegrationOff !== true;
    dependencies.preferences().terminalFont = normalizeTerminalFont(display.terminalFont);
    dependencies.preferences().applyApplicationFont();
    dependencies.preferences().terminalRowSpacing = normalizeTerminalRowSpacing(display.terminalRowSpacing);
    dependencies.preferences().terminalColorMode = normalizeTerminalColorMode(display.terminalColorMode);
    // Performance capabilities belong to this browser and device. Ignore the
    // legacy account setting so an Older Mac cap cannot follow the user to a
    // newer computer.
    dependencies.preferences().setOlderMacMode(dependencies.preferences().olderMacMode, { save: false });
    dependencies.preferences().setOLEDWindowBorderSize(display.oledWindowBorderSize, { save: false });
    dependencies.preferences().applyTheme(display.themeId || dependencies.preferences().defaultTheme, { save: false });
    dependencies.deskbar().updateDeskbar();
  }

  async function switchSession(session, options = {}) {
    if (!session || dependencies.sessionsDialog().sessionNavigationPending) {
      return;
    }
    if (session.id === feature.currentSessionID) {
      if (options.historyMode === "replace") {
        platform.window.history.replaceState({}, "", feature.sessionRoute(feature.currentUser || "default", session.id));
      }
      dependencies.sessionsDialog().hideSessionsModal();
      return;
    }
    dependencies.sessionsDialog().sessionNavigationPending = true;
    try {
      if (!options.skipSave && feature.currentSessionID) {
        await dependencies.workspace().flushWorkspaceSave();
      }
      const workspace = await dependencies.workspace().fetchWorkspace(session.id);
      const activated = await platform.fetch(`${feature.userAPIPath("sessions")}/${encodeURIComponent(session.id)}/activate`, { method: "POST" });
      if (!activated.ok) {
        throw new Error(`activate session failed: ${activated.status}`);
      }
      // The old workspace remains usable during network requests. Include any
      // edits made while the target was loading before replacing its panes.
      if (!options.skipSave && feature.currentSessionID) {
        await dependencies.workspace().flushWorkspaceSave();
      }
      feature.currentSessionID = session.id;
      feature.currentSessionName = session.name;
      dependencies.workspace().loadWorkspace(workspace);
      const route = feature.sessionRoute(feature.currentUser || "default", session.id);
      if (options.historyMode === "replace") {
        platform.window.history.replaceState({}, "", route);
      } else if (options.historyMode !== "none") {
        platform.window.history.pushState({}, "", route);
      }
      dependencies.sessionsDialog().hideSessionsModal();
      await feature.refreshSessions().catch((error) => {
        platform.console.warn(error);
        dependencies.workspace().setWorkspaceStatus("error", "Session opened; refresh failed", error.message);
      });
    } catch (error) {
      platform.console.warn(error);
      dependencies.workspace().setWorkspaceStatus("error", "Could not switch session", error.message);
      // Back/Forward changes the URL before this handler starts.
      if (options.historyMode === "none" && feature.currentSessionID) {
        platform.window.history.replaceState({}, "", feature.sessionRoute(feature.currentUser || "default", feature.currentSessionID));
      }
      return false;
    } finally {
      dependencies.sessionsDialog().sessionNavigationPending = false;
    }
  }

  async function handleSessionHistoryNavigation() {
    if (dependencies.sessionsDialog().sessionNavigationPending) {
      platform.window.setTimeout(() => void feature.handleSessionHistoryNavigation(), 25);
      return;
    }
    const routed = feature.parseSessionRoute();
    if (!routed || !feature.isAllowedUser(routed.userID)) {
      return;
    }
    if (routed.userID !== feature.currentUser) {
      await dependencies.workspace().flushAllPersistence();
      await feature.selectUser(routed.userID, { sessionID: routed.sessionID, historyMode: "none" });
      return;
    }
    await feature.refreshSessions();
    const target = feature.sessions.find((session) => session.id === routed.sessionID) || feature.sessions[0];
    if (target) {
      await feature.switchSession(target, { historyMode: target.id === routed.sessionID ? "none" : "replace" });
    }
  }

  function showUserSelect() {
    feature.renderUserSelect();
    feature.userSelect.hidden = false;
  }

  function hideUserSelect() {
    feature.userSelect.hidden = true;
  }

  function renderUserSelect() {
    feature.userSelect.replaceChildren();

    const panel = platform.document.createElement("div");
    panel.className = "user-select-panel";

    const title = platform.document.createElement("div");
    title.className = "user-select-title";
    title.textContent = "Select a user";
    panel.appendChild(title);

    const hint = platform.document.createElement("div");
    hint.className = "user-select-hint";
    hint.textContent = "Each user has separate named desktop sessions.";
    panel.appendChild(hint);

    const list = platform.document.createElement("div");
    list.className = "user-select-list";
    for (const name of feature.userRoster) {
      const button = platform.document.createElement("button");
      button.type = "button";
      button.className = "user-select-entry";
      button.textContent = name;
      button.addEventListener("click", () => feature.selectUser(name));
      list.appendChild(button);
    }
    panel.appendChild(list);

    feature.userSelect.appendChild(panel);
  }

  function initializeWorkspaceID() {
    feature.workspaceID = "default";
    feature.multiUser = false;
    feature.userRoster = [];
    // "off", "file" or "system". With file sign-in the signed-in account is the
    // only user, so switching users means signing out.
    feature.authMode = "off";
    feature.signedInAccount = "";
    // An ended sign-in shows a dialog over the workspace, then retries what was
    // waiting, instead of leaving the page.
    feature.signInRecovery = new SignInRecovery({ target: platform.window, doc: platform.document, config: () => ({ mode: feature.authMode, account: feature.signedInAccount }) });
    feature.signInRecovery.install();
    feature.currentUser = null;
    feature.userSelectionRequestID = 0;
    feature.sessions = [];
    feature.currentSessionID = "";
  }

  function initializeCurrentSessionName() {
    feature.currentSessionName = "";
  }

  function initializeUserStorageKey() {
    feature.userStorageKey = "tessera-user";
  }

  function initializeUserSelect() {
    feature.userSelect = platform.document.createElement("div");
    feature.userSelect.className = "user-select";
    feature.userSelect.hidden = true;
    platform.document.body.appendChild(feature.userSelect);
  }

  function initializeShortcutsUI() {
    feature.shortcutsUI = new ShortcutsModal({
      getContext: () => ({ user: feature.currentUser || "default", workspaceId: feature.workspaceID, cwd: dependencies.desktop().getActivePane()?.cwd || "" }),
      onLaunch: result => {
        dependencies.desktop().createTerminalPane(null, { title: result.title, cwd: result.cwd, terminalStartupCommand: result.command });
      },
      onSaved: () => { if (!dependencies.palette().commandPalette.hidden) dependencies.palette().renderPaletteResults(); },
      onClose: overlay => dependencies.switcher().restorePaneFocusAfterOverlayDismiss(overlay),
    });
  }

  Object.assign(feature, {
    readStoredUser,
    persistUser,
    sessionRoute,
    parseSessionRoute,
    isAllowedUser,
    userAPIPath,
    startApp,
    openStartupWorkspace,
    showStartupFailure,
    waitForStartupWorkspace,
    selectUser,
    signOutOfTessera,
    switchUser,
    jumpToUser,
    refreshSessions,
    fetchSessions,
    fetchUserShortcuts,
    openShortcuts,
    invokeShortcut,
    fetchUserSettings,
    applyUserSettings,
    switchSession,
    handleSessionHistoryNavigation,
    showUserSelect,
    hideUserSelect,
    renderUserSelect,
    initializeWorkspaceID,
    initializeCurrentSessionName,
    initializeUserStorageKey,
    initializeUserSelect,
    initializeShortcutsUI,
  });
  return feature;
}
