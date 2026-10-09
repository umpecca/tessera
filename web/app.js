import {
  ClipboardBridge,
  clipboardBridgeNeedsUpdate,
  firefoxClipboardExtensionRecommendation,
} from "./clipboard-bridge.mjs";
import { compatibilityDiagnostics, detectCompatibility } from "./compatibility.mjs";
import { CommandWheel } from "./command-wheel.mjs";
import { TerminalAudioPlayer, terminalAudioMuteKey } from "./terminal-audio.mjs";
import { TerminalFiles } from "./terminal-files.mjs";
import { ShortcutsModal } from "./shortcuts.mjs";
import { WindowWobble } from "./window-wobble.mjs";
import { browserWakeDetected, nextServerConnectionState } from "./server-connection.mjs";
import { isExpectedServerVersion, isSystemdUpdateCheck } from "./server-update.mjs";
import { localHTTPSConfigWithCurrentHostname, localHTTPSDraft, localHTTPSNextURL, validateLocalHTTPSDraft } from "./local-https-settings.mjs";
import { shouldShowIPadHTTPGuidance } from "./ipad-http-guidance.mjs";
import { installNativeClose } from "./native-desktop.mjs";
import {
  terminalBacklogCloseCode,
  terminalCloseOutcome,
  terminalConnectingStatus,
  terminalShouldRetry,
  terminalStatusLabel,
} from "./terminal-reconnect.mjs";
import {
  isTerminalCopyShortcut,
  shouldIsolateMacTerminalPasteKeydown,
  terminalControlSequence,
  terminalNavigationSequence,
  terminalPasteSource,
  terminalShouldSwallowCommandKey,
} from "./terminal-keyboard.mjs";
import {
  TerminalContextMenuFallback,
  TerminalMousePress,
  clearTerminalSelectionStartedDuringGesture,
  emptyTerminalCopyGuidance,
  isTerminalContextMenuGesture,
  terminalMouseMessage,
  terminalPasteText,
} from "./terminal-input.mjs";
import {
  defaultTerminalTERM, normalizeTerminalTERM,
  defaultTerminalRowSpacing, normalizeTerminalRowSpacing, terminalRowSpacings,
} from "./terminal-settings.mjs";
import {
  defaultTerminalFont,
  loadTerminalFont,
  normalizeTerminalFont,
  terminalFontFamily,
  terminalPrimaryFontFamily,
  terminalFonts,
} from "./terminal-font.mjs";
import {
  defaultTerminalColorMode,
  normalizeTerminalColorMode,
  recreateOpenTerminalViews,
  terminalColorModes,
  terminalColorTheme,
} from "./terminal-colors.mjs";
import { installTerminalBlockRenderer } from "./terminal-block-renderer.mjs";
import {
  browseLocalPortHelpCommand,
  browserHelpAddress,
  browserLocalPortExamples,
  normalizeBrowserAddress,
} from "./browser-pane.mjs";
import {
  normalizeVNCTarget,
  normalizeVNCScaleMode,
  vncCredentialFields,
  vncWebSocketURL,
} from "./vnc-pane.mjs";
import { newWorkspaceRevision, workspaceRevisionMatches, workspaceSaveOutcome } from "./workspace-concurrency.mjs";
import { activePaneOnLoad, focusPane, openTerminalWithoutFocus, paneNeedsRaise } from "./pane-activation.mjs";
import { paneContentFields } from "./pane-content-sync.mjs";
import { adjacentWindowPane, moveWindowPane, placeWindowPaneBefore, windowSwitcherEntries } from "./window-switcher.mjs";
import { TerminalFitScheduler } from "./terminal-fit-scheduler.mjs";
import { terminalIsCovered } from "./terminal-visibility.mjs";
import { TerminalWriteScheduler } from "./terminal-write-scheduler.mjs";
import { normalizeTerminalBacklogLimit, TerminalReplica } from "./terminal-replica.mjs";
import { TerminalOutputTiming, formatOutputTiming } from "./terminal-output-timing.mjs";
import {
  defaultOLEDBorderSize,
  maximumOLEDBorderSize,
  minimumOLEDBorderSize,
  normalizeOLEDBorderSize,
} from "./oled-border-size.mjs";
import {
  defaultWheelSensitivity,
  normalizeWheelSensitivity,
  wheelDeltaUnits,
  wheelSensitivityOptions,
} from "./wheel-sensitivity.mjs";

const board = document.querySelector("#board");
const tabHeight = 24;
const rectangles = [];
let activeRect = null;
let terminalVisibilityFrame = null;
let activePaneID = "";
let interaction = null;
// "Cascade Arrange" snapshots every visible pane's box before its first tile;
// "Back Arrange" restores it. Repeating Cascade Arrange preserves that snapshot.
// Any geometry change outside of arranging (move, resize, dock, maximize, a
// new window) drops the snapshot via setRectangle.
let arrangeOutSnapshot = null;
let isArrangingWindows = false;
let nextZIndex = 1;
let contextMenuRect = null;
let terminalMenuRect = null;
let workspaceMenuPoint = null;
let windowTypeRect = null;
let directoryBrowserRect = null;
let directoryBrowserPath = "";
let clipboardText = "";
let workspaceID = "default";
let workspaceRevision = "";
let workspaceSaveSuspended = false;
let workspaceNeedsRevalidation = false;
let workspaceSavePromise = null;
let workspaceInFlightRevision = "";
let workspaceSaveQueued = false;
let multiUser = false;
let userRoster = [];
let currentUser = null;
let userSelectionRequestID = 0;
let sessions = [];
let currentSessionID = "";
let currentSessionName = "";
let sessionSelection = 0;
let sessionQuery = "";
let sessionEntries = [];
let sessionsSearchInput = null;
let sessionsList = null;
let sessionNavigationPending = false;
let workspaceHasBackground = false;
let workspaceBackgroundVersion = "";
let workspaceBackgroundMode = "fill";
let backgroundRequestID = 0;
let isLoadingWorkspace = false;
let saveTimer = null;
let workspaceStatusHideTimer = null;
let saveRevision = 0;
const clipboardBridge = new ClipboardBridge();
let clipboardPromptCheckID = 0;
let clipboardPromptDismissed = false;
const clipboardPromptSnoozeKey = "tessera.clipboard-extension-prompt-snoozed-until.v1";
const ipadHTTPGuidanceDismissedKey = "tessera.ipad-http-guidance-dismissed.v1";
window.addEventListener("focus", () => {
  checkForBrowserWake();
  void refreshClipboardBridgeAndPrompt();
});

let userSettingsSaveTimer = null;
let userSettingsSavePromise = null;
let userSettingsDirty = false;
let userSettingsRevision = "";
let userSettingsInFlightRevision = "";
let ghosttyModulePromise = null;
let vncModulePromise = null;
const terminalTextEncoder = new TextEncoder();
// The terminal must render in a monospace face for column
// alignment; keep this in sync with --tessera-font in styles.css. xterm
// measures glyphs on a canvas and cannot resolve a CSS var(), so this has
// to be a concrete font-family string rather than "var(--tessera-font)".
const fallbackPaneFontSize = 14;
const minimumPaneFontSize = 10;
const maximumPaneFontSize = 24;
let defaultPaneFontSize = fallbackPaneFontSize;
let deskbarButtonEnabled = true;
let terminalWheelSensitivity = defaultWheelSensitivity;
let oledWindowBorderSize = defaultOLEDBorderSize;
let terminalTerm = defaultTerminalTERM;
let terminalFont = defaultTerminalFont;
let terminalRowSpacing = defaultTerminalRowSpacing;
let terminalColorMode = defaultTerminalColorMode;
const olderMacModeStorageKey = "tessera.older-mac-mode.v1";
let olderMacMode = false;
const experimentalTerminalRendererStorageKey = "tessera.experimental-terminal-renderer.v1";
let experimentalTerminalRenderer = true;
const terminalPaintCoalescingStorageKey = "tessera.terminal-paint-coalescing.v1";
let terminalPaintCoalescing = true;
const terminalOutputCoalescingStorageKey = "tessera.terminal-output-coalescing.v1";
let terminalOutputCoalescing = false;
const terminalBacklogLimitStorageKey = "tessera.terminal-output-backlog.v1";
let terminalBacklogLimit = "auto";
const windowWobbleStorageKey = "tessera.window-wobble.v1";
let windowWobbleEnabled = true;
try {
  olderMacMode = window.localStorage.getItem(olderMacModeStorageKey) === "true";
  experimentalTerminalRenderer = window.localStorage.getItem(experimentalTerminalRendererStorageKey) !== "false";
  terminalPaintCoalescing = window.localStorage.getItem(terminalPaintCoalescingStorageKey) !== "false";
  terminalOutputCoalescing = window.localStorage.getItem(terminalOutputCoalescingStorageKey) === "true";
  terminalBacklogLimit = normalizeTerminalBacklogLimit(window.localStorage.getItem(terminalBacklogLimitStorageKey));
  windowWobbleEnabled = window.localStorage.getItem(windowWobbleStorageKey) !== "false";
} catch {
  // Storage can be unavailable in hardened or private browser contexts.
}
const terminalAudioPlayer = new TerminalAudioPlayer();
window.addEventListener("pagehide", (event) => {
  if (event.persisted) terminalAudioPlayer.disable();
  else terminalAudioPlayer.dispose();
});
const serverHealthPollInterval = 5000;
// The browser caps the body of a request asked to outlive its page at 64KB,
// counted across every such request in flight. Saves stay under it by leaving
// out pane content the server already has, but an edit large enough to break
// that ceiling falls back to an ordinary request.
const maxKeepaliveSaveBytes = 60 * 1024;
let serverConnectionState = { failures: 0, state: "" };
let serverConnectionLastHealthy = null;
let serverHealthMonitorTimer = null;
let serverHealthProbe = null;
let serverUpdateRestarting = false;
let browserWakeSample = { wall: Date.now(), monotonic: performance.now() };
let browserWakePending = false;
let wakeRecoveryID = 0;
let wakeRecoveryActive = false;
let wakeRecoveryHealthReady = false;
let wakeRecoveryStatusHideTimer = null;
const wakeRecoveryTerminals = new Set();

const defaultThemeID = "next-tessera";
const themes = {
  "next-tessera": {
    label: "Next Tessera",
  },
  studio: {
    label: "Studio",
  },
  hacker: {
    label: "Hacker",
  },
  "dark-professional": {
    label: "Dark Professional",
  },
  "oled-terminal": {
    label: "OLED Terminal",
  },
  operator: {
    label: "Operator",
  },
};
let defaultTheme = defaultThemeID;
let themeID = defaultThemeID;
const reducedWindowMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const windowWobble = new WindowWobble({
  enabled: () => themeID === "operator" && windowWobbleEnabled && !olderMacMode && !reducedWindowMotion.matches,
});
reducedWindowMotion.addEventListener("change", () => windowWobble.stop());
document.addEventListener("visibilitychange", () => { if (document.hidden) windowWobble.stop(); });

function setWindowWobbleEnabled(enabled) {
  windowWobbleEnabled = enabled === true;
  saveBrowserSetting(windowWobbleStorageKey, windowWobbleEnabled);
  if (!windowWobbleEnabled) windowWobble.stop();
}

function setDefaultTheme(id) {
  defaultTheme = themes[id] ? id : defaultThemeID;
  scheduleUserSettingsSave();
}

function setDefaultPaneFontSize(fontSize) {
  defaultPaneFontSize = normalizePaneFontSize(fontSize);
  scheduleUserSettingsSave();
}

function setTerminalWheelSensitivity(value) {
  const normalized = normalizeWheelSensitivity(value);
  terminalWheelSensitivity = normalized;
  scheduleUserSettingsSave();
}

function setOLEDWindowBorderSize(value, { save = true } = {}) {
  oledWindowBorderSize = normalizeOLEDBorderSize(value);
  document.documentElement.style.setProperty("--oled-window-border-size", `${oledWindowBorderSize}px`);
  if (save) {
    scheduleUserSettingsSave();
  }
}

function setTerminalTERM(value) {
  terminalTerm = normalizeTerminalTERM(value);
  scheduleUserSettingsSave();
}

async function setTerminalFont(value, { save = true } = {}) {
  terminalFont = normalizeTerminalFont(value);
  if (save) {
    scheduleUserSettingsSave();
  }
  const terminalPanes = rectangles.filter((rect) => rect.kind === "terminal" && rect.terminal?.term);
  await Promise.all([...new Set(terminalPanes.map((rect) => rect.fontSize))]
    .map((fontSize) => loadTerminalFont(document.fonts, terminalFont, fontSize)));
  const family = terminalPrimaryFontFamily(terminalFont);
  const symbolFamily = terminalFontFamily(terminalFont);
  for (const rect of terminalPanes) {
    rect.terminal.term.setFontFamilies(family, symbolFamily);
    requestTerminalFit(rect);
  }
}

function setTerminalRowSpacing(value, { save = true } = {}) {
  terminalRowSpacing = normalizeTerminalRowSpacing(value);
  if (save) scheduleUserSettingsSave();
  for (const rect of rectangles) {
    if (rect.kind === "terminal" && rect.terminal?.term) {
      rect.terminal.term.setRowSpacing(terminalRowSpacing);
      requestTerminalFit(rect);
    }
  }
}

async function setTerminalColorMode(value, { save = true } = {}) {
  const nextMode = normalizeTerminalColorMode(value);
  if (nextMode === terminalColorMode) {
    return;
  }
  terminalColorMode = nextMode;
  if (save) {
    scheduleUserSettingsSave();
  }
  await recreateOpenTerminalViews(rectangles, disposeTerminal, startTerminal);
}

function setOlderMacMode(enabled, { save = true } = {}) {
  olderMacMode = enabled === true;
  if (save) {
    try {
      window.localStorage.setItem(olderMacModeStorageKey, String(olderMacMode));
    } catch {
      // Keep the selection for this page when browser storage is unavailable.
    }
  }
  document.documentElement.dataset.performanceProfile = olderMacMode ? "older-mac" : "standard";
  for (const rect of rectangles) {
    const term = rect.kind === "terminal" ? rect.terminal?.term : null;
    if (!term) continue;
    term.setRenderPixelRatioCap?.(olderMacMode ? 1 : 0);
    term.setPaintFPSLimit?.(olderMacMode ? 30 : 0);
    term.setCursorBlinkEnabled?.(!olderMacMode);
    term.options.smoothScrollDuration = olderMacMode ? 0 : 100;
    updateTerminalRenderState(rect);
  }
}

function setExperimentalTerminalRenderer(enabled) {
  experimentalTerminalRenderer = enabled === true;
  try {
    window.localStorage.setItem(experimentalTerminalRendererStorageKey, String(experimentalTerminalRenderer));
  } catch {
    // Keep the selection for this page when browser storage is unavailable.
  }
  for (const rect of rectangles) {
    if (rect.kind === "terminal") {
      rect.terminal?.term?.setExperimentalRenderer?.(experimentalTerminalRenderer);
    }
  }
}

function saveBrowserSetting(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Keep the selection for this page when browser storage is unavailable.
  }
}

function setTerminalPaintCoalescing(enabled) {
  terminalPaintCoalescing = enabled === true;
  saveBrowserSetting(terminalPaintCoalescingStorageKey, terminalPaintCoalescing);
  for (const rect of rectangles) {
    if (rect.kind === "terminal") {
      rect.terminal?.term?.setPaintCoalescing?.(terminalPaintCoalescing);
    }
  }
}

function sendTerminalOutputCoalescing(terminalState) {
  if (terminalState?.socket?.readyState === WebSocket.OPEN) {
    terminalState.socket.send(JSON.stringify({ type: "output-coalescing", enabled: terminalOutputCoalescing }));
  }
}

function setTerminalOutputCoalescing(enabled) {
  terminalOutputCoalescing = enabled === true;
  saveBrowserSetting(terminalOutputCoalescingStorageKey, terminalOutputCoalescing);
  for (const rect of rectangles) {
    if (rect.kind === "terminal") sendTerminalOutputCoalescing(rect.terminal);
  }
}

function setTerminalBacklogLimit(value) {
  terminalBacklogLimit = normalizeTerminalBacklogLimit(value);
  saveBrowserSetting(terminalBacklogLimitStorageKey, terminalBacklogLimit);
  for (const rect of rectangles) {
    if (rect.kind === "terminal") rect.terminal?.replica?.setBacklogLimit(terminalBacklogLimit);
  }
}

function applyTheme(id, { save = true } = {}) {
  windowWobble.stop();
  themeID = themes[id] ? id : defaultThemeID;
  if (themeID !== "oled-terminal") {
    rectangles.forEach((rect) => setOLEDMoveMode(rect, false));
  }
  document.documentElement.dataset.theme = themeID;
  reflowDockedPanesForTheme();
  // Operator puts its title bar inside the window; other themes use an
  // external tab. Re-measure contents after the chrome changes, never on move.
  for (const rect of rectangles) {
    requestTerminalFit(rect);
  }
  scheduleTerminalVisibilityUpdate();
  if (save) {
    scheduleUserSettingsSave();
  }
}

const userStorageKey = "tessera-user";

function readStoredUser() {
  try {
    return localStorage.getItem(userStorageKey) || "";
  } catch {
    return "";
  }
}

function persistUser(name) {
  try {
    if (name) {
      localStorage.setItem(userStorageKey, name);
    } else {
      localStorage.removeItem(userStorageKey);
    }
  } catch {
    // localStorage unavailable; selection still applies for this session
  }
}

function sessionRoute(userID, sessionID) {
  return `/users/${encodeURIComponent(userID)}/sessions/${encodeURIComponent(sessionID)}`;
}

function parseSessionRoute(pathname = window.location.pathname) {
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
  return multiUser ? userRoster.includes(name) : name === "default";
}

function userAPIPath(resource, user = currentUser || "default") {
  return `/api/users/${encodeURIComponent(user)}/${resource}`;
}

// startApp decides between single-user and multi-user startup. A failed or
// disabled /api/users falls back to the single default workspace so the app
// still loads.
async function startApp() {
  try {
    const response = await fetch("/api/users");
    if (response.ok) {
      const config = await response.json();
      multiUser = Boolean(config.enabled) && Array.isArray(config.users) && config.users.length > 0;
      userRoster = multiUser ? config.users : [];
    }
  } catch (error) {
    console.warn(error);
  }

  const routed = parseSessionRoute();
  if (routed && isAllowedUser(routed.userID)) {
    await selectUser(routed.userID, { sessionID: routed.sessionID, historyMode: "replace" });
    return;
  }

  if (!multiUser) {
    await selectUser("default", { historyMode: "replace" });
    return;
  }

  const stored = readStoredUser();
  if (stored && userRoster.includes(stored)) {
    await selectUser(stored, { historyMode: "replace" });
  } else {
    showUserSelect();
  }
}

async function selectUser(name, options = {}) {
  if (!isAllowedUser(name)) {
    return false;
  }
  const requestID = ++userSelectionRequestID;
  try {
    const [nextSessions, settings, nextShortcuts] = await Promise.all([fetchSessions(name), fetchUserSettings(name), fetchUserShortcuts(name)]);
    const requested = nextSessions.find((session) => session.id === options.sessionID);
    const target = requested || nextSessions[0];
    if (!target) throw new Error("No sessions");
    const workspace = await fetchWorkspace(target.id);
    if (requestID !== userSelectionRequestID) return false;
    const activated = await fetch(`${userAPIPath("sessions", name)}/${encodeURIComponent(target.id)}/activate`, { method: "POST" });
    if (!activated.ok) throw new Error(`activate session failed: ${activated.status}`);
    if (requestID !== userSelectionRequestID) return false;
    currentUser = name;
    sessions = nextSessions;
    applyUserSettings(settings);
    shortcutsUI.setDocument(name, nextShortcuts);
    currentSessionID = target.id;
    currentSessionName = target.name;
    loadWorkspace(workspace);
    persistUser(name);
    hideUserSelect();
    const route = sessionRoute(name, target.id);
    if (options.historyMode === "push") window.history.pushState({}, "", route);
    else if (options.historyMode !== "none") window.history.replaceState({}, "", route);
    return true;
  } catch (error) {
    if (requestID === userSelectionRequestID) {
      console.warn(error);
      setWorkspaceStatus("error", "Could not switch user", error.message);
    }
    return false;
  }
}

async function switchUser() {
  await flushAllPersistence();
  userSelectionRequestID += 1;
  currentUser = null;
  currentSessionID = "";
  currentSessionName = "";
  sessions = [];
  persistUser("");
  clearRectanglesForLoad();
  window.history.pushState({}, "", "/");
  setWorkspaceStatus("idle", "Select user");
  showUserSelect();
}

// Direct switch to a named user (from the command palette), skipping the
// selection screen.
async function jumpToUser(name) {
  if (!userRoster.includes(name) || name === currentUser) {
    return;
  }
  await flushAllPersistence();
  await selectUser(name, { historyMode: "push" });
}

async function refreshSessions() {
  sessions = await fetchSessions(currentUser || "default");
  return sessions;
}

async function fetchSessions(user) {
  const response = await fetch(userAPIPath("sessions", user));
  if (!response.ok) {
    throw new Error(`load sessions failed: ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

async function fetchUserShortcuts(user) {
  const response = await fetch(userAPIPath("shortcuts", user));
  if (!response.ok) throw new Error(`Load shortcuts failed (${response.status}).`);
  return response.json();
}

function openShortcuts() {
  hideAllMenus();
  shortcutsUI.open();
}

function invokeShortcut(shortcut) {
  hideAllMenus();
  shortcutsUI.invoke(shortcut);
}

async function fetchUserSettings(user) {
  const response = await fetch(userAPIPath("settings", user));
  if (!response.ok) {
    throw new Error(`load user settings failed: ${response.status}`);
  }
  return response.json();
}

function applyUserSettings(settings) {
  userSettingsRevision = settings.revision || "";
  userSettingsDirty = false;
  defaultPaneFontSize = normalizePaneFontSize(settings.defaultPaneFontSize);
  defaultTheme = themes[settings.defaultTheme] ? settings.defaultTheme : defaultThemeID;
  deskbarButtonEnabled = settings.deskbarButtonEnabled !== false;
  terminalWheelSensitivity = normalizeWheelSensitivity(settings.terminalWheelSensitivity);
  terminalTerm = normalizeTerminalTERM(settings.terminalTerm);
  terminalFont = normalizeTerminalFont(settings.terminalFont);
  terminalRowSpacing = normalizeTerminalRowSpacing(settings.terminalRowSpacing);
  terminalColorMode = normalizeTerminalColorMode(settings.terminalColorMode);
  // Performance capabilities belong to this browser and device. Ignore the
  // legacy account setting so an Older Mac cap cannot follow the user to a
  // newer computer.
  setOlderMacMode(olderMacMode, { save: false });
  setOLEDWindowBorderSize(settings.oledWindowBorderSize, { save: false });
  applyTheme(settings.themeId || defaultTheme, { save: false });
  updateDeskbar();
}

async function switchSession(session, options = {}) {
  if (!session || sessionNavigationPending) {
    return;
  }
  if (session.id === currentSessionID) {
    if (options.historyMode === "replace") {
      window.history.replaceState({}, "", sessionRoute(currentUser || "default", session.id));
    }
    hideSessionsModal();
    return;
  }
  sessionNavigationPending = true;
  try {
    if (!options.skipSave && currentSessionID) {
      await flushWorkspaceSave();
    }
    const workspace = await fetchWorkspace(session.id);
    const activated = await fetch(`${userAPIPath("sessions")}/${encodeURIComponent(session.id)}/activate`, { method: "POST" });
    if (!activated.ok) {
      throw new Error(`activate session failed: ${activated.status}`);
    }
    // The old workspace remains usable during network requests. Include any
    // edits made while the target was loading before replacing its panes.
    if (!options.skipSave && currentSessionID) {
      await flushWorkspaceSave();
    }
    currentSessionID = session.id;
    currentSessionName = session.name;
    loadWorkspace(workspace);
    const route = sessionRoute(currentUser || "default", session.id);
    if (options.historyMode === "replace") {
      window.history.replaceState({}, "", route);
    } else if (options.historyMode !== "none") {
      window.history.pushState({}, "", route);
    }
    hideSessionsModal();
    await refreshSessions().catch((error) => {
      console.warn(error);
      setWorkspaceStatus("error", "Session opened; refresh failed", error.message);
    });
  } catch (error) {
    console.warn(error);
    setWorkspaceStatus("error", "Could not switch session", error.message);
    // Back/Forward changes the URL before this handler starts.
    if (options.historyMode === "none" && currentSessionID) {
      window.history.replaceState({}, "", sessionRoute(currentUser || "default", currentSessionID));
    }
    return false;
  } finally {
    sessionNavigationPending = false;
  }
}

async function handleSessionHistoryNavigation() {
  if (sessionNavigationPending) {
    window.setTimeout(() => void handleSessionHistoryNavigation(), 25);
    return;
  }
  const routed = parseSessionRoute();
  if (!routed || !isAllowedUser(routed.userID)) {
    return;
  }
  if (routed.userID !== currentUser) {
    await flushAllPersistence();
    await selectUser(routed.userID, { sessionID: routed.sessionID, historyMode: "none" });
    return;
  }
  await refreshSessions();
  const target = sessions.find((session) => session.id === routed.sessionID) || sessions[0];
  if (target) {
    await switchSession(target, { historyMode: target.id === routed.sessionID ? "none" : "replace" });
  }
}

function showUserSelect() {
  renderUserSelect();
  userSelect.hidden = false;
}

function hideUserSelect() {
  userSelect.hidden = true;
}

function renderUserSelect() {
  userSelect.replaceChildren();

  const panel = document.createElement("div");
  panel.className = "user-select-panel";

  const title = document.createElement("div");
  title.className = "user-select-title";
  title.textContent = "Select a user";
  panel.appendChild(title);

  const hint = document.createElement("div");
  hint.className = "user-select-hint";
  hint.textContent = "Each user has separate named desktop sessions.";
  panel.appendChild(hint);

  const list = document.createElement("div");
  list.className = "user-select-list";
  for (const name of userRoster) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "user-select-entry";
    button.textContent = name;
    button.addEventListener("click", () => selectUser(name));
    list.appendChild(button);
  }
  panel.appendChild(list);

  userSelect.appendChild(panel);
}

const maxBackgroundBytes = 10 * 1024 * 1024;
const targetBackgroundBytes = Math.floor(maxBackgroundBytes * 0.9);
const maxBackgroundDimension = 3840;
const backgroundDisplayModes = {
  fill: { label: "Fill", size: "cover" },
  fit: { label: "Fit", size: "contain" },
  stretch: { label: "Stretch", size: "100% 100%" },
  center: { label: "Center", size: "auto" },
};

function normalizeBackgroundDisplayMode(mode) {
  return backgroundDisplayModes[mode] ? mode : "fill";
}

function backgroundURL(version) {
  return backgroundURLFor(workspaceID, version);
}

function backgroundURLFor(id, version) {
  const base = `/api/workspace/${encodeURIComponent(id)}/background`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

// applyWorkspaceBackground sets or clears the board's background image layer.
// The image renders beneath the theme's overlay (see .board in styles.css).
function applyWorkspaceBackground(has, version, mode = workspaceBackgroundMode) {
  workspaceHasBackground = Boolean(has);
  workspaceBackgroundVersion = version || "";
  workspaceBackgroundMode = normalizeBackgroundDisplayMode(mode);
  if (workspaceHasBackground) {
    board.style.setProperty("--board-user-image", `url("${backgroundURL(workspaceBackgroundVersion)}")`);
    board.style.setProperty("--board-user-size", backgroundDisplayModes[workspaceBackgroundMode].size);
  } else {
    board.style.removeProperty("--board-user-image");
    board.style.removeProperty("--board-user-size");
  }
  // The background controls live in the Settings modal; if it's open when a
  // set/clear finishes, refresh it so the button labels stay in sync.
  if (!settingsModal.hidden) {
    renderSettingsModal();
  }
}

function handleBackgroundFileChange(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (file) {
    void uploadBackground(file);
  }
}

function canvasJPEG(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("could not encode image"));
      }
    }, "image/jpeg", quality);
  });
}

async function compressBackgroundImage(file) {
  const source = await createImageBitmap(file);
  try {
    let scale = Math.min(1, maxBackgroundDimension / Math.max(source.width, source.height));
    let quality = 0.88;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new Error("could not prepare image canvas");
      }
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
      context.drawImage(source, 0, 0, width, height);
      const jpeg = await canvasJPEG(canvas, quality);
      if (jpeg.size <= targetBackgroundBytes) {
        return jpeg;
      }
      if (quality > 0.5) {
        quality -= 0.1;
      } else {
        scale *= 0.75;
        quality = 0.85;
      }
    }
  } finally {
    source.close();
  }
  throw new Error("could not compress image below the upload limit");
}

async function uploadBackground(file) {
  if (!file.type.startsWith("image/")) {
    setWorkspaceStatus("error", "Not an image", "Background must be an image file");
    return;
  }
  const targetWorkspaceID = workspaceID;
  const requestID = ++backgroundRequestID;
  try {
    setWorkspaceStatus("saving", "Preparing image...");
    const jpeg = await compressBackgroundImage(file);
    if (requestID !== backgroundRequestID || workspaceID !== targetWorkspaceID) return;
    if (jpeg.size > maxBackgroundBytes) {
      throw new Error("compressed image is still too large");
    }
    setWorkspaceStatus("saving", "Saving...");
    const response = await fetch(backgroundURLFor(targetWorkspaceID, ""), {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: jpeg,
    });
    if (!response.ok) {
      throw new Error(`set background failed: ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    if (requestID !== backgroundRequestID || workspaceID !== targetWorkspaceID) return;
    applyWorkspaceBackground(true, data.version || String(Date.now()), workspaceBackgroundMode);
    setWorkspaceStatus("saved", "Saved", "Background updated");
  } catch (error) {
    if (requestID !== backgroundRequestID || workspaceID !== targetWorkspaceID) return;
    console.warn(error);
    setWorkspaceStatus("error", "Save failed", error.message || "Background save failed");
  }
}

async function clearBackground() {
  const targetWorkspaceID = workspaceID;
  const requestID = ++backgroundRequestID;
  setWorkspaceStatus("saving", "Saving...");
  try {
    const response = await fetch(backgroundURLFor(targetWorkspaceID, ""), { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`clear background failed: ${response.status}`);
    }
    if (requestID !== backgroundRequestID || workspaceID !== targetWorkspaceID) return;
    applyWorkspaceBackground(false, "", workspaceBackgroundMode);
    setWorkspaceStatus("saved", "Saved", "Background cleared");
  } catch (error) {
    if (requestID !== backgroundRequestID || workspaceID !== targetWorkspaceID) return;
    console.warn(error);
    setWorkspaceStatus("error", "Clear failed", error.message || "Background clear failed");
  }
}

const vncPaneKind = "vnc";
// Which modifier the platform pastes with, since that decides whether the
// browser will deliver a paste event on its own. userAgentData is the modern
// signal; navigator.platform is deprecated but still the only one in some
// builds, and the user agent string is the last resort.
const appleKeyboardLayout = /mac|iphone|ipad/i.test(
  navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "",
);

const browserPaneKind = "browser";
// Window-management keystrokes a browser pane's iframe may relay to the app.
const browserPaneRelayedKeys = new Set(["[", "]", "BracketLeft", "BracketRight", "k", "K", "l", "L", ";", "Semicolon", "F7", "F9", "F10", "ArrowUp", "ArrowDown"]);
const dockMenu = document.createElement("div");
dockMenu.className = "dock-menu";
dockMenu.hidden = true;
document.body.appendChild(dockMenu);

const terminalMenu = document.createElement("div");
terminalMenu.className = "dock-menu terminal-menu";
terminalMenu.hidden = true;
document.body.appendChild(terminalMenu);

const workspaceMenu = document.createElement("div");
workspaceMenu.className = "dock-menu workspace-menu";
workspaceMenu.hidden = true;
document.body.appendChild(workspaceMenu);

const windowTypeMenu = document.createElement("div");
windowTypeMenu.className = "dock-menu window-type-menu";
windowTypeMenu.hidden = true;
document.body.appendChild(windowTypeMenu);

const directoryBrowser = document.createElement("div");
directoryBrowser.className = "directory-browser";
directoryBrowser.hidden = true;
document.body.appendChild(directoryBrowser);

const userSelect = document.createElement("div");
userSelect.className = "user-select";
userSelect.hidden = true;
document.body.appendChild(userSelect);

const backgroundFileInput = document.createElement("input");
backgroundFileInput.type = "file";
backgroundFileInput.accept = "image/*";
backgroundFileInput.hidden = true;
backgroundFileInput.addEventListener("change", handleBackgroundFileChange);
document.body.appendChild(backgroundFileInput);

// The Deskbar is a compact, always-reachable recovery point for minimized
// panes. The command palette stays separate as the keyboard-first action UI.
const deskbarButton = document.createElement("button");
deskbarButton.type = "button";
deskbarButton.className = "deskbar-button";
deskbarButton.title = "Windows";
deskbarButton.setAttribute("aria-label", "Window list");
deskbarButton.setAttribute("aria-haspopup", "true");
deskbarButton.setAttribute("aria-expanded", "false");
deskbarButton.dataset.minimizedCount = "0";
deskbarButton.addEventListener("click", () => toggleDeskbar());
deskbarButton.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  event.preventDefault();
  openDeskbar({ focusWindow: event.key === "ArrowDown" ? 0 : -1 });
});
document.body.appendChild(deskbarButton);

const deskbarPanel = document.createElement("div");
deskbarPanel.className = "dock-menu deskbar-panel";
deskbarPanel.hidden = true;
deskbarPanel.addEventListener("keydown", handleDeskbarKeyboard);
document.body.appendChild(deskbarPanel);

const settingsModal = document.createElement("div");
settingsModal.className = "settings-modal";
settingsModal.hidden = true;
settingsModal.addEventListener("pointerdown", (event) => {
  if (event.target === settingsModal) {
    hideSettingsModal();
  }
});
document.body.appendChild(settingsModal);

const shortcutsUI = new ShortcutsModal({
  getContext: () => ({ user: currentUser || "default", workspaceId: workspaceID, cwd: getActivePane()?.cwd || "" }),
  onLaunch: result => {
    const point = paneSpawnPoint();
    createTerminalPane(point.x, point.y, { title: result.title, cwd: result.cwd, terminalStartupCommand: result.command });
  },
  onSaved: () => { if (!commandPalette.hidden) renderPaletteResults(); },
  onClose: overlay => restorePaneFocusAfterOverlayDismiss(overlay),
});

const localHTTPSModal = document.createElement("div");
localHTTPSModal.className = "settings-modal local-https-modal";
localHTTPSModal.hidden = true;
localHTTPSModal.addEventListener("pointerdown", (event) => {
  if (event.target === localHTTPSModal) {
    hideLocalHTTPSModal();
  }
});
document.body.appendChild(localHTTPSModal);

const clipboardSetupPrompt = document.createElement("aside");
clipboardSetupPrompt.className = "clipboard-setup-prompt";
clipboardSetupPrompt.hidden = true;
clipboardSetupPrompt.setAttribute("role", "region");
clipboardSetupPrompt.setAttribute("aria-labelledby", "clipboard-setup-prompt-title");
const clipboardSetupCopy = document.createElement("div");
const clipboardSetupTitle = document.createElement("strong");
clipboardSetupTitle.id = "clipboard-setup-prompt-title";
clipboardSetupTitle.textContent = "Enable reliable clipboard access";
const clipboardSetupMessage = document.createElement("span");
clipboardSetupCopy.append(clipboardSetupTitle, clipboardSetupMessage);
const clipboardSetupActions = document.createElement("div");
clipboardSetupActions.className = "clipboard-setup-prompt-actions";
const clipboardSetupButton = document.createElement("button");
clipboardSetupButton.type = "button";
clipboardSetupButton.textContent = "Set up clipboard";
clipboardSetupButton.addEventListener("click", () => {
  clipboardPromptDismissed = true;
  clipboardSetupPrompt.hidden = true;
  openSettingsModal({ clipboard: true });
});
const clipboardSetupDismiss = document.createElement("button");
clipboardSetupDismiss.type = "button";
clipboardSetupDismiss.textContent = "Remind me later";
clipboardSetupDismiss.addEventListener("click", () => {
  clipboardPromptDismissed = true;
  clipboardSetupPrompt.hidden = true;
  try {
    window.localStorage.setItem(clipboardPromptSnoozeKey, String(Date.now() + 24 * 60 * 60 * 1000));
  } catch {
    // The in-memory dismissal still prevents repeated prompts on this page.
  }
});
clipboardSetupActions.append(clipboardSetupButton, clipboardSetupDismiss);
clipboardSetupPrompt.append(clipboardSetupCopy, clipboardSetupActions);
document.body.appendChild(clipboardSetupPrompt);

const renameWindowModal = document.createElement("div");
renameWindowModal.className = "settings-modal rename-window-modal";
renameWindowModal.hidden = true;
renameWindowModal.addEventListener("pointerdown", (event) => {
  if (event.target === renameWindowModal) {
    hideRenameWindowModal();
  }
});
document.body.appendChild(renameWindowModal);

const sessionsModal = document.createElement("div");
sessionsModal.className = "settings-modal sessions-modal";
sessionsModal.hidden = true;
sessionsModal.addEventListener("pointerdown", (event) => {
  if (event.target === sessionsModal) {
    hideSessionsModal();
  }
});
document.body.appendChild(sessionsModal);

const sessionActionModal = document.createElement("div");
sessionActionModal.className = "settings-modal session-action-modal";
sessionActionModal.hidden = true;
sessionActionModal.addEventListener("pointerdown", (event) => {
  if (event.target === sessionActionModal) {
    hideSessionActionModal();
  }
});
document.body.appendChild(sessionActionModal);

const serverUpdateModal = document.createElement("div");
serverUpdateModal.className = "settings-modal server-update-modal";
serverUpdateModal.hidden = true;
serverUpdateModal.addEventListener("pointerdown", (event) => {
  if (event.target === serverUpdateModal && serverUpdateModal.dataset.closable === "true") {
    hideServerUpdateModal();
  }
});
document.body.appendChild(serverUpdateModal);

const serverConnectionModal = document.createElement("div");
serverConnectionModal.className = "settings-modal server-connection-modal";
serverConnectionModal.hidden = true;
document.body.appendChild(serverConnectionModal);

const workspaceConflictModal = document.createElement("div");
workspaceConflictModal.className = "settings-modal workspace-conflict-modal";
workspaceConflictModal.hidden = true;
document.body.appendChild(workspaceConflictModal);

const helpModal = document.createElement("div");
helpModal.className = "settings-modal help-modal";
helpModal.hidden = true;
helpModal.addEventListener("pointerdown", (event) => {
  if (event.target === helpModal) {
    hideHelpModal();
  }
});
document.body.appendChild(helpModal);

const commandPalette = document.createElement("div");
commandPalette.className = "command-palette";
commandPalette.hidden = true;
const commandPalettePanel = document.createElement("div");
commandPalettePanel.className = "command-palette-panel";
const commandPaletteInput = document.createElement("input");
commandPaletteInput.className = "command-palette-input";
commandPaletteInput.type = "text";
commandPaletteInput.placeholder = "Command, shortcut, or window name · Enter to run";
commandPaletteInput.autocomplete = "off";
commandPaletteInput.setAttribute("autocorrect", "off");
commandPaletteInput.setAttribute("writingsuggestions", "false");
commandPaletteInput.spellcheck = false;
commandPaletteInput.setAttribute("aria-label", "Command palette");
const commandPaletteList = document.createElement("div");
commandPaletteList.className = "command-palette-list";
commandPalettePanel.appendChild(commandPaletteInput);
commandPalettePanel.appendChild(commandPaletteList);
commandPalette.appendChild(commandPalettePanel);
document.body.appendChild(commandPalette);

commandPalette.addEventListener("pointerdown", (event) => {
  if (event.target === commandPalette) {
    hideCommandPalette();
  }
});
commandPaletteInput.addEventListener("input", () => renderPaletteResults());
commandPaletteInput.addEventListener("keydown", handlePaletteKeyboard);

// The experimental wheel shares the palette's available commands and codes.
const commandWheel = document.createElement("div");
commandWheel.className = "command-wheel";
commandWheel.hidden = true;
const commandWheelUI = new CommandWheel(commandWheel, {
  onCommand: command => runPaletteCommand(command),
  onClose: () => hideCommandWheel(),
  onSearch: () => openCommandPalette(),
});
document.body.appendChild(commandWheel);

const windowList = document.createElement("div");
windowList.className = "command-palette window-list";
windowList.hidden = true;
const windowListPanel = document.createElement("div");
windowListPanel.className = "command-palette-panel window-list-panel";
windowListPanel.tabIndex = 0;
windowListPanel.setAttribute("role", "dialog");
windowListPanel.setAttribute("aria-modal", "true");
windowListPanel.setAttribute("aria-labelledby", "window-list-title");
windowListPanel.setAttribute("aria-describedby", "window-list-hint");
const windowListTitle = document.createElement("div");
windowListTitle.className = "window-list-title";
const windowListHeading = document.createElement("span");
windowListHeading.id = "window-list-title";
windowListHeading.textContent = "Window List";
const windowListClose = document.createElement("button");
windowListClose.type = "button";
windowListClose.className = "settings-close";
windowListClose.textContent = "X";
windowListClose.setAttribute("aria-label", "Close window list");
windowListClose.addEventListener("click", hideWindowList);
windowListTitle.append(windowListHeading, windowListClose);
const windowListItems = document.createElement("div");
windowListItems.className = "command-palette-list window-list-items";
document.addEventListener("pointermove", updateWindowListDrop);
document.addEventListener("pointerup", dropWindowListEntry);
document.addEventListener("pointercancel", (event) => {
  if (windowListDrag?.pointerID === event.pointerId) clearWindowListDrag();
});
windowListItems.addEventListener("lostpointercapture", (event) => {
  if (windowListDrag?.pointerID === event.pointerId) clearWindowListDrag();
});
const windowListHint = document.createElement("p");
windowListHint.id = "window-list-hint";
windowListHint.className = "window-list-hint";
windowListHint.textContent = "Drag rows to reorder · ↑/↓ selects · Enter opens · Ctrl/Cmd+↑/↓ reorders";
const windowListStatus = document.createElement("div");
windowListStatus.className = "window-list-status";
windowListStatus.setAttribute("role", "status");
windowListPanel.append(windowListTitle, windowListItems, windowListHint, windowListStatus);
windowList.appendChild(windowListPanel);
document.body.appendChild(windowList);

windowList.addEventListener("pointerdown", (event) => {
  if (event.target === windowList) {
    hideWindowList();
  }
});
windowListPanel.addEventListener("keydown", handleWindowListKeyboard);

const windowSwitcher = document.createElement("div");
windowSwitcher.className = "window-switcher";
windowSwitcher.hidden = true;
const windowSwitcherPanel = document.createElement("section");
windowSwitcherPanel.className = "window-switcher-panel";
windowSwitcherPanel.setAttribute("role", "status");
windowSwitcherPanel.setAttribute("aria-live", "polite");
const windowSwitcherHeader = document.createElement("div");
windowSwitcherHeader.className = "window-switcher-header";
const windowSwitcherTitle = document.createElement("span");
windowSwitcherTitle.textContent = "Windows";
const windowSwitcherPosition = document.createElement("span");
windowSwitcherPosition.className = "window-switcher-position";
windowSwitcherHeader.append(windowSwitcherTitle, windowSwitcherPosition);
const windowSwitcherList = document.createElement("div");
windowSwitcherList.className = "window-switcher-list";
windowSwitcherPanel.append(windowSwitcherHeader, windowSwitcherList);
windowSwitcher.appendChild(windowSwitcherPanel);
document.body.appendChild(windowSwitcher);

const paletteLauncher = document.createElement("button");
paletteLauncher.type = "button";
paletteLauncher.className = "palette-fab";
paletteLauncher.textContent = "≡";
paletteLauncher.title = "Commands (Ctrl+K)";
paletteLauncher.setAttribute("aria-label", "Open command palette");
paletteLauncher.addEventListener("click", () => openCommandPalette());
document.body.appendChild(paletteLauncher);

const workspaceStatus = document.createElement("div");
workspaceStatus.className = "workspace-status";
workspaceStatus.setAttribute("role", "status");
workspaceStatus.setAttribute("aria-live", "polite");
workspaceStatus.dataset.state = "idle";
workspaceStatus.textContent = "Loading...";
document.body.appendChild(workspaceStatus);

const wakeRecoveryStatus = document.createElement("div");
wakeRecoveryStatus.className = "wake-recovery-status";
wakeRecoveryStatus.hidden = true;
wakeRecoveryStatus.setAttribute("role", "status");
wakeRecoveryStatus.setAttribute("aria-live", "polite");
document.body.appendChild(wakeRecoveryStatus);

board.addEventListener("pointerdown", startDrawing);
board.addEventListener("pointerdown", (event) => {
  if (event.button === 1) startDrawing(event);
}, { capture: true });
board.addEventListener("auxclick", (event) => {
  if (event.button === 1) {
    event.preventDefault();
    event.stopPropagation();
  }
}, { capture: true });
board.addEventListener("lostpointercapture", (event) => {
  if (interaction?.type === "draw" && interaction.id === event.pointerId) {
    finishInteraction({ pointerId: event.pointerId, type: "pointercancel" });
  }
});
board.addEventListener("contextmenu", openWorkspaceMenu);
document.addEventListener("pointerdown", hideMenusWhenOutside);
document.addEventListener("keydown", hideMenusOnEscape);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && interaction?.type === "draw" && interaction.button === 1) {
    event.preventDefault();
    event.stopPropagation();
    finishInteraction({ pointerId: interaction.id, type: "pointercancel" });
    hideAllMenus();
  }
}, { capture: true });
document.addEventListener("keydown", handleSettingsKeyboard, { capture: true });
document.addEventListener("focusin", containSettingsFocus);
document.addEventListener("focusin", containWindowListFocus);
document.addEventListener("focusin", containCommandWheelFocus);
document.addEventListener("keydown", handlePaneKeyboardShortcuts, { capture: true });
document.addEventListener("keyup", handleWindowSwitcherKeyup, { capture: true });
document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  browserWakePending = true;
  checkForBrowserWake();
});
// pagehide is the one teardown event that also fires when a tab is discarded
// or frozen, where unload does not.
window.addEventListener("pagehide", saveWorkspaceOnExit);
window.addEventListener("pagehide", saveUserSettingsOnExit);
window.addEventListener("pagehide", () => {
  shortcutsUI.close();
  for (const rect of rectangles) {
    disposeVNCPane(rect);
    rect.terminal?.files?.dispose();
  }
});
window.addEventListener("pointermove", continueInteraction);
window.addEventListener("pointerup", finishInteraction);
window.addEventListener("pointercancel", finishInteraction);
window.addEventListener("blur", hideWindowSwitcher);
window.addEventListener("blur", () => {
  if (interaction?.type === "draw" && interaction.button === 1) {
    finishInteraction({ pointerId: interaction.id, type: "pointercancel" });
  }
});
window.addEventListener("resize", hideAllMenus);
window.addEventListener("popstate", () => void handleSessionHistoryNavigation());
window.addEventListener("message", handleBrowserPaneMessage);

applyTheme(themeID, { save: false });
void refreshClipboardBridgeAndPrompt();
showIPadHTTPGuidanceIfNeeded();
void startApp()
  .catch((error) => console.warn(error))
  .finally(startServerConnectionMonitor);

function startDrawing(event, { capture = true } = {}) {
  if (interaction || (event.button !== 1 && (event.button !== 0 || event.target !== board))) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  hideAllMenus();

  const point = boardPoint(event);
  const cwd = activeRect?.cwd || "";
  interaction = {
    type: "draw",
    id: event.pointerId,
    button: event.button,
    rect: null,
    cwd,
    startX: point.x,
    startY: point.y,
  };
  if (event.button === 0) createDrawnRectangle(interaction);
  if (capture) board.setPointerCapture(event.pointerId);
}

function createDrawnRectangle(draw) {
  if (activeRect || activePaneID) clearActivePane();
  draw.rect = createRectangle(draw.startX, draw.startY, 1, 1, {
    kind: "pending", cwd: draw.cwd, zIndex: nextZIndex,
  });
  nextZIndex += 1;
}

function startMoving(event, rect, captureElement = rect.element) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  hideFloatingMenus();
  setActivePane(rect, { raise: true, focus: true });

  const point = boardPoint(event);
  interaction = {
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
  windowWobble.start(rect.element, rect.x, rect.y, point.x - rect.x, point.y - rect.y);
}

function startResizing(event, rect, handle) {
  windowWobble.stop();
  if (themeID === "oled-terminal" && rect.oledMoveMode && event.button === 0) {
    startMoving(event, rect);
    return;
  }
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  hideFloatingMenus();
  clearFullState(rect);
  setActivePane(rect, { raise: true, focus: true });

  const point = boardPoint(event);
  interaction = {
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
    for (const other of rectangles) {
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
  if (!interaction || interaction.id !== event.pointerId) {
    return;
  }

  const point = boardPoint(event);
  if (interaction.type === "draw") {
    if (!interaction.rect) {
      if (Math.hypot(point.x - interaction.startX, point.y - interaction.startY) < 6) return;
      createDrawnRectangle(interaction);
    }
    const box = boxFromDrag(interaction.startX, interaction.startY, point.x, point.y, event.shiftKey);
    clampIntoBoard(box);
    setRectangle(interaction.rect, box);
    return;
  }

  if (interaction.type === "move") {
    const dx = point.x - interaction.startX;
    const dy = point.y - interaction.startY;
    if (interaction.rect.isFull && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      clearFullState(interaction.rect);
    }
    const next = {
      ...interaction.original,
      x: interaction.original.x + dx,
      y: interaction.original.y + dy,
    };
    clampIntoBoard(next);
    setRectangle(interaction.rect, next);
    windowWobble.move(interaction.rect.x, interaction.rect.y);
    return;
  }

  if (interaction.type === "resize") {
    const next = resizeBox(interaction.original, interaction.handle, point.x - interaction.startX, point.y - interaction.startY, event.shiftKey);
    clampIntoBoard(next);
    setRectangle(interaction.rect, next);
  }
}

function finishInteraction(event) {
  if (!interaction || interaction.id !== event.pointerId) {
    return;
  }

  const finishedInteraction = interaction;
  interaction = null;

  if (finishedInteraction.type === "draw") {
    if (!finishedInteraction.rect) return;
    if (event.type === "pointercancel" || finishedInteraction.rect.width < 6 || finishedInteraction.rect.height < 6) {
      destroyRectangle(finishedInteraction.rect, { selectNext: false });
      return;
    }
    showWindowTypeMenu(finishedInteraction.rect, event.clientX, event.clientY);
    return;
  }

  if (finishedInteraction.type === "move") {
    setOLEDMoveMode(finishedInteraction.rect, false);
    if (event.type === "pointercancel") windowWobble.stop();
    else windowWobble.release();
  }

}

function createRectangle(x, y, width, height, options = {}) {
  if (["file-browser", "worksheet", "text-editor"].includes(options.kind)) options = { ...options, kind: "terminal" };
  const element = document.createElement("div");
  element.className = "rectangle";
  element.dataset.paneId = options.id || "";
  element.tabIndex = -1;
  element.addEventListener("pointerdown", (event) => {
    if (event.target === element) {
      startMoving(event, rect);
    }
  });

  const rect = {
    id: options.id || newPaneID(),
    kind: options.kind || "terminal",
    x,
    y,
    width,
    height,
    element,
    zIndex: options.zIndex || 0,
    title: options.title || defaultPaneTitle(options.kind || "terminal"),
    // Archived documents from retired panes stay opaque and survive layout saves.
    archivedContent: {
      bufferText: options.text || "",
      editorTabs: options.editorTabs || "",
      editorMode: options.editorMode || "",
      lastExportPath: options.lastExportPath || "",
    },
    fontSize: normalizePaneFontSize(options.fontSize),
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
    isFull: Boolean(options.isFull),
    minimized: Boolean(options.minimized),
    restoreBox: options.restoreBox || null,
    minButton: null,
    maxButton: null,
  };
  element.dataset.paneId = rect.id;
  element.addEventListener("lostpointercapture", (event) => {
    if (interaction?.rect === rect && interaction.id === event.pointerId) {
      finishInteraction({ pointerId: event.pointerId, type: "pointercancel" });
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
    hideFloatingMenus();
    toggleFullRestore(rect);
  }

  const tab = document.createElement("div");
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
    startMoving(event, rect, tab);
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

  const grip = document.createElement("div");
  grip.className = "window-grip";
  grip.addEventListener("pointerdown", (event) => {
    if (themeID === "operator") return; // The dotted grip drags; right-click still opens the window menu.
    if (event.button === 0) {
      // Keep the menu below the grip so a second click still lands on the
      // title bar and can complete a double-click.
      openDockMenu(event, rect, tabHeight);
    }
  });
  grip.addEventListener("contextmenu", (event) => openDockMenu(event, rect));

  const title = document.createElement("input");
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
      hideFloatingMenus();
      setActivePane(rect, { raise: true });
    }
  });
  title.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    startTitleRename(rect, title);
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
    updateDeskbar();
    scheduleWorkspaceSave();
  });

  const controls = document.createElement("div");
  controls.className = "window-controls";
  const minButton = document.createElement("button");
  minButton.type = "button";
  minButton.className = "window-control window-control-min";
  const maxButton = document.createElement("button");
  maxButton.type = "button";
  maxButton.className = "window-control window-control-max";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "window-control window-control-close";
  closeButton.dataset.glyph = "close";
  closeButton.title = "Close";
  closeButton.setAttribute("aria-label", "Close window");
  rect.minButton = minButton;
  rect.maxButton = maxButton;
  for (const [button, run] of [[minButton, () => toggleMinimize(rect)], [maxButton, () => toggleFullRestore(rect)], [closeButton, () => closeWindowFromTitleBar(rect)]]) {
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

  const status = document.createElement("div");
  status.className = "window-status";

  const fontSizeControl = document.createElement("div");
  fontSizeControl.className = "window-font-size";
  fontSizeControl.setAttribute("aria-label", "Font size");
  const fontSizeDecreaseButton = document.createElement("button");
  fontSizeDecreaseButton.className = "window-font-size-button";
  fontSizeDecreaseButton.type = "button";
  fontSizeDecreaseButton.textContent = "A−";
  fontSizeDecreaseButton.title = "Decrease font size";
  fontSizeDecreaseButton.setAttribute("aria-label", "Decrease font size");
  const fontSizeValue = document.createElement("output");
  fontSizeValue.className = "window-font-size-value";
  const fontSizeIncreaseButton = document.createElement("button");
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
      setPaneFontSize(rect, rect.fontSize + delta);
    });
  }
  fontSizeControl.append(fontSizeDecreaseButton, fontSizeValue, fontSizeIncreaseButton);
  rect.fontSizeValue = fontSizeValue;
  rect.fontSizeDecreaseButton = fontSizeDecreaseButton;
  rect.fontSizeIncreaseButton = fontSizeIncreaseButton;

  const cwdLabel = document.createElement("span");
  cwdLabel.className = "window-status-label";
  cwdLabel.textContent =  rect.kind === browserPaneKind
        ? "url"
      : rect.kind === vncPaneKind
        ? "target"
      : "cwd";

  const cwdInput = document.createElement("input");
  cwdInput.className = "window-cwd";
  cwdInput.type = "text";
  cwdInput.value =  rect.kind === browserPaneKind
      ? rect.browserUrl
    : rect.kind === vncPaneKind
      ? rect.vncTarget
      : rect.cwd;
  cwdInput.placeholder =  rect.kind === browserPaneKind
        ? "localhost:5000"
      : rect.kind === vncPaneKind
        ? "host:5900"
      : "host default";
  cwdInput.readOnly = true;
  cwdInput.spellcheck = false;
  cwdInput.setAttribute("aria-label",  rect.kind === browserPaneKind
        ? "Browser address"
      : rect.kind === vncPaneKind
        ? "VNC target"
      : "Pane working directory");
  cwdInput.addEventListener("pointerdown", (event) => {
    if (rect.kind === browserPaneKind || rect.kind === vncPaneKind) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hideFloatingMenus();
    setActivePane(rect, { raise: true });
    openDirectoryBrowser(rect, rect.cwd);
  });
  cwdInput.addEventListener("keydown", (event) => {
    if (rect.kind === browserPaneKind || rect.kind === vncPaneKind) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setActivePane(rect, { raise: true });
      openDirectoryBrowser(rect, rect.cwd);
    }
  });
  cwdInput.addEventListener("input", () => {
    setPaneCwd(rect, cwdInput.value, { fromField: true });
  });

  const body = document.createElement("div");
  body.className = "window-body";
  rect.body = body;
  body.setAttribute("aria-label", rect.kind === "terminal"
    ? "Terminal"
    : rect.kind === browserPaneKind
        ? "Browser"
      : rect.kind === vncPaneKind
        ? "VNC remote desktop"
      : rect.kind === "pending"
        ? "New window"
        : "Terminal");
  body.addEventListener("pointerdown", () => {
    hideFloatingMenus();
  }, { capture: true });
  // A right-click on an OLED border arms this explicit move mode. Keep it
  // ahead of terminal mouse reporting.
  body.addEventListener("pointerdown", (event) => {
    if (themeID === "oled-terminal" && rect.oledMoveMode && event.button === 0) {
      startMoving(event, rect);
    }
  }, { capture: true });
  body.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    setActivePane(rect, { raise: true });
    if (rect.kind === "terminal") {
      rect.terminal?.term?.focus();
    }
  });
  body.addEventListener("focusin", () => setActivePane(rect, { raise: true }));

  tab.appendChild(grip);
  tab.appendChild(title);
  tab.appendChild(controls);
  updateWindowControls(rect);
  if (rect.kind === "terminal") {
    status.appendChild(fontSizeControl);
    updatePaneFontSizeUI(rect);
  }
  status.appendChild(cwdLabel);
  status.appendChild(cwdInput);
  element.appendChild(tab);
  element.appendChild(body);
  element.appendChild(status);
  if (rect.kind === browserPaneKind) {
    rect.browserStatusInput = cwdInput;
  } else if (rect.kind === vncPaneKind) {
    rect.vncStatusInput = cwdInput;
  } else if (rect.kind !== browserPaneKind) {
    rect.cwdInput = cwdInput;
  }
  setPaneCwd(rect, rect.cwd, { silent: true });

  if (rect.kind === "terminal") {
    body.classList.add("is-terminal");
    const terminalContainer = document.createElement("div");
    terminalContainer.className = "terminal-container";
    // Ghostty makes this surface editable for keyboard input. Browser writing
    // assistants must not treat its painted output as a prose text field.
    terminalContainer.spellcheck = false;
    terminalContainer.setAttribute("writingsuggestions", "false");
    terminalContainer.setAttribute("autocorrect", "off");
    terminalContainer.setAttribute("autocapitalize", "off");
    body.appendChild(terminalContainer);
    rect.terminalContainer = terminalContainer;
    void startTerminal(rect);
  } else if (rect.kind === browserPaneKind) {
    mountBrowserPane(rect);
  } else if (rect.kind === vncPaneKind) {
    mountVNCPane(rect);
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
    const node = document.createElement("div");
    node.className = kind === "edge" ? `resize-edge resize-edge-${handle}` : `resize-handle handle-${handle}`;
    node.addEventListener("pointerdown", (event) => startResizing(event, rect, handle));
    node.addEventListener("contextmenu", (event) => {
      if (themeID !== "oled-terminal") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setActivePane(rect, { raise: true });
      setOLEDMoveMode(rect, !rect.oledMoveMode);
    });
    element.appendChild(node);
  }

  rectangles.push(rect);
  board.appendChild(element);
  setRectangle(rect, rect);
  if (rect.isFull) {
    // A pane loaded already-maximized fills whatever board it's on now,
    // not the literal size it was saved at (which may be from a different
    // screen entirely).
    applyFullGeometry(rect);
  }
  rect.element.style.zIndex = String(rect.zIndex);
  nextZIndex = Math.max(nextZIndex, rect.zIndex + 1);
  updateDeskbar();
  return rect;
}

function mountBrowserPane(rect) {
  rect.body.classList.add("is-browser");
  const pane = document.createElement("div");
  pane.className = "browser-pane";
  const toolbar = document.createElement("div");
  toolbar.className = "browser-toolbar";
  const back = browserToolbarButton("\u2190", "Back");
  const forward = browserToolbarButton("\u2192", "Forward");
  const reload = browserToolbarButton("\u21bb", "Reload");
  const address = document.createElement("input");
  address.className = "browser-address";
  address.type = "text";
  address.placeholder = "localhost:5000";
  address.value = rect.browserUrl;
  address.spellcheck = false;
  address.setAttribute("aria-label", "Browser address");
  const localPortHelp = browserNetworkHelpButton();
  const openExternal = browserToolbarButton("\u2197", "Open externally");
  const message = document.createElement("div");
  message.className = "browser-message";
  message.textContent = rect.browserUrl ? "Connecting..." : "Enter a loopback development-server address.";
  const frame = document.createElement("iframe");
  frame.className = "browser-frame";
  frame.title = rect.title;
  frame.hidden = true;
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-downloads");
  frame.setAttribute("referrerpolicy", "no-referrer");

  rect.browser = { pane, address, frame, message, sessionID: "" };
  back.addEventListener("click", () => frame.contentWindow?.postMessage("tessera-browser-back", "*"));
  forward.addEventListener("click", () => frame.contentWindow?.postMessage("tessera-browser-forward", "*"));
  reload.addEventListener("click", () => {
    if (rect.browser?.sessionID) {
      frame.contentWindow?.postMessage("tessera-browser-reload", "*");
    } else if (rect.browserUrl) {
      void navigateBrowserPane(rect, rect.browserUrl);
    }
  });
  localPortHelp.addEventListener("click", () => openBrowserPortHelp(rect));
  openExternal.addEventListener("click", () => {
    if (rect.browserUrl) {
      window.open(rect.browserUrl, "_blank", "noopener,noreferrer");
    }
  });
  address.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void navigateBrowserPane(rect, address.value);
    }
  });

  toolbar.append(back, forward, reload, address, localPortHelp, openExternal);
  pane.append(toolbar, message, frame);
  rect.body.appendChild(pane);
  if (rect.browserUrl) {
    void navigateBrowserPane(rect, rect.browserUrl);
  }
}

function browserToolbarButton(label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "browser-toolbar-button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function browserNetworkHelpButton() {
  const button = browserToolbarButton("", "Browse local port help");
  button.classList.add("browser-toolbar-icon");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const links = document.createElementNS("http://www.w3.org/2000/svg", "path");
  links.setAttribute("d", "M12 12 5 5m7 7 7-7m-7 7v7");
  links.setAttribute("fill", "none");
  links.setAttribute("stroke", "currentColor");
  links.setAttribute("stroke-width", "1.8");
  links.setAttribute("stroke-linecap", "round");
  for (const [cx, cy] of [[5, 5], [19, 5], [12, 12], [12, 19]]) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    node.setAttribute("cx", String(cx));
    node.setAttribute("cy", String(cy));
    node.setAttribute("r", "2.2");
    node.setAttribute("fill", "var(--pane-bg)");
    node.setAttribute("stroke", "currentColor");
    node.setAttribute("stroke-width", "1.8");
    svg.appendChild(node);
  }
  svg.prepend(links);
  button.appendChild(svg);
  return button;
}

async function navigateBrowserPane(rect, value) {
  const browser = rect?.browser;
  if (!browser) {
    return;
  }
  const requestID = ++rect.browserRequestID;
  const normalized = normalizeBrowserAddress(value);
  if (!normalized) {
    browser.message.textContent = "Use a loopback HTTP address such as localhost:5000.";
    browser.message.classList.add("is-error");
    browser.message.hidden = false;
    browser.frame.hidden = true;
    return;
  }
  browser.address.value = normalized;
  browser.message.textContent = `Connecting to ${normalized}...`;
  browser.message.classList.remove("is-error");
  browser.message.hidden = false;
  browser.frame.hidden = true;
  try {
    const response = await fetch("/api/browser-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: normalized }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `browser proxy failed: ${response.status}`);
    }
    if (requestID !== rect.browserRequestID || rect.browser !== browser || !rectangles.includes(rect)) {
      releaseBrowserProxySession(data.id);
      return;
    }
    const previousSessionID = browser.sessionID;
    browser.sessionID = data.id;
    rect.browserUrl = data.url || normalized;
    browser.address.value = rect.browserUrl;
    if (rect.browserStatusInput) {
      rect.browserStatusInput.value = rect.browserUrl;
    }
    browser.frame.src = data.path;
    browser.frame.hidden = false;
    browser.message.hidden = true;
    scheduleWorkspaceSave();
    if (previousSessionID && previousSessionID !== browser.sessionID) {
      releaseBrowserProxySession(previousSessionID);
    }
  } catch (error) {
    if (requestID !== rect.browserRequestID || rect.browser !== browser) return;
    browser.message.textContent = error.message || "Could not open development server.";
    browser.message.classList.add("is-error");
    browser.message.hidden = false;
    browser.frame.hidden = true;
  }
}

function handleBrowserPaneMessage(event) {
  if (event.data?.type === "tessera-browser-draw") {
    handleBrowserPaneDraw(event);
    return;
  }
  if (event.data?.type === "tessera-browser-key") {
    handleBrowserPaneShortcut(event);
    return;
  }
  if (event.data?.type !== "tessera-browser-location" || typeof event.data.url !== "string") {
    return;
  }
  const rect = rectangles.find((candidate) => candidate.kind === browserPaneKind && candidate.browser?.frame.contentWindow === event.source);
  if (!rect) {
    return;
  }
  const normalized = normalizeBrowserAddress(event.data.url);
  if (!normalized) {
    return;
  }
  rect.browserUrl = normalized;
  rect.browser.address.value = normalized;
  if (rect.browserStatusInput) {
    rect.browserStatusInput.value = normalized;
  }
  scheduleWorkspaceSave();
}

function handleBrowserPaneDraw(event) {
  const data = event.data;
  const rect = rectangles.find(candidate => candidate.kind === browserPaneKind && candidate.browser?.frame.contentWindow === event.source);
  if (!rect || rect.minimized || rect.browser.frame.hidden || !serverConnectionModal.hidden) return;
  if (!Number.isInteger(data.pointerId) || data.pointerId < 0 || !Number.isFinite(data.clientX) || !Number.isFinite(data.clientY)) return;
  const frame = rect.browser.frame, bounds = frame.getBoundingClientRect();
  const width = frame.clientWidth, height = frame.clientHeight;
  if (!width || !height) return;
  const pointer = {
    pointerId: data.pointerId, button: 1, target: board, shiftKey: data.shiftKey === true,
    clientX: bounds.left + data.clientX * bounds.width / width,
    clientY: bounds.top + data.clientY * bounds.height / height,
    preventDefault() {}, stopPropagation() {},
  };
  if (data.phase === "start") {
    if (interaction || data.clientX < 0 || data.clientX > width || data.clientY < 0 || data.clientY > height) return;
    // The iframe owns native pointer capture and relays the whole drag.
    startDrawing(pointer, { capture: false });
    interaction.browserFrame = frame;
  } else if (interaction?.type === "draw" && interaction.browserFrame === frame && interaction.id === data.pointerId) {
    if (data.phase === "move") continueInteraction(pointer);
    else if (data.phase === "end" || data.phase === "cancel") {
      finishInteraction({ ...pointer, type: data.phase === "cancel" ? "pointercancel" : "pointerup" });
    }
  }
}

// Keystrokes typed while a browser pane's iframe holds focus never reach this
// document, so the proxy bootstrap relays the window-management ones here.
function handleBrowserPaneShortcut(event) {
  if (!serverConnectionModal.hidden) {
    return;
  }
  const keys = event.data;
  const rect = rectangles.find((candidate) => candidate.kind === browserPaneKind && candidate.browser?.frame.contentWindow === event.source);
  if (!rect) {
    return;
  }
  // Page content can post anything, so only the non-destructive window
  // shortcuts are honored from an iframe.
  if (!browserPaneRelayedKeys.has(keys.key) && !browserPaneRelayedKeys.has(keys.code)) {
    return;
  }
  const shortcut = paneShortcutAction(keys);
  if (!shortcut) {
    return;
  }
  // The iframe swallowed the click that focused it, so make sure the shortcut
  // acts on the pane the keystroke actually came from.
  if (getActivePane() !== rect) {
    setActivePane(rect, { raise: false });
  }
  shortcut.run();
}

function disposeBrowserPane(rect) {
  const browser = rect?.browser;
  if (!browser) {
    return;
  }
  if (interaction?.type === "draw" && interaction.browserFrame === browser.frame) {
    finishInteraction({ pointerId: interaction.id, type: "pointercancel" });
  }
  const sessionID = browser.sessionID;
  rect.browserRequestID += 1;
  rect.browserRequestID += 1;
  browser.sessionID = "";
  browser.frame.src = "about:blank";
  rect.browser = null;
  releaseBrowserProxySession(sessionID);
}

function releaseBrowserProxySession(sessionID) {
  if (!sessionID) return;
  void fetch(`/api/browser-proxy/${encodeURIComponent(sessionID)}`, { method: "DELETE" }).catch(() => {});
}

function loadVNCModule() {
  if (!vncModulePromise) {
    vncModulePromise = import("./vendor/vnc.js?v=novnc-1.7.0");
  }
  return vncModulePromise;
}

function mountVNCPane(rect) {
  rect.body.classList.add("is-vnc");
  const pane = document.createElement("div");
  pane.className = "vnc-pane";
  const toolbar = document.createElement("div");
  toolbar.className = "vnc-toolbar";
  const address = document.createElement("input");
  address.className = "vnc-address";
  address.type = "text";
  address.placeholder = "host:5900";
  address.value = rect.vncTarget;
  address.spellcheck = false;
  address.setAttribute("aria-label", "VNC target");
  const connect = browserToolbarButton("Connect", "Connect or disconnect VNC");
  connect.classList.add("vnc-connect");
  const ctrlAltDelete = browserToolbarButton("CAD", "Send Ctrl+Alt+Del");
  const scale = document.createElement("select");
  scale.className = "vnc-select";
  scale.setAttribute("aria-label", "VNC scaling");
  for (const [value, label] of [["fit", "Fit"], ["one-to-one", "1:1"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    scale.appendChild(option);
  }
  scale.value = rect.vncScaleMode;
  const viewOnlyLabel = document.createElement("label");
  viewOnlyLabel.className = "vnc-toggle";
  const viewOnly = document.createElement("input");
  viewOnly.type = "checkbox";
  viewOnly.checked = rect.vncViewOnly;
  viewOnlyLabel.append(viewOnly, "View only");
  const sendClipboard = browserToolbarButton("↑", "Send local clipboard to remote");
  const copyClipboard = browserToolbarButton("↓", "Copy remote clipboard locally");
  const message = document.createElement("div");
  message.className = "vnc-message";
  message.textContent = rect.vncTarget ? "Ready to connect." : "Enter a VNC server address.";
  const screen = document.createElement("div");
  screen.className = "vnc-screen";
  screen.tabIndex = 0;
  screen.hidden = true;
  const dialog = document.createElement("form");
  dialog.className = "vnc-dialog";
  dialog.hidden = true;

  rect.vnc = {
    pane, address, connect, ctrlAltDelete, scale, viewOnly, sendClipboard, copyClipboard,
    message, screen, dialog, rfb: null, credentials: {}, remoteClipboard: "", intentionalDisconnect: false,
  };
  toolbar.append(address, connect, ctrlAltDelete, scale, viewOnlyLabel, sendClipboard, copyClipboard);
  pane.append(toolbar, message, screen, dialog);
  rect.body.appendChild(pane);
  updateVNCControls(rect);

  address.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void connectVNCPane(rect);
    }
  });
  address.addEventListener("input", () => {
    rect.vncTarget = address.value;
    if (rect.vncStatusInput) {
      rect.vncStatusInput.value = rect.vncTarget;
    }
    scheduleWorkspaceSave();
  });
  connect.addEventListener("click", () => {
    if (rect.vnc?.rfb) {
      disconnectVNCPane(rect);
    } else {
      void connectVNCPane(rect);
    }
  });
  ctrlAltDelete.addEventListener("click", () => rect.vnc?.rfb?.sendCtrlAltDel());
  scale.addEventListener("change", () => {
    rect.vncScaleMode = normalizeVNCScaleMode(scale.value);
    applyVNCPreferences(rect);
    scheduleWorkspaceSave();
  });
  viewOnly.addEventListener("change", () => {
    rect.vncViewOnly = viewOnly.checked;
    applyVNCPreferences(rect);
    scheduleWorkspaceSave();
  });
  sendClipboard.addEventListener("click", () => void sendVNCClipboard(rect));
  copyClipboard.addEventListener("click", () => void copyVNCClipboard(rect));
}

function setVNCMessage(rect, text, error = false) {
  if (!rect.vnc) {
    return;
  }
  rect.vnc.message.textContent = text;
  rect.vnc.message.classList.toggle("is-error", error);
  rect.vnc.message.hidden = false;
}

function updateVNCControls(rect) {
  const view = rect.vnc;
  if (!view) {
    return;
  }
  const connected = Boolean(view.rfb);
  view.connect.textContent = connected ? "Disconnect" : "Connect";
  view.address.disabled = connected;
  view.ctrlAltDelete.disabled = !connected || rect.vncViewOnly;
  view.sendClipboard.disabled = !connected || rect.vncViewOnly;
  view.copyClipboard.disabled = !view.remoteClipboard;
}

function applyVNCPreferences(rect) {
  const rfb = rect.vnc?.rfb;
  if (!rfb) {
    return;
  }
  rfb.viewOnly = rect.vncViewOnly;
  rfb.scaleViewport = rect.vncScaleMode === "fit";
  rfb.clipViewport = rect.vncScaleMode === "one-to-one";
  rfb.resizeSession = false;
  rect.vnc.screen.classList.toggle("is-one-to-one", rect.vncScaleMode === "one-to-one");
  updateVNCControls(rect);
}

async function connectVNCPane(rect) {
  const view = rect?.vnc;
  if (!view || view.rfb) {
    return;
  }
  const target = normalizeVNCTarget(view.address.value);
  if (!target) {
    setVNCMessage(rect, "Enter a host, host:port, or bracketed IPv6 address.", true);
    return;
  }
  view.connect.disabled = true;
  setVNCMessage(rect, `Connecting to ${target}...`);
  hideVNCDialog(rect);
  try {
    const [module, response] = await Promise.all([
      loadVNCModule(),
      fetch("/api/vnc-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspaceID, target }),
      }),
    ]);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `VNC proxy failed: ${response.status}`);
    }
    if (!rect.vnc || !rectangles.includes(rect)) {
      return;
    }
    rect.vncTarget = data.target || target;
    view.address.value = rect.vncTarget;
    if (rect.vncStatusInput) {
      rect.vncStatusInput.value = rect.vncTarget;
    }
    const rfb = new module.RFB(view.screen, vncWebSocketURL(data.path, window.location), {
      shared: true,
      credentials: { ...view.credentials },
      wsProtocols: ["binary"],
    });
    view.rfb = rfb;
    view.intentionalDisconnect = false;
    rfb.addEventListener("connect", () => {
      if (view.rfb !== rfb) return;
      view.screen.hidden = false;
      view.message.hidden = true;
      hideVNCDialog(rect);
      updateVNCControls(rect);
      rfb.focus({ preventScroll: true });
    });
    rfb.addEventListener("disconnect", (event) => {
      if (view.rfb !== rfb) return;
      view.rfb = null;
      view.screen.hidden = true;
      hideVNCDialog(rect);
      setVNCMessage(rect, view.intentionalDisconnect || event.detail.clean ? "Disconnected." : "The VNC connection closed unexpectedly.", !view.intentionalDisconnect && !event.detail.clean);
      view.intentionalDisconnect = false;
      updateVNCControls(rect);
    });
    rfb.addEventListener("credentialsrequired", (event) => showVNCCredentials(rect, rfb, event.detail.types));
    rfb.addEventListener("serververification", (event) => void showVNCVerification(rect, rfb, event.detail));
    rfb.addEventListener("securityfailure", (event) => setVNCMessage(rect, event.detail.reason || "VNC authentication failed.", true));
    rfb.addEventListener("clipboard", (event) => {
      view.remoteClipboard = event.detail.text || "";
      updateVNCControls(rect);
    });
    applyVNCPreferences(rect);
    scheduleWorkspaceSave();
  } catch (error) {
    setVNCMessage(rect, error.message || "Could not connect to the VNC server.", true);
  } finally {
    if (rect.vnc) {
      rect.vnc.connect.disabled = false;
      updateVNCControls(rect);
    }
  }
}

function showVNCCredentials(rect, rfb, requestedTypes) {
  const view = rect.vnc;
  if (!view || view.rfb !== rfb) return;
  const fields = vncCredentialFields(requestedTypes);
  view.dialog.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = "Credentials required";
  view.dialog.appendChild(title);
  const inputs = {};
  for (const type of fields) {
    const input = document.createElement("input");
    input.type = type === "password" ? "password" : "text";
    input.placeholder = type === "target" ? "Target or session" : type[0].toUpperCase() + type.slice(1);
    input.autocomplete = type === "password" ? "current-password" : "off";
    input.setAttribute("aria-label", input.placeholder);
    input.value = view.credentials[type] || "";
    inputs[type] = input;
    view.dialog.appendChild(input);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Continue";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => disconnectVNCPane(rect));
  view.dialog.append(submit, cancel);
  view.dialog.onsubmit = (event) => {
    event.preventDefault();
    for (const [type, input] of Object.entries(inputs)) view.credentials[type] = input.value;
    hideVNCDialog(rect);
    rfb.sendCredentials({ ...view.credentials });
  };
  view.dialog.hidden = false;
  inputs[fields[0]]?.focus();
}

async function showVNCVerification(rect, rfb, details) {
  const view = rect.vnc;
  if (!view || view.rfb !== rfb) return;
  let identity = details?.type || "unknown type";
  if (details?.publickey instanceof Uint8Array && crypto.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", details.publickey));
    identity += ` SHA-256 ${[...digest].map((value) => value.toString(16).padStart(2, "0")).join(":")}`;
  }
  if (!rect.vnc || view.rfb !== rfb) return;
  view.dialog.replaceChildren();
  const message = document.createElement("span");
  message.textContent = `Verify this VNC server identity before continuing: ${identity}`;
  const approve = document.createElement("button");
  approve.type = "button";
  approve.textContent = "Trust once";
  approve.addEventListener("click", () => {
    hideVNCDialog(rect);
    rfb.approveServer();
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => disconnectVNCPane(rect));
  view.dialog.append(message, approve, cancel);
  view.dialog.hidden = false;
  approve.focus();
}

function showVNCClipboardEntry(rect) {
  const view = rect.vnc;
  if (!view?.rfb) return;
  view.dialog.replaceChildren();
  const field = document.createElement("textarea");
  field.placeholder = "Paste text to send to the remote desktop";
  field.setAttribute("aria-label", "Remote clipboard text");
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => hideVNCDialog(rect));
  view.dialog.append(field, send, cancel);
  view.dialog.onsubmit = (event) => {
    event.preventDefault();
    view.rfb?.clipboardPasteFrom(field.value);
    hideVNCDialog(rect);
    view.rfb?.focus({ preventScroll: true });
  };
  view.dialog.hidden = false;
  field.focus();
}

function hideVNCDialog(rect) {
  if (!rect.vnc) return;
  rect.vnc.dialog.hidden = true;
  rect.vnc.dialog.onsubmit = null;
  rect.vnc.dialog.replaceChildren();
}

async function sendVNCClipboard(rect) {
  const rfb = rect.vnc?.rfb;
  if (!rfb || rect.vncViewOnly) return;
  try {
    const text = await readClipboardText();
    if (clipboardReadFellBack) throw new Error("clipboard unavailable");
    rfb.clipboardPasteFrom(text);
    rfb.focus({ preventScroll: true });
  } catch {
    showVNCClipboardEntry(rect);
  }
}

async function copyVNCClipboard(rect) {
  const text = rect.vnc?.remoteClipboard;
  if (!text) return;
  if (!await writeClipboardText(text)) {
    setWorkspaceStatus("error", "Clipboard blocked", "The remote text is available to Tessera's own Paste.");
  }
  rect.vnc?.rfb?.focus({ preventScroll: true });
}

function disconnectVNCPane(rect) {
  const view = rect?.vnc;
  if (!view?.rfb) return;
  view.intentionalDisconnect = true;
  view.rfb.disconnect();
}

function disposeVNCPane(rect) {
  const view = rect?.vnc;
  if (!view) return;
  view.intentionalDisconnect = true;
  view.rfb?.disconnect();
  view.credentials = {};
  view.remoteClipboard = "";
  view.rfb = null;
  rect.vnc = null;
}



















function startTitleRename(rect, title) {
  hideFloatingMenus();
  setActivePane(rect, { raise: true });
  title.readOnly = false;
  title.classList.add("is-renaming");
  title.focus({ preventScroll: true });
  title.select();
  requestAnimationFrame(() => {
    if (document.activeElement === title && !title.readOnly) {
      title.select();
    }
  });
}

function normalizePaneFontSize(fontSize) {
  const parsed = Number(fontSize);
  if (!Number.isFinite(parsed)) {
    return defaultPaneFontSize;
  }
  return Math.max(minimumPaneFontSize, Math.min(maximumPaneFontSize, Math.round(parsed)));
}



function setPaneFontSize(rect, fontSize) {
  if (!rect || (rect.kind !== "terminal")) {
    return;
  }
  rect.fontSize = normalizePaneFontSize(fontSize);
  updatePaneFontSizeUI(rect);
  if (rect.kind === "terminal" && rect.terminal?.term) {
    rect.terminal.term.options.fontSize = rect.fontSize;
    requestTerminalFit(rect);
  } else {
  }
  scheduleWorkspaceSave();
}

function adjustActivePaneFontSize(delta) {
  const rect = getActivePane();
  if (rect) {
    setPaneFontSize(rect, rect.fontSize + delta);
    showPaneFontSizeIndicator(rect);
  }
}

function resetActivePaneFontSize() {
  const rect = getActivePane();
  if (rect) {
    setPaneFontSize(rect, defaultPaneFontSize);
    showPaneFontSizeIndicator(rect);
  }
}

function showPaneFontSizeIndicator(rect) {
  if (!rect.body || (rect.kind !== "terminal")) {
    return;
  }
  if (rect.fontSizeIndicator?.parentElement !== rect.body) {
    const indicator = document.createElement("div");
    indicator.className = "window-font-size-indicator";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-atomic", "true");
    rect.body.appendChild(indicator);
    rect.fontSizeIndicator = indicator;
  }
  const indicator = rect.fontSizeIndicator;
  const percentage = Math.round(rect.fontSize / defaultPaneFontSize * 100);
  indicator.setAttribute("aria-hidden", "false");
  indicator.textContent = `Text size ${percentage}%`;
  indicator.classList.add("is-visible");
  window.clearTimeout(rect.fontSizeIndicatorTimer);
  rect.fontSizeIndicatorTimer = window.setTimeout(() => {
    indicator.classList.remove("is-visible");
    indicator.setAttribute("aria-hidden", "true");
    rect.fontSizeIndicatorTimer = null;
  }, 1200);
}

function updatePaneFontSizeUI(rect) {
  if (!rect) {
    return;
  }
  rect.fontSize = normalizePaneFontSize(rect.fontSize);
  if (rect.fontSizeValue) {
    rect.fontSizeValue.value = String(rect.fontSize);
    rect.fontSizeValue.textContent = `${rect.fontSize}px`;
  }
  if (rect.fontSizeDecreaseButton) {
    rect.fontSizeDecreaseButton.disabled = rect.fontSize <= minimumPaneFontSize;
  }
  if (rect.fontSizeIncreaseButton) {
    rect.fontSizeIncreaseButton.disabled = rect.fontSize >= maximumPaneFontSize;
  }
}

function setActivePane(rect, options = {}) {
  if (!rect || !rectangles.includes(rect)) {
    clearActivePane();
    return;
  }
  const wasActive = activePaneID === rect.id;
  const needsRaise = Boolean(options.raise) && paneNeedsRaise(rectangles, rect);
  if (wasActive && !needsRaise) {
    if (options.focus) {
      focusPane(rect);
    } else if (options.focusElement) {
      rect.element.focus({ preventScroll: true });
    }
    return;
  }
  clearActivePaneClass();
  activeRect = rect;
  activePaneID = rect.id;
  board.dataset.activePaneId = activePaneID;
  rect.element.dataset.activePane = "true";
  rect.element.classList.add("is-selected");
  setTerminalCursorBlink(rect, true);
  if (needsRaise) {
    rect.zIndex = nextZIndex;
    nextZIndex += 1;
    rect.element.style.zIndex = String(rect.zIndex);
    scheduleTerminalVisibilityUpdate();
  }
  if (options.focus) {
    focusPane(rect);
  } else if (options.focusElement) {
    rect.element.focus({ preventScroll: true });
  }
  if (!wasActive || needsRaise) {
    scheduleWorkspaceSave();
  }
  updateDeskbar();
}

function openRenameWindowModal(rect) {
  if (!rect || !rectangles.includes(rect)) {
    return;
  }
  hideAllMenus();
  renameWindowModal.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "settings-panel rename-window-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "rename-window-title");

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "rename-window-title";
  title.textContent = "Set Window Title";
  titleBar.appendChild(title);

  const content = document.createElement("div");
  content.className = "settings-content rename-window-content";
  const label = document.createElement("label");
  label.htmlFor = "rename-window-input";
  label.textContent = "Window title";
  const input = document.createElement("input");
  input.id = "rename-window-input";
  input.className = "rename-window-input";
  input.type = "text";
  input.value = rect.title;
  input.spellcheck = false;

  const actions = document.createElement("div");
  actions.className = "rename-window-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "settings-background-button";
  cancelButton.textContent = "Cancel";
  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.className = "settings-background-button";
  renameButton.textContent = "Set Title";

  const save = () => {
    if (!rectangles.includes(rect)) {
      hideRenameWindowModal();
      return;
    }
    rect.title = input.value;
    rect.titleInput.value = rect.title;
    updateDeskbar();
    scheduleWorkspaceSave();
    hideRenameWindowModal();
    setActivePane(rect, { raise: true, focus: true });
  };
  cancelButton.addEventListener("click", hideRenameWindowModal);
  renameButton.addEventListener("click", save);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      hideRenameWindowModal();
    }
  });

  actions.append(cancelButton, renameButton);
  content.append(label, input, actions);
  panel.append(titleBar, content);
  renameWindowModal.appendChild(panel);
  renameWindowModal.hidden = false;
  input.focus();
  input.select();
}

function hideRenameWindowModal() {
  renameWindowModal.hidden = true;
  renameWindowModal.replaceChildren();
}

function clearActivePane() {
  clearActivePaneClass();
  activeRect = null;
  activePaneID = "";
  delete board.dataset.activePaneId;
  scheduleWorkspaceSave();
  updateDeskbar();
}

function clearActivePaneClass() {
  if (activeRect) {
    activeRect.element.classList.remove("is-selected");
    delete activeRect.element.dataset.activePane;
    setTerminalCursorBlink(activeRect, false);
  }
}

// Only the active pane blinks. The adapter requests a frame per blink tick
// and hides inactive cursors without keeping an idle animation loop alive.
// Selection also transfers parsing priority to the active visible terminal.
function setTerminalCursorBlink(rect, blink) {
  if (rect?.kind !== "terminal" || !rect.terminal?.term) {
    return;
  }
  try {
    const { term } = rect.terminal;
    const active = blink && !document.hidden && !rect.minimized && !term.renderPaused;
    rect.terminal.output?.setActive?.(active);
    term.setCursorActive?.(active);
  } catch {
    // Terminal not fully initialized yet; ignore.
  }
}

function updateTerminalRenderState(rect) {
  const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
  if (!term) {
    return;
  }
  const paused = document.hidden || Boolean(rect.minimized) || terminalIsCovered(rect, rectangles);
  const wasPaused = term.renderPaused;
  term.setRenderPaused?.(paused);
  rect.terminal.output?.setActive?.(!paused && activeRect === rect);
  term.setCursorActive?.(!paused && activeRect === rect);
  if (!paused && wasPaused) {
    term.requestFullRedraw?.();
  }
  setTerminalOutputPaused(rect, paused);
}

function setTerminalOutputPaused(rect, paused) {
  const terminalState = rect.terminal;
  if (!terminalState || Boolean(terminalState.outputPaused) === paused) return;
  terminalState.outputPaused = paused;
  if (paused) {
    // Keep shell-exit notices connected while pausing server delivery. Reveal
    // requests bounded replay from the applied cutoff, or a fresh snapshot for
    // a larger gap. Older hosts retain their snapshot-on-change fallback.
    terminalState.snapshotIfChanged = true;
    if (terminalState.socket?.readyState === WebSocket.OPEN) {
      terminalState.socket.send(JSON.stringify({ type: "pause-output" }));
    }
    const replica = terminalState.replica;
    replica.disconnect();
    if (terminalState.reconnectTimer !== null) {
      window.clearTimeout(terminalState.reconnectTimer);
      terminalState.reconnectTimer = null;
    }
    completeTerminalWakeRecovery(terminalState);
    return;
  }
  if (rect.terminalStatus && !rect.terminalStatus.reconnect) return;
  // Small gaps replay from the applied cursor; larger gaps use a snapshot.
  // An unchanged terminal keeps selection and scroll. Replace the socket so late
  // messages from the discarded stream stay inert.
  const oldSocket = terminalState.socket;
  terminalState.reconnectAttempts = 0;
  connectTerminalSocket(rect);
  if (oldSocket?.readyState === WebSocket.OPEN || oldSocket?.readyState === WebSocket.CONNECTING) {
    oldSocket.send(JSON.stringify({ type: "file-handoff" }));
    oldSocket.close(1000, "Restoring visible terminal");
  }
}

function scheduleTerminalVisibilityUpdate() {
  if (terminalVisibilityFrame !== null) return;
  terminalVisibilityFrame = window.requestAnimationFrame(() => {
    terminalVisibilityFrame = null;
    for (const rect of rectangles) updateTerminalRenderState(rect);
  });
}

function handleDocumentVisibilityChange() {
  checkForBrowserWake();
  updateTerminalDocumentVisibility();
  if (serverHealthMonitorTimer !== null) scheduleServerHealthPolling();
  if (document.hidden) {
    // A backgrounded tab may be discarded without ever running code again,
    // so anything scheduled goes out now. This one takes the ordinary path:
    // the page is still here to read the response and keep its revision in
    // step, which the exit flush cannot do.
    void saveWorkspace();
    void flushUserSettingsSave().catch(reportSettingsSaveError);
    return;
  }
  // A backgrounded tab has its timers throttled, so a pane that went to
  // sleep waiting may be well past the moment it meant to try again — and
  // after a machine suspends, the socket it was holding can be gone without
  // having said so.
  // ResizeObserver delivery can also be throttled while hidden, so measure
  // every visible terminal before resuming its connection.
  for (const rect of rectangles) {
    if (rect.kind === "terminal" && !rect.minimized) requestTerminalFit(rect);
  }
  resumeTerminalConnections();
  void checkServerConnection({ force: true });
}

function checkForBrowserWake() {
  const sample = { wall: Date.now(), monotonic: performance.now() };
  if (browserWakeDetected(browserWakeSample, sample)) browserWakePending = true;
  browserWakeSample = sample;
  if (!browserWakePending || document.hidden) return;
  browserWakePending = false;
  void recoverAfterBrowserWake();
}

async function recoverAfterBrowserWake() {
  const recoveryID = ++wakeRecoveryID;
  wakeRecoveryActive = true;
  wakeRecoveryHealthReady = false;
  wakeRecoveryTerminals.clear();
  window.clearTimeout(wakeRecoveryStatusHideTimer);
  wakeRecoveryStatusHideTimer = null;

  for (const rect of rectangles) {
    const terminalState = rect.kind === "terminal" ? rect.terminal : null;
    if (!terminalState?.term) continue;
    if (terminalState.outputPaused) continue;
    requestTerminalFit(rect);
    terminalState.term.requestFullRedraw?.();
    if (rect.terminalStatus && !rect.terminalStatus.reconnect) continue;

    wakeRecoveryTerminals.add(terminalState);
    terminalState.wakeRecoveryID = recoveryID;
    if (terminalState.reconnectTimer !== null) {
      window.clearTimeout(terminalState.reconnectTimer);
      terminalState.reconnectTimer = null;
    }
    terminalState.reconnectAttempts = 0;
    const oldSocket = terminalState.socket;
    connectTerminalSocket(rect);
    if (oldSocket?.readyState === WebSocket.OPEN || oldSocket?.readyState === WebSocket.CONNECTING) {
      oldSocket.close(1000, "Reconnecting after wake");
    }
  }
  updateWakeRecoveryStatus();

  const healthy = await checkServerConnection({ force: true });
  if (recoveryID !== wakeRecoveryID) return;
  if (healthy) wakeRecoveryHealthReady = true;
  updateWakeRecoveryStatus();
}

function completeTerminalWakeRecovery(terminalState) {
  if (!wakeRecoveryActive || terminalState?.wakeRecoveryID !== wakeRecoveryID) return;
  terminalState.wakeRecoveryID = 0;
  wakeRecoveryTerminals.delete(terminalState);
  updateWakeRecoveryStatus();
}

function updateWakeRecoveryStatus() {
  if (!wakeRecoveryActive) return;
  const pending = wakeRecoveryTerminals.size;
  if (!wakeRecoveryHealthReady || pending > 0) {
    wakeRecoveryStatus.textContent = pending > 0
      ? `Reconnecting after wake… ${pending} terminal${pending === 1 ? "" : "s"}`
      : "Checking Tessera after wake…";
    wakeRecoveryStatus.hidden = false;
    return;
  }
  wakeRecoveryActive = false;
  wakeRecoveryStatus.textContent = "Ready after wake";
  wakeRecoveryStatus.hidden = false;
  wakeRecoveryStatusHideTimer = window.setTimeout(() => {
    wakeRecoveryStatus.hidden = true;
    wakeRecoveryStatusHideTimer = null;
  }, 2000);
}

function updateTerminalDocumentVisibility() {
  // Do this synchronously: a hidden document can throttle both timers and RAF.
  for (const rect of rectangles) updateTerminalRenderState(rect);
  if (!ghosttyModulePromise) {
    return;
  }
  void ghosttyModulePromise
    .then((module) => module.setTerminalDocumentVisible?.(!document.hidden))
    .catch(() => {});
}

function getActivePane() {
  return rectangles.find((rect) => rect.id === activePaneID) || null;
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
    scheduleWorkspaceSave();
  }
}

async function openDirectoryBrowser(rect, path) {
  if (!rect) {
    return;
  }
  directoryBrowserRect = rect;
  hideDockMenu();
  directoryBrowser.hidden = false;
  renderDirectoryBrowserLoading(path || "");

  try {
    await loadDirectoryBrowser(path || "");
  } catch (error) {
    renderDirectoryBrowserError(error.message || "Could not load directory");
  }
}

async function loadDirectoryBrowser(path) {
  const url = path ? `/api/directories?path=${encodeURIComponent(path)}` : "/api/directories";
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `directory load failed: ${response.status}`);
  }
  directoryBrowserPath = data.path || "";
  renderDirectoryBrowser(data);
}

function renderDirectoryBrowserLoading(path) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel("Choose Working Directory");
  const pathLine = document.createElement("div");
  pathLine.className = "directory-browser-path";
  pathLine.textContent = path || "host default";
  const message = document.createElement("div");
  message.className = "directory-browser-message";
  message.textContent = "Loading...";
  panel.appendChild(pathLine);
  panel.appendChild(message);
  directoryBrowser.appendChild(panel);
}

function renderDirectoryBrowserError(messageText) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel("Choose Working Directory");
  const message = document.createElement("div");
  message.className = "directory-browser-message is-error";
  message.textContent = messageText;
  const actions = document.createElement("div");
  actions.className = "directory-browser-actions";
  actions.appendChild(directoryBrowserButton("Close", hideDirectoryBrowser));
  panel.appendChild(message);
  panel.appendChild(actions);
  directoryBrowser.appendChild(panel);
}

function renderDirectoryBrowser(data) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel("Choose Working Directory");

  const pathLine = document.createElement("div");
  pathLine.className = "directory-browser-path";
  pathLine.textContent = data.path || "host default";
  pathLine.title = data.path || "host default";

  const nav = document.createElement("div");
  nav.className = "directory-browser-nav";
  if (data.parent) {
    nav.appendChild(directoryBrowserButton("Up", () => loadDirectoryBrowser(data.parent)));
  }
  for (const root of data.roots || []) {
    nav.appendChild(directoryBrowserButton(root.name, () => loadDirectoryBrowser(root.path)));
  }

  const list = document.createElement("div");
  list.className = "directory-browser-list";
  if ((data.entries || []).length === 0) {
    const empty = document.createElement("div");
    empty.className = "directory-browser-message";
    empty.textContent = "No folders";
    list.appendChild(empty);
  }
  for (const entry of data.entries || []) {
    const button = directoryBrowserButton(entry.name, () => loadDirectoryBrowser(entry.path));
    button.className = "directory-browser-entry";
    button.title = entry.path;
    list.appendChild(button);
  }

  const actions = document.createElement("div");
  actions.className = "directory-browser-actions";
  actions.appendChild(directoryBrowserButton("Host Default", () => chooseDirectory("")));
  actions.appendChild(directoryBrowserButton("Use This Folder", () => chooseDirectory(data.path || "")));
  actions.appendChild(directoryBrowserButton("Cancel", hideDirectoryBrowser));

  panel.appendChild(pathLine);
  panel.appendChild(nav);
  panel.appendChild(list);
  panel.appendChild(actions);
  directoryBrowser.appendChild(panel);
}

function directoryBrowserPanel(titleText) {
  const panel = document.createElement("div");
  panel.className = "directory-browser-panel";
  const title = document.createElement("div");
  title.className = "directory-browser-title";
  title.textContent = titleText;
  panel.appendChild(title);
  return panel;
}

function directoryBrowserButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function chooseDirectory(path) {
  if (directoryBrowserRect) {
    setPaneCwd(directoryBrowserRect, path);
  }
  hideDirectoryBrowser();
}

function setRectangle(rect, next) {
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
  scheduleTerminalVisibilityUpdate();
  if (sizeChanged) {
    rect.element.style.width = `${rect.width}px`;
    rect.element.style.height = `${rect.height}px`;
    requestTerminalFit(rect);
  }
  if (!isArrangingWindows) {
    arrangeOutSnapshot = null;
  }
  scheduleWorkspaceSave();
}

async function fetchWorkspace(id) {
  const response = await fetch(`/api/workspace/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`load workspace failed: ${response.status}`);
  const workspace = await response.json();
  if (!workspace || workspace.id !== id || typeof workspace.revision !== "string"
    || !Array.isArray(workspace.panes) || workspace.panes.some((pane) => !pane || typeof pane.id !== "string")) {
    throw new Error("Invalid workspace response");
  }
  return workspace;
}

function loadWorkspace(workspace) {
  isLoadingWorkspace = true;
  setWorkspaceStatus("loading", "Loading...");
  try {
    workspaceID = workspace.id || "default";
    workspaceRevision = workspace.revision || "";
    workspaceSaveSuspended = false;
    workspaceNeedsRevalidation = false;
    workspaceSaveQueued = false;
    workspaceConflictModal.hidden = true;
    applyWorkspaceBackground(Boolean(workspace.hasBackground), workspace.backgroundVersion || "", workspace.backgroundMode);
    clearRectanglesForLoad();

    let highestZIndex = 0;
    for (const pane of workspace.panes || []) {
      // Retired Audio panes in imported documents have no terminal to play on.
      if (pane.kind === "audio") continue;
      const rect = createRectangle(pane.x ?? 80, pane.y ?? tabHeight + 56, pane.width || 360, pane.height || 240, {
        id: pane.id,
        kind: pane.kind || "terminal",
        title: pane.title,
        text: pane.bufferText,
        editorMode: pane.editorMode,
        fontSize: pane.fontSize,
        cwd: pane.cwd,
        lastExportPath: pane.lastExportPath,
        editorTabs: pane.editorTabs,
        browserUrl: pane.browserUrl,
        vncTarget: pane.vncTarget,
        vncViewOnly: Boolean(pane.vncViewOnly),
        vncScaleMode: pane.vncScaleMode,
        zIndex: pane.zIndex || 0,
        minimized: Boolean(pane.minimized),
        isFull: Boolean(pane.isFull),
        restoreBox: parseRestoreBox(pane.restoreBox),
      });
      highestZIndex = Math.max(highestZIndex, rect.zIndex);
    }

    reflowDockedPanesForTheme();

    nextZIndex = Math.max(nextZIndex, highestZIndex + 1);
    const activeLoadedRect = activePaneOnLoad(rectangles, workspace.activePaneId);
    if (activeLoadedRect) {
      setActivePane(activeLoadedRect, { raise: false, focus: true });
    }
    updateDeskbar();
    setWorkspaceStatus("saved", "Saved", "Workspace loaded");
  } finally {
    isLoadingWorkspace = false;
  }
}

function clearRectanglesForLoad() {
  backgroundRequestID += 1;
  // Whatever is loaded next is the server's copy, not the content this browser
  // last pushed, so the next save carries its documents again.
  savedPaneContent = new Map();
  for (const rect of rectangles.splice(0)) {
    window.clearTimeout(rect.fontSizeIndicatorTimer);
    disposeTerminal(rect);
    disposeBrowserPane(rect);
    disposeVNCPane(rect);
    rect.element.remove();
  }
  activeRect = null;
  activePaneID = "";
  delete board.dataset.activePaneId;
  interaction = null;
  contextMenuRect = null;
  hideAllMenus();
  nextZIndex = 1;
  updateDeskbar();
}

function scheduleWorkspaceSave() {
  if (isLoadingWorkspace || workspaceSaveSuspended) {
    return;
  }
  if (workspaceNeedsRevalidation) {
    workspaceSaveQueued = true;
    setWorkspaceStatus("saving", "Waiting to reconnect...");
    return;
  }
  setWorkspaceStatus("saving", "Saving...");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveWorkspace(), 250);
}

function scheduleUserSettingsSave() {
  if (!currentUser) {
    return;
  }
  userSettingsDirty = true;
  window.clearTimeout(userSettingsSaveTimer);
  userSettingsSaveTimer = window.setTimeout(() => {
    void saveUserSettings().catch(reportSettingsSaveError);
  }, 250);
}

function userSettingsPayload() {
  return {
      revision: userSettingsRevision,
      defaultPaneFontSize,
      defaultTheme,
      themeId: themeID,
      deskbarButtonEnabled,
      terminalWheelSensitivity,
      oledWindowBorderSize,
      terminalTerm,
      terminalFont,
      terminalRowSpacing,
      terminalColorMode,
      // Clear the legacy account-wide value when settings are next saved.
      olderMacMode: false,
  };
}

function reportSettingsSaveError(error) {
  console.warn(error);
  setWorkspaceStatus("error", "Settings save failed", error.message || "Settings save failed");
}

async function saveUserSettings() {
  window.clearTimeout(userSettingsSaveTimer);
  userSettingsSaveTimer = null;
  if (userSettingsSavePromise) return userSettingsSavePromise;
  if (!currentUser || !userSettingsDirty) return;
  const url = userAPIPath("settings");
  userSettingsSavePromise = (async () => {
    while (userSettingsDirty) {
      userSettingsDirty = false;
      const body = userSettingsPayload();
      body.nextRevision = newWorkspaceRevision();
      userSettingsInFlightRevision = body.nextRevision;
      try {
        const response = await fetch(url, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body), keepalive: true,
        });
        if (!response.ok) throw new Error(response.status === 409
          ? "Settings changed in another browser. Refresh before saving settings again."
          : `save user settings failed: ${response.status}`);
        const saved = await response.json();
        userSettingsRevision = saved.revision;
      } catch (error) {
        userSettingsDirty = true;
        throw error;
      } finally {
        userSettingsInFlightRevision = "";
      }
    }
  })();
  try {
    await userSettingsSavePromise;
  } finally {
    userSettingsSavePromise = null;
  }
}

function saveUserSettingsOnExit() {
  if (!currentUser || (!userSettingsDirty && !userSettingsSavePromise)) return;
  const body = userSettingsPayload();
  body.nextRevision = newWorkspaceRevision();
  body.alternateRevision = userSettingsInFlightRevision;
  void fetch(userAPIPath("settings"), {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), keepalive: true,
  }).catch(() => {});
}

async function flushUserSettingsSave() {
  await saveUserSettings();
}

async function flushAllPersistence() {
  await Promise.all([flushWorkspaceSave(), flushUserSettingsSave()]);
}

installNativeClose(window, flushAllPersistence);

async function flushWorkspaceSave() {
  if (isLoadingWorkspace || workspaceSaveSuspended || workspaceNeedsRevalidation) {
    throw new Error("Workspace saving is paused. Resolve the connection or conflict before leaving this session.");
  }
  window.clearTimeout(saveTimer);
  saveTimer = null;
  if (!await saveWorkspace()) {
    throw new Error("Workspace could not be saved. Your current session has been kept open.");
  }
}

// A scheduled save lives in a timer, and a page that goes away takes the timer
// with it: the pane you just focused, moved or renamed is lost, and the next
// load restores the state from before it. This is the last moment the page is
// given to run code, so the request goes out here and is asked to outlive the
// document rather than awaited, since nothing here will be resumed.
function saveWorkspaceOnExit() {
  if (isLoadingWorkspace || workspaceSaveSuspended || workspaceNeedsRevalidation) {
    return;
  }
  // A save already in flight is about to be cancelled along with the page, so
  // it needs sending again as much as a scheduled one does.
  if (saveTimer === null && workspaceSavePromise === null) {
    return;
  }
  window.clearTimeout(saveTimer);
  saveTimer = null;
  const { body: payload, contentByPaneID } = workspaceSavePayload();
  // The pending save may contain content changed and then reverted locally.
  // Carry all final content rather than comparing against the last ACK.
  if (workspaceInFlightRevision) {
    for (const pane of payload.panes) {
      Object.assign(pane, contentByPaneID.get(pane.id));
      delete pane.bufferTextUnchanged;
      delete pane.editorTabsUnchanged;
    }
  }
  payload.nextRevision = newWorkspaceRevision();
  payload.alternateRevision = workspaceInFlightRevision;
  const body = JSON.stringify(payload);
  void fetch(`/api/workspace/${encodeURIComponent(workspaceID)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    // Requests that outlive their page are capped, and the cap is shared with
    // everything else already in flight. A body over it would be rejected
    // outright, so an oversized save is sent as an ordinary request: it may
    // not survive the unload, which is still better than not trying. Trimming
    // it is not an option — a pane whose content is left out of a save is a
    // pane the server keeps its old copy of.
    keepalive: new TextEncoder().encode(body).byteLength <= maxKeepaliveSaveBytes,
  }).catch(() => {});
}

async function saveWorkspace() {
  if (isLoadingWorkspace || workspaceSaveSuspended) {
    return false;
  }
  if (workspaceNeedsRevalidation) {
    workspaceSaveQueued = true;
    return false;
  }
  if (workspaceSavePromise) {
    workspaceSaveQueued = true;
    return workspaceSavePromise;
  }
  // Every waiter shares the entire drain, including edits queued during a
  // request. Waiting only for the first request can navigate away too early.
  workspaceSavePromise = (async () => {
    do {
      workspaceSaveQueued = false;
      if (!await performWorkspaceSave()) return false;
      if (workspaceSaveSuspended || workspaceNeedsRevalidation) return false;
    } while (workspaceSaveQueued || saveTimer !== null);
    return true;
  })();
  try {
    return await workspaceSavePromise;
  } finally {
    workspaceSavePromise = null;
  }
}

// The pane content this browser has already stored on the server, by pane id.
// Rebuilt from each successful save, so a failed or conflicting save resends
// everything it was carrying.
let savedPaneContent = new Map();

function paneContent(rect) {
  return {
    bufferText: rect.archivedContent?.bufferText || "",
    editorTabs: rect.archivedContent?.editorTabs || "",
  };
}

// workspaceSavePayload builds the request body and the record of what content
// it carries, both from the state as it stands right now. Building it apart
// from sending it lets a page on its way out post the same body without any
// of the awaiting that a closing document will not get to finish.
function workspaceSavePayload() {
  const savedRectangles = rectangles.filter((rect) => rect.kind !== "pending");
  const contentByPaneID = new Map(savedRectangles.map((rect) => [rect.id, paneContent(rect)]));
  const panes = savedRectangles.map((rect, index) => ({
    id: rect.id,
    title: rect.title,
    kind: rect.kind,
    ...paneContentFields(contentByPaneID.get(rect.id), savedPaneContent.get(rect.id)),
    editorMode: rect.archivedContent?.editorMode || "",
    fontSize: rect.kind === "terminal" ? rect.fontSize : defaultPaneFontSize,
    cwd: rect.cwd || "",
    lastExportPath: rect.archivedContent?.lastExportPath || "",
    browserUrl: rect.kind === browserPaneKind ? rect.browserUrl : "",
    vncTarget: rect.kind === vncPaneKind ? rect.vncTarget : "",
    vncViewOnly: rect.kind === vncPaneKind && rect.vncViewOnly,
    vncScaleMode: rect.kind === vncPaneKind ? rect.vncScaleMode : "fit",
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: rect.zIndex,
    minimized: rect.minimized,
    // Maximize is an attribute ("fills the board"), not a fixed size — x/y/
    // width/height above are just this device's current full-board size.
    // isFull is what actually gets restored; restoreBox is where "Restore"
    // should go back to, serialized since it's opaque bookkeeping.
    isFull: Boolean(rect.isFull),
    restoreBox: rect.restoreBox ? JSON.stringify(rect.restoreBox) : "",
    position: index,
  }));

  return {
    contentByPaneID,
    body: {
      id: workspaceID,
      revision: workspaceRevision,
      name: currentSessionName || "Default",
      activePaneId: savedRectangles.some((rect) => rect.id === activePaneID) ? activePaneID : "",
      backgroundMode: workspaceBackgroundMode,
      layout: { panes: panes.map((pane) => pane.id) },
      panes,
    },
  };
}

async function performWorkspaceSave() {
  const revision = ++saveRevision;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  setWorkspaceStatus("saving", "Saving...");
  const { body, contentByPaneID } = workspaceSavePayload();
  body.nextRevision = newWorkspaceRevision();
  workspaceInFlightRevision = body.nextRevision;

  try {
    const response = await fetch(`/api/workspace/${encodeURIComponent(workspaceID)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    const outcome = workspaceSaveOutcome(workspaceRevision, response.status, data.revision);
    if (outcome.suspended) {
      showWorkspaceConflict();
      return false;
    }
    if (!response.ok) {
      throw new Error(`save workspace failed: ${response.status}`);
    }
    workspaceRevision = outcome.revision;
    savedPaneContent = contentByPaneID;
    if (revision === saveRevision && saveTimer === null) {
      setWorkspaceStatus("saved", "Saved");
    }
    return true;
  } catch (error) {
    if (revision === saveRevision && saveTimer === null) {
      console.warn(error);
      setWorkspaceStatus("error", "Save failed", error.message || "Workspace save failed");
    }
    return false;
  } finally {
    workspaceInFlightRevision = "";
  }
}

function showWorkspaceConflict() {
  workspaceSaveSuspended = true;
  workspaceNeedsRevalidation = false;
  workspaceSaveQueued = false;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  setWorkspaceStatus("error", "Newer workspace available", "Reload to use the workspace saved by another browser");
  serverConnectionModal.hidden = true;
  workspaceConflictModal.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "settings-panel workspace-conflict-panel";
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "workspace-conflict-title");
  panel.setAttribute("aria-describedby", "workspace-conflict-status");

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "workspace-conflict-title";
  title.textContent = "Newer Workspace Available";
  titleBar.appendChild(title);

  const content = document.createElement("div");
  content.className = "settings-content";
  const status = document.createElement("p");
  status.id = "workspace-conflict-status";
  status.className = "workspace-conflict-status";
  status.textContent = "Another browser saved this workspace after this page loaded. Autosave is paused so this older copy cannot overwrite it.";
  content.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "rename-window-actions";
  const reloadButton = document.createElement("button");
  reloadButton.type = "button";
  reloadButton.className = "settings-background-button server-connection-primary";
  reloadButton.textContent = "Reload Latest Workspace";
  reloadButton.addEventListener("click", () => window.location.reload());
  actions.appendChild(reloadButton);

  panel.append(titleBar, content, actions);
  workspaceConflictModal.appendChild(panel);
  workspaceConflictModal.hidden = false;
  reloadButton.focus();
}

function markWorkspaceDisconnected() {
  if (workspaceSaveSuspended || isLoadingWorkspace) {
    return;
  }
  workspaceNeedsRevalidation = true;
  if (saveTimer !== null) {
    workspaceSaveQueued = true;
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
}

async function revalidateWorkspaceRevision() {
  if (workspaceSaveSuspended || !workspaceNeedsRevalidation) {
    return !workspaceSaveSuspended;
  }
  try {
    const response = await fetch(`/api/workspace/${encodeURIComponent(workspaceID)}`, { cache: "no-store" });
    if (!response.ok) {
      return false;
    }
    const workspace = await response.json();
    if (!workspaceRevisionMatches(workspaceRevision, workspace.revision || "")) {
      showWorkspaceConflict();
      return false;
    }
    workspaceNeedsRevalidation = false;
    if (workspaceSaveQueued) {
      workspaceSaveQueued = false;
      scheduleWorkspaceSave();
    }
    return true;
  } catch {
    return false;
  }
}

const savedStatusHideMs = 3000;

// A status that reports a condition the operator has to act on stays up until
// something replaces it. One that only narrates a moment — a save, or a copy
// that had nothing to copy — takes an autoHideMs and clears itself.
function setWorkspaceStatus(state, text, title = "", options = {}) {
  const autoHideMs = options.autoHideMs ?? (state === "saved" ? savedStatusHideMs : 0);
  // Dragging a window calls this every pointer move with the same "Saving..."
  // arguments, so skip the DOM writes when nothing about the status changed.
  // A hidden status still needs re-showing, and one that auto-hides needs its
  // timer re-armed, so both fall through.
  if (
    !workspaceStatus.hidden
    && !autoHideMs
    && workspaceStatus.dataset.state === state
    && workspaceStatus.textContent === text
    && workspaceStatus.title === (title || text)
  ) {
    return;
  }
  window.clearTimeout(workspaceStatusHideTimer);
  workspaceStatusHideTimer = null;
  workspaceStatus.hidden = false;
  workspaceStatus.dataset.state = state;
  workspaceStatus.textContent = text;
  workspaceStatus.title = title || text;
  if (autoHideMs) {
    workspaceStatusHideTimer = window.setTimeout(() => {
      // Anything that replaced this status owns the strip now, and clears the
      // timer on its way in; this only guards against a stale firing.
      if (workspaceStatus.dataset.state === state && workspaceStatus.textContent === text) {
        workspaceStatus.hidden = true;
      }
      workspaceStatusHideTimer = null;
    }, autoHideMs);
  }
}




function loadGhosttyModule() {
  if (!ghosttyModulePromise) {
    ghosttyModulePromise = import("./vendor/terminal.js?v=selection-recovery-1").then(async (module) => {
      await module.init();
      installTerminalBlockRenderer(module.CanvasRenderer, module.CellFlags);
      module.setTerminalDocumentVisible?.(!document.hidden);
      return module;
    });
  }
  return ghosttyModulePromise;
}

async function startTerminal(rect) {
  if (!rect?.terminalContainer || rect.terminal) {
    return;
  }

  rect.terminalContainer.textContent = "Starting terminal...";
  try {
    const modulePromise = loadGhosttyModule();
    await loadTerminalFont(document.fonts, terminalFont, rect.fontSize);
    const { FitAddon, Terminal, WrappedHTTPLinkProvider } = await modulePromise;
    if (!rect.terminalContainer || rect.kind !== "terminal" || !rectangles.includes(rect)) {
      return;
    }

    rect.terminalContainer.replaceChildren();
    // ANSI assigns color roles rather than RGB values. The terminal's neutral
    // light/dark mode supplies an xterm-compatible palette independently from
    // Tessera's decorative workspace theme.
    const terminalTheme = terminalColorTheme(terminalColorMode);
    rect.terminalContainer.style.background = terminalTheme.background;
    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: rect.fontSize,
      fontFamily: terminalPrimaryFontFamily(terminalFont),
      symbolFontFamily: terminalFontFamily(terminalFont),
      rowSpacing: terminalRowSpacing,
      cursorBlink: activeRect === rect,
      cursorBlinkEnabled: !olderMacMode,
      renderPixelRatioCap: olderMacMode ? 1 : 0,
      paintFPSLimit: olderMacMode ? 30 : 0,
      paintCoalescing: terminalPaintCoalescing,
      renderMetricsEnabled: settingsDiagnosticsOpen(),
      experimentalRenderer: experimentalTerminalRenderer,
      smoothScrollDuration: olderMacMode ? 0 : 100,
      theme: { ...terminalTheme },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    openTerminalWithoutFocus(term, rect.terminalContainer);
    term.attachCustomKeyEventHandler((event) => {
      if (isTerminalCopyShortcut(event)) {
        void applyTerminalMenuAction("copy", rect);
        return true;
      }
      // Returning true tells ghostty-web the key was handled, which also calls
      // preventDefault(). Doing that for the platform's paste accelerator would
      // cancel the browser's paste event that ghostty-web itself listens for.
      const pasteSource = terminalPasteSource(event, { appleKeyboard: appleKeyboardLayout });
      if (pasteSource === "native") {
        return false;
      }
      if (pasteSource === "clipboard") {
        void applyTerminalMenuAction("paste", rect);
        return true;
      }
      const controlSequence = terminalControlSequence(event, { appleKeyboard: appleKeyboardLayout });
      if (controlSequence) {
        sendTerminalInput(rect.terminal?.socket, controlSequence);
        return true;
      }
      // Swallowing beats ghostty-web's encoder falling back to the bare
      // character and typing it into the application.
      if (terminalShouldSwallowCommandKey(event)) {
        return true;
      }
      const sequence = terminalNavigationSequence(event, {
        applicationCursorKeys: term.getMode?.(1, false),
        applicationKeypad: term.getMode?.(66, false),
      });
      if (!sequence) {
        return false;
      }
      sendTerminalInput(rect.terminal?.socket, sequence);
      return true;
    });
    term.registerLinkProvider(new WrappedHTTPLinkProvider(term));
    fit.fit();
    fit.observeResize();
    const dataDisposable = term.onData((data) => {
      term.noteInteractiveInput?.();
      sendTerminalInput(rect.terminal?.socket, data);
    });
    const resizeDisposable = term.onResize(() => {
      requestTerminalGridSize(rect.terminal);
    });
    rect.terminal = {
      term, fit, socket: null, dataDisposable, resizeDisposable, mouseBridge: null,
      pasteBridge: attachTerminalPasteBridge(rect, term),
      output: new TerminalWriteScheduler((data) => term.write(data)),
      reconnectTimer: null, reconnectAttempts: 0, outputPaused: false, snapshotIfChanged: false,
      backlogRecoveryAttempts: 0, lastBacklogRecoveryAt: 0,
      sentCols: 0, sentRows: 0,
      // What this pane holds of the server's stream, so a reconnect can ask
      // for the remainder instead of the whole scrollback.
      stream: { epoch: "", offset: 0 },
    };
    rect.terminal.replica = new TerminalReplica(term, rect.terminal.output, term.coreID, (text) => {
      void applyTerminalClipboardWrite(text);
    }, (error) => rect.terminal?.socket?.close(4500, error.message.slice(0, 100)), {
      backlogLimit: terminalBacklogLimit,
      onBacklogExceeded: () => recoverTerminalBacklog(rect),
    });
    attachTerminalAudio(rect);
    rect.terminal.files = new TerminalFiles({ workspaceId: workspaceID, paneId: rect.id, container: rect.body,
      send: message => { const socket = rect.terminal?.socket; if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); },
      onPending: count => { rect.filePendingCount = count; updateDeskbar(); requestTerminalFit(rect); },
    });
    updateTerminalRenderState(rect);
    connectTerminalSocket(rect);
    requestTerminalFit(rect);
  } catch (error) {
    console.warn(error);
    if (rect.terminalContainer) {
      rect.terminalContainer.textContent = error.message || "Terminal failed to start";
    }
  }
}

function recoverTerminalBacklog(rect) {
  const terminalState = rect.terminal;
  if (!terminalState) return;
  const now = Date.now();
  if (now - terminalState.lastBacklogRecoveryAt > 30000) terminalState.backlogRecoveryAttempts = 0;
  terminalState.lastBacklogRecoveryAt = now;
  terminalState.socket?.close(terminalBacklogCloseCode, "terminal output backlog exceeded");
}

function connectTerminalSocket(rect) {
  const terminalState = rect?.terminal;
  if (!terminalState?.term || rect.kind !== "terminal") {
    return;
  }
  terminalState.reconnectTimer = null;
  // A pane that is already reporting trouble says an attempt is under way;
  // a pane opening its first socket has nothing to report yet.
  if (rect.terminalStatus) {
    setTerminalStatus(rect, terminalConnectingStatus(rect.terminalStatus));
  }
  const { term } = terminalState;
  terminalState.replica.disconnect();
  const socket = new WebSocket(terminalWebSocketURL(rect, term.desiredCols || term.cols, term.desiredRows || term.rows));
  socket.binaryType = "arraybuffer";
  terminalState.socket = socket;
  // A new connection has not been told any size yet.
  terminalState.sentCols = 0;
  terminalState.sentRows = 0;
  terminalState.mouseBridge?.dispose?.();
  terminalState.mouseBridge = attachTerminalMouseBridge(rect, term, socket);
  // A half-received sequence belongs to the connection that was sending it.

  socket.addEventListener("open", () => {
    if (rect.terminal?.socket !== socket) {
      return;
    }
    terminalState.reconnectAttempts = 0;
    socket.send(JSON.stringify({ type: "audio-events", enabled: true }));
    terminalState.files?.subscribe(socket);
    clearTerminalStatus(rect);
    setPaneCwd(rect, rect.cwd, { silent: true });
    // It may have become hidden while the connection was opening.
    if (terminalState.outputPaused) socket.send(JSON.stringify({ type: "pause-output" }));
    sendTerminalGridSize(terminalState);
    if (terminalOutputCoalescing) sendTerminalOutputCoalescing(terminalState);
    if (terminalState.replica.timing) sendTerminalTimingEnabled(terminalState);
    // Reconnection must not take keyboard focus away from a dialog.
    if (!terminalState.outputPaused && activeRect === rect && (document.activeElement === document.body || rect.element.contains(document.activeElement))) {
      term.focus();
    }
    if (rect.terminalStartupCommand) {
      const command = rect.terminalStartupCommand;
      rect.terminalStartupCommand = "";
      sendTerminalInput(socket, `${command}\r`);
    }
  });
  socket.addEventListener("message", (event) => {
    if (rect.terminal?.socket !== socket) {
      return;
    }
    if (typeof event.data === "string") {
      let message; try { message = JSON.parse(event.data); } catch {}
      if (terminalState.files?.receive(message)) return;
      if (handleTerminalAudioMessage(rect, event.data)) return;
    }
    if (terminalState.outputPaused) {
      // Discarded output never advances the applied cursor. The next host
      // attachment decides whether its missing suffix is small enough to replay.
      return;
    }
    // Text carries the server's account of where this connection starts;
    // everything else is the stream itself.
    if (typeof event.data === "string") {
      applyTerminalTextMessage(rect, terminalState, event.data);
      return;
    }
    try { terminalState.replica.receive(new Uint8Array(event.data)); }
    catch (error) { socket.close(4500, error.message.slice(0, 100)); }
  });
  socket.addEventListener("close", (event) => {
    if (rect.terminal?.socket === socket) {
      handleTerminalSocketClose(rect, terminalState, event);
    }
  });
}

// The server opens every connection by saying which stream it is sending and
// where in that stream the bytes about to arrive belong. A reset means those
// bytes are a fresh start rather than a continuation, so whatever the pane
// still shows came from a stream it can no longer be lined up with.
function applyTerminalTextMessage(rect, terminalState, data) {
  if (terminalState.outputPaused) {
    return;
  }
  let message = null;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (message?.type === "timing") {
    terminalState.replica.timing?.host(message);
    return;
  }
  if (message?.type !== "attach") {
    return;
  }
  try {
    terminalState.replica.attach(message);
  } catch (error) {
    terminalState.socket?.close(4503, error.message.slice(0, 100));
    return;
  }
  terminalState.snapshotIfChanged = false;
  completeTerminalWakeRecovery(terminalState);
}

function attachTerminalAudio(rect) {
  const key = terminalAudioMuteKey(workspaceID, rect.id);
  rect.terminal.audioKey = key;
  let muted = false;
  try { muted = window.localStorage.getItem(key) === "true"; } catch {}
  terminalAudioPlayer.attach(key, { muted, onStatus: status => {
    if (rect.terminal?.audioKey === key) renderTerminalAudioStatus(rect, status);
  } });
}

function handleTerminalAudioMessage(rect, data) {
  let message;
  try { message = JSON.parse(data); } catch { return false; }
  if (message?.type === "audio-events") return true;
  if (message?.type !== "terminal-audio") return false;
  terminalAudioPlayer.receive(rect.terminal?.audioKey, message);
  return true;
}

function renderTerminalAudioStatus(rect, status) {
  if (!rect.body || !rect.terminal) return;
  let badge = rect.terminalAudioBadge;
  if (!status) { if (badge) badge.hidden = true; return; }
  if (!badge || badge.parentElement !== rect.body) {
    badge = document.createElement("button");
    badge.type = "button";
    badge.className = "terminal-audio-badge";
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      if (badge.dataset.kind === "enable") void terminalAudioPlayer.enable().catch(() => {
        badge.textContent = "Tap to enable terminal audio";
        badge.title = "Playback could not start. Tap to try again.";
      });
      else badge.hidden = true;
    });
    rect.body.appendChild(badge);
    rect.terminalAudioBadge = badge;
  }
  badge.hidden = false;
  badge.dataset.kind = status.kind;
  badge.textContent = status.text;
  badge.title = status.kind === "enable" ? "Enable future terminal sounds in this browser page" : status.text;
  badge.setAttribute("aria-label", badge.title);
}

function handleTerminalSocketClose(rect, terminalState, closeEvent) {
  terminalAudioPlayer.disconnect(terminalState.audioKey);
  terminalState.files?.disconnect();
  terminalState.replica?.disconnect();
  if (terminalState.reconnectTimer !== null) {
    return;
  }
  const outcome = terminalCloseOutcome(closeEvent, {
    // Successful socket opens reset ordinary connection backoff. Overloads
    // keep their own counter so a busy shell cannot cause a tight retry loop.
    attempt: closeEvent?.code === terminalBacklogCloseCode
      ? terminalState.backlogRecoveryAttempts++ : terminalState.reconnectAttempts,
    serverReported: !serverConnectionModal.hidden,
  });
  // A shell that exited takes its pane with it, the way a terminal emulator
  // closes a tab. Its session is already gone on the server, so there is
  // nothing left to tell it about.
  if (outcome.closesPane) {
    destroyRectangle(rect);
    return;
  }
  setTerminalStatus(rect, outcome);
  if (!outcome.reconnect || terminalState.outputPaused) {
    return;
  }
  terminalState.reconnectAttempts += 1;
  terminalState.reconnectTimer = window.setTimeout(() => {
    terminalState.reconnectTimer = null;
    if (rect.terminal === terminalState) {
      connectTerminalSocket(rect);
    }
  }, outcome.delay);
}

// Brings the pending attempt forward. Whoever asks — a person watching the
// pane, or a health probe that just got an answer — knows more about the
// server than the backoff does, so the retry also restarts it: the next
// automatic wait should be short again, not wherever the cycle had crept to
// while nobody was looking.
function retryTerminalNow(rect) {
  const terminalState = rect?.terminal;
  if (!terminalState || terminalState.outputPaused || !terminalShouldRetry(rect.terminalStatus)) {
    return;
  }
  const socket = terminalState.socket;
  if (socket?.readyState === WebSocket.OPEN) {
    return;
  }
  if (terminalState.reconnectTimer !== null) {
    window.clearTimeout(terminalState.reconnectTimer);
    terminalState.reconnectTimer = null;
  }
  // A stale attempt is abandoned rather than raced. Its close arrives after
  // the replacement is already in place, where the socket check in the
  // handler ignores it.
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
  terminalState.reconnectAttempts = 0;
  connectTerminalSocket(rect);
}

// A pane waiting out its backoff has no way to learn that the server came
// back: the schedule is the only thing that moves it, and a backgrounded tab
// does not even run that on time. Anything that does know brings every
// waiting pane forward at once.
function resumeTerminalConnections() {
  for (const rect of rectangles) {
    if (rect.kind === "terminal") {
      retryTerminalNow(rect);
    }
  }
}

function setTerminalStatus(rect, status) {
  rect.terminalStatus = status;
  stopTerminalStatusCountdown(rect);
  renderTerminalStatusBadge(rect);
  if (status?.retryAt) {
    // Twice a second, so the displayed count is never a stale second behind.
    rect.terminalStatusTimer = window.setInterval(() => {
      if (!document.hidden) renderTerminalStatusBadge(rect);
    }, 500);
  }
}

function clearTerminalStatus(rect) {
  rect.terminalStatus = null;
  stopTerminalStatusCountdown(rect);
  renderTerminalStatusBadge(rect);
}

function stopTerminalStatusCountdown(rect) {
  if (rect?.terminalStatusTimer) {
    window.clearInterval(rect.terminalStatusTimer);
    rect.terminalStatusTimer = null;
  }
}

// An outage used to be announced by writing a line into the terminal, which
// then sat in the scrollback long after the session came back. The badge is
// pane chrome instead: it hovers over the surface while the socket is down
// and goes away the moment one reconnects, leaving the buffer untouched.
function terminalStatusBadge(rect) {
  if (!rect.body) {
    return null;
  }
  // A rebuilt pane element leaves the old badge detached, so the cached one
  // only counts while it still belongs to the pane body in front of it.
  if (rect.terminalStatusBadge?.parentElement === rect.body) {
    return rect.terminalStatusBadge;
  }
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "terminal-status-badge";
  badge.hidden = true;
  badge.setAttribute("role", "status");
  // A link broken in the middle reads as "disconnected" at badge size,
  // where a plug's prongs would not; a power symbol says the shell is gone
  // rather than out of reach. Both are built up front and swapped by state.
  badge.appendChild(terminalStatusIcon(
    "is-link-icon",
    ["M9.5 17H7.5a5 5 0 0 1 0-10h2", "M14.5 7h2a5 5 0 0 1 0 10h-2", "M13.8 9.6l-3.6 4.8"],
  ));
  badge.appendChild(terminalStatusIcon(
    "is-power-icon",
    ["M12 4.5v7", "M7.8 7.3a6.4 6.4 0 1 0 8.4 0"],
  ));
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    retryTerminalNow(rect);
  });
  rect.body.appendChild(badge);
  rect.terminalStatusBadge = badge;
  return badge;
}

function terminalStatusIcon(className, paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
  }
  return svg;
}

function renderTerminalStatusBadge(rect) {
  const status = rect.terminalStatus?.showBadge ? rect.terminalStatus : null;
  const badge = status ? terminalStatusBadge(rect) : rect.terminalStatusBadge;
  if (!badge) {
    return;
  }
  if (!status) {
    badge.hidden = true;
    return;
  }
  const label = terminalStatusLabel(status, status.retryAt ? status.retryAt - Date.now() : 0);
  badge.title = label;
  badge.setAttribute("aria-label", label);
  badge.dataset.state = status.state;
  badge.classList.toggle("is-settled", Boolean(status.settled));
  // Only a pane with an attempt still to come has anything a click can do.
  badge.disabled = !status.reconnect || status.state === "connecting";
  badge.hidden = false;
}

// ghostty-web's own paste listener passes the clipboard text to the PTY the
// same way it passes typing, so an application never learns that a paste
// happened: no bracketed paste, and a TUI editor records the text as a run of
// single keystrokes, which its undo then walks back one character at a time.
// This listener sits on the pane body, so the capture phase reaches it before
// the container listener ghostty-web installed, and pastes through the terminal
// instead — which wraps the text whenever the application asked for bracketed
// paste.
function attachTerminalPasteBridge(rect, term) {
  const host = rect.terminalContainer?.parentElement;
  if (!host) {
    return null;
  }

  const onKeyDown = (event) => {
    if (!rect.terminalContainer?.contains(event.target)) {
      return;
    }
    if (!shouldIsolateMacTerminalPasteKeydown(event, { appleKeyboard: appleKeyboardLayout })) {
      return;
    }
    // Do not preventDefault(): Chrome's default action is what emits the
    // trusted paste event below. Only keep the physical `v` keydown away from
    // ghostty-web and the raw-mode application behind it.
    event.stopImmediatePropagation();
  };

  const onPaste = (event) => {
    if (!rect.terminalContainer?.contains(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const text = terminalPasteText(event.clipboardData?.getData("text/plain") || "");
    if (text) {
      term.paste(text);
    }
  };

  host.addEventListener("keydown", onKeyDown, { capture: true });
  host.addEventListener("paste", onPaste, { capture: true });

  return {
    dispose() {
      host.removeEventListener("keydown", onKeyDown, { capture: true });
      host.removeEventListener("paste", onPaste, { capture: true });
    },
  };
}

function attachTerminalMouseBridge(rect, term, socket) {
  const container = rect.terminalContainer;
  if (!container) {
    return null;
  }

  const activePress = new TerminalMousePress();
  const contextMenuFallback = new TerminalContextMenuFallback();
  let selectionAtReportedPress = null;
  let wheelRemainder = 0;
  let wheelDirection = 0;

  const scaledDiscreteWheelSteps = (baseSteps, direction) => {
    if (direction !== wheelDirection) {
      wheelRemainder = 0;
      wheelDirection = direction;
    }
    const scaled = baseSteps * terminalWheelSensitivity + wheelRemainder;
    const steps = Math.min(20, Math.floor(scaled));
    wheelRemainder = scaled - Math.floor(scaled);
    return steps;
  };

  const onPointerDown = (event) => {
    selectionAtReportedPress = null;
    if (isTerminalContextMenuGesture(event, { appleKeyboard: appleKeyboardLayout })
        && !terminalShouldReportMouse(term, event)) {
      // ghostty-web's selection manager handles every mouse-down. Cancel the
      // compatibility mouse event so a secondary click cannot replace the
      // selection that Tessera's context-menu Copy action is about to read.
      stopTerminalMouseEvent(event);
      return;
    }
    const buttonCode = terminalMouseButtonCode(event.button);
    if (buttonCode == null || !terminalShouldReportMouse(term, event)) {
      return;
    }
    const position = terminalMousePosition(term, container, event);
    if (!position) {
      return;
    }
    try {
      selectionAtReportedPress = Boolean(term.hasSelection?.());
    } catch {
      selectionAtReportedPress = null;
    }
    contextMenuFallback.notePress(buttonCode, event.timeStamp);
    stopTerminalMouseEvent(event);
    hideFloatingMenus();
    setActivePane(rect, { raise: true });
    term.focus();
    activePress.begin(event.pointerId, buttonCode, position);
    container.setPointerCapture?.(event.pointerId);
    sendTerminalMouseSequence(socket, terminalMouseEventCode(buttonCode, event), position, "M");
  };

  const onMouseDown = (event) => {
    // Safari may send a Control-primary mousedown without a PointerEvent.
    // Keep macOS's contextual click out of Ghostty's left-drag selection.
    if (isTerminalContextMenuGesture(event, { appleKeyboard: appleKeyboardLayout })
        && !terminalShouldReportMouse(term, event)) {
      stopTerminalMouseEvent(event);
      return;
    }
    if (selectionAtReportedPress !== null || !terminalShouldReportMouse(term, event)) {
      return;
    }
    // WebKit can deliver a compatibility mousedown even when it omits the
    // corresponding PointerEvent. Capture the pre-gesture selection state
    // before ghostty-web's canvas listener can start a local selection.
    try {
      selectionAtReportedPress = Boolean(term.hasSelection?.());
    } catch {
      selectionAtReportedPress = null;
    }
  };

  const finishTerminalPointer = (event, pointerID = event.pointerId) => {
    const position = event.type === "pointercancel" || event.type === "lostpointercapture"
      ? null
      : terminalMousePosition(term, container, event);
    const release = activePress.finish(pointerID, position);
    if (!release) {
      return false;
    }
    stopTerminalMouseEvent(event);
    if (release.position) {
      sendTerminalMouseSequence(
        socket,
        terminalMouseEventCode(release.buttonCode, event),
        release.position,
        "m",
      );
    }
    if (container.hasPointerCapture?.(release.pointerID)) {
      container.releasePointerCapture(release.pointerID);
    }
    return true;
  };

  const onPointerMove = (event) => {
    if (!activePress.matches(event.pointerId)) {
      return;
    }
    if (event.buttons === 0) {
      finishTerminalPointer(event);
      return;
    }
    const position = terminalMousePosition(term, container, event);
    if (!position) {
      return;
    }
    activePress.update(event.pointerId, position);
    stopTerminalMouseEvent(event);
    sendTerminalMouseSequence(
      socket,
      terminalMouseEventCode(activePress.buttonCode + 32, event),
      position,
      "M",
    );
  };

  const onPointerUp = (event) => {
    finishTerminalPointer(event);
  };

  const onPointerCancel = (event) => {
    finishTerminalPointer(event);
  };

  const onLostPointerCapture = (event) => {
    finishTerminalPointer(event);
  };

  const onContextMenu = (event) => {
    if (terminalShouldReportMouse(term, event)) {
      // macOS may show contextmenu before delivering pointerup for a
      // secondary click. Finish the already-forwarded press here so the TUI
      // cannot remain latched if that pointerup is suppressed.
      finishTerminalPointer(event, null);
      if (event.button === 2 && contextMenuFallback.needsFallback(2, event.timeStamp)) {
        // Safari on macOS may emit only contextmenu for a trackpad secondary
        // click. In that case report one complete right-click to the TUI. A
        // recent pointerdown suppresses this fallback in browsers that deliver
        // the normal pointer sequence.
        const position = terminalMousePosition(term, container, event);
        if (position) {
          const buttonCode = terminalMouseEventCode(2, event);
          sendTerminalMouseSequence(socket, buttonCode, position, "M");
          sendTerminalMouseSequence(socket, buttonCode, position, "m");
        }
      }
      // ghostty-web can misinterpret a macOS secondary-click compatibility
      // event as a local left-button drag. Remove only a selection created
      // during this TUI-owned gesture, preserving any selection that predated
      // the click and preserving the normal right-click report to the TUI.
      clearTerminalSelectionStartedDuringGesture(term, selectionAtReportedPress);
      selectionAtReportedPress = null;
      stopTerminalMouseEvent(event);
      return;
    }
    openTerminalMenu(event, rect);
  };

  const onClick = (event) => {
    // Control-click is a macOS context-menu gesture. Command-click remains
    // the link accelerator for both detected URLs and OSC 8 hyperlinks.
    if (appleKeyboardLayout && event.ctrlKey) stopTerminalMouseEvent(event);
  };

  const onWheel = (event) => {
    if (event.deltaY === 0) {
      return false;
    }

    const direction = event.deltaY < 0 ? -1 : 1;
    if (terminalShouldReportMouse(term, event)) {
      const position = terminalMousePosition(term, container, event);
      if (!position) {
        return false;
      }
      const buttonCode = direction < 0 ? 64 : 65;
      const baseSteps = Math.min(5, Math.max(1, Math.round(Math.abs(event.deltaY) / 40)));
      const steps = terminalWheelSensitivity === 1
        ? baseSteps
        : scaledDiscreteWheelSteps(baseSteps, direction);
      for (let index = 0; index < steps; index += 1) {
        sendTerminalMouseSequence(socket, terminalMouseEventCode(buttonCode, event), position, "M");
      }
      return true;
    }

    if (terminalWheelSensitivity === 1) {
      return false;
    }

    if (term.wasmTerm?.isAlternateScreen?.()) {
      const baseSteps = Math.min(5, Math.abs(Math.round(event.deltaY / 33)));
      const steps = scaledDiscreteWheelSteps(baseSteps, direction);
      const sequence = direction < 0 ? "\x1B[A" : "\x1B[B";
      for (let index = 0; index < steps; index += 1) {
        term.input(sequence, true);
      }
      return true;
    }

    const lineHeight = term.renderer?.getMetrics?.().height || 20;
    const lines = wheelDeltaUnits(event.deltaY, event.deltaMode, lineHeight, term.rows);
    term.scrollLines(lines * terminalWheelSensitivity);
    return true;
  };

  container.addEventListener("pointerdown", onPointerDown, { capture: true });
  container.addEventListener("mousedown", onMouseDown, { capture: true });
  container.addEventListener("pointermove", onPointerMove, { capture: true });
  container.addEventListener("pointerup", onPointerUp, { capture: true });
  container.addEventListener("pointercancel", onPointerCancel, { capture: true });
  container.addEventListener("lostpointercapture", onLostPointerCapture, { capture: true });
  container.addEventListener("contextmenu", onContextMenu, { capture: true });
  container.addEventListener("click", onClick, { capture: true });
  term.attachCustomWheelEventHandler?.(onWheel);

  return {
    dispose() {
      container.removeEventListener("pointerdown", onPointerDown, { capture: true });
      container.removeEventListener("mousedown", onMouseDown, { capture: true });
      container.removeEventListener("pointermove", onPointerMove, { capture: true });
      container.removeEventListener("pointerup", onPointerUp, { capture: true });
      container.removeEventListener("pointercancel", onPointerCancel, { capture: true });
      container.removeEventListener("lostpointercapture", onLostPointerCapture, { capture: true });
      container.removeEventListener("contextmenu", onContextMenu, { capture: true });
      container.removeEventListener("click", onClick, { capture: true });
      term.attachCustomWheelEventHandler?.(null);
    },
  };
}

function terminalShouldReportMouse(term, event) {
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  try {
    return Boolean(term?.hasMouseTracking?.());
  } catch {
    return false;
  }
}

function terminalMouseButtonCode(button) {
  if (button === 0) {
    return 0;
  }
  if (button === 1) {
    return 1;
  }
  if (button === 2) {
    return 2;
  }
  return null;
}

function terminalMouseEventCode(buttonCode, event) {
  let code = buttonCode;
  if (event.shiftKey) {
    code += 4;
  }
  if (event.altKey || event.metaKey) {
    code += 8;
  }
  if (event.ctrlKey) {
    code += 16;
  }
  return code;
}

function terminalMousePosition(term, container, event) {
  const canvas = container.querySelector("canvas");
  const box = canvas?.getBoundingClientRect();
  if (!box || box.width <= 0 || box.height <= 0) {
    return null;
  }
  const col = Math.min(term.cols, Math.max(1, Math.floor((event.clientX - box.left) / (box.width / term.cols)) + 1));
  const row = Math.min(term.rows, Math.max(1, Math.floor((event.clientY - box.top) / (box.height / term.rows)) + 1));
  return { col, row };
}

function sendTerminalMouseSequence(socket, code, position, finalByte) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(terminalMouseMessage(`\x1b[<${code};${position.col};${position.row}${finalByte}`));
}

function stopTerminalMouseEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function terminalWebSocketURL(rect, cols, rows) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    workspaceId: workspaceID,
    paneId: rect.id,
    cwd: rect.cwd || "",
    cols: String(cols || 80),
    rows: String(rows || 24),
    protocol: "2",
    core: rect.terminal.term.coreID,
  });
  // Saying what this pane already holds lets the server send only what it
  // missed. Bound every replay, including interrupted visibility recovery.
  // An overrun or incomplete snapshot omits the cursor to request a fresh
  // snapshot; the applied cursor stays intact until that import completes.
  const stream = rect.terminal?.replica?.cursor;
  if (rect.terminal.outputPaused) params.set("outputPaused", "1");
  if (rect.terminal.snapshotIfChanged) params.set("snapshotIfChanged", "1");
  if (stream?.epoch && !rect.terminal.replica.needsSnapshot) {
    params.set("catchUpReplay", "1");
    params.set("resumeEpoch", stream.epoch);
    params.set("resumeOffset", String(stream.offset));
    params.set("resumeSequence", String(stream.sequence));
  }
  return `${protocol}//${window.location.host}/api/terminal?${params.toString()}`;
}

function sendTerminalInput(socket, data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(terminalTextEncoder.encode(data));
  }
}

const terminalTimingCaptureSeconds = 10;
let terminalTimingCaptureTimer = null;

function sendTerminalTimingEnabled(terminalState) {
  if (terminalState?.socket?.readyState === WebSocket.OPEN) {
    terminalState.socket.send(JSON.stringify({ type: "timing", enabled: Boolean(terminalState.replica?.timing) }));
  }
}

function setTerminalTimingHooks(terminalState, timing) {
  terminalState.replica.timing = timing;
  terminalState.term.outputTiming = timing;
  sendTerminalTimingEnabled(terminalState);
}

// Leaves Settings free to close: a capture runs for a fixed time while the
// terminal is visible, and its results stay on the pane for later review.
function startTerminalTimingCapture() {
  stopTerminalTimingCapture();
  for (const rect of rectangles) {
    if (rect.kind !== "terminal" || !rect.terminal?.replica) continue;
    rect.terminal.outputTiming = new TerminalOutputTiming();
    setTerminalTimingHooks(rect.terminal, rect.terminal.outputTiming);
  }
  terminalTimingCaptureTimer = window.setTimeout(stopTerminalTimingCapture, terminalTimingCaptureSeconds * 1000);
}

function stopTerminalTimingCapture() {
  window.clearTimeout(terminalTimingCaptureTimer);
  terminalTimingCaptureTimer = null;
  for (const rect of rectangles) {
    if (rect.kind === "terminal" && rect.terminal?.replica?.timing) {
      rect.terminal.replica.timing.stop();
      setTerminalTimingHooks(rect.terminal, null);
    }
  }
}

const terminalFits = new TerminalFitScheduler();

function requestTerminalFit(rect) {
  terminalFits.request(rect?.terminal);
}

function repairTerminalView(rect) {
  const state = rect?.kind === "terminal" ? rect.terminal : null;
  if (!state?.term || !state.fit || !rectangles.includes(rect)) return;
  setMinimized(rect, false);
  // Discard cached fit/send decisions so an unchanged window can repair stale
  // desired geometry and resend its measured size to the existing shell.
  state.fit.lastColumns = undefined;
  state.fit.lastRows = undefined;
  state.term.desiredCols = state.term.cols;
  state.term.desiredRows = state.term.rows;
  state.sentCols = 0;
  state.sentRows = 0;
  requestTerminalFit(rect);
  state.term.requestFullRedraw();
  setWorkspaceStatus("saved", "Terminal view repair requested");
}

function sendTerminalGridSize(terminalState) {
  terminalFits.sendGridSize(terminalState);
}

function requestTerminalGridSize(terminalState) {
  terminalFits.requestGridSize(terminalState);
}

function disposeTerminal(rect, options = {}) {
  if (!rect?.terminal) {
    if (options.closeServer && rect?.kind === "terminal") {
      closeServerTerminal(rect);
    }
    return;
  }
  const terminalState = rect.terminal;
  completeTerminalWakeRecovery(terminalState);
  terminalAudioPlayer.detach(terminalState.audioKey);
  terminalState.files?.dispose();
  rect.terminalAudioBadge?.remove();
  rect.terminalAudioBadge = null;
  rect.terminal = null;
  if (terminalState.reconnectTimer !== null) {
    window.clearTimeout(terminalState.reconnectTimer);
    terminalState.reconnectTimer = null;
  }
  clearTerminalStatus(rect);
  terminalFits.cancel(terminalState);
  if (options.closeServer) {
    closeServerTerminal(rect);
  }
  terminalState.dataDisposable?.dispose?.();
  terminalState.resizeDisposable?.dispose?.();
  terminalState.mouseBridge?.dispose?.();
  terminalState.pasteBridge?.dispose?.();
  terminalState.output?.dispose?.();
  terminalState.fit?.dispose?.();
  terminalState.fit = null;
  terminalState.term?.dispose?.();
  if (terminalState.socket?.readyState === WebSocket.OPEN || terminalState.socket?.readyState === WebSocket.CONNECTING) {
    terminalState.socket.close();
  }
}

function closeServerTerminal(rect) {
  if (!rect?.id) {
    return;
  }
  const params = new URLSearchParams({ workspaceId: workspaceID, paneId: rect.id });
  fetch(`/api/terminal?${params.toString()}`, {
    method: "DELETE",
    keepalive: true,
  }).catch((error) => console.warn(error));
}

function newPaneID() {
  if (crypto.randomUUID) {
    return `pane-${crypto.randomUUID()}`;
  }
  return `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaultPaneTitle(kind) {
  const base = kind === "terminal"
    ? "Terminal"
    : kind === browserPaneKind
        ? "Browser"
      : kind === vncPaneKind
        ? "VNC"
      : "Window";
  if (themeID === "operator") return base;
  let highest = 0;
  for (const rect of rectangles) {
    const match = rect.title.trim().match(new RegExp(`^${base} (\\d+)$`));
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `${base} ${highest + 1}`;
}

function openDockMenu(event, rect, offsetY = 0) {
  event.preventDefault();
  event.stopPropagation();
  if (rect.kind === "pending") {
    hideWindowTypeMenu({ finalizeDefault: false });
    finalizePendingRectangle(rect, "terminal");
    return;
  }
  setActivePane(rect, { raise: true });
  hideTerminalMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
  contextMenuRect = rect;
  renderDockMenu(rect);
  showMenuAt(dockMenu, event.clientX, event.clientY + offsetY);
}

function openTerminalMenu(event, rect) {
  event.preventDefault();
  event.stopPropagation();
  setActivePane(rect, { raise: true });
  hideDockMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
  terminalMenuRect = rect;
  renderTerminalMenu(rect);
  showMenuAt(terminalMenu, event.clientX, event.clientY);
}

function openWorkspaceMenu(event) {
  if (event.target !== board) {
    return;
  }
  event.preventDefault();
  openWorkspaceMenuAt(event.clientX, event.clientY);
}

function openWorkspaceMenuAt(clientX, clientY) {
  workspaceMenuPoint = boardClientPoint(clientX, clientY);
  hideDockMenu();
  hideTerminalMenu();
  hideWindowTypeMenu();
  renderWorkspaceMenu();
  showMenuAt(workspaceMenu, clientX, clientY);
}

function renderDockMenu(rect) {
  dockMenu.replaceChildren();
  const actions = [
    ["top", "Dock Top"],
    ["left", "Dock Left"],
    ["right", "Dock Right"],
    ["bottom", "Dock Bottom"],
    [rect.isFull ? "restore" : "full", rect.isFull ? "Restore" : "Full"],
    [rect.minimized ? "unminimize" : "minimize", rect.minimized ? "Restore" : "Minimize"],
    ["destroy", "Destroy"],
  ];

  for (const [action, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (action === "destroy") {
      button.className = "is-danger";
    }
    button.addEventListener("click", () => {
      applyDockAction(action, contextMenuRect);
      hideDockMenu();
    });
    dockMenu.appendChild(button);
  }
}

function renderWorkspaceMenu() {
  workspaceMenu.replaceChildren();

  const terminalButton = document.createElement("button");
  terminalButton.type = "button";
  terminalButton.textContent = "New Terminal";
  terminalButton.className = "is-command";
  terminalButton.addEventListener("click", () => {
    const point = workspaceMenuPoint || { x: 80, y: tabHeight + 56 };
    hideWorkspaceMenu();
    createTerminalPane(point.x, point.y);
  });
  workspaceMenu.appendChild(terminalButton);

  const browserButton = document.createElement("button");
  browserButton.type = "button";
  browserButton.textContent = "New Browser";
  browserButton.className = "is-command";
  browserButton.addEventListener("click", () => {
    const point = workspaceMenuPoint || { x: 80, y: tabHeight + 56 };
    hideWorkspaceMenu();
    createBrowserPane(point.x, point.y);
  });
  workspaceMenu.appendChild(browserButton);

  const vncButton = document.createElement("button");
  vncButton.type = "button";
  vncButton.textContent = "New VNC";
  vncButton.className = "is-command";
  vncButton.addEventListener("click", () => {
    const point = workspaceMenuPoint || { x: 80, y: tabHeight + 56 };
    hideWorkspaceMenu();
    createVNCPane(point.x, point.y);
  });
  workspaceMenu.appendChild(vncButton);

  const shortcutsButton = directoryBrowserButton("Shortcuts...", openShortcuts);
  workspaceMenu.appendChild(shortcutsButton);

  const panes = rectangles.filter((rect) => rect.kind !== "pending");
  if (panes.length === 0) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.textContent = "No windows";
    empty.disabled = true;
    workspaceMenu.appendChild(empty);
  }

  for (const rect of panes) {
    const row = document.createElement("div");
    row.className = "workspace-menu-row";
    if (rect.id === activePaneID) {
      row.classList.add("is-active");
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-menu-name";
    button.textContent = workspaceMenuLabel(rect);
    button.title = rect.cwd ? `${button.textContent} (${rect.cwd})` : button.textContent;
    button.addEventListener("click", () => {
      hideWorkspaceMenu();
      setMinimized(rect, false);
      setActivePane(rect, { raise: true, focus: true });
    });

    const destroyButton = document.createElement("button");
    destroyButton.type = "button";
    destroyButton.className = "workspace-menu-destroy is-danger";
    destroyButton.textContent = "X";
    destroyButton.title = `Destroy ${button.textContent}`;
    destroyButton.setAttribute("aria-label", `Destroy ${button.textContent}`);
    destroyButton.addEventListener("click", () => {
      hideWorkspaceMenu();
      destroyRectangle(rect, { closeServerTerminal: true });
    });

    row.appendChild(button);
    row.appendChild(destroyButton);
    workspaceMenu.appendChild(row);
  }

  const sessionSeparator = document.createElement("div");
  sessionSeparator.className = "dock-menu-separator";
  workspaceMenu.appendChild(sessionSeparator);
  const sessionsButton = document.createElement("button");
  sessionsButton.type = "button";
  sessionsButton.textContent = currentSessionName ? `Sessions (${currentSessionName})...` : "Sessions...";
  sessionsButton.addEventListener("click", () => {
    hideWorkspaceMenu();
    void openSessionsModal();
  });
  workspaceMenu.appendChild(sessionsButton);

  if (multiUser) {
    const userSeparator = document.createElement("div");
    userSeparator.className = "dock-menu-separator";
    workspaceMenu.appendChild(userSeparator);

    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.textContent = currentUser ? `Switch user (${currentUser})...` : "Switch user...";
    switchButton.addEventListener("click", () => {
      hideWorkspaceMenu();
      void switchUser();
    });
    workspaceMenu.appendChild(switchButton);
  }

  const paletteSeparator = document.createElement("div");
  paletteSeparator.className = "dock-menu-separator";
  workspaceMenu.appendChild(paletteSeparator);

  const paletteButton = document.createElement("button");
  paletteButton.type = "button";
  paletteButton.className = "has-hint";
  const paletteLabel = document.createElement("span");
  paletteLabel.textContent = "Command Palette";
  const paletteHint = document.createElement("span");
  paletteHint.className = "menu-hint";
  paletteHint.textContent = "Ctrl+K";
  paletteButton.appendChild(paletteLabel);
  paletteButton.appendChild(paletteHint);
  paletteButton.addEventListener("click", () => {
    hideWorkspaceMenu();
    openCommandPalette();
  });
  workspaceMenu.appendChild(paletteButton);
  const wheelButton = document.createElement("button");
  wheelButton.type = "button";
  wheelButton.className = "has-hint";
  const wheelLabel = document.createElement("span");
  wheelLabel.textContent = "Command Wheel";
  const wheelHint = document.createElement("span");
  wheelHint.className = "menu-hint";
  wheelHint.textContent = "Ctrl/Cmd+;";
  wheelButton.append(wheelLabel, wheelHint);
  wheelButton.addEventListener("click", () => openCommandWheel());
  workspaceMenu.appendChild(wheelButton);
}

// The Deskbar lists windows and restores minimized panes in place.
function toggleDeskbar() {
  if (deskbarPanel.hidden) {
    openDeskbar();
  } else {
    hideDeskbar();
  }
}

function openDeskbar(options = {}) {
  hideAllMenus();
  renderDeskbar();
  deskbarPanel.hidden = false;
  deskbarButton.setAttribute("aria-expanded", "true");
  if (Number.isInteger(options.focusWindow)) {
    window.requestAnimationFrame(() => focusDeskbarWindow(options.focusWindow));
  }
}

function setWorkspaceBackgroundMode(mode) {
  workspaceBackgroundMode = normalizeBackgroundDisplayMode(mode);
  if (workspaceHasBackground) {
    board.style.setProperty("--board-user-size", backgroundDisplayModes[workspaceBackgroundMode].size);
  }
  scheduleWorkspaceSave();
}

function hideDeskbar() {
  deskbarPanel.hidden = true;
  deskbarButton.setAttribute("aria-expanded", "false");
}

function toggleDeskbarButton() {
  deskbarButtonEnabled = !deskbarButtonEnabled;
  if (!deskbarButtonEnabled) {
    hideDeskbar();
  }
  updateDeskbar();
  scheduleUserSettingsSave();
}

function focusDeskbarWindow(index) {
  const buttons = Array.from(deskbarPanel.querySelectorAll(".workspace-menu-name"));
  if (buttons.length === 0) {
    return;
  }
  const normalizedIndex = ((index % buttons.length) + buttons.length) % buttons.length;
  buttons[normalizedIndex].focus();
}

function handleDeskbarKeyboard(event) {
  const row = event.target.closest(".workspace-menu-row");
  if (!row || !deskbarPanel.contains(row)) {
    if (event.key === "Escape") {
      event.preventDefault();
      hideDeskbar();
      deskbarButton.focus();
    }
    return;
  }

  const rows = Array.from(deskbarPanel.querySelectorAll(".workspace-menu-row"));
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
    focusDeskbarWindow(rowIndex + (event.key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    focusDeskbarWindow(0);
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    focusDeskbarWindow(-1);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideDeskbar();
    deskbarButton.focus();
  }
}

function updateDeskbar() {
  const activePane = getActivePane();
  const hideForFocusedFullscreenPane = Boolean(activePane?.isFull && !activePane.minimized);
  deskbarButton.hidden = !deskbarButtonEnabled || hideForFocusedFullscreenPane;
  if (deskbarButton.hidden) {
    hideDeskbar();
  }
  const minimizedCount = rectangles.filter((rect) => rect.kind !== "pending" && rect.minimized).length;
  deskbarButton.dataset.minimizedCount = String(minimizedCount);
  const fileCount = rectangles.reduce((count, rect) => count + (rect.filePendingCount || 0), 0);
  deskbarButton.dataset.fileCount = String(fileCount);
  deskbarButton.title = fileCount ? `${fileCount} pending file transfer${fileCount === 1 ? "" : "s"}` : "Window list";
  deskbarButton.setAttribute("aria-label", minimizedCount === 1
    ? "Window list, 1 minimized window"
    : minimizedCount > 1
      ? `Window list, ${minimizedCount} minimized windows`
      : "Window list");
  if (!deskbarPanel.hidden) {
    renderDeskbar();
  }
  if (!windowList.hidden) {
    renderWindowList();
  }
}

// The Deskbar keeps window recovery and a small set of workspace controls in
// one corner, without duplicating the command palette as a general launcher.
function renderDeskbar() {
  deskbarPanel.replaceChildren();

  const title = document.createElement("div");
  title.className = "deskbar-title";
  const titleText = document.createElement("span");
  titleText.textContent = "Windows";
  title.appendChild(titleText);
  const minimizedCount = rectangles.filter((rect) => rect.kind !== "pending" && rect.minimized).length;
  const count = document.createElement("span");
  count.className = "deskbar-user";
  count.textContent = minimizedCount === 1 ? "1 minimized" : `${minimizedCount} minimized`;
  title.appendChild(count);
  deskbarPanel.appendChild(title);
  const panes = rectangles.filter((rect) => rect.kind !== "pending");
  if (panes.length === 0) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.textContent = "No windows";
    empty.disabled = true;
    deskbarPanel.appendChild(empty);
  }
  for (const rect of panes) {
    const row = document.createElement("div");
    row.className = "workspace-menu-row";
    if (rect.id === activePaneID) {
      row.classList.add("is-active");
    }
    if (rect.minimized) {
      row.classList.add("is-minimized");
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-menu-name";
    button.textContent = workspaceMenuLabel(rect);
    button.title = rect.cwd ? `${button.textContent} (${rect.cwd})` : button.textContent;
    button.addEventListener("click", () => {
      hideDeskbar();
      setMinimized(rect, false);
      setActivePane(rect, { raise: true, focus: true });
    });

    const destroyButton = document.createElement("button");
    destroyButton.type = "button";
    destroyButton.className = "workspace-menu-destroy is-danger";
    destroyButton.textContent = "X";
    destroyButton.title = `Destroy ${button.textContent}`;
    destroyButton.setAttribute("aria-label", `Destroy ${button.textContent}`);
    destroyButton.addEventListener("click", () => {
      destroyRectangle(rect, { closeServerTerminal: true });
    });

    row.appendChild(button);
    row.appendChild(destroyButton);
    deskbarPanel.appendChild(row);
  }

  const separator = document.createElement("div");
  separator.className = "dock-menu-separator";
  deskbarPanel.appendChild(separator);
  const sessionsButton = document.createElement("button");
  sessionsButton.type = "button";
  sessionsButton.className = "deskbar-settings";
  sessionsButton.textContent = currentSessionName ? `Sessions (${currentSessionName})...` : "Sessions...";
  sessionsButton.addEventListener("click", () => void openSessionsModal());
  deskbarPanel.appendChild(sessionsButton);
  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "deskbar-settings";
  settingsButton.textContent = "Settings...";
  settingsButton.addEventListener("click", openSettingsModal);
  deskbarPanel.appendChild(settingsButton);
}

async function openSessionsModal() {
  hideAllMenus();
  try {
    await refreshSessions();
  } catch (error) {
    console.warn(error);
  }
  sessionQuery = "";
  sessionSelection = 0;
  renderSessionsModal();
  const currentIndex = sessionEntries.findIndex((entry) => entry.session.id === currentSessionID);
  if (currentIndex >= 0) {
    sessionSelection = currentIndex;
    renderSessionsResults();
  }
  sessionsModal.hidden = false;
  window.requestAnimationFrame(() => sessionsSearchInput?.focus());
}

function hideSessionsModal() {
  sessionsModal.hidden = true;
  sessionsModal.replaceChildren();
  sessionsSearchInput = null;
  sessionsList = null;
  sessionEntries = [];
}

function hideSessionActionModal() {
  sessionActionModal.hidden = true;
  sessionActionModal.replaceChildren();
}

function renderSessionsModal() {
  sessionsModal.replaceChildren();
  const panel = document.createElement("section");
  panel.className = "settings-panel sessions-panel";
  panel.tabIndex = 0;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "sessions-title");
  panel.addEventListener("keydown", handleSessionsKeyboard);

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "sessions-title";
  title.textContent = "Sessions";
  const createButton = document.createElement("button");
  createButton.type = "button";
  createButton.className = "settings-background-button";
  createButton.textContent = "Create Session";
  createButton.addEventListener("click", () => openSessionNameDialog("create"));
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "settings-close";
  closeButton.textContent = "X";
  closeButton.setAttribute("aria-label", "Close sessions");
  closeButton.addEventListener("click", hideSessionsModal);
  titleBar.append(title, createButton, closeButton);
  panel.appendChild(titleBar);

  const searchInput = document.createElement("input");
  searchInput.className = "command-palette-input sessions-search-input";
  searchInput.type = "text";
  searchInput.placeholder = "Type a session name...";
  searchInput.spellcheck = false;
  searchInput.value = sessionQuery;
  searchInput.setAttribute("aria-label", "Find a session");
  searchInput.addEventListener("input", () => {
    sessionQuery = searchInput.value;
    sessionSelection = 0;
    renderSessionsResults();
  });
  panel.appendChild(searchInput);

  const list = document.createElement("div");
  list.className = "sessions-list command-palette-list";
  panel.appendChild(list);
  sessionsModal.appendChild(panel);
  sessionsSearchInput = searchInput;
  sessionsList = list;
  renderSessionsResults();
}

function renderSessionsResults() {
  if (!sessionsList) {
    return;
  }

  const query = sessionQuery.trim();
  sessionEntries = sessions
    .map((session) => ({ session, score: paletteScore(query, session.name) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.session.name.localeCompare(b.session.name));
  sessionSelection = Math.min(sessionSelection, Math.max(0, sessionEntries.length - 1));
  sessionsList.replaceChildren();

  if (sessionEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-palette-empty";
    empty.textContent = "No matching sessions";
    sessionsList.appendChild(empty);
    return;
  }

  sessionEntries.forEach(({ session }, index) => {
    const row = document.createElement("div");
    row.className = "sessions-row";
    row.classList.toggle("is-selected", index === sessionSelection);
    row.classList.toggle("is-current", session.id === currentSessionID);
    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.className = "sessions-name";
    switchButton.tabIndex = -1;
    switchButton.textContent = session.name;
    switchButton.setAttribute("aria-label", `Switch to session ${session.name}`);
    switchButton.addEventListener("click", () => void switchSession(session));
    const state = document.createElement("span");
    state.className = "sessions-state";
    state.textContent = session.id === currentSessionID ? "Current" : "";
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "sessions-action";
    renameButton.textContent = "Rename";
    renameButton.addEventListener("click", () => openSessionNameDialog("rename", session));
    const destroyButton = document.createElement("button");
    destroyButton.type = "button";
    destroyButton.className = "sessions-action is-danger";
    destroyButton.textContent = "Destroy";
    destroyButton.disabled = sessions.length <= 1;
    destroyButton.addEventListener("click", () => openDestroySessionDialog(session));
    row.append(switchButton, state, renameButton, destroyButton);
    sessionsList.appendChild(row);
  });
}

function handleSessionsKeyboard(event) {
  if (event.target.closest("button") && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (sessionEntries.length) {
      sessionSelection = (sessionSelection + (event.key === "ArrowDown" ? 1 : -1) + sessionEntries.length) % sessionEntries.length;
      renderSessionsResults();
      sessionsList?.querySelectorAll(".sessions-row")[sessionSelection]?.scrollIntoView({ block: "nearest" });
    }
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const session = sessionEntries[sessionSelection]?.session;
    if (session) {
      void switchSession(session);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideSessionsModal();
  }
}

function openSessionNameDialog(mode, session = null) {
  sessionActionModal.replaceChildren();
  const panel = document.createElement("section");
  panel.className = "settings-panel rename-window-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.textContent = mode === "create" ? "Create Session" : "Rename Session";
  titleBar.appendChild(title);
  const form = document.createElement("form");
  form.className = "settings-content session-action-content";
  const label = document.createElement("label");
  label.textContent = "Session name";
  const input = document.createElement("input");
  input.className = "rename-window-input";
  input.type = "text";
  input.maxLength = 80;
  input.value = session?.name || "";
  const error = document.createElement("div");
  error.className = "session-action-error";
  const actions = document.createElement("div");
  actions.className = "rename-window-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "settings-background-button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", hideSessionActionModal);
  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "settings-background-button";
  submitButton.textContent = mode === "create" ? "Create" : "Rename";
  actions.append(cancelButton, submitButton);
  label.appendChild(input);
  form.append(label, error, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    try {
      const endpoint = mode === "create"
        ? userAPIPath("sessions")
        : `${userAPIPath("sessions")}/${encodeURIComponent(session.id)}`;
      const response = await fetch(endpoint, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: input.value }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `session ${mode} failed`);
      }
      const saved = await response.json();
      await refreshSessions();
      hideSessionActionModal();
      if (mode === "create") {
        await switchSession(saved);
      } else {
        if (saved.id === currentSessionID) {
          currentSessionName = saved.name;
        }
        renderSessionsModal();
      }
    } catch (requestError) {
      error.textContent = requestError.message;
      submitButton.disabled = false;
      input.focus();
    }
  });
  panel.append(titleBar, form);
  sessionActionModal.appendChild(panel);
  sessionActionModal.hidden = false;
  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function openDestroySessionDialog(session) {
  sessionActionModal.replaceChildren();
  const panel = document.createElement("section");
  panel.className = "settings-panel rename-window-panel";
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-modal", "true");
  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.textContent = "Destroy Session";
  titleBar.appendChild(title);
  const message = document.createElement("p");
  message.textContent = `Destroy “${session.name}”? Its windows, history, background, and running processes will be permanently removed.`;
  const error = document.createElement("div");
  error.className = "session-action-error";
  const actions = document.createElement("div");
  actions.className = "rename-window-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "settings-background-button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", hideSessionActionModal);
  const destroyButton = document.createElement("button");
  destroyButton.type = "button";
  destroyButton.className = "settings-background-button is-danger";
  destroyButton.textContent = "Destroy";
  destroyButton.addEventListener("click", async () => {
    destroyButton.disabled = true;
    try {
      const response = await fetch(`${userAPIPath("sessions")}/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "destroy session failed");
      }
      const wasCurrent = session.id === currentSessionID;
      await refreshSessions();
      hideSessionActionModal();
      if (wasCurrent) {
        currentSessionID = "";
        currentSessionName = "";
        clearRectanglesForLoad();
        await switchSession(sessions[0], { skipSave: true, historyMode: "replace" });
      } else {
        sessionSelection = Math.min(sessionSelection, Math.max(0, sessions.length - 1));
        renderSessionsModal();
      }
    } catch (requestError) {
      error.textContent = requestError.message;
      destroyButton.disabled = false;
    }
  });
  actions.append(cancelButton, destroyButton);
  panel.append(titleBar, message, error, actions);
  sessionActionModal.appendChild(panel);
  sessionActionModal.hidden = false;
  window.requestAnimationFrame(() => cancelButton.focus());
}

function openSettingsModal(options = {}) {
  if (settingsModal.hidden) settingsReturnFocus = document.activeElement;
  hideDeskbar();
  renderSettingsModal();
  settingsModal.hidden = false;
  window.requestAnimationFrame(() => {
    if (!settingsOwnsFocus()) return;
    const clipboardRow = options.clipboard ? settingsModal.querySelector("#settings-clipboard") : null;
    clipboardRow?.scrollIntoView({ block: "center" });
    (clipboardRow?.querySelector("button, a") || settingsModal.querySelector("button, select"))?.focus();
  });
}

let compatibilityUpdateTimer = null;
let settingsReturnFocus = null;

function settingsOwnsFocus() {
  return !settingsModal.hidden && ![...document.querySelectorAll(".settings-modal")]
    .some(modal => modal !== settingsModal && !modal.hidden);
}

function settingsFocusControls() {
  return [...settingsModal.querySelectorAll("button, a[href], input, select, textarea, summary, [tabindex]")]
    .filter(control => control.tabIndex >= 0 && !control.matches(":disabled")
      && !control.closest("[hidden], [inert]") && control.getClientRects().length > 0);
}

function containSettingsFocus(event) {
  if (settingsOwnsFocus() && !settingsModal.contains(event.target)) {
    settingsFocusControls()[0]?.focus();
  }
}

function handleSettingsKeyboard(event) {
  if (event.defaultPrevented || !settingsOwnsFocus()) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    hideSettingsModal();
    return;
  }
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
  const controls = settingsFocusControls();
  const current = controls.indexOf(document.activeElement);
  // Leave normal movement to the browser; wrap only at the visible boundaries.
  if (current < 0 || (event.shiftKey ? current === 0 : current === controls.length - 1)) {
    event.preventDefault();
    event.stopPropagation();
    (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
  }
}

function settingsDiagnosticsOpen() {
  return !settingsModal.hidden && settingsModal.querySelector("#settings-diagnostics")?.open === true;
}

function hideSettingsModal() {
  const wasOpen = !settingsModal.hidden;
  const returnFocus = settingsReturnFocus;
  settingsReturnFocus = null;
  window.clearInterval(compatibilityUpdateTimer);
  compatibilityUpdateTimer = null;
  settingsModal.hidden = true;
  settingsModal.replaceChildren();
  setTerminalRenderingMetricsEnabled(false);
  if (!wasOpen) return;
  window.requestAnimationFrame(() => {
    if (!settingsModal.hidden || [...document.querySelectorAll(".settings-modal")].some(modal => !modal.hidden)
      || !commandPalette.hidden || !commandWheel.hidden || !windowList.hidden) return;
    // A close can hand off to another UI in the same tick. Preserve that focus.
    if (document.activeElement !== document.body) return;
    if (returnFocus?.isConnected && !returnFocus.matches(":disabled")
      && !returnFocus.closest("[hidden], [inert]") && returnFocus.getClientRects().length) {
      returnFocus.focus();
    } else if (getActivePane()) {
      focusPane(getActivePane());
    } else if (!deskbarButton.hidden) {
      deskbarButton.focus();
    }
  });
}

async function openLocalHTTPSModal() {
  if (window.__tesseraDesktop === true) return;
  hideDeskbar();
  localHTTPSModal.hidden = false;
  localHTTPSModal.replaceChildren();
  const loading = document.createElement("section");
  loading.className = "settings-panel local-https-panel";
  loading.textContent = "Loading Local HTTPS settings...";
  localHTTPSModal.appendChild(loading);
  try {
    const response = await fetch("/api/host/https", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    body.config = localHTTPSConfigWithCurrentHostname(body.config, window.location.hostname);
    renderLocalHTTPSModal(body);
  } catch (error) {
    renderLocalHTTPSError(error.message || String(error));
  }
}

function hideLocalHTTPSModal() {
  localHTTPSModal.hidden = true;
  localHTTPSModal.replaceChildren();
}

function showIPadHTTPGuidanceIfNeeded() {
  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(ipadHTTPGuidanceDismissedKey) === "true";
  } catch {
    // Show the guidance when persistent browser storage is unavailable.
  }
  const device = {
    userAgent: navigator.userAgent || "",
    platform: navigator.platform || "",
    maxTouchPoints: navigator.maxTouchPoints || 0,
  };
  if (!shouldShowIPadHTTPGuidance({ protocol: window.location.protocol, device, dismissed })) return;

  localHTTPSModal.replaceChildren();
  localHTTPSModal.hidden = false;
  const panel = document.createElement("section");
  panel.className = "settings-panel ipad-http-info-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "ipad-http-info-title");

  const title = document.createElement("h2");
  title.id = "ipad-http-info-title";
  title.textContent = "Use HTTPS for the best iPad experience";
  const explanation = document.createElement("p");
  explanation.textContent = "Tessera works over HTTP, but iPadOS limits clipboard access and other browser features on connections that are not secure.";
  const recommendation = document.createElement("p");
  recommendation.textContent = "Set up Tessera Local HTTPS for more reliable terminal copy and paste. HTTP will remain available on port 7331 for recovery and certificate enrollment.";

  const actions = document.createElement("div");
  actions.className = "rename-window-actions";
  const continueHTTP = document.createElement("button");
  continueHTTP.type = "button";
  continueHTTP.textContent = "Continue with HTTP";
  continueHTTP.addEventListener("click", () => {
    try {
      window.localStorage.setItem(ipadHTTPGuidanceDismissedKey, "true");
    } catch {
      // The modal still closes for this page when storage is unavailable.
    }
    hideLocalHTTPSModal();
  });
  const setupHTTPS = document.createElement("button");
  setupHTTPS.type = "button";
  setupHTTPS.textContent = "Set up HTTPS";
  setupHTTPS.addEventListener("click", () => void openLocalHTTPSModal());
  actions.append(continueHTTP, setupHTTPS);
  panel.append(title, explanation, recommendation, actions);
  localHTTPSModal.appendChild(panel);
  window.requestAnimationFrame(() => setupHTTPS.focus());
}

function renderLocalHTTPSError(message) {
  localHTTPSModal.replaceChildren();
  const panel = document.createElement("section");
  panel.className = "settings-panel local-https-panel";
  const title = document.createElement("h2");
  title.textContent = "Local HTTPS";
  const error = document.createElement("p");
  error.className = "local-https-error";
  error.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", hideLocalHTTPSModal);
  panel.append(title, error, close);
  localHTTPSModal.appendChild(panel);
}

function localHTTPSField(labelText, detailText, control) {
  const field = document.createElement("label");
  field.className = "local-https-field";
  const label = document.createElement("strong");
  label.textContent = labelText;
  const detail = document.createElement("span");
  detail.textContent = detailText;
  field.append(label, detail, control);
  return field;
}

function renderLocalHTTPSModal(state, message = "") {
  localHTTPSModal.replaceChildren();
  const config = state.config || {};
  const panel = document.createElement("section");
  panel.className = "settings-panel local-https-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "local-https-title");

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "local-https-title";
  title.textContent = "Local HTTPS";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "settings-close";
  close.textContent = "X";
  close.setAttribute("aria-label", "Close Local HTTPS settings");
  close.addEventListener("click", hideLocalHTTPSModal);
  titleBar.append(title, close);

  const form = document.createElement("form");
  form.className = "local-https-form";
  const introduction = document.createElement("p");
  introduction.className = "local-https-introduction";
  introduction.textContent = "Tessera keeps the workspace available over HTTP and can also serve it over HTTPS with a private certificate authority. The root stays stable across service restarts and upgrades.";

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = Boolean(config.enabled);
  const enabledField = localHTTPSField("Enable Local HTTPS", "HTTP remains available on the primary listener while HTTPS uses its own port.", enabled);
  enabledField.classList.add("local-https-check-field");
  const httpsAddress = document.createElement("input");
  httpsAddress.type = "text";
  httpsAddress.value = config.httpsAddress || "0.0.0.0:7332";
  httpsAddress.placeholder = "0.0.0.0:7332";
  const dnsNames = document.createElement("textarea");
  dnsNames.rows = 2;
  dnsNames.value = (config.dnsNames || []).join("\n");
  dnsNames.placeholder = "tessera.local";
  const ipAddresses = document.createElement("textarea");
  ipAddresses.rows = 2;
  ipAddresses.value = (config.ipAddresses || []).join("\n");
  ipAddresses.placeholder = "192.168.1.50\n100.64.0.10";
  const dependent = [httpsAddress, dnsNames, ipAddresses];
  const updateDisabled = () => {
    for (const control of dependent) control.disabled = !enabled.checked;
  };
  enabled.addEventListener("change", updateDisabled);
  updateDisabled();

  form.append(
    introduction,
    enabledField,
    localHTTPSField("HTTPS listener", "Separate TLS address in host:port form. The default is port 7332; HTTP stays on port 7331.", httpsAddress),
    localHTTPSField("Certificate DNS names", "One per line or comma-separated. Include every hostname used from the iPad.", dnsNames),
    localHTTPSField("Certificate IP addresses", "Include LAN and VPN addresses that may be entered directly in Safari.", ipAddresses),
  );

  if (state.hasCA) {
    const identity = document.createElement("div");
    identity.className = "local-https-identity";
    const identityTitle = document.createElement("strong");
    identityTitle.textContent = state.rootName || "Tessera Root CA";
    const fingerprint = document.createElement("code");
    fingerprint.textContent = state.fingerprint || "Fingerprint unavailable";
    const download = document.createElement("a");
    download.href = "/api/host/https/ca";
    download.textContent = "Download public root certificate";
    identity.append(identityTitle, fingerprint, download);
    if (state.enrollmentURL) {
      const enrollment = document.createElement("a");
      enrollment.href = state.enrollmentURL;
      enrollment.target = "_blank";
      enrollment.rel = "noopener";
      enrollment.textContent = "Open HTTP enrollment page";
      identity.appendChild(enrollment);
    }
    form.appendChild(identity);
  }

  const guidance = document.createElement("p");
  guidance.className = "local-https-guidance";
  guidance.textContent = "On iPadOS, install the downloaded profile, then enable it under General → About → Certificate Trust Settings. Private keys never leave this Tessera host.";
  const status = document.createElement("div");
  status.className = "local-https-status";
  status.setAttribute("role", "status");
  status.textContent = message;
  const actions = document.createElement("div");
  actions.className = "rename-window-actions local-https-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", hideLocalHTTPSModal);
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save and apply";
  actions.append(cancel, save);
  form.append(guidance, status, actions);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const draft = localHTTPSDraft({
      enabled: enabled.checked,
      httpsAddress: httpsAddress.value,
      dnsNames: dnsNames.value,
      ipAddresses: ipAddresses.value,
    });
    const validation = validateLocalHTTPSDraft(draft);
    if (validation) {
      status.textContent = validation;
      status.classList.add("is-error");
      return;
    }
    status.classList.remove("is-error");
    status.textContent = "Saving host settings and preparing certificates...";
    save.disabled = true;
    cancel.disabled = true;
    let enrollmentTab = null;
    if (draft.enabled) {
      enrollmentTab = window.open("about:blank", "tessera-enrollment");
      if (enrollmentTab) enrollmentTab.opener = null;
    }
    try {
      const response = await fetch("/api/host/https", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      if (!body.restarting) {
        enrollmentTab?.close();
        renderLocalHTTPSModal(body, "Settings are already applied.");
        return;
      }
      localHTTPSModal.replaceChildren();
      const restarting = document.createElement("section");
      restarting.className = "settings-panel local-https-restarting";
      const heading = document.createElement("h2");
      heading.textContent = "Applying Local HTTPS";
      const explanation = document.createElement("p");
      const nextURL = localHTTPSNextURL(body, window.location.href);
      explanation.textContent = body.config.enabled && body.enrollmentURL
        ? "Tessera is applying HTTPS. The HTTP enrollment page is opening in a new tab."
        : "Tessera is applying the listener settings and will reopen over HTTP.";
      restarting.append(heading, explanation);
      if (body.config.enabled && body.enrollmentURL) {
        const enrollmentLink = document.createElement("a");
        enrollmentLink.href = body.enrollmentURL;
        enrollmentLink.target = "_blank";
        enrollmentLink.rel = "noopener";
        enrollmentLink.textContent = "Open enrollment page";
        restarting.appendChild(enrollmentLink);
        if (enrollmentTab) enrollmentTab.location.replace(body.enrollmentURL);
      } else {
        enrollmentTab?.close();
        window.setTimeout(() => window.location.assign(nextURL), 1000);
      }
      localHTTPSModal.appendChild(restarting);
    } catch (error) {
      enrollmentTab?.close();
      status.textContent = error.message || String(error);
      status.classList.add("is-error");
      save.disabled = false;
      cancel.disabled = false;
    }
  });

  panel.append(titleBar, form);
  localHTTPSModal.appendChild(panel);
  window.requestAnimationFrame(() => enabled.focus());
}

function setTerminalRenderingMetricsEnabled(enabled) {
  for (const rect of rectangles) {
    if (rect.kind === "terminal") {
      rect.terminal?.term?.setRenderingMetricsEnabled?.(enabled);
    }
  }
}

function renderSettingsModal() {
  const scrollTop = settingsModal.querySelector(".settings-content")?.scrollTop || 0;
  const advancedOpen = settingsModal.querySelector("#settings-advanced")?.open === true;
  const diagnosticsOpen = settingsModal.querySelector("#settings-diagnostics")?.open === true;
  const focused = settingsModal.contains(document.activeElement) ? document.activeElement : null;
  window.clearInterval(compatibilityUpdateTimer);
  compatibilityUpdateTimer = null;
  settingsModal.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "settings-panel settings-main-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "settings-title");

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "settings-title";
  title.textContent = "Settings";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "settings-close";
  closeButton.textContent = "X";
  closeButton.setAttribute("aria-label", "Close settings");
  closeButton.addEventListener("click", hideSettingsModal);
  titleBar.append(title, closeButton);
  panel.appendChild(titleBar);

  const content = document.createElement("div");
  content.className = "settings-content";
  content.appendChild(renderSettingsSection("Font size", [
    renderSettingsFontRow("Default", "Used for new terminal panes in all sessions.", defaultPaneFontSize, (next) => {
      setDefaultPaneFontSize(next);
      renderSettingsModal();
    }),
    renderCurrentPaneFontRow(),
  ]));
  content.appendChild(renderSettingsSection("Theme", [
    renderSettingsThemeRow("Default", "Used for new windows in all of this user's sessions.", defaultTheme, (next) => setDefaultTheme(next)),
    renderSettingsThemeRow("Current", "Applied across this user's sessions immediately.", themeID, (next) => applyTheme(next)),
    renderSettingsOLEDWindowBorderRow(),
    renderSettingsToggleRow("Wobbly windows", "Gentle elasticity when dragging Operator windows. Applies to this browser; reduced motion and Older Mac mode disable the effect.", windowWobbleEnabled, setWindowWobbleEnabled),
  ]));
  content.appendChild(renderSettingsSection("Terminal", [
    renderSettingsTerminalFontRow(),
    renderSettingsTerminalRowSpacingRow(),
    renderSettingsTerminalColorModeRow(),
  ]));
  content.appendChild(renderSettingsSection("Scroll wheel", [
    renderSettingsWheelRow(
      "Terminal",
      "Controls terminal scrollback and wheel input in full-screen terminal apps.",
      terminalWheelSensitivity,
      (next) => setTerminalWheelSensitivity(next),
    ),
  ]));
  content.appendChild(renderSettingsSection("Shortcuts", [directoryBrowserButton("Manage shortcuts...", openShortcuts)]));
  content.appendChild(renderSettingsSection("Background", [
    renderSettingsBackgroundRow(),
    renderSettingsBackgroundModeRow(),
  ]));
  content.appendChild(renderSettingsSection("Clipboard", [renderSettingsClipboardRow()]));
  content.appendChild(renderSettingsSection("Performance", [renderSettingsPerformanceRow()]));

  const advanced = document.createElement("details");
  advanced.id = "settings-advanced";
  advanced.className = "settings-disclosure";
  advanced.open = advancedOpen;
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = "Advanced";
  const advancedContent = document.createElement("div");
  advancedContent.className = "settings-disclosure-content";
  advancedContent.append(
    renderSettingsSection("Terminal", [renderSettingsTerminalTERMRow()]),
    renderSettingsSection("Performance", [
      renderSettingsExperimentalRendererRow(),
      renderSettingsToggleRow(
        "Paint coalescing",
        "While terminal output is streaming, wait up to one frame for a 3 ms pause before painting so animation frames split across many writes are not drawn in pieces. Applies to this browser only.",
        terminalPaintCoalescing,
        setTerminalPaintCoalescing,
      ),
      renderSettingsToggleRow(
        "Server output coalescing",
        "Ask the server to join terminal output that arrives within 2 ms (holding at most 8 ms) into one WebSocket message. Applies to this browser's connections only.",
        terminalOutputCoalescing,
        setTerminalOutputCoalescing,
      ),
      renderSettingsTerminalBacklogRow(),
    ]),
  );
  advanced.append(advancedSummary, advancedContent);

  const diagnostics = document.createElement("details");
  diagnostics.id = "settings-diagnostics";
  diagnostics.className = "settings-disclosure";
  diagnostics.open = diagnosticsOpen;
  const diagnosticsSummary = document.createElement("summary");
  diagnosticsSummary.textContent = "Diagnostics";
  const diagnosticsContent = document.createElement("div");
  diagnosticsContent.className = "settings-disclosure-content";
  let diagnosticsRendered = null;
  const updateDiagnostics = () => {
    if (!diagnostics.isConnected || settingsModal.hidden || diagnosticsRendered === diagnostics.open) return;
    diagnosticsRendered = diagnostics.open;
    window.clearInterval(compatibilityUpdateTimer);
    compatibilityUpdateTimer = null;
    setTerminalRenderingMetricsEnabled(diagnostics.open);
    diagnosticsContent.replaceChildren();
    if (diagnostics.open) diagnosticsContent.appendChild(renderSettingsCompatibilityRow());
  };
  diagnostics.addEventListener("toggle", updateDiagnostics);
  diagnostics.append(diagnosticsSummary, diagnosticsContent);
  content.append(advanced, diagnostics);
  panel.appendChild(content);
  settingsModal.appendChild(panel);
  updateDiagnostics();
  if (focused && settingsOwnsFocus()) {
    const controls = settingsFocusControls();
    const replacement = controls.find(control => {
      if (control.tagName !== focused.tagName) return false;
      if (focused.id) return control.id === focused.id;
      const label = focused.getAttribute("aria-label");
      return label ? control.getAttribute("aria-label") === label : control.textContent === focused.textContent;
    });
    (replacement || controls[0])?.focus({ preventScroll: true });
  }
  content.scrollTop = scrollTop;
}

function currentCompatibility() {
  const info = detectCompatibility({
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform || navigator.platform || "Unknown",
    secureContext: window.isSecureContext,
    clipboard: navigator.clipboard,
    extension: clipboardBridge.status,
    displayPixelRatio: window.devicePixelRatio || 1,
    olderMacMode,
    experimentalTerminalRenderer,
    online: navigator.onLine !== false,
    serverHealthy: serverConnectionLastHealthy,
    serverState: serverConnectionState.state,
  });
  info.rendererRows = [];
  info.renderingCosts = rectangles.filter(rect => rect.kind === "terminal" && rect.terminal?.term)
    .map((rect, index) => {
      const term = rect.terminal.term;
      const stats = term.renderingStatistics?.();
      if (!stats) return "";
      const recent = stats.recent;
      const rows = stats.rendererRows;
      if (rows) {
        const percent = count => rows.totalRows ? `${(count / rows.totalRows * 100).toFixed(1)}%` : "0.0%";
        info.rendererRows.push(`Terminal ${index + 1}: ${percent(rows.fastRows)} fast (${rows.fastRows}), ${percent(rows.hybridRows)} hybrid (${rows.hybridRows}), ${percent(rows.originalRows)} original (${rows.originalRows}); ${rows.totalRows} rows total`);
      }
      const activity = recent ? `Last 5 s: ${recent.fps.toFixed(1)} FPS, ${recent.paintMsPerSecond.toFixed(1)} ms painting/s, average ${recent.averageMs.toFixed(2)} ms/frame, peak ${recent.maxMs.toFixed(2)} ms. ` : "";
      return `Terminal ${index + 1}: ${term.renderPaused ? "paused" : "visible"}. ${activity}Measurement sample: ${stats.frames} frames, average ${stats.averageMs.toFixed(2)} ms, peak ${stats.maxMs.toFixed(2)} ms, total ${stats.totalMs.toFixed(1)} ms`;
    }).filter(Boolean);
  info.paintCoalescing = terminalPaintCoalescing;
  info.outputCoalescing = terminalOutputCoalescing;
  info.outputTiming = rectangles.filter(rect => rect.kind === "terminal" && rect.terminal?.term)
    .map((rect, index) => rect.terminal.outputTiming
      ? `Terminal ${index + 1}${rect.terminal.replica?.timing ? " (capturing)" : ""}: ${formatOutputTiming(rect.terminal.outputTiming.summary())}`
      : "")
    .filter(Boolean);
  return info;
}

function renderSettingsCompatibilityRow() {
  const row = document.createElement("div");
  row.className = "settings-compatibility";
  row.id = "settings-compatibility";
  const grid = document.createElement("dl");
  grid.className = "settings-compatibility-grid";
  const status = document.createElement("p");
  status.className = "settings-compatibility-status";
  status.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "settings-compatibility-actions";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = "Refresh checks";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy diagnostics";
  const captureButton = document.createElement("button");
  captureButton.type = "button";
  captureButton.textContent = `Capture output timing (${terminalTimingCaptureSeconds} s)`;
  captureButton.addEventListener("click", () => {
    startTerminalTimingCapture();
    update();
    status.textContent = "Capturing output timing. Close Settings and keep the terminal visible.";
  });

  const update = () => {
    const info = currentCompatibility();
    const items = [
      ["Clipboard support", info.nativeClipboard ? "Native API available" : "Native API unavailable"],
      ["Extension connection", info.extension],
      ["Terminal extension writes", info.terminalClipboard],
      ["Rendering scale", `${info.renderScale} · ${info.performanceProfile} (${info.renderScaleDetail})`],
      ["Connection status", info.connection],
      ["Painting limit", olderMacMode ? "30 FPS (input temporarily bypasses cap)" : "Display refresh rate"],
      ["Terminal renderer", info.terminalRenderer],
      ["Renderer row paths", info.rendererRows.join("; ") || (experimentalTerminalRenderer ? "No rows painted yet" : "Available in Experimental mode")],
      ["Rendering costs", info.renderingCosts.join("; ") || "No terminals open"],
      ["Output timing", info.outputTiming.join("; ") || `Not captured. Start a capture, close Settings, and leave the terminal visible for ${terminalTimingCaptureSeconds} s.`],
    ];
    captureButton.disabled = terminalTimingCaptureTimer !== null;
    grid.replaceChildren();
    for (const [name, value] of items) {
      const term = document.createElement("dt");
      term.textContent = name;
      const description = document.createElement("dd");
      description.textContent = value;
      grid.append(term, description);
    }
    return info;
  };

  const refresh = async () => {
    refreshButton.disabled = true;
    status.textContent = "Checking browser and server…";
    const [, healthResult] = await Promise.allSettled([
      clipboardBridge.check(),
      probeServerHealth(),
    ]);
    if (healthResult.status === "fulfilled") serverConnectionLastHealthy = healthResult.value;
    if (!row.isConnected) return;
    update();
    status.textContent = "Checks updated.";
    refreshButton.disabled = false;
  };

  refreshButton.addEventListener("click", refresh);
  copyButton.addEventListener("click", async () => {
    copyButton.disabled = true;
    const copied = await writeClipboardText(compatibilityDiagnostics(update()));
    if (!row.isConnected) return;
    status.textContent = copied
      ? "Diagnostics copied to the system clipboard."
      : "The browser blocked the system clipboard. Diagnostics are available to Tessera Paste.";
    copyButton.disabled = false;
  });
  actions.append(refreshButton, copyButton, captureButton);
  row.append(grid, actions, status);
  update();
  compatibilityUpdateTimer = window.setInterval(() => {
    if (row.isConnected && !document.hidden) update();
  }, 1000);
  void refresh();
  return row;
}

function renderSettingsClipboardRow() {
  const row = document.createElement("div");
  row.className = "settings-clipboard";
  row.id = "settings-clipboard";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const instructions = document.createElement("p");
  instructions.textContent = "The optional Firefox extension enables text Copy/Paste commands on older Firefox and HTTP connections. After installation, open its toolbar button and enable this Tessera address. Terminal-initiated copying is a separate extension option.";
  const address = document.createElement("code");
  address.textContent = window.location.origin;
  const actions = document.createElement("div");
  actions.className = "settings-clipboard-actions";
  const check = document.createElement("button");
  check.type = "button";
  check.textContent = "Check connection";
  const download = document.createElement("a");
  download.hidden = true;
  const help = document.createElement("a");
  help.href = "/extensions/firefox-clipboard-help.html";
  help.target = "_blank";
  help.rel = "noopener noreferrer";
  help.textContent = "Installation instructions";
  const packageStatus = document.createElement("p");
  packageStatus.textContent = "Checking bundled extension…";
  let bundle = null;
  const update = () => {
    const connected = clipboardBridge.status;
    status.textContent = connected
      ? `Clipboard bridge connected (v${connected.version}). Terminal copying: ${connected.terminal ? "enabled" : "disabled"}.`
      : "Clipboard bridge not connected. Keyboard paste and browser fallbacks remain available.";
    if (bundle) {
      const newer = connected && clipboardBridgeNeedsUpdate(connected.version, bundle.version);
      download.textContent = bundle.signed
        ? `${newer ? "Update" : "Install"} Firefox extension (v${bundle.version})`
        : `Download development extension (v${bundle.version}, unsigned)`;
    }
  };
  check.addEventListener("click", async () => {
    check.disabled = true;
    status.textContent = "Checking clipboard bridge…";
    await clipboardBridge.check();
    if (!row.isConnected) return;
    if (clipboardBridge.status) clipboardSetupPrompt.hidden = true;
    check.disabled = false;
    update();
  });
  void fetch("/extensions/firefox-clipboard.json", { cache: "no-store" })
    .then(response => { if (!response.ok) throw new Error(); return response.json(); })
    .then(info => {
      if (!row.isConnected) return;
      bundle = info;
      download.href = info.signed ? "/extensions/tessera-clipboard.xpi" : "/extensions/tessera-clipboard-dev.zip";
      if (!info.signed) download.download = "tessera-clipboard-dev.zip";
      download.hidden = false;
      packageStatus.textContent = info.signed
        ? "Firefox will ask you to approve installation and clipboard permissions. If prompted, download the file and use Firefox’s Install Add-on From File option."
        : "This build includes an unsigned development package. Extract it and use about:debugging → This Firefox → Load Temporary Add-on → manifest.json. Temporary installation ends when Firefox closes. A Mozilla-signed package is required for normal installation.";
      update();
    })
    .catch(() => { if (row.isConnected) packageStatus.textContent = "The bundled extension is unavailable. See installation instructions."; });
  update();
  actions.append(check, download, help);
  row.append(status, instructions, address, actions, packageStatus);
  return row;
}

async function refreshClipboardBridgeAndPrompt() {
  const checkID = ++clipboardPromptCheckID;
  const connected = await clipboardBridge.check();
  if (checkID !== clipboardPromptCheckID) return;
  if (connected) {
    clipboardSetupPrompt.hidden = true;
    return;
  }

  const recommendation = firefoxClipboardExtensionRecommendation({
    userAgent: navigator.userAgent,
    isSecureContext: window.isSecureContext,
    clipboard: navigator.clipboard,
  });
  if (!recommendation || clipboardPromptDismissed) return;
  try {
    if (Number(window.localStorage.getItem(clipboardPromptSnoozeKey)) > Date.now()) return;
  } catch {
    // Storage may be unavailable in hardened browser profiles.
  }
  clipboardSetupMessage.textContent = recommendation;
  clipboardSetupPrompt.hidden = false;
}

function openHelpModal() {
  hideDeskbar();
  renderHelpModal();
  helpModal.hidden = false;
  window.requestAnimationFrame(() => helpModal.querySelector("button")?.focus());
}

function openBrowserPortHelp(rect = null) {
  hideDeskbar();
  renderBrowserPortHelp(rect?.kind === browserPaneKind ? rect : null);
  helpModal.hidden = false;
  window.requestAnimationFrame(() => helpModal.querySelector(".browser-port-help-address")?.focus());
}

function hideHelpModal() {
  helpModal.hidden = true;
  helpModal.replaceChildren();
}

function renderBrowserPortHelp(targetRect) {
  helpModal.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "settings-panel help-panel browser-port-help-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "browser-port-help-title");

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "browser-port-help-title";
  title.textContent = "Browse a Local Port";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "settings-close";
  closeButton.textContent = "X";
  closeButton.setAttribute("aria-label", "Close local port help");
  closeButton.addEventListener("click", hideHelpModal);
  titleBar.append(title, closeButton);

  const content = document.createElement("div");
  content.className = "settings-content help-content browser-port-help-content";
  const introduction = document.createElement("p");
  introduction.className = "browser-port-help-introduction";
  introduction.textContent = "Open an HTTP development server running on the Tessera host inside a sandboxed Browser pane. Tessera relays it; Tessera does not start the server.";
  content.appendChild(introduction);

  const launchForm = document.createElement("form");
  launchForm.className = "browser-port-help-launch";
  const launchLabel = document.createElement("label");
  launchLabel.htmlFor = "browser-port-help-address";
  launchLabel.textContent = "Local address";
  const address = document.createElement("input");
  address.id = "browser-port-help-address";
  address.className = "browser-port-help-address";
  address.type = "text";
  address.spellcheck = false;
  address.value = browserHelpAddress(targetRect?.browserUrl);
  address.placeholder = "localhost:5000";
  const openButton = document.createElement("button");
  openButton.type = "submit";
  openButton.className = "settings-background-button browser-port-help-open";
  openButton.textContent = "Open in Browser";
  const validation = document.createElement("div");
  validation.className = "browser-port-help-validation";
  validation.setAttribute("role", "alert");
  validation.hidden = true;
  launchForm.append(launchLabel, address, openButton, validation);
  launchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const normalized = normalizeBrowserAddress(address.value);
    if (!normalized) {
      validation.textContent = "Enter a loopback HTTP address such as localhost:5000.";
      validation.hidden = false;
      address.setAttribute("aria-invalid", "true");
      address.focus();
      return;
    }
    validation.hidden = true;
    address.removeAttribute("aria-invalid");
    let destination = targetRect;
    if (!destination || !rectangles.includes(destination) || !destination.browser) {
      const point = paneSpawnPoint();
      destination = createBrowserPane(point.x, point.y);
    }
    hideHelpModal();
    void navigateBrowserPane(destination, normalized);
  });
  content.appendChild(launchForm);

  const quickStart = document.createElement("section");
  quickStart.className = "settings-section";
  const quickStartTitle = document.createElement("h3");
  quickStartTitle.textContent = "Quick start";
  const steps = document.createElement("ol");
  steps.className = "browser-port-help-steps";
  for (const text of [
    "Start an HTTP development server on the same machine as Tessera.",
    "Enter localhost:<port> or an explicit loopback HTTP/HTTPS URL.",
    "Tessera opens it through a temporary path on its existing listener.",
  ]) {
    const step = document.createElement("li");
    step.textContent = text;
    steps.appendChild(step);
  }
  quickStart.append(quickStartTitle, steps);
  content.appendChild(quickStart);

  const examples = document.createElement("section");
  examples.className = "settings-section";
  const examplesTitle = document.createElement("h3");
  examplesTitle.textContent = "Server examples";
  const exampleList = document.createElement("div");
  exampleList.className = "browser-port-help-examples";
  for (const example of browserLocalPortExamples) {
    const row = document.createElement("div");
    row.className = "browser-port-help-example";
    const label = document.createElement("strong");
    label.textContent = example.label;
    const command = document.createElement("code");
    command.textContent = example.command;
    const useButton = document.createElement("button");
    useButton.type = "button";
    useButton.className = "settings-background-button";
    useButton.textContent = `Use ${example.address}`;
    useButton.addEventListener("click", () => {
      address.value = example.address;
      validation.hidden = true;
      address.removeAttribute("aria-invalid");
      address.focus();
    });
    row.append(label, command, useButton);
    exampleList.appendChild(row);
  }
  examples.append(examplesTitle, exampleList);
  content.appendChild(examples);

  content.appendChild(renderHelpSection("Network boundary", [
    ["localhost / 127.0.0.1", "The app remains local to the Tessera host; remote access goes through Tessera's existing listener."],
    ["0.0.0.0", "The development server may already be directly reachable from other machines on the network."],
    ["Additional ports", "Tessera opens no new listening port; it uses a randomized path on its current HTTP address."],
  ]));
  content.appendChild(renderHelpSection("Compatibility notes", [
    ["Usually works", "Relative assets, forms, fetch, XHR, WebSockets, EventSource, and same-origin redirects."],
    ["May need app changes", "Cookie authentication, service workers, strict origin checks, cross-origin redirects, and unusual URL construction."],
  ]));

  panel.append(titleBar, content);
  helpModal.appendChild(panel);
}

function renderHelpModal() {
  helpModal.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "settings-panel help-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "help-title");

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "help-title";
  title.textContent = "Help";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "settings-close";
  closeButton.textContent = "X";
  closeButton.setAttribute("aria-label", "Close help");
  closeButton.addEventListener("click", hideHelpModal);
  titleBar.append(title, closeButton);

  const content = document.createElement("div");
  content.className = "settings-content help-content";
  content.appendChild(renderHelpSection("Window controls", [
    ["Draw a new window", "Left-drag empty desktop space, or middle-drag over any pane. Release to choose the window type; Escape cancels a middle drag."],
    ["Move an OLED window", "Right-click a pane border to arm Move mode, then left-drag the pane."],
    ["Move a standard window", "Drag its title tab."],
    ["Change the active title", "Run Set Window Title... from the command palette."],
  ]));
  content.appendChild(renderHelpSection("Keyboard shortcuts", [
    ["Command palette", "Ctrl/Cmd+K — search or type a code, ↑/↓ to select, Enter to run"],
    ["Command wheel", "Ctrl/Cmd+; — S opens Settings; other commands use two keys, Backspace to go back"],
    ["Window list", "Ctrl/Cmd+L"],
    ["Destroy active window", "Ctrl/Cmd+Backspace"],
    ["Next / previous window", "Ctrl/Cmd+] / Ctrl/Cmd+["],
    ["Move window earlier / later", "Ctrl/Cmd+Shift+↑ / Ctrl/Cmd+Shift+↓"],
    ["Reorder highlighted window in Window List", "Ctrl/Cmd+↑ / Ctrl/Cmd+↓"],
    ["Maximize / restore", "Alt+F10"],
    ["Minimize / restore", "Alt+F9"],
    ["Cascade / restore arrangement", "Alt+F7"],
  ]));

  const commands = buildPaletteCommands();
  assignPaletteShortcutCodes(commands);
  const commandSection = document.createElement("section");
  commandSection.className = "settings-section";
  const commandHeading = document.createElement("h3");
  commandHeading.textContent = "Command palette";
  commandSection.appendChild(commandHeading);
  const commandList = document.createElement("div");
  commandList.className = "help-command-list";
  for (const command of commands) {
    const row = document.createElement("div");
    row.className = "help-command-row";
    const label = document.createElement("span");
    label.textContent = command.label;
    const code = document.createElement("kbd");
    code.textContent = command.code || "—";
    const hint = document.createElement("span");
    hint.textContent = command.hint || "";
    row.append(label, code, hint);
    commandList.appendChild(row);
  }
  commandSection.appendChild(commandList);
  content.appendChild(commandSection);

  panel.append(titleBar, content);
  helpModal.appendChild(panel);
}

function renderHelpSection(titleText, entries) {
  const section = document.createElement("section");
  section.className = "settings-section";
  const title = document.createElement("h3");
  title.textContent = titleText;
  section.appendChild(title);
  const list = document.createElement("div");
  list.className = "help-shortcut-list";
  for (const [labelText, valueText] of entries) {
    const row = document.createElement("div");
    row.className = "help-shortcut-row";
    const label = document.createElement("span");
    label.textContent = labelText;
    const value = document.createElement("span");
    value.textContent = valueText;
    row.append(label, value);
    list.appendChild(row);
  }
  section.appendChild(list);
  return section;
}

function renderSettingsSection(titleText, rows) {
  const section = document.createElement("section");
  section.className = "settings-section";
  const title = document.createElement("h3");
  title.textContent = titleText;
  section.appendChild(title);
  for (const row of rows) {
    section.appendChild(row);
  }
  return section;
}

function renderSettingsPerformanceRow() {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "Profile";
  const detail = document.createElement("span");
  detail.textContent = "Use Older Mac to reduce visual effects and improve responsiveness on slower devices. Saved in this browser; applies immediately.";
  label.append(name, detail);
  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", "Performance profile");
  for (const [value, text] of [["standard", "Standard"], ["older-mac", "Older Mac"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = olderMacMode === (value === "older-mac");
    select.appendChild(option);
  }
  select.addEventListener("change", () => setOlderMacMode(select.value === "older-mac"));
  row.append(label, select);
  return row;
}

function renderSettingsTerminalBacklogRow() {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "Terminal output backlog";
  const detail = document.createElement("span");
  detail.textContent = "Caps output waiting to be processed per terminal. Auto uses the server's budget (normally 4 MiB). A full queue catches up automatically while commands keep running. Saved in this browser; applies immediately.";
  label.append(name, detail);
  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", "Terminal output backlog");
  for (const value of ["auto", "8", "16", "32"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "auto" ? "Auto" : `${value} MiB`;
    option.selected = terminalBacklogLimit === value;
    select.appendChild(option);
  }
  select.addEventListener("change", () => setTerminalBacklogLimit(select.value));
  row.append(label, select);
  return row;
}

function renderSettingsExperimentalRendererRow() {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "Terminal renderer";
  const detail = document.createElement("span");
  detail.textContent = "Experimental is the default hybrid, color-aware ASCII fast path. Stable uses Ghostty's original renderer. Saved in this browser; applies immediately.";
  label.append(name, detail);
  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", "Terminal renderer");
  for (const [value, text] of [["stable", "Stable"], ["experimental", "Experimental"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = experimentalTerminalRenderer === (value === "experimental");
    select.appendChild(option);
  }
  select.addEventListener("change", () => setExperimentalTerminalRenderer(select.value === "experimental"));
  row.append(label, select);
  return row;
}

function renderSettingsToggleRow(nameText, description, enabled, onChange) {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = nameText;
  const detail = document.createElement("span");
  detail.textContent = description;
  label.append(name, detail);
  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", nameText);
  for (const [value, text] of [["off", "Off"], ["on", "On"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = enabled === (value === "on");
    select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value === "on"));
  row.append(label, select);
  return row;
}

function renderSettingsFontRow(labelText, description, value, onChange, disabled = false) {
  const row = document.createElement("div");
  row.className = "settings-row";
  const label = document.createElement("div");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = labelText;
  const detail = document.createElement("span");
  detail.textContent = description;
  label.append(name, detail);

  const control = document.createElement("div");
  control.className = "settings-font-control";
  const decreaseButton = document.createElement("button");
  decreaseButton.type = "button";
  decreaseButton.textContent = "A−";
  decreaseButton.setAttribute("aria-label", `Decrease ${labelText.toLowerCase()} font size`);
  const size = document.createElement("output");
  size.textContent = disabled ? "—" : `${value}px`;
  const increaseButton = document.createElement("button");
  increaseButton.type = "button";
  increaseButton.textContent = "A+";
  increaseButton.setAttribute("aria-label", `Increase ${labelText.toLowerCase()} font size`);
  decreaseButton.disabled = disabled || value <= minimumPaneFontSize;
  increaseButton.disabled = disabled || value >= maximumPaneFontSize;
  decreaseButton.addEventListener("click", () => onChange(value - 1));
  increaseButton.addEventListener("click", () => onChange(value + 1));
  control.append(decreaseButton, size, increaseButton);
  row.append(label, control);
  return row;
}

function renderCurrentPaneFontRow() {
  const active = getActivePane();
  if (!active || (active.kind !== "terminal")) {
    return renderSettingsFontRow("Current", "Select a terminal pane to adjust its font.", defaultPaneFontSize, () => {}, true);
  }
  return renderSettingsFontRow("Current", `${active.title} only. This value saves with the pane.`, active.fontSize, (next) => {
    setPaneFontSize(active, next);
    renderSettingsModal();
  });
}

function renderSettingsThemeRow(labelText, description, value, onChange) {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = labelText;
  const detail = document.createElement("span");
  detail.textContent = description;
  label.append(name, detail);
  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", `${labelText} theme`);
  for (const [id, theme] of Object.entries(themes)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = theme.label;
    option.selected = id === value;
    select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  row.append(label, select);
  return row;
}

function renderSettingsOLEDWindowBorderRow() {
  const row = document.createElement("div");
  row.className = "settings-row";
  const label = document.createElement("div");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "OLED border";
  const detail = document.createElement("span");
  detail.textContent = "Window border size used by the OLED Terminal theme.";
  label.append(name, detail);

  const control = document.createElement("div");
  control.className = "settings-font-control";
  const decreaseButton = document.createElement("button");
  decreaseButton.type = "button";
  decreaseButton.textContent = "−";
  decreaseButton.setAttribute("aria-label", "Decrease OLED window border size");
  decreaseButton.disabled = oledWindowBorderSize <= minimumOLEDBorderSize;
  decreaseButton.addEventListener("click", () => {
    setOLEDWindowBorderSize(oledWindowBorderSize - 1);
    renderSettingsModal();
  });
  const size = document.createElement("output");
  size.textContent = `${oledWindowBorderSize}px`;
  const increaseButton = document.createElement("button");
  increaseButton.type = "button";
  increaseButton.textContent = "+";
  increaseButton.setAttribute("aria-label", "Increase OLED window border size");
  increaseButton.disabled = oledWindowBorderSize >= maximumOLEDBorderSize;
  increaseButton.addEventListener("click", () => {
    setOLEDWindowBorderSize(oledWindowBorderSize + 1);
    renderSettingsModal();
  });
  control.append(decreaseButton, size, increaseButton);
  row.append(label, control);
  return row;
}

function renderSettingsWheelRow(labelText, description, value, onChange) {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = labelText;
  const detail = document.createElement("span");
  detail.textContent = description;
  label.append(name, detail);

  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", `${labelText} wheel speed`);
  for (const multiplier of wheelSensitivityOptions) {
    const option = document.createElement("option");
    option.value = String(multiplier);
    option.textContent = multiplier === 1 ? "1.0×" : `${multiplier}×`;
    option.selected = multiplier === value;
    select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  row.append(label, select);
  return row;
}

function renderSettingsTerminalTERMRow() {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "TERM";
  const detail = document.createElement("span");
  detail.textContent = "Terminal capability name used by new terminal sessions. Existing terminals keep their current value.";
  label.append(name, detail);

  const input = document.createElement("input");
  input.className = "settings-text-input";
  input.type = "text";
  input.maxLength = 64;
  input.spellcheck = false;
  input.autocapitalize = "none";
  input.setAttribute("aria-label", "Terminal TERM value");
  input.value = terminalTerm;
  input.addEventListener("change", () => {
    setTerminalTERM(input.value);
    input.value = terminalTerm;
  });
  row.append(label, input);
  return row;
}

function renderSettingsTerminalFontRow() {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "Font";
  const detail = document.createElement("span");
  detail.textContent = "Font used by terminal panes. Changes apply to open terminals immediately.";
  label.append(name, detail);

  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", "Terminal font");
  for (const [id, font] of Object.entries(terminalFonts)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = font.label;
    option.selected = id === terminalFont;
    select.appendChild(option);
  }
  select.addEventListener("change", () => void setTerminalFont(select.value));
  row.append(label, select);
  return row;
}

function renderSettingsTerminalRowSpacingRow() {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "Row spacing";
  const detail = document.createElement("span");
  detail.textContent = "Tight is the default. Comfortable adds space above and below text. Changes apply to open terminals immediately.";
  label.append(name, detail);

  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", "Terminal row spacing");
  for (const [id, spacing] of Object.entries(terminalRowSpacings)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = spacing.label;
    option.selected = id === terminalRowSpacing;
    select.appendChild(option);
  }
  select.addEventListener("change", () => setTerminalRowSpacing(select.value));
  row.append(label, select);
  return row;
}

function renderSettingsTerminalColorModeRow() {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "Colors";
  const detail = document.createElement("span");
  detail.textContent = "Neutral xterm colors, independent of the workspace theme.";
  label.append(name, detail);

  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", "Terminal color mode");
  for (const [id, mode] of Object.entries(terminalColorModes)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = mode.label;
    option.selected = id === terminalColorMode;
    select.appendChild(option);
  }
  select.addEventListener("change", () => void setTerminalColorMode(select.value));
  row.append(label, select);
  return row;
}

function renderSettingsBackgroundRow() {
  const row = document.createElement("div");
  row.className = "settings-row";
  const label = document.createElement("div");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "Board image";
  const detail = document.createElement("span");
  detail.textContent = workspaceHasBackground
    ? "Shown behind this workspace's panes. New sessions start with a copy of it."
    : "None set. Sessions created from here will also start without one.";
  label.append(name, detail);

  const control = document.createElement("div");
  control.className = "settings-background-control";
  const setButton = document.createElement("button");
  setButton.type = "button";
  setButton.className = "settings-background-button";
  setButton.textContent = workspaceHasBackground ? "Change..." : "Set...";
  setButton.addEventListener("click", () => backgroundFileInput.click());
  control.appendChild(setButton);

  if (workspaceHasBackground) {
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "settings-background-button";
    clearButton.textContent = "Clear";
    clearButton.addEventListener("click", () => void clearBackground());
    control.appendChild(clearButton);
  }

  row.append(label, control);
  return row;
}

function renderSettingsBackgroundModeRow() {
  const row = document.createElement("label");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  const name = document.createElement("strong");
  name.textContent = "Display";
  const detail = document.createElement("span");
  detail.textContent = workspaceHasBackground
    ? "Fill crops, Fit preserves the full image, Stretch fills both dimensions, Center keeps natural size."
    : "Set a board image to choose how it is displayed.";
  label.append(name, detail);

  const select = document.createElement("select");
  select.className = "settings-theme-select";
  select.setAttribute("aria-label", "Background display mode");
  select.disabled = !workspaceHasBackground;
  for (const [id, mode] of Object.entries(backgroundDisplayModes)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = mode.label;
    option.selected = id === workspaceBackgroundMode;
    select.appendChild(option);
  }
  select.addEventListener("change", () => setWorkspaceBackgroundMode(select.value));
  row.append(label, select);
  return row;
}

let paletteEntries = [];
let paletteSelection = 0;
let windowListEntries = [];
let windowListSelection = 0;
let windowListDrag = null;
let windowSwitcherHideTimer = null;

function toggleCommandPalette() {
  if (commandPalette.hidden) {
    openCommandPalette();
  } else {
    hideCommandPalette();
  }
}

function toggleCommandWheel() {
  if (commandWheel.hidden) openCommandWheel();
  else hideCommandWheel();
}

function openCommandWheel() {
  if (!userSelect.hidden) return;
  hideAllMenus();
  const commands = buildPaletteCommands();
  assignPaletteShortcutCodes(commands);
  commandWheelUI.open(commands);
}

function hideCommandWheel() {
  const restorePaneFocus = !commandWheel.hidden && commandWheel.contains(document.activeElement);
  commandWheel.hidden = true;
  if (restorePaneFocus) restorePaneFocusAfterOverlayDismiss(commandWheel);
}

function containCommandWheelFocus(event) {
  if (!commandWheel.hidden && !commandWheel.contains(event.target)) {
    commandWheelUI.panel.focus({ preventScroll: true });
  }
}

function openCommandPalette() {
  if (!userSelect.hidden) {
    return;
  }
  hideAllMenus();
  commandPalette.hidden = false;
  commandPaletteInput.value = "";
  renderPaletteResults();
  commandPaletteInput.focus();
}

function hideCommandPalette() {
  const restorePaneFocus = !commandPalette.hidden && commandPalette.contains(document.activeElement);
  commandPalette.hidden = true;
  if (restorePaneFocus) {
    restorePaneFocusAfterOverlayDismiss(commandPalette);
  }
}

function toggleWindowList() {
  if (windowList.hidden) {
    openWindowList();
  } else {
    hideWindowList();
  }
}

function openWindowList() {
  if (!userSelect.hidden) {
    return;
  }
  hideAllMenus();
  windowList.hidden = false;
  windowListStatus.textContent = "";
  renderWindowList(activePaneID);
  window.requestAnimationFrame(() => {
    if (!windowList.hidden) windowListPanel.focus();
  });
}

function hideWindowList() {
  clearWindowListDrag();
  const restorePaneFocus = !windowList.hidden && windowList.contains(document.activeElement);
  windowList.hidden = true;
  if (restorePaneFocus) {
    restorePaneFocusAfterOverlayDismiss(windowList);
  }
}

function restorePaneFocusAfterOverlayDismiss(overlay) {
  window.requestAnimationFrame(() => {
    // One overlay can hand off to another in the same tick (running Window
    // List from the command palette). The overlay that is still open owns
    // keyboard focus, so returning it to the pane would swallow its arrow keys.
    if ([commandPalette, commandWheel, windowList, settingsModal, localHTTPSModal,
      renameWindowModal, sessionsModal, sessionActionModal, helpModal, shortcutsUI.element].some(modal => !modal.hidden)) {
      return;
    }
    const focused = document.activeElement;
    if (overlay.hidden && (overlay.contains(focused) || focused === document.body)) {
      focusPane(getActivePane());
    }
  });
}

function showWindowSwitcher(options = {}) {
  const entries = windowSwitcherEntries(rectangles, activePaneID, options);
  if (entries.length === 0) {
    hideWindowSwitcher();
    return;
  }

  windowSwitcherList.replaceChildren();
  let activeRow = null;
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "window-switcher-item";
    if (entry.active) {
      row.classList.add("is-selected");
      activeRow = row;
      windowSwitcherPosition.textContent = `${entry.position} of ${entry.total}`;
    }
    const order = document.createElement("span");
    order.className = "window-switcher-order";
    order.textContent = String(entry.position);
    const name = document.createElement("span");
    name.className = "window-switcher-name";
    name.textContent = `${entry.name}${entry.pane.minimized ? " (minimized)" : ""}`;
    row.append(order, name);
    windowSwitcherList.appendChild(row);
  }

  windowSwitcher.hidden = false;
  window.clearTimeout(windowSwitcherHideTimer);
  windowSwitcherHideTimer = window.setTimeout(hideWindowSwitcher, 1200);
  activeRow?.scrollIntoView({ block: "nearest" });
}

function hideWindowSwitcher() {
  window.clearTimeout(windowSwitcherHideTimer);
  windowSwitcherHideTimer = null;
  windowSwitcher.hidden = true;
}

function handleWindowSwitcherKeyup(event) {
  if (event.key === "Control" || event.key === "Meta") {
    hideWindowSwitcher();
  }
}

function renderWindowList(selectedPaneID = windowListEntries[windowListSelection]?.id || activePaneID) {
  clearWindowListDrag();
  const focused = windowListItems.contains(document.activeElement) ? document.activeElement : null;
  const focusedPaneID = focused?.closest(".window-list-item")?.dataset.paneId;
  const focusedAction = focused?.dataset.windowListAction;
  windowListEntries = rectangles.filter((rect) => rect.kind !== "pending");
  const selectedIndex = windowListEntries.findIndex((rect) => rect.id === selectedPaneID);
  const activeIndex = windowListEntries.findIndex((rect) => rect.id === activePaneID);
  windowListSelection = selectedIndex >= 0 ? selectedIndex : Math.max(0, activeIndex);
  windowListItems.replaceChildren();

  if (windowListEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-palette-empty";
    empty.textContent = "No windows";
    windowListItems.appendChild(empty);
    return;
  }

  windowListEntries.forEach((rect, index) => {
    const row = document.createElement("div");
    row.className = "command-palette-item window-list-item";
    row.dataset.paneId = rect.id;
    row.addEventListener("pointerdown", (event) => startWindowListDrag(event, rect));
    row.addEventListener("click", (event) => {
      if (row.dataset.suppressClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    const grip = document.createElement("span");
    grip.className = "window-list-grip";
    grip.textContent = "⠿";
    grip.title = "Drag to reorder window";
    grip.setAttribute("aria-hidden", "true");
    const name = document.createElement("button");
    name.type = "button";
    name.className = "window-list-name";
    name.dataset.windowListAction = "focus";
    name.textContent = `${index + 1}. ${workspaceMenuLabel(rect)}${rect.minimized ? " (minimized)" : ""}`;
    name.title = rect.minimized ? "Drag to reorder, or click to restore and focus" : "Drag to reorder, or click to focus";
    name.setAttribute("aria-label", name.textContent);
    name.addEventListener("click", () => selectWindowListEntry(index));
    const actions = document.createElement("div");
    actions.className = "window-list-actions";
    for (const [direction, text, action] of [[-1, "↑", "up"], [1, "↓", "down"]]) {
      const move = document.createElement("button");
      move.type = "button";
      move.className = "window-list-move";
      move.dataset.windowListAction = action;
      move.textContent = text;
      move.title = `Move ${action} in window order`;
      move.setAttribute("aria-label", `Move ${workspaceMenuLabel(rect)} ${action}`);
      move.disabled = direction < 0 ? index === 0 : index === windowListEntries.length - 1;
      move.addEventListener("click", () => {
        setWindowListSelection(index);
        moveWindowInOrder(rect, direction);
      });
      actions.appendChild(move);
    }
    row.addEventListener("pointermove", () => {
      if (!windowListDrag) setWindowListSelection(index);
    });
    row.addEventListener("focusin", () => setWindowListSelection(index));
    row.append(grip, name, actions);
    windowListItems.appendChild(row);
  });
  setWindowListSelection(windowListSelection);
  if (focusedPaneID) {
    const row = [...windowListItems.querySelectorAll(".window-list-item")].find(row => row.dataset.paneId === focusedPaneID);
    const control = row?.querySelector(`[data-window-list-action="${focusedAction}"]`);
    (control && !control.disabled ? control : row?.querySelector(".window-list-name") || windowListPanel).focus({ preventScroll: true });
  }
}

function moveWindowInOrder(rect, direction, options = {}) {
  const moved = moveWindowPane(rectangles, rect, direction);
  return finishWindowOrderMove(rect, moved, options);
}

function finishWindowOrderMove(rect, moved, options = {}) {
  if (moved) {
    updateDeskbar();
    scheduleWorkspaceSave();
    if (!windowList.hidden) {
      const index = windowListEntries.indexOf(rect);
      windowListStatus.textContent = `${workspaceMenuLabel(rect)} moved to ${index + 1} of ${windowListEntries.length}.`;
    }
  }
  if (rect && rect.kind !== "pending" && options.showSwitcher) showWindowSwitcher({ includeMinimized: true });
  return moved;
}

function startWindowListDrag(event, rect) {
  if (event.button !== 0 || !event.isPrimary || event.target.closest(".window-list-actions")
    || !windowListEntries.includes(rect)) return;
  clearWindowListDrag();
  windowListDrag = { paneID: rect.id, beforePaneID: null, valid: false, started: false,
    pointerID: event.pointerId, startX: event.clientX, startY: event.clientY,
    clientX: event.clientX, clientY: event.clientY, row: event.currentTarget, scrollFrame: null };
}

function clearWindowListDropIndicator() {
  if (windowListDrag) windowListDrag.valid = false;
  windowListItems.querySelectorAll(".window-list-item").forEach(row => {
    row.classList.remove("is-drop-before", "is-drop-after");
  });
}

function clearWindowListDrag() {
  if (windowListDrag) {
    const { pointerID, scrollFrame, row, started } = windowListDrag;
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    if (windowListItems.hasPointerCapture(pointerID)) windowListItems.releasePointerCapture(pointerID);
    if (started) {
      // The following click must not open the window after a drag or cancel.
      row.dataset.suppressClick = "true";
      setTimeout(() => delete row.dataset.suppressClick, 0);
    }
  }
  clearWindowListDropIndicator();
  windowListItems.querySelectorAll(".is-dragging").forEach(row => row.classList.remove("is-dragging"));
  windowListItems.classList.remove("is-reordering");
  windowListDrag = null;
}

function updateWindowListDrop(event) {
  if (!windowListDrag || windowList.hidden || event.pointerId !== windowListDrag.pointerID) return;
  if (windowListDrag.canceled) return;
  if (!windowListDrag.started) {
    if (Math.hypot(event.clientX - windowListDrag.startX, event.clientY - windowListDrag.startY) < 5) return;
    windowListDrag.started = true;
    setWindowListSelection(windowListEntries.findIndex(pane => pane.id === windowListDrag.paneID));
    windowListItems.setPointerCapture(event.pointerId);
    windowListDrag.row.classList.add("is-dragging");
    windowListItems.classList.add("is-reordering");
  }
  event.preventDefault();
  windowListDrag.clientX = event.clientX;
  windowListDrag.clientY = event.clientY;
  updateWindowListDropIndicator();
  if (windowListDrag.scrollFrame === null) windowListDrag.scrollFrame = requestAnimationFrame(scrollWindowListDrag);
}

function updateWindowListDropIndicator() {
  clearWindowListDropIndicator();
  const { clientX, clientY } = windowListDrag;
  const listBounds = windowListItems.getBoundingClientRect();
  if (clientX < listBounds.left || clientX > listBounds.right || clientY < listBounds.top || clientY > listBounds.bottom) return;
  const rows = [...windowListItems.querySelectorAll(".window-list-item")];
  const before = rows.find(row => {
    const bounds = row.getBoundingClientRect();
    return clientY < bounds.top + bounds.height / 2;
  });
  windowListDrag.beforePaneID = before?.dataset.paneId || null;
  windowListDrag.valid = rows.length > 0;
  if (before) before.classList.add("is-drop-before");
  else rows.at(-1)?.classList.add("is-drop-after");
}

function scrollWindowListDrag() {
  if (!windowListDrag) return;
  windowListDrag.scrollFrame = null;
  if (!windowListDrag.valid) return;
  const bounds = windowListItems.getBoundingClientRect();
  const y = windowListDrag.clientY;
  const amount = y < bounds.top + 24 ? -6 : y > bounds.bottom - 24 ? 6 : 0;
  const previous = windowListItems.scrollTop;
  windowListItems.scrollTop += amount;
  if (windowListItems.scrollTop !== previous) {
    updateWindowListDropIndicator();
    windowListDrag.scrollFrame = requestAnimationFrame(scrollWindowListDrag);
  }
}

function dropWindowListEntry(event) {
  if (!windowListDrag || event.pointerId !== windowListDrag.pointerID) return;
  const started = windowListDrag.started;
  if (started && !windowListDrag.canceled) {
    event.preventDefault();
    windowListDrag.clientX = event.clientX;
    windowListDrag.clientY = event.clientY;
    updateWindowListDropIndicator();
  }
  const { paneID, beforePaneID, valid } = windowListDrag;
  clearWindowListDrag();
  if (!started || !valid || windowList.hidden) return;
  const rect = rectangles.find(pane => pane.id === paneID);
  const before = beforePaneID === null ? null : rectangles.find(pane => pane.id === beforePaneID);
  finishWindowOrderMove(rect, placeWindowPaneBefore(rectangles, rect, before));
  const row = [...windowListItems.querySelectorAll(".window-list-item")].find(row => row.dataset.paneId === paneID);
  row?.querySelector(".window-list-name")?.focus({ preventScroll: true });
}

function containWindowListFocus(event) {
  if (!windowList.hidden && commandPalette.hidden
    && ![...document.querySelectorAll(".settings-modal")].some(modal => !modal.hidden)
    && !windowList.contains(event.target)) windowListPanel.focus();
}

function setWindowListSelection(index) {
  if (windowListEntries.length === 0) {
    return;
  }
  windowListSelection = (index + windowListEntries.length) % windowListEntries.length;
  const rows = windowListItems.querySelectorAll(".window-list-item");
  rows.forEach((row, rowIndex) => row.classList.toggle("is-selected", rowIndex === windowListSelection));
  rows[windowListSelection]?.scrollIntoView({ block: "nearest" });
}

function selectWindowListEntry(index = windowListSelection) {
  const rect = windowListEntries[index];
  if (!rect) {
    return;
  }
  hideWindowList();
  setMinimized(rect, false);
  setActivePane(rect, { raise: true, focus: true });
}

function handleWindowListKeyboard(event) {
  if (event.defaultPrevented) return;
  if (windowListDrag?.started) {
    if (event.key === "Escape") {
      windowListDrag.canceled = true;
      clearWindowListDropIndicator();
      windowListItems.querySelectorAll(".is-dragging").forEach(row => row.classList.remove("is-dragging"));
      windowListItems.classList.remove("is-reordering");
    }
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const controls = [...windowListPanel.querySelectorAll("button:not(:disabled)")];
    const current = controls.indexOf(document.activeElement);
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
      moveWindowInOrder(windowListEntries[windowListSelection], direction);
    } else {
      setWindowListSelection(windowListSelection + direction);
      windowListItems.querySelectorAll(".window-list-name")[windowListSelection]?.focus();
    }
    return;
  }
  if ((event.key === "Enter" || event.key === " ") && event.target === windowListPanel) {
    event.preventDefault();
    selectWindowListEntry();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    hideWindowList();
  }
}

function startServerConnectionMonitor() {
  if (serverHealthMonitorTimer !== null) {
    return;
  }
  window.addEventListener("offline", handleBrowserOffline);
  window.addEventListener("online", handleBrowserOnline);
  void checkServerConnection();
  scheduleServerHealthPolling();
}

function scheduleServerHealthPolling() {
  window.clearInterval(serverHealthMonitorTimer);
  serverHealthMonitorTimer = window.setInterval(() => {
    checkForBrowserWake();
    void checkServerConnection();
  }, document.hidden ? 30000 : serverHealthPollInterval);
}

function handleBrowserOffline() {
  if (serverUpdateRestarting) {
    return;
  }
  markWorkspaceDisconnected();
  serverConnectionState = nextServerConnectionState(serverConnectionState, {
    healthy: false,
    online: false,
    force: true,
  });
  showServerConnectionModal(serverConnectionState.state);
}

function handleBrowserOnline() {
  if (serverUpdateRestarting) {
    return;
  }
  if (!serverConnectionModal.hidden) {
    showServerConnectionModal("checking");
  }
  checkForBrowserWake();
  // The panes do not wait for the probe to confirm what the browser just
  // said; a failed attempt costs one round trip and reschedules itself.
  resumeTerminalConnections();
  void checkServerConnection({ force: true });
}

async function probeServerHealth() {
  if (!serverHealthProbe) {
    const probe = (async () => {
      try {
        const response = await fetch("/api/health", {
          signal: AbortSignal.timeout(2000),
          cache: "no-store",
        });
        return response.ok;
      } catch {
        return false;
      }
    })();
    serverHealthProbe = probe;
    probe.finally(() => {
      if (serverHealthProbe === probe) {
        serverHealthProbe = null;
      }
    });
  }
  return serverHealthProbe;
}

async function checkServerConnection({ manual = false, force = false } = {}) {
  if (serverUpdateRestarting) {
    return false;
  }
  if (manual) {
    showServerConnectionModal("checking");
  }
  const previousState = serverConnectionState.state;
  const healthy = await probeServerHealth();
  serverConnectionLastHealthy = healthy;
  if (serverUpdateRestarting) {
    return healthy;
  }
  if (healthy && wakeRecoveryActive) {
    wakeRecoveryHealthReady = true;
    updateWakeRecoveryStatus();
  }
  // The probe reaches the server over the same network the terminal sockets
  // use, so an answer after a spell of trouble is the earliest evidence a
  // waiting pane could act on. Only the recovery is interesting: healthy
  // polls during ordinary operation move nothing.
  if (healthy && previousState) {
    resumeTerminalConnections();
  }
  serverConnectionState = nextServerConnectionState(serverConnectionState, {
    healthy,
    online: navigator.onLine !== false,
    force,
  });

  if (!healthy && serverConnectionState.state) {
    markWorkspaceDisconnected();
  }
  if (healthy && workspaceNeedsRevalidation) {
    const current = await revalidateWorkspaceRevision();
    if (!current) {
      return true;
    }
  }
  if (workspaceSaveSuspended) {
    return healthy;
  }
  if (healthy && manual) {
    showServerConnectionModal("restored", { reloading: true });
    window.setTimeout(() => window.location.reload(), 250);
    return true;
  }
  if (serverConnectionState.state && (manual || force || serverConnectionModal.hidden || serverConnectionState.state !== previousState)) {
    showServerConnectionModal(serverConnectionState.state);
  }
  return healthy;
}

function showServerConnectionModal(state, { reloading = false } = {}) {
  if (serverUpdateRestarting || workspaceSaveSuspended) {
    return;
  }
  serverConnectionModal.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "settings-panel server-connection-panel";
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "server-connection-title");
  panel.setAttribute("aria-describedby", "server-connection-status");
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const controls = [...panel.querySelectorAll("button:not(:disabled)")];
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }
    const current = controls.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (current <= 0 ? controls.length - 1 : current - 1)
      : (current < 0 || current === controls.length - 1 ? 0 : current + 1);
    event.preventDefault();
    controls[next].focus();
  });

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "server-connection-title";
  title.textContent = state === "restored" ? "Connection Restored" : "Connection Lost";
  titleBar.appendChild(title);

  const content = document.createElement("div");
  content.className = "settings-content server-connection-content";
  const status = document.createElement("p");
  status.id = "server-connection-status";
  status.className = "server-connection-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "assertive");
  if (state === "offline") {
    status.textContent = "This device appears to be offline. Restore its network connection, then reconnect to Tessera.";
  } else if (state === "checking") {
    status.classList.add("is-busy");
    status.textContent = "Checking the Tessera server...";
  } else if (state === "restored") {
    status.textContent = reloading
      ? "The Tessera server is available again. Reloading this workspace..."
      : "The Tessera server is available again. Reload to reconnect terminals, streams, and workspace state.";
  } else {
    status.textContent = "The Tessera server is not responding. It may be stopped, restarting, or unreachable from this device.";
  }

  const actions = document.createElement("div");
  actions.className = "rename-window-actions server-connection-actions";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "settings-background-button";
  refreshButton.textContent = "Refresh Page";
  refreshButton.addEventListener("click", () => window.location.reload());

  const primaryButton = document.createElement("button");
  primaryButton.type = "button";
  primaryButton.className = "settings-background-button server-connection-primary";
  if (state === "restored") {
    primaryButton.textContent = reloading ? "Reloading..." : "Reload Tessera";
    primaryButton.disabled = reloading;
    if (!reloading) {
      primaryButton.addEventListener("click", () => window.location.reload());
    }
  } else if (state === "checking") {
    primaryButton.textContent = "Checking...";
    primaryButton.disabled = true;
  } else {
    primaryButton.textContent = "Reconnect";
    primaryButton.addEventListener("click", () => void checkServerConnection({ manual: true, force: true }));
  }

  actions.append(refreshButton, primaryButton);
  content.append(status, actions);
  panel.append(titleBar, content);
  serverConnectionModal.appendChild(panel);
  serverConnectionModal.hidden = false;
  window.requestAnimationFrame(() => (primaryButton.disabled ? refreshButton : primaryButton).focus());
}

function hideServerConnectionModal() {
  serverConnectionModal.hidden = true;
  serverConnectionModal.replaceChildren();
}

// Shows the server-update status modal with a message. Closable steps get a
// Close button and backdrop dismissal; in-flight steps (download, restart)
// keep the modal locked so the flow isn't abandoned half-way.
function showUpdateStatus(message, { closable = false, busy = false } = {}) {
  serverUpdateModal.replaceChildren();
  serverUpdateModal.dataset.closable = String(closable);

  const panel = document.createElement("section");
  panel.className = "settings-panel server-update-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "server-update-title");

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "server-update-title";
  title.textContent = "Update Server";
  titleBar.appendChild(title);

  const content = document.createElement("div");
  content.className = "settings-content server-update-content";
  const status = document.createElement("p");
  status.className = "server-update-status";
  if (busy) {
    status.classList.add("is-busy");
  }
  status.textContent = message;
  content.appendChild(status);

  if (closable) {
    const actions = document.createElement("div");
    actions.className = "rename-window-actions";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "settings-background-button";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", hideServerUpdateModal);
    actions.appendChild(closeButton);
    content.appendChild(actions);
    window.requestAnimationFrame(() => closeButton.focus());
  }

  panel.append(titleBar, content);
  serverUpdateModal.appendChild(panel);
  serverUpdateModal.hidden = false;
}

function hideServerUpdateModal() {
  serverUpdateModal.hidden = true;
  serverUpdateModal.replaceChildren();
}

function showSystemdUpdatePrompt(check) {
  serverUpdateModal.replaceChildren();
  serverUpdateModal.dataset.closable = "true";

  const panel = document.createElement("section");
  panel.className = "settings-panel server-update-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "server-update-title");

  const titleBar = document.createElement("div");
  titleBar.className = "settings-title";
  const title = document.createElement("h2");
  title.id = "server-update-title";
  title.textContent = "Update Server";
  titleBar.appendChild(title);

  const content = document.createElement("div");
  content.className = "settings-content server-update-content";
  const status = document.createElement("p");
  status.className = "server-update-status";
  status.textContent = `Tessera ${check.latestVersion} is available. This systemd installation needs sudo authorization in a Terminal.`;

  const actions = document.createElement("div");
  actions.className = "rename-window-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "settings-background-button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", hideServerUpdateModal);
  const terminalButton = document.createElement("button");
  terminalButton.type = "button";
  terminalButton.textContent = "Open Update Terminal";
  terminalButton.addEventListener("click", () => {
    const point = paneSpawnPoint();
    createTerminalPane(point.x, point.y, {
      title: "Update Tessera",
      terminalStartupCommand: check.updateCommand,
    });
    hideServerUpdateModal();
    hideServerConnectionModal();
    serverUpdateRestarting = true;
    void waitForUpdatedServer(check, {
      timeoutMs: 5 * 60 * 1000,
      timeoutMessage: "The service update did not complete within five minutes. Inspect the Update Tessera terminal or the systemd journal.",
    });
  });
  actions.append(cancelButton, terminalButton);
  content.append(status, actions);
  panel.append(titleBar, content);
  serverUpdateModal.appendChild(panel);
  serverUpdateModal.hidden = false;
  window.requestAnimationFrame(() => terminalButton.focus());
}

async function waitForUpdatedServer(check, { timeoutMs = 60000, timeoutMessage = "The server did not come back within a minute. Use Reconnect once it is running." } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastHealth = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const cacheBuster = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await fetch(`/api/health?update=${encodeURIComponent(cacheBuster)}`, {
        signal: AbortSignal.timeout(2000),
        cache: "no-store",
      });
      if (!response.ok) {
        continue;
      }
      const health = await response.json();
      lastHealth = health;
      // The old process can answer while graceful shutdown is still in
      // progress. Do not reload until the replacement identifies itself.
      if (!isExpectedServerVersion(health, check.latestVersion)) {
        continue;
      }
      serverUpdateRestarting = false;
      serverConnectionState = { failures: 0, state: "" };
      showUpdateStatus(`Updated to ${health.version || check.latestVersion} — reloading...`, { busy: true });
      window.setTimeout(() => window.location.reload(), 800);
      // If navigation is blocked or stalls, restore an actionable client UI
      // instead of leaving the locked update dialog on screen indefinitely.
      window.setTimeout(() => {
        hideServerUpdateModal();
        showServerConnectionModal("restored");
      }, 5000);
      return;
    } catch {
      // Server still restarting; keep polling.
    }
  }
  serverUpdateRestarting = false;
  if (lastHealth && !isExpectedServerVersion(lastHealth, check.currentVersion)) {
    showUpdateStatus(
      `The server restarted as ${lastHealth.version || "an unknown version"}; expected ${check.latestVersion}.`,
      { closable: true },
    );
  } else {
    showUpdateStatus(timeoutMessage, { closable: true });
  }
  await checkServerConnection({ force: true });
}

// Checks GitHub for a newer release via the server, chooses the direct or
// systemd-owned install path, and waits for the expected version before reload.
async function runServerUpdate() {
  if (window.__tesseraDesktop === true) return;
  showUpdateStatus("Checking for updates...", { busy: true });
  let check;
  try {
    const response = await fetch("/api/update");
    const body = await response.json();
    if (!response.ok) {
      showUpdateStatus(`Update check failed: ${body.error || response.status}`, { closable: true });
      return;
    }
    check = body;
  } catch (error) {
    showUpdateStatus(`Update check failed: ${error.message}`, { closable: true });
    return;
  }
  if (!check.updateAvailable) {
    showUpdateStatus(`Tessera is up to date (${check.currentVersion}).`, { closable: true });
    return;
  }

  if (isSystemdUpdateCheck(check)) {
    showSystemdUpdatePrompt(check);
    return;
  }

  showUpdateStatus(`Updating ${check.currentVersion} → ${check.latestVersion} — downloading...`, { busy: true });
  let updatePostError = null;
  try {
    const response = await fetch("/api/update", { method: "POST" });
    const body = await response.json();
    if (!response.ok) {
      showUpdateStatus(`Update failed: ${body.error || response.status}`, { closable: true });
      return;
    }
    if (body.status !== "restarting") {
      showUpdateStatus(`Tessera is up to date (${body.currentVersion}).`, { closable: true });
      return;
    }
    serverUpdateRestarting = true;
    hideServerConnectionModal();
  } catch (error) {
    // Shutdown can close the request after installation but before the JSON
    // acknowledgement arrives. The new server version is authoritative.
    updatePostError = error;
    serverUpdateRestarting = true;
    hideServerConnectionModal();
  }

  showUpdateStatus(updatePostError
    ? "The update connection closed. Waiting for the updated server..."
    : "Restarting server...", { busy: true });
  await waitForUpdatedServer(check);
}

// Every action the workspace menu offers, flattened into searchable commands,
// plus jump-to-window entries (which also restore minimized panes).
function buildPaletteCommands() {
  const commands = [];
  commands.push({ id: "command-wheel", label: "Command Wheel", hint: "Ctrl/Cmd+;", run: () => openCommandWheel() });
  commands.push({ id: "help", label: "Help", hint: "shortcuts and commands", run: () => openHelpModal() });
  commands.push({ ...browseLocalPortHelpCommand, run: () => {
    const active = getActivePane();
    openBrowserPortHelp(active?.kind === browserPaneKind ? active : null);
  } });
  commands.push({ id: "window-list", label: "Window List", hint: "Ctrl+L", run: () => openWindowList() });
  commands.push({
    id: "deskbar-button-toggle",
    label: deskbarButtonEnabled ? "Hide Deskbar Button" : "Show Deskbar Button",
    hint: "interface",
    run: () => toggleDeskbarButton(),
  });
  // Keep Settings ahead of other equally ranked "se" prefix matches.
  commands.push({ id: "settings", label: "Settings...", aliases: ["preferences"], hint: "workspace", run: () => openSettingsModal() });
  commands.push({ id: "sessions", label: "Tessera Sessions...", hint: currentSessionName || "manage", run: () => void openSessionsModal() });
  commands.push({ id: "new-session", label: "Create Session...", hint: "session", run: () => openSessionNameDialog("create") });
  if (sessions.length > 1) {
    const current = sessions.find((session) => session.id === currentSessionID);
    if (current) {
      commands.push({
        id: "destroy-session",
        label: "Destroy Session...",
        hint: currentSessionName || "delete",
        run: () => openDestroySessionDialog(current),
      });
    }
  }
  for (const session of sessions) {
    if (session.id !== currentSessionID) {
      commands.push({ label: `Switch Session: ${session.name}`, hint: "session", run: () => void switchSession(session) });
    }
  }
  commands.push({ id: "manage-shortcuts", label: "Shortcuts...", hint: "manage terminal launchers", run: openShortcuts });
  for (const shortcut of shortcutsUI.items) {
    commands.push({ id: `shortcut:${shortcut.id}`, label: `Create ${shortcut.name}`, aliases: [shortcut.name], code: shortcut.code, shortcut: true, hint: "terminal shortcut", run: () => invokeShortcut(shortcut) });
  }
  commands.push({ id: "new-terminal", label: "New Terminal", hint: "create", run: () => {
    const point = paneSpawnPoint();
    createTerminalPane(point.x, point.y);
  } });
  commands.push({ id: "new-browser", label: "New Browser", hint: "localhost development server", run: () => {
    const point = paneSpawnPoint();
    createBrowserPane(point.x, point.y);
  } });
  commands.push({ id: "new-vnc", label: "New VNC", hint: "remote desktop", run: () => {
    const point = paneSpawnPoint();
    createVNCPane(point.x, point.y);
  } });
  commands.push({ id: "next-window", label: "Next Window", hint: "Ctrl+]", run: () => focusAdjacentPane(1) });
  commands.push({ id: "previous-window", label: "Previous Window", hint: "Ctrl+[", run: () => focusAdjacentPane(-1) });
  const visiblePaneCount = rectangles.filter((rect) => rect.kind !== "pending" && !rect.minimized).length;
  if (visiblePaneCount > 0) {
    commands.push({
      id: "arrange-out",
      label: arrangeOutSnapshot ? "Back Arrange" : "Cascade Arrange",
      hint: "Alt+F7",
      run: () => toggleArrangeWindows(),
    });
  }
  const dockTarget = getActivePane();
  if (dockTarget) {
    if (dockTarget.kind === "terminal" && dockTarget.terminal?.term) {
      commands.push({
        id: "repair-terminal-view",
        label: "Repair Terminal View",
        hint: "refit and repaint",
        run: () => repairTerminalView(dockTarget),
      });
    }
    commands.push({
      id: "rename-window",
      label: "Set Window Title...",
      aliases: ["rename", "rename window"],
      hint: "Ctrl+T",
      run: () => openRenameWindowModal(dockTarget),
    });
    commands.push({
      id: "maximize-toggle",
      label: dockTarget.isFull ? "Restore Window" : "Maximize Window",
      hint: "Alt+F10",
      run: () => toggleFullRestore(dockTarget),
    });
    commands.push({
      id: "minimize-toggle",
      label: dockTarget.minimized ? "Restore Window" : "Minimize Window",
      hint: "Alt+F9",
      run: () => toggleMinimize(dockTarget),
    });
    for (const [action, id, label] of [["top", "dock-top", "Dock Top"], ["left", "dock-left", "Dock Left"], ["right", "dock-right", "Dock Right"], ["bottom", "dock-bottom", "Dock Bottom"]]) {
      commands.push({
        id,
        label,
        hint: dockTarget.title,
        run: () => applyDockAction(action, dockTarget),
      });
    }
    commands.push({ id: "destroy-window", label: "Destroy Window", aliases: ["close", "close window"], hint: "Ctrl+Backspace", run: () => destroyActivePane() });
  }
  if (window.__tesseraDesktop !== true) {
    commands.push({ id: "local-https", label: "Local HTTPS...", hint: "server and iPad certificates", run: () => void openLocalHTTPSModal() });
    commands.push({ id: "update-server", label: "Update Server", hint: "server", run: () => void runServerUpdate() });
  }
  if (multiUser) {
    for (const name of userRoster) {
      if (name !== currentUser) {
        commands.push({ label: `Switch user: ${name}`, hint: "user", run: () => void jumpToUser(name) });
      }
    }
  }
  const panes = rectangles.filter((rect) => rect.kind !== "pending");
  for (const rect of panes) {
    commands.push({
      label: workspaceMenuLabel(rect),
      hint: rect.minimized ? "window, minimized" : "window",
      run: () => {
        setMinimized(rect, false);
        setActivePane(rect, { raise: true, focus: true });
      },
    });
  }
  return commands;
}

// Fixed, hand-picked codes for the static commands (identified by
// `id`, since a toggle command's label changes but its code shouldn't).
// Dynamic per-window/per-user entries have no `id` and so show no code —
// a "fixed set" can't cover an unbounded, runtime-dependent list.
const paletteShortcutCodes = {
  "help": "HP",
  "browse-local-port-help": "BL",
  "new-terminal": "NN",
  "repair-terminal-view": "RV",
  "new-browser": "NB",
  "new-vnc": "NV",
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

// Stamps each command with its fixed code (or none, for dynamic entries).
function assignPaletteShortcutCodes(commands) {
  for (const command of commands) {
    command.code = command.shortcut ? command.code : command.id ? paletteShortcutCodes[command.id] || null : null;
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
  const rawQuery = commandPaletteInput.value;
  const query = rawQuery.trim();
  const allCommands = buildPaletteCommands();
  assignPaletteShortcutCodes(allCommands);

  // Exact codes rank first even when their letters don't match the label.
  // Typing only selects results; Enter or a click runs the selected command.
  const codeMatch = findPaletteCodeMatch(query, allCommands);

  paletteEntries = allCommands
    .map((command) => ({ command, score: command === codeMatch ? 2000 : Math.max(
      paletteScore(query, command.label),
      ...(command.aliases || []).map(alias => paletteScore(query, alias)),
    ) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((entry) => entry.command);
  paletteSelection = 0;

  commandPaletteList.replaceChildren();
  if (paletteEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-palette-empty";
    empty.textContent = "No matching commands";
    commandPaletteList.appendChild(empty);
    return;
  }
  paletteEntries.forEach((command, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "command-palette-item";
    if (index === paletteSelection) {
      row.classList.add("is-selected");
    }
    const label = document.createElement("span");
    label.textContent = command.label;
    const meta = document.createElement("span");
    meta.className = "command-palette-item-meta";
    if (command.code) {
      const code = document.createElement("span");
      code.className = "command-palette-code";
      code.textContent = command.code;
      meta.appendChild(code);
    }
    const hint = document.createElement("span");
    hint.className = "command-palette-hint";
    hint.textContent = command.hint;
    meta.appendChild(hint);
    row.appendChild(label);
    row.appendChild(meta);
    row.addEventListener("pointermove", () => setPaletteSelection(index));
    row.addEventListener("click", () => runPaletteCommand(command));
    commandPaletteList.appendChild(row);
  });
}

function handlePaletteKeyboard(event) {
  if (event.isComposing) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    movePaletteSelection(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    runPaletteSelection();
  }
}

function setPaletteSelection(index) {
  paletteSelection = index;
  const rows = commandPaletteList.querySelectorAll(".command-palette-item");
  rows.forEach((row, rowIndex) => {
    row.classList.toggle("is-selected", rowIndex === index);
  });
}

function movePaletteSelection(direction) {
  if (paletteEntries.length === 0) {
    return;
  }
  const next = (paletteSelection + direction + paletteEntries.length) % paletteEntries.length;
  setPaletteSelection(next);
  commandPaletteList.querySelectorAll(".command-palette-item")[next]?.scrollIntoView({ block: "nearest" });
}

function runPaletteSelection() {
  const command = paletteEntries[paletteSelection];
  if (command) {
    runPaletteCommand(command);
  }
}

function runPaletteCommand(command) {
  hideCommandPalette();
  hideCommandWheel();
  command.run();
}

function showWindowTypeMenu(rect, clientX, clientY) {
  if (!rect || rect.kind !== "pending" || !rectangles.includes(rect)) {
    return;
  }
  hideDockMenu();
  hideTerminalMenu();
  hideWorkspaceMenu();
  hideDirectoryBrowser();
  windowTypeRect = rect;
  renderWindowTypeMenu();
  showMenuAt(windowTypeMenu, clientX, clientY);
}

function renderWindowTypeMenu() {
  windowTypeMenu.replaceChildren();
  const actions = [
    ["terminal", "Terminal"],
    [browserPaneKind, "Browser"],
    [vncPaneKind, "VNC"],
  ];
  for (const [kind, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      const rect = windowTypeRect;
      hideWindowTypeMenu({ finalizeDefault: false });
      finalizePendingRectangle(rect, kind);
    });
    windowTypeMenu.appendChild(button);
  }
}

function finalizePendingRectangle(rect, kind) {
  if (!rect || rect.kind !== "pending" || !rectangles.includes(rect)) {
    return;
  }
  const paneKind = kind === "terminal" || kind === browserPaneKind || kind === vncPaneKind
    ? kind
    : "terminal";
  const box = rectangleBox(rect);
  const paneID = rect.id;
  const zIndex = rect.zIndex;
  const cwd = rect.cwd || "";
  destroyRectangle(rect);
  const nextRect = createRectangle(box.x, box.y, box.width, box.height, {
    id: paneID,
    kind: paneKind,
    cwd,
    zIndex,
  });
  setActivePane(nextRect, { raise: true, focus: true });
  scheduleWorkspaceSave();
}

function workspaceMenuLabel(rect) {
  const index = rectangles.indexOf(rect);
  const name = rect.title.trim() || `Window ${index + 1}`;
  const kindSuffix = rect.kind === "terminal"
    ? " [terminal]"
    : rect.kind === browserPaneKind
        ? " [browser]"
      : rect.kind === vncPaneKind
        ? " [vnc]"
      : "";
  return `${name}${kindSuffix}${rect.filePendingCount ? ` [${rect.filePendingCount} file transfer${rect.filePendingCount === 1 ? "" : "s"}]` : ""}`;
}

function createTerminalPane(x, y, options = {}) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 640, 360, {
    kind: "terminal",
    cwd: options.cwd ?? activeRect?.cwd ?? "",
    title: options.title,
    terminalStartupCommand: options.terminalStartupCommand,
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focus: true });
  scheduleWorkspaceSave();
  return rect;
}


function createBrowserPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 720, 480, {
    kind: browserPaneKind,
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focus: true });
  rect.browser?.address.focus();
  scheduleWorkspaceSave();
  return rect;
}

function createVNCPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 720, 480, {
    kind: vncPaneKind,
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focus: true });
  rect.vnc?.address.focus();
  scheduleWorkspaceSave();
  return rect;
}

// A cascading spawn point for panes created without a click location (from
// the Deskbar or the command palette).
function paneSpawnPoint() {
  const count = rectangles.filter((rect) => rect.kind !== "pending").length;
  const step = count % 6;
  return { x: 48 + step * 32, y: tabHeight + 40 + step * 28 };
}

function renderTerminalMenu(rect) {
  terminalMenu.replaceChildren();
  const actions = [
    ["copy", "Copy"],
    ["paste", "Paste"],
  ];
  const term = rect?.terminal?.term;
  const hasSelection = Boolean(term?.hasSelection?.() || term?.getSelection?.());
  const canReadClipboard = Boolean(clipboardBridge.status || navigator.clipboard?.readText || document.queryCommandSupported?.("paste"));
  const canPaste = canReadClipboard || clipboardText.length > 0;

  for (const [action, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    if (action === "copy") {
      button.disabled = !hasSelection;
    } else if (action === "paste") {
      button.disabled = !canPaste;
    }
    button.addEventListener("click", () => {
      const actionRect = terminalMenuRect;
      hideTerminalMenu();
      void applyTerminalMenuAction(action, actionRect);
    });
    terminalMenu.appendChild(button);
  }

  const separator = document.createElement("div");
  separator.className = "dock-menu-separator";
  terminalMenu.appendChild(separator);
  const audioToggle = document.createElement("button");
  audioToggle.type = "button";
  audioToggle.textContent = terminalAudioPlayer.enabled ? "Disable terminal audio" : "Enable terminal audio";
  audioToggle.addEventListener("click", () => {
    hideTerminalMenu();
    if (terminalAudioPlayer.enabled) terminalAudioPlayer.disable();
    else void terminalAudioPlayer.enable().catch(() => renderTerminalAudioStatus(rect, { kind: "enable", text: "Audio could not start. Enable again." }));
  });
  terminalMenu.appendChild(audioToggle);
  const muteLabel = document.createElement("label");
  muteLabel.className = "terminal-image-setting";
  const mute = document.createElement("input");
  mute.type = "checkbox";
  const audioKey = rect?.terminal?.audioKey;
  mute.checked = Boolean(terminalAudioPlayer.terminals.get(audioKey)?.muted);
  mute.disabled = !audioKey;
  mute.addEventListener("change", () => {
    terminalAudioPlayer.setMuted(audioKey, mute.checked);
    try { window.localStorage.setItem(audioKey, String(mute.checked)); } catch {}
    hideTerminalMenu();
  });
  muteLabel.append(mute, document.createTextNode("Mute terminal audio"));
  terminalMenu.appendChild(muteLabel);
  const audioSeparator = document.createElement("div");
  audioSeparator.className = "dock-menu-separator";
  terminalMenu.appendChild(audioSeparator);
  const imageSettings = term?.imageSettings?.() || { memoryMiB: 64, showPlaceholders: true };
  const connected = rect?.terminal?.socket?.readyState === WebSocket.OPEN && Boolean(rect.terminal.replica?.cursor.epoch);
  const budgetLabel = document.createElement("label");
  budgetLabel.className = "terminal-image-setting";
  budgetLabel.textContent = "Image memory";
  budgetLabel.title = "Decoded image budget for this running shell, shared by all browsers.";
  const budget = document.createElement("select");
  budget.setAttribute("aria-label", "Terminal image memory");
  budget.disabled = !connected;
  for (const memoryMiB of [16, 32, 64]) {
    const option = document.createElement("option");
    option.value = String(memoryMiB);
    option.textContent = `${memoryMiB} MiB`;
    option.selected = imageSettings.memoryMiB === memoryMiB;
    budget.appendChild(option);
  }
  budget.addEventListener("change", () => {
    sendTerminalImageAction(rect, { type: "image-settings", memoryMiB: Number(budget.value) });
    hideTerminalMenu();
  });
  budgetLabel.appendChild(budget);
  terminalMenu.appendChild(budgetLabel);
  const placeholderLabel = document.createElement("label");
  placeholderLabel.className = "terminal-image-setting";
  const placeholders = document.createElement("input");
  placeholders.type = "checkbox";
  placeholders.checked = imageSettings.showPlaceholders;
  placeholders.disabled = !connected;
  placeholders.addEventListener("change", () => {
    sendTerminalImageAction(rect, { type: "image-settings", showPlaceholders: placeholders.checked });
    hideTerminalMenu();
  });
  placeholderLabel.append(placeholders, document.createTextNode("Show discarded image markers"));
  terminalMenu.appendChild(placeholderLabel);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear terminal images";
  clear.disabled = !connected;
  clear.title = "Free retained images and markers in this shell, keeping text and scrollback.";
  clear.addEventListener("click", () => {
    sendTerminalImageAction(rect, { type: "clear-images" });
    hideTerminalMenu();
  });
  terminalMenu.appendChild(clear);
}

function sendTerminalImageAction(rect, message) {
  const state = rect?.terminal;
  if (state?.socket?.readyState !== WebSocket.OPEN || !state.replica?.cursor.epoch) return;
  state.socket.send(JSON.stringify(message));
}

function applyDockAction(action, rect) {
  if (!rect) {
    return;
  }
  windowWobble.stop(rect.element);

  if (action === "destroy") {
    destroyRectangle(rect, { closeServerTerminal: true });
    return;
  }

  if (action === "minimize") {
    setMinimized(rect, true);
    return;
  }

  if (action === "unminimize") {
    setMinimized(rect, false);
    setActivePane(rect, { raise: true, focus: true });
    return;
  }

  setActivePane(rect, { raise: true, focus: true });

  if (action === "restore") {
    if (rect.restoreBox) {
      setRectangle(rect, rect.restoreBox);
    }
    clearFullState(rect);
    return;
  }

  if (action === "full") {
    // A maximized pane must be expanded, not rolled up.
    if (rect.minimized) {
      setMinimized(rect, false);
    }
    if (!rect.isFull) {
      rect.restoreBox = rectangleBox(rect);
    }
    rect.isFull = true;
    applyFullGeometry(rect);
    updateWindowControls(rect);
    return;
  }

  if (action === "top" || action === "left" || action === "right" || action === "bottom") {
    // A docked pane must be visible and at its own size, not rolled up or
    // still carrying a stale "full" restore box.
    if (rect.minimized) {
      setMinimized(rect, false);
    }
    clearFullState(rect);
    const bounds = board.getBoundingClientRect();
    setDockedPaneGeometry(rect, action, bounds);
  }
}

function dockTopInset() {
  return themeID === "oled-terminal" || themeID === "operator" ? 0 : tabHeight;
}

function dockedPaneBox(action, bounds, inset = dockTopInset()) {
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

function setDockedPaneGeometry(rect, action, bounds = board.getBoundingClientRect()) {
  setRectangle(rect, dockedPaneBox(action, bounds));
}

function sameRectangleBox(rect, box) {
  return rect.x === box.x && rect.y === box.y && rect.width === box.width && rect.height === box.height;
}

// Docked panes from every theme use one of two exact geometry families: the
// normal title-tab inset or the OLED/Operator edge-to-edge layout. Operator
// reserves its title height within the pane rather than above its saved box.
// Recognizing either form lets existing saved docks update on theme changes.
function reflowDockedPanesForTheme() {
  const bounds = board.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) {
    return;
  }
  const insetBoxes = [0, tabHeight].flatMap((inset) => (
    ["top", "left", "right", "bottom"].map((action) => ({ action, box: dockedPaneBox(action, bounds, inset) }))
  ));
  for (const rect of rectangles) {
    if (rect.kind === "pending" || rect.minimized || rect.isFull) {
      continue;
    }
    const match = insetBoxes.find(({ box }) => sameRectangleBox(rect, box));
    if (match) {
      const themedBox = dockedPaneBox(match.action, bounds);
      if (!sameRectangleBox(rect, themedBox)) {
        setRectangle(rect, themedBox);
      }
    }
  }
}

function toggleFullRestore(rect) {
  applyDockAction(rect?.isFull ? "restore" : "full", rect);
}

// Maximize is an attribute ("this pane fills the board"), not a fixed size:
// this always measures the board fresh, so a maximized pane fills whatever
// screen it's actually being viewed on — including a different device's
// screen after the workspace reloads, or the browser window being resized
// while a pane is maximized.
function applyFullGeometry(rect) {
  if (themeID === "operator") {
    // Focusing an offscreen control can scroll an overflow:hidden desktop.
    // A maximized Operator window must start at the visible desktop origin.
    board.scrollLeft = 0;
    board.scrollTop = 0;
  }
  const bounds = board.getBoundingClientRect();
  setRectangle(rect, { x: 0, y: 0, width: bounds.width, height: bounds.height });
}

// Re-fills every maximized pane when the viewport changes size, so "full"
// keeps meaning "fills the board" instead of freezing at whatever size it
// happened to be maximized at.
function reapplyFullGeometryForViewport() {
  for (const rect of rectangles) {
    if (rect.kind !== "pending" && rect.isFull && !rect.minimized) {
      applyFullGeometry(rect);
    }
  }
}
window.addEventListener("resize", reapplyFullGeometryForViewport);
// The window "resize" event doesn't fire for every way the board's own box
// can change size (browser chrome changes, OS-level display/zoom changes,
// some devtools/embedded viewport changes) — a ResizeObserver on the board
// itself catches those too, since it fires on the actual box change rather
// than a specific event source.
new ResizeObserver(reapplyFullGeometryForViewport).observe(board);

// Tiles every visible pane into a near-square grid so all of their contents
// are on screen at once, remembering each pane's prior box so Back Arrange
// can undo it.
function toggleArrangeWindows() {
  if (arrangeOutSnapshot) {
    arrangeWindowsBack();
  } else {
    arrangeWindowsOut();
  }
}

function arrangeWindowsOut() {
  const panes = rectangles.filter((rect) => rect.kind !== "pending" && !rect.minimized);
  if (panes.length === 0) {
    return;
  }

  if (!arrangeOutSnapshot) {
    arrangeOutSnapshot = panes.map((rect) => ({ id: rect.id, box: rectangleBox(rect) }));
  }

  const bounds = board.getBoundingClientRect();
  const inset = themeID === "operator" ? 0 : tabHeight;
  const usableHeight = Math.max(16, bounds.height - inset);
  const columns = Math.ceil(Math.sqrt(panes.length));
  const rows = Math.ceil(panes.length / columns);
  const cellWidth = Math.max(16, Math.floor(bounds.width / columns));
  const cellHeight = Math.max(16, Math.floor(usableHeight / rows));

  isArrangingWindows = true;
  panes.forEach((rect, index) => {
    clearFullState(rect);
    const column = index % columns;
    const row = Math.floor(index / columns);
    setRectangle(rect, {
      x: column * cellWidth,
      y: inset + row * cellHeight,
      width: cellWidth,
      height: cellHeight,
    });
  });
  isArrangingWindows = false;
  scheduleWorkspaceSave();
}

// Restores every pane's box from the last Cascade Arrange, if nothing has moved,
// resized, docked, or otherwise repositioned a window since.
function arrangeWindowsBack() {
  if (!arrangeOutSnapshot) {
    return;
  }
  const snapshot = arrangeOutSnapshot;
  isArrangingWindows = true;
  for (const { id, box } of snapshot) {
    const rect = rectangles.find((candidate) => candidate.id === id);
    if (rect) {
      setRectangle(rect, box);
    }
  }
  isArrangingWindows = false;
  arrangeOutSnapshot = null;
  scheduleWorkspaceSave();
}

function destroyActivePane() {
  const active = getActivePane();
  if (active) {
    destroyRectangle(active, { closeServerTerminal: true });
  }
}

function closeWindowFromTitleBar(rect) {
  if (rect.kind === "terminal" && rect.terminalStatus?.state !== "exited"
      && !window.confirm(`Close "${rect.title}"? This ends its shell and any running processes.`)) {
    return;
  }
  destroyRectangle(rect, { closeServerTerminal: true });
}

// Minimize hides the pane but keeps its live terminal intact. The
// Deskbar is the persistent visual handle that restores it.
function setMinimized(rect, on) {
  windowWobble.stop(rect?.element);
  if (!rect) {
    return;
  }
  const next = Boolean(on);
  if (rect.minimized === next) {
    return;
  }
  rect.minimized = next;
  rect.element.classList.toggle("is-minimized", next);
  scheduleTerminalVisibilityUpdate();
  updateTerminalRenderState(rect);
  if (next) {
    rect.element.setAttribute("aria-hidden", "true");
  } else {
    rect.element.removeAttribute("aria-hidden");
    window.requestAnimationFrame(() => {
      requestTerminalFit(rect);
    });
  }
  updateWindowControls(rect);
  updateDeskbar();
  if (next && activePaneID === rect.id) {
    focusTopVisiblePane();
  }
  scheduleWorkspaceSave();
}

function toggleMinimize(rect) {
  if (!rect) {
    return;
  }
  setActivePane(rect, { raise: true });
  setMinimized(rect, !rect.minimized);
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
  updateDeskbar();
}

async function applyTerminalMenuAction(action, rect) {
  const term = rect?.terminal?.term;
  if (!term) {
    return;
  }

  if (action === "copy") {
    // Read first: focusing a contenteditable canvas terminal can alter the
    // browser/terminal selection on some WebKit builds.
    const text = term.getSelection?.() || "";
    if (text) {
      await writeClipboardText(text);
    } else {
      reportEmptyTerminalCopy(term);
    }
    term.focus();
    return;
  }

  if (action === "paste") {
    term.focus();
    const text = await readClipboardText();
    if (text) {
      term.paste?.(text);
    }
    reportClipboardFallback(appleKeyboardLayout ? "Cmd+V" : "Ctrl+V");
    term.focus();
  }
}

const emptyCopyStatusHideMs = 4000;

// A copy that found no selection did nothing at all, and the keystroke that
// asked for it was consumed either way. Say so, and name the way to make a
// selection, rather than leaving the key looking broken.
function reportEmptyTerminalCopy(term) {
  let mouseTracking = false;
  try {
    mouseTracking = Boolean(term?.hasMouseTracking?.());
  } catch {
    mouseTracking = false;
  }
  setWorkspaceStatus("error", "Nothing to copy", emptyTerminalCopyGuidance(mouseTracking), {
    // Nothing is broken and nothing needs answering — the next copy either
    // works or says this again, so it should not sit in the corner.
    autoHideMs: emptyCopyStatusHideMs,
  });
}

// This browser refused to read the clipboard, so whatever was pasted came from
// Tessera's own last copy rather than the system clipboard. Say so instead of
// letting stale text look like a normal paste.
function reportClipboardFallback(acceleratorName) {
  if (!clipboardReadFellBack) {
    return;
  }
  clipboardReadFellBack = false;
  setWorkspaceStatus(
    "error",
    "Clipboard blocked",
    `This browser would not read the clipboard, so Tessera's own last copy was used. Use ${acceleratorName} to paste from the system clipboard.`,
  );
}

// Chrome leaves clipboard.writeText() pending — neither resolved nor rejected —
// while its window does not hold focus. An OSC 52 copy hits that easily, since
// it arrives over the terminal socket rather than from a keystroke, and awaiting
// it forever loses the copy with no error to report and stalls every write
// queued behind it. Give up instead and take the fallback path.
const clipboardWriteTimeoutMs = 1500;

// Resolves true when the promise settled in time and false when it did not. A
// rejection still propagates, so a refused write stays distinguishable from a
// stalled one.
function settledWithin(promise, milliseconds) {
  let timer = null;
  const expiry = new Promise((resolve) => {
    timer = window.setTimeout(() => resolve(false), milliseconds);
  });
  return Promise.race([promise.then(() => true), expiry])
    .finally(() => window.clearTimeout(timer));
}

// Returns whether the text reached the real system clipboard. Tessera's own
// buffer is updated either way, so pasting back inside Tessera still works
// when the browser refuses the write.
async function writeClipboardText(text, { terminal = false } = {}) {
  clipboardText = text;
  if (clipboardBridge.status && (!terminal || clipboardBridge.status.terminal)) {
    try {
      await clipboardBridge.writeText(text, terminal);
      return true;
    } catch {
      // Retain the ordinary browser and internal-buffer fallbacks.
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      if (await settledWithin(navigator.clipboard.writeText(text), clipboardWriteTimeoutMs)) {
        return true;
      }
    } catch {
      // Fall through to the synchronous copy fallback below.
    }
  }
  return copyTextWithHiddenField(text);
}

// OSC 52 copies arrive from the PTY rather than from a keystroke, and a
// browser that requires a user gesture — or an unfocused window — will refuse
// the write. Say so once rather than leaving the operator to discover it by
// pasting something stale into another application.
let terminalClipboardWrites = Promise.resolve();

function applyTerminalClipboardWrite(text) {
  terminalClipboardWrites = terminalClipboardWrites
    .then(async () => {
      if (await writeClipboardText(text, { terminal: true })) {
        return;
      }
      setWorkspaceStatus(
        "error",
        "Clipboard blocked",
        "A Terminal program copied text, but this browser would not write the system clipboard. The text is available to Tessera's own Paste.",
      );
    })
    .catch(() => {});
  return terminalClipboardWrites;
}

// True when the last read could not reach the real clipboard and fell back to
// whatever Tessera itself last copied. Callers surface that, so a blocked read
// never looks like a successful paste of someone else's text.
let clipboardReadFellBack = false;

async function readClipboardText() {
  clipboardReadFellBack = false;
  if (clipboardBridge.status) {
    try { return await clipboardBridge.readText(); }
    catch { /* Continue with the browser and internal-buffer fallbacks. */ }
  }
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Fall through to the synchronous paste fallback below.
    }
  }
  const pastedText = pasteTextWithHiddenField();
  if (pastedText !== null) {
    return pastedText;
  }
  clipboardReadFellBack = true;
  return clipboardText;
}

function copyTextWithHiddenField(text) {
  // Selecting the field takes focus, and an OSC 52 copy can land while a TUI
  // has the keyboard, so give focus back where it was.
  const previouslyFocused = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-1000px";
  field.style.top = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  if (previouslyFocused && typeof previouslyFocused.focus === "function") {
    previouslyFocused.focus();
  }
  return copied;
}

function pasteTextWithHiddenField() {
  const field = document.createElement("textarea");
  field.style.position = "fixed";
  field.style.left = "-1000px";
  field.style.top = "0";
  document.body.appendChild(field);
  field.focus();
  let pasted = false;
  try {
    pasted = document.execCommand("paste");
  } catch {
    pasted = false;
  }
  const text = pasted ? field.value : null;
  field.remove();
  return text;
}

function destroyRectangle(rect, options = {}) {
  windowWobble.stop(rect.element);
  const index = rectangles.indexOf(rect);
  const wasActive = activePaneID === rect.id;
  if (index >= 0) {
    rectangles.splice(index, 1);
  }
  if (interaction?.rect === rect) {
    interaction = null;
  }
  if (contextMenuRect === rect) {
    contextMenuRect = null;
  }
  if (terminalMenuRect === rect) {
    terminalMenuRect = null;
  }
  if (windowTypeRect === rect) {
    windowTypeRect = null;
    windowTypeMenu.hidden = true;
  }
  if (wasActive) {
    activeRect = null;
    activePaneID = "";
    delete board.dataset.activePaneId;
  }
  disposeTerminal(rect, { closeServer: options.closeServerTerminal });
  disposeBrowserPane(rect);
  disposeVNCPane(rect);
  window.clearTimeout(rect.fontSizeIndicatorTimer);
  rect.fontSizeIndicatorTimer = null;
  rect.element.remove();
  scheduleTerminalVisibilityUpdate();
  if (wasActive && options.selectNext !== false) {
    focusTopVisiblePane();
  }
  updateDeskbar();
  scheduleWorkspaceSave();
}

function handlePaneKeyboardShortcuts(event) {
  if (event.defaultPrevented) {
    return;
  }
  if (!serverConnectionModal.hidden) {
    return;
  }

  const shortcut = paneShortcutAction(event);
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
  if ([settingsModal, localHTTPSModal, renameWindowModal, sessionsModal, sessionActionModal,
    serverUpdateModal, serverConnectionModal, workspaceConflictModal, helpModal,
    directoryBrowser, userSelect, shortcutsUI.element].some((overlay) => !overlay.hidden)) {
    return null;
  }
  const primary = (keys.ctrlKey || keys.metaKey) && !keys.altKey && !keys.shiftKey;
  const alt = keys.altKey && !keys.ctrlKey && !keys.metaKey && !keys.shiftKey;

  if (primary && (keys.key === "l" || keys.key === "L")) {
    return { run: toggleWindowList };
  }
  if (primary && (keys.key === "k" || keys.key === "K")) {
    return { run: toggleCommandPalette };
  }
  if (primary && !keys.repeat && !keys.isComposing && (keys.key === ";" || keys.code === "Semicolon")) {
    return { run: toggleCommandWheel };
  }
  if (!commandWheel.hidden) return null;
  if (primary && (keys.key === "t" || keys.key === "T")) {
    return { run: () => openRenameWindowModal(getActivePane()) };
  }
  if (!commandPalette.hidden || !commandWheel.hidden || !windowList.hidden) {
    return null;
  }
  if ((keys.ctrlKey || keys.metaKey) && keys.shiftKey && !keys.altKey
    && (keys.key === "ArrowUp" || keys.key === "ArrowDown")) {
    return { run: () => moveWindowInOrder(getActivePane(), keys.key === "ArrowUp" ? -1 : 1, { showSwitcher: true }) };
  }
  if (primary && (keys.key === "Backspace" || keys.code === "Backspace")) {
    return { run: destroyActivePane };
  }
  if (primary && (keys.key === "]" || keys.code === "BracketRight")) {
    return { run: () => focusAdjacentPane(1, { showSwitcher: true }) };
  }
  if (primary && (keys.key === "[" || keys.code === "BracketLeft")) {
    return { run: () => focusAdjacentPane(-1, { showSwitcher: true }) };
  }
  const fontSizeShortcut = (keys.ctrlKey || keys.metaKey) && !keys.altKey && (!keys.shiftKey || keys.key === "+");
  if (fontSizeShortcut && (keys.key === "+" || keys.key === "=" || keys.code === "NumpadAdd")) {
    return { run: () => adjustActivePaneFontSize(1) };
  }
  if (fontSizeShortcut && (keys.key === "-" || keys.key === "_" || keys.code === "NumpadSubtract")) {
    return { run: () => adjustActivePaneFontSize(-1) };
  }
  if (primary && (keys.key === "0" || keys.code === "Numpad0")) {
    return { run: resetActivePaneFontSize };
  }
  if (alt && keys.key === "F10") {
    return { run: () => toggleFullRestore(getActivePane()), propagate: true };
  }
  if (alt && keys.key === "F9") {
    return { run: () => toggleMinimize(getActivePane()), propagate: true };
  }
  if (alt && keys.key === "F7") {
    return { run: toggleArrangeWindows, propagate: true };
  }
  return null;
}

function focusAdjacentPane(direction, options = {}) {
  const next = adjacentWindowPane(rectangles, getActivePane(), direction);
  if (!next) {
    return;
  }
  setActivePane(next, { raise: true, focus: true });
  if (options.showSwitcher) {
    showWindowSwitcher();
  }
}

function focusTopVisiblePane() {
  const next = rectangles
    .filter((rect) => rect.kind !== "pending" && !rect.minimized)
    .sort((a, b) => b.zIndex - a.zIndex)[0] || null;
  if (next) {
    setActivePane(next, { raise: false, focus: true });
  } else {
    clearActivePane();
  }
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
    clampIntoBoard(box);
    return box;
  } catch {
    return null;
  }
}

function clearFullState(rect) {
  rect.isFull = false;
  rect.restoreBox = null;
  updateWindowControls(rect);
}

function hideMenusWhenOutside(event) {
  if (!dockMenu.hidden && !dockMenu.contains(event.target)) {
    hideDockMenu();
  }
  if (!terminalMenu.hidden && !terminalMenu.contains(event.target)) {
    hideTerminalMenu();
  }
  if (!workspaceMenu.hidden && !workspaceMenu.contains(event.target)) {
    hideWorkspaceMenu();
  }
  if (!windowTypeMenu.hidden && !windowTypeMenu.contains(event.target)) {
    hideWindowTypeMenu();
  }
  if (!deskbarPanel.hidden && !deskbarPanel.contains(event.target) && !deskbarButton.contains(event.target)) {
    hideDeskbar();
  }
  if (!directoryBrowser.hidden && !directoryBrowser.contains(event.target)) {
    hideDirectoryBrowser();
  }
}

function hideMenusOnEscape(event) {
  if (event.key === "Escape") {
    hideAllMenus();
  }
}

function hideAllMenus() {
  shortcutsUI.close();
  hideFloatingMenus();
  hideDirectoryBrowser();
  hideCommandPalette();
  hideCommandWheel();
  hideWindowList();
  hideDeskbar();
  hideSettingsModal();
  hideLocalHTTPSModal();
  hideHelpModal();
  hideRenameWindowModal();
  hideSessionsModal();
  hideSessionActionModal();
}

function hideFloatingMenus() {
  hideDockMenu();
  hideTerminalMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
}

function hideDockMenu() {
  dockMenu.hidden = true;
  contextMenuRect = null;
}

function hideTerminalMenu() {
  terminalMenu.hidden = true;
  terminalMenuRect = null;
}

function hideWorkspaceMenu() {
  workspaceMenu.hidden = true;
  workspaceMenuPoint = null;
}

// Dismissing the window-type menu without picking a type (click outside,
// Escape, or opening another menu) cancels the draw instead of defaulting
// to a window kind — the user gets exactly what they chose, or nothing.
function hideWindowTypeMenu(options = {}) {
  const rect = windowTypeRect;
  windowTypeMenu.hidden = true;
  windowTypeRect = null;
  if (options.finalizeDefault === false) {
    return;
  }
  if (rect && rect.kind === "pending" && rectangles.includes(rect)) {
    destroyRectangle(rect, { selectNext: false });
  }
}

function hideDirectoryBrowser() {
  directoryBrowser.hidden = true;
  directoryBrowserRect = null;
  directoryBrowserPath = "";
}

function showMenuAt(menu, clientX, clientY) {
  menu.hidden = false;
  const menuBox = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - menuBox.width - 6);
  const top = Math.min(clientY, window.innerHeight - menuBox.height - 6);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, top)}px`;
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
  const bounds = board.getBoundingClientRect();
  const visibleX = Math.min(56, rect.width, bounds.width);
  const visibleY = Math.min(56, rect.height, bounds.height);
  const titleVisible = 12;

  const minX = visibleX - rect.width;
  const maxX = bounds.width - visibleX;
  // The floor keeps a sliver of the title tab grabbable when a window is
  // dragged mostly above the board; OLED Terminal has no tab, so it should
  // allow panes flush against the top edge instead of leaving a gap.
  const minY = Math.max(visibleY - rect.height, dockTopInset() - titleVisible);
  const maxY = bounds.height - visibleY;

  rect.x = Math.min(Math.max(minX, rect.x), maxX);
  rect.y = Math.min(Math.max(minY, rect.y), maxY);
}

function boardPoint(event) {
  return boardClientPoint(event.clientX, event.clientY);
}

function boardClientPoint(clientX, clientY) {
  const bounds = board.getBoundingClientRect();
  return {
    x: clientX - bounds.left,
    y: clientY - bounds.top,
  };
}
