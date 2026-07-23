import {
  basicSetup,
  EditorSelection,
  EditorState,
  EditorView,
  Prec,
  Transaction,
  keymap,
  css,
  cpp,
  go,
  html,
  java,
  javascript,
  markdown,
  php,
  python,
  rust,
  sql,
  xml,
  yaml,
} from "./vendor/codemirror.js?v=syntax-highlighting-1";
import { textEditorLanguageID } from "./text-editor-language.mjs";
import { nextServerConnectionState } from "./server-connection.mjs";
import { isExpectedServerVersion } from "./server-update.mjs";
import { terminalReconnectDelay } from "./terminal-reconnect.mjs";
import { isTerminalPasteShortcut, terminalNavigationSequence } from "./terminal-keyboard.mjs";
import { terminalMouseMessage } from "./terminal-input.mjs";
import { defaultTerminalTERM, normalizeTerminalTERM } from "./terminal-settings.mjs";
import {
  defaultTerminalFont,
  loadTerminalFont,
  normalizeTerminalFont,
  terminalFontFamily,
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
import { workspaceRevisionMatches, workspaceSaveOutcome } from "./workspace-concurrency.mjs";
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
let editorMenuRect = null;
let terminalMenuRect = null;
let workspaceMenuPoint = null;
let windowTypeRect = null;
let directoryBrowserRect = null;
let directoryBrowserPath = "";
let fileBrowserRect = null;
let fileBrowserMode = "";
let fileBrowserPath = "";
let fileBrowserFilePath = "";
let paneFileClipboard = null;
let editorClipboardText = "";
let workspaceID = "default";
let workspaceRevision = "";
let workspaceSaveSuspended = false;
let workspaceNeedsRevalidation = false;
let workspaceSavePromise = null;
let workspaceSaveQueued = false;
let multiUser = false;
let userRoster = [];
let currentUser = null;
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
let isLoadingWorkspace = false;
let saveTimer = null;
let workspaceStatusHideTimer = null;
let saveRevision = 0;
let userSettingsSaveTimer = null;
let worksheetLineDrag = null;
const runStreamControllers = new Map();
let ghosttyModulePromise = null;
const terminalTextEncoder = new TextEncoder();
// The editor and terminal must render in a monospace face for column
// alignment; keep this in sync with --tessera-font in styles.css. xterm
// measures glyphs on a canvas and cannot resolve a CSS var(), so this has
// to be a concrete font-family string rather than "var(--tessera-font)".
const tesseraMonoFontFamily = '"Fira Code", monospace';
const fallbackPaneFontSize = 14;
const minimumPaneFontSize = 10;
const maximumPaneFontSize = 24;
const defaultFileBrowserSidebarWidth = 200;
const minimumFileBrowserSidebarWidth = 110;
const maximumFileBrowserSidebarWidth = 480;
let fileBrowserSidebarResizeDrag = null;
let defaultPaneFontSize = fallbackPaneFontSize;
let deskbarButtonEnabled = true;
let terminalWheelSensitivity = defaultWheelSensitivity;
let editorWheelSensitivity = defaultWheelSensitivity;
let oledWindowBorderSize = defaultOLEDBorderSize;
let terminalTerm = defaultTerminalTERM;
let terminalFont = defaultTerminalFont;
let terminalColorMode = defaultTerminalColorMode;
let audioStationState = null;
let audioStationEvents = null;
let audioStationReconnectTimer = null;
const audioVolumeStorageKey = "tessera-audio-volume";
const serverHealthPollInterval = 5000;
let serverConnectionState = { failures: 0, state: "" };
let serverHealthMonitorTimer = null;
let serverHealthProbe = null;
let serverUpdateRestarting = false;

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
};
let defaultTheme = defaultThemeID;
let themeID = defaultThemeID;

const tesseraEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    background: "var(--editor-bg, transparent)",
    color: "var(--editor-text)",
  },
  ".cm-scroller": {
    fontFamily: tesseraMonoFontFamily,
    fontSize: "var(--pane-editor-font-size, 14px)",
    lineHeight: "1.42",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "10px 12px",
    caretColor: "var(--editor-caret)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--editor-caret)",
  },
  ".cm-gutters": {
    width: "40px",
    minWidth: "40px",
    backgroundColor: "var(--editor-gutter-bg)",
    color: "var(--editor-gutter-text)",
    borderRight: "1px solid var(--editor-gutter-border)",
  },
  ".cm-lineNumbers": {
    width: "39px",
    minWidth: "39px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    boxSizing: "border-box",
    width: "39px",
    minWidth: "39px",
    padding: "0 6px 0 0",
    textAlign: "right",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--editor-active-line)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--editor-active-line-gutter)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--editor-selection-bg, var(--selection-bg))",
  },
});

function setDefaultTheme(id) {
  defaultTheme = themes[id] ? id : defaultThemeID;
  scheduleUserSettingsSave();
}

function setDefaultPaneFontSize(fontSize) {
  defaultPaneFontSize = normalizePaneFontSize(fontSize);
  scheduleUserSettingsSave();
}

function setWheelSensitivity(kind, value) {
  const normalized = normalizeWheelSensitivity(value);
  if (kind === "terminal") {
    terminalWheelSensitivity = normalized;
  } else {
    editorWheelSensitivity = normalized;
  }
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
  const family = terminalFontFamily(terminalFont);
  for (const rect of terminalPanes) {
    rect.terminal.term.options.fontFamily = family;
    requestTerminalFit(rect);
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

function applyTheme(id, { save = true } = {}) {
  themeID = themes[id] ? id : defaultThemeID;
  if (themeID !== "oled-terminal") {
    rectangles.forEach((rect) => setOLEDMoveMode(rect, false));
  }
  document.documentElement.dataset.theme = themeID;
  reflowDockedPanesForTheme();
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

function userAPIPath(resource) {
  return `/api/users/${encodeURIComponent(currentUser || "default")}/${resource}`;
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
    return;
  }
  currentUser = name;
  persistUser(name);
  hideUserSelect();
  await Promise.all([refreshSessions(), loadUserSettings()]);
  const requested = sessions.find((session) => session.id === options.sessionID);
  const target = requested || sessions[0];
  if (!target) {
    setWorkspaceStatus("error", "No sessions");
    return;
  }
  await switchSession(target, { skipSave: true, historyMode: options.historyMode || "replace" });
}

async function switchUser() {
  await flushAllPersistence();
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
  const response = await fetch(userAPIPath("sessions"));
  if (!response.ok) {
    throw new Error(`load sessions failed: ${response.status}`);
  }
  const payload = await response.json();
  sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  return sessions;
}

async function loadUserSettings() {
  const response = await fetch(userAPIPath("settings"));
  if (!response.ok) {
    throw new Error(`load user settings failed: ${response.status}`);
  }
  const settings = await response.json();
  defaultPaneFontSize = normalizePaneFontSize(settings.defaultPaneFontSize);
  defaultTheme = themes[settings.defaultTheme] ? settings.defaultTheme : defaultThemeID;
  deskbarButtonEnabled = settings.deskbarButtonEnabled !== false;
  terminalWheelSensitivity = normalizeWheelSensitivity(settings.terminalWheelSensitivity);
  editorWheelSensitivity = normalizeWheelSensitivity(settings.editorWheelSensitivity);
  terminalTerm = normalizeTerminalTERM(settings.terminalTerm);
  terminalFont = normalizeTerminalFont(settings.terminalFont);
  terminalColorMode = normalizeTerminalColorMode(settings.terminalColorMode);
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
    const activated = await fetch(`${userAPIPath("sessions")}/${encodeURIComponent(session.id)}/activate`, { method: "POST" });
    if (!activated.ok) {
      throw new Error(`activate session failed: ${activated.status}`);
    }
    currentSessionID = session.id;
    currentSessionName = session.name;
    workspaceID = session.id;
    const route = sessionRoute(currentUser || "default", session.id);
    if (options.historyMode === "replace") {
      window.history.replaceState({}, "", route);
    } else if (options.historyMode !== "none") {
      window.history.pushState({}, "", route);
    }
    await loadWorkspace();
    await refreshSessions();
    hideSessionsModal();
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
  const base = `/api/workspace/${encodeURIComponent(workspaceID)}/background`;
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
  try {
    setWorkspaceStatus("saving", "Preparing image...");
    const jpeg = await compressBackgroundImage(file);
    if (jpeg.size > maxBackgroundBytes) {
      throw new Error("compressed image is still too large");
    }
    setWorkspaceStatus("saving", "Saving...");
    const response = await fetch(backgroundURL(""), {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: jpeg,
    });
    if (!response.ok) {
      throw new Error(`set background failed: ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    applyWorkspaceBackground(true, data.version || String(Date.now()), workspaceBackgroundMode);
    setWorkspaceStatus("saved", "Saved", "Background updated");
  } catch (error) {
    console.warn(error);
    setWorkspaceStatus("error", "Save failed", error.message || "Background save failed");
  }
}

async function clearBackground() {
  setWorkspaceStatus("saving", "Saving...");
  try {
    const response = await fetch(backgroundURL(""), { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`clear background failed: ${response.status}`);
    }
    applyWorkspaceBackground(false, "", workspaceBackgroundMode);
    setWorkspaceStatus("saved", "Saved", "Background cleared");
  } catch (error) {
    console.warn(error);
    setWorkspaceStatus("error", "Clear failed", error.message || "Background clear failed");
  }
}

const commandSpinnerFrames = ["\u25f0", "\u25f3", "\u25f2", "\u25f1"];
const commandSpinnerIntervalMs = 120;

const worksheetFilenameWordChars = EditorState.languageData.of(() => [{
  wordChars: ".-_",
}]);

const defaultWorksheetEditorMode = "free";
const normalWorksheetEditorMode = "normal";
const fileBrowserPaneKind = "file-browser";
const textEditorPaneKind = "text-editor";
const audioPaneKind = "audio";
const browserPaneKind = "browser";
const textEditorFileExtensions = new Set([
  ".txt", ".md", ".markdown", ".log", ".csv", ".tsv",
  ".json", ".jsonc", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".go", ".py", ".rb", ".php", ".java", ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".rs",
  ".sql", ".graphql", ".gql", ".vue", ".svelte", ".astro",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".psd1", ".bat", ".cmd",
]);

function textEditorLanguageExtension(path) {
  switch (textEditorLanguageID(path)) {
    case "markdown": return markdown();
    case "json": return javascript({ json: true });
    case "xml": return xml();
    case "yaml": return yaml();
    case "html": return html();
    case "css": return css();
    case "javascript": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "typescript": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "go": return go();
    case "python": return python();
    case "php": return php();
    case "java": return java();
    case "cpp": return cpp();
    case "rust": return rust();
    case "sql": return sql();
    default: return null;
  }
}

function newTextEditorTab(path = "", text = "") {
  return { id: newPaneID(), path, text, selection: 0 };
}

function parseTextEditorTabs(rawTabs, fallbackPath, fallbackText) {
  try {
    const saved = typeof rawTabs === "string" ? JSON.parse(rawTabs) : rawTabs;
    const tabs = Array.isArray(saved?.tabs) ? saved.tabs
      .filter((tab) => tab && typeof tab === "object")
      .map((tab) => ({
        id: typeof tab.id === "string" && tab.id ? tab.id : newPaneID(),
        path: typeof tab.path === "string" ? tab.path : "",
        text: typeof tab.text === "string" ? tab.text : "",
        selection: Number.isInteger(tab.selection) ? Math.max(0, tab.selection) : 0,
      })) : [];
    if (tabs.length > 0) {
      return { tabs, active: Math.max(0, Math.min(Number(saved.active) || 0, tabs.length - 1)) };
    }
  } catch {
    // Older panes have no tab document; fall back to their single saved file.
  }
  return { tabs: [newTextEditorTab(fallbackPath, fallbackText)], active: 0 };
}

function activeTextEditorTab(rect) {
  return rect.textEditorTabs?.[rect.activeTextEditorTab] || null;
}

function syncActiveTextEditorTab(rect) {
  const tab = activeTextEditorTab(rect);
  if (!tab) {
    return;
  }
  rect.text = tab.text;
  rect.lastExportPath = tab.path;
}

function rememberActiveTextEditorTab(rect) {
  const tab = activeTextEditorTab(rect);
  if (!tab || !rect.editor) {
    return;
  }
  tab.text = rect.editor.state.doc.toString();
  tab.selection = rect.editor.state.selection.main.head;
  rect.text = tab.text;
}

function serializedTextEditorTabs(rect) {
  rememberActiveTextEditorTab(rect);
  return JSON.stringify({
    active: rect.activeTextEditorTab,
    tabs: rect.textEditorTabs.map((tab) => ({
      id: tab.id,
      path: tab.path,
      text: tab.text,
      selection: tab.selection,
    })),
  });
}

const freeCursorExtension = Prec.highest([
  keymap.of([
    { key: "ArrowUp", run: (view) => moveFreeCursorVertically(view, -1), preventDefault: true },
    { key: "ArrowDown", run: (view) => moveFreeCursorVertically(view, 1), preventDefault: true },
    { key: "ArrowRight", run: moveFreeCursorRight, preventDefault: true },
  ]),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      return moveFreeCursorFromMouse(view, event);
    },
  }),
]);

const dockMenu = document.createElement("div");
dockMenu.className = "dock-menu";
dockMenu.hidden = true;
document.body.appendChild(dockMenu);

const editorMenu = document.createElement("div");
editorMenu.className = "dock-menu editor-menu";
editorMenu.hidden = true;
document.body.appendChild(editorMenu);

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
commandPaletteInput.placeholder = "Type a command or window name...";
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
commandPaletteInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    movePaletteSelection(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const commands = buildPaletteCommands();
    assignPaletteShortcutCodes(commands);
    const codeMatch = findPaletteCodeMatch(commandPaletteInput.value, commands);
    if (codeMatch) {
      runPaletteCommand(codeMatch);
    } else {
      runPaletteSelection();
    }
  }
});

// A small floating launcher for the command palette — the persistent,
// touch-reachable entry point (tapping it focuses the input, which raises the
// on-screen keyboard). Bottom-right, clear of each window's title-bar controls
// (grip at top-left, minimize/maximize at top-right).
const windowList = document.createElement("div");
windowList.className = "command-palette window-list";
windowList.hidden = true;
const windowListPanel = document.createElement("div");
windowListPanel.className = "command-palette-panel window-list-panel";
windowListPanel.tabIndex = 0;
windowListPanel.setAttribute("aria-label", "Window list");
const windowListTitle = document.createElement("div");
windowListTitle.className = "window-list-title";
windowListTitle.textContent = "Window List";
const windowListItems = document.createElement("div");
windowListItems.className = "command-palette-list window-list-items";
windowListPanel.append(windowListTitle, windowListItems);
windowList.appendChild(windowListPanel);
document.body.appendChild(windowList);

windowList.addEventListener("pointerdown", (event) => {
  if (event.target === windowList) {
    hideWindowList();
  }
});
windowListPanel.addEventListener("keydown", handleWindowListKeyboard);

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

board.addEventListener("pointerdown", startDrawing);
board.addEventListener("contextmenu", openWorkspaceMenu);
document.addEventListener("pointerdown", hideMenusWhenOutside);
document.addEventListener("keydown", hideMenusOnEscape);
document.addEventListener("keydown", handlePaneKeyboardShortcuts, { capture: true });
document.addEventListener("visibilitychange", updateTerminalDocumentVisibility);
window.addEventListener("pointermove", continueInteraction);
window.addEventListener("pointerup", finishInteraction);
window.addEventListener("pointercancel", finishInteraction);
window.addEventListener("resize", hideAllMenus);
window.addEventListener("popstate", () => void handleSessionHistoryNavigation());
window.addEventListener("message", handleBrowserPaneMessage);

applyTheme(themeID, { save: false });
void startApp()
  .catch((error) => console.warn(error))
  .finally(startServerConnectionMonitor);

function startDrawing(event) {
  if (event.button !== 0 || event.target !== board) {
    return;
  }
  event.preventDefault();
  hideAllMenus();

  const point = boardPoint(event);
  const cwd = activeRect?.cwd || "";
  if (activeRect || activePaneID) {
    clearActivePane();
  }
  const rect = createRectangle(point.x, point.y, 1, 1, {
    kind: "pending",
    cwd,
    zIndex: nextZIndex,
  });
  nextZIndex += 1;

  interaction = {
    type: "draw",
    id: event.pointerId,
    rect,
    startX: point.x,
    startY: point.y,
  };
  board.setPointerCapture(event.pointerId);
}

function startMoving(event, rect) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  hideFloatingMenus();
  setActivePane(rect, { raise: true });

  const point = boardPoint(event);
  interaction = {
    type: "move",
    id: event.pointerId,
    rect,
    startX: point.x,
    startY: point.y,
    original: { ...rect },
  };
  rect.element.setPointerCapture(event.pointerId);
}

function startResizing(event, rect, handle) {
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
  setActivePane(rect, { raise: true });

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
    if (finishedInteraction.rect.width < 6 || finishedInteraction.rect.height < 6) {
      destroyRectangle(finishedInteraction.rect, { selectNext: false });
      return;
    }
    showWindowTypeMenu(finishedInteraction.rect, event.clientX, event.clientY);
    return;
  }

  if (finishedInteraction.type === "move") {
    setOLEDMoveMode(finishedInteraction.rect, false);
  }

}

function createRectangle(x, y, width, height, options = {}) {
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
    kind: options.kind || "worksheet",
    x,
    y,
    width,
    height,
    element,
    zIndex: options.zIndex || 0,
    title: options.title || defaultPaneTitle(options.kind || "worksheet"),
    text: options.kind === "terminal" ? "" : (options.text || ""),
    editorMode: normalizeWorksheetEditorMode(options.editorMode),
    fontSize: normalizePaneFontSize(options.fontSize),
    cwd: options.cwd || "",
    lastExportPath: options.lastExportPath || "",
    textEditorTabs: [],
    activeTextEditorTab: 0,
    textEditorTabBar: null,
    oledMoveMode: false,
    fileBrowserSidebarWidth: normalizeFileBrowserSidebarWidth(options.fileBrowserSidebarWidth),
    running: false,
    runID: "",
    commandSpinner: null,
    terminal: null,
    terminalContainer: null,
    body: null,
    titleInput: null,
    editorModeButton: null,
    fontSizeValue: null,
    fontSizeDecreaseButton: null,
    fontSizeIncreaseButton: null,
    filePathInput: null,
    browserStatusInput: null,
    fileBrowserView: null,
    fileBrowserRequestID: 0,
    browserUrl: options.browserUrl || "",
    browser: null,
    audio: null,
    isFull: Boolean(options.isFull),
    minimized: Boolean(options.minimized),
    restoreBox: options.restoreBox || null,
    minButton: null,
    maxButton: null,
  };
  if (rect.kind === textEditorPaneKind) {
    const tabState = parseTextEditorTabs(options.editorTabs, rect.lastExportPath, rect.text);
    rect.textEditorTabs = tabState.tabs;
    rect.activeTextEditorTab = tabState.active;
    syncActiveTextEditorTab(rect);
  }
  element.dataset.paneId = rect.id;
  element.dataset.paneKind = rect.kind;
  element.dataset.oledMoveMode = "false";
  element.style.setProperty("--pane-editor-font-size", `${rect.fontSize}px`);
  element.style.setProperty("--file-browser-sidebar-width", `${rect.fileBrowserSidebarWidth}px`);
  element.classList.toggle("is-full", rect.isFull);
  element.classList.toggle("is-minimized", rect.minimized);
  if (rect.minimized) {
    element.setAttribute("aria-hidden", "true");
  }

  function toggleFromTitleBar(event) {
    event.preventDefault();
    event.stopPropagation();
    hideFloatingMenus();
    toggleMinimize(rect);
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
    startMoving(event, rect);
  });
  tab.addEventListener("dblclick", (event) => {
    if (controls.contains(event.target)) {
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
  rect.minButton = minButton;
  rect.maxButton = maxButton;
  for (const [button, run] of [[minButton, () => toggleMinimize(rect)], [maxButton, () => toggleFullRestore(rect)]]) {
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

  const status = document.createElement("div");
  status.className = "window-status";

  const modeButton = document.createElement("button");
  modeButton.className = "window-editor-mode";
  modeButton.type = "button";
  modeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleWorksheetEditorMode(rect);
  });

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
  cwdLabel.textContent = rect.kind === fileBrowserPaneKind
    ? "path"
    : rect.kind === textEditorPaneKind
      ? "file"
      : rect.kind === browserPaneKind
        ? "url"
      : rect.kind === audioPaneKind
        ? "station"
      : "cwd";

  const cwdInput = document.createElement("input");
  cwdInput.className = "window-cwd";
  cwdInput.type = "text";
  cwdInput.value = rect.kind === textEditorPaneKind
    ? rect.lastExportPath
    : rect.kind === browserPaneKind
      ? rect.browserUrl
    : rect.kind === audioPaneKind
      ? "Shared across clients"
      : rect.cwd;
  cwdInput.placeholder = rect.kind === fileBrowserPaneKind
    ? "loading..."
    : rect.kind === textEditorPaneKind
      ? "untitled"
      : rect.kind === browserPaneKind
        ? "localhost:5000"
      : rect.kind === audioPaneKind
        ? "Shared across clients"
      : "host default";
  cwdInput.readOnly = true;
  cwdInput.spellcheck = false;
  cwdInput.setAttribute("aria-label", rect.kind === fileBrowserPaneKind
    ? "Current folder"
    : rect.kind === textEditorPaneKind
      ? "Editor file"
      : rect.kind === browserPaneKind
        ? "Browser address"
      : rect.kind === audioPaneKind
        ? "Shared audio station"
      : "Pane working directory");
  cwdInput.addEventListener("pointerdown", (event) => {
    if (rect.kind === fileBrowserPaneKind || rect.kind === browserPaneKind || rect.kind === audioPaneKind) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hideFloatingMenus();
    setActivePane(rect, { raise: true });
    if (rect.kind === textEditorPaneKind) {
      void openEditorFileBrowser(rect, "import");
    } else {
      openDirectoryBrowser(rect, rect.cwd);
    }
  });
  cwdInput.addEventListener("keydown", (event) => {
    if (rect.kind === fileBrowserPaneKind || rect.kind === browserPaneKind || rect.kind === audioPaneKind) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setActivePane(rect, { raise: true });
      if (rect.kind === textEditorPaneKind) {
        void openEditorFileBrowser(rect, "import");
      } else {
        openDirectoryBrowser(rect, rect.cwd);
      }
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
    : rect.kind === fileBrowserPaneKind
      ? "File browser"
      : rect.kind === textEditorPaneKind
        ? "Text editor"
      : rect.kind === browserPaneKind
        ? "Browser"
      : rect.kind === audioPaneKind
        ? "Audio station"
      : rect.kind === "pending"
        ? "New window"
        : "Workspace text");
  body.addEventListener("pointerdown", () => {
    hideFloatingMenus();
  }, { capture: true });
  // A right-click on an OLED border arms this explicit move mode. Keep it
  // ahead of terminal mouse reporting and editor selection handling.
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
  if (rect.kind === "worksheet" || rect.kind === textEditorPaneKind) {
    body.addEventListener("contextmenu", (event) => openEditorMenu(event, rect));
  }

  tab.appendChild(grip);
  tab.appendChild(title);
  tab.appendChild(controls);
  updateWindowControls(rect);
  if (rect.kind === "worksheet") {
    rect.editorModeButton = modeButton;
    status.appendChild(modeButton);
    updateWorksheetEditorModeUI(rect);
  }
  if (rect.kind === "terminal" || rect.kind === "worksheet" || rect.kind === textEditorPaneKind) {
    status.appendChild(fontSizeControl);
    updatePaneFontSizeUI(rect);
  }
  status.appendChild(cwdLabel);
  status.appendChild(cwdInput);
  element.appendChild(tab);
  element.appendChild(body);
  element.appendChild(status);
  if (rect.kind === textEditorPaneKind) {
    rect.filePathInput = cwdInput;
  } else if (rect.kind === browserPaneKind) {
    rect.browserStatusInput = cwdInput;
  } else if (rect.kind !== browserPaneKind && rect.kind !== audioPaneKind) {
    rect.cwdInput = cwdInput;
  }
  setPaneCwd(rect, rect.cwd, { silent: true });

  if (rect.kind === "terminal") {
    body.classList.add("is-terminal");
    const terminalContainer = document.createElement("div");
    terminalContainer.className = "terminal-container";
    body.appendChild(terminalContainer);
    rect.terminalContainer = terminalContainer;
    void startTerminal(rect);
  } else if (rect.kind === "worksheet") {
    mountWorksheetEditor(rect);
  } else if (rect.kind === fileBrowserPaneKind) {
    mountPaneFileBrowser(rect);
  } else if (rect.kind === textEditorPaneKind) {
    mountTextEditor(rect);
  } else if (rect.kind === browserPaneKind) {
    mountBrowserPane(rect);
  } else if (rect.kind === audioPaneKind) {
    mountAudioPane(rect);
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
  if (rect.kind === audioPaneKind) {
    void refreshAudioStationState();
    connectAudioStationEvents();
  }
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
      void fetch(`/api/browser-proxy/${encodeURIComponent(previousSessionID)}`, { method: "DELETE" });
    }
  } catch (error) {
    browser.message.textContent = error.message || "Could not open development server.";
    browser.message.classList.add("is-error");
    browser.message.hidden = false;
    browser.frame.hidden = true;
  }
}

function handleBrowserPaneMessage(event) {
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

function disposeBrowserPane(rect) {
  const browser = rect?.browser;
  if (!browser) {
    return;
  }
  const sessionID = browser.sessionID;
  browser.sessionID = "";
  browser.frame.src = "about:blank";
  rect.browser = null;
  if (sessionID) {
    void fetch(`/api/browser-proxy/${encodeURIComponent(sessionID)}`, { method: "DELETE" });
  }
}

function readAudioVolume() {
  const stored = window.localStorage.getItem(audioVolumeStorageKey);
  if (stored === null) {
    return 0.8;
  }
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8;
}

function broadcastAudioStationState(state) {
  audioStationState = state;
  for (const rect of rectangles) {
    if (rect.kind === audioPaneKind && rect.audio) {
      renderAudioPane(rect, state);
    }
  }
}

async function refreshAudioStationState() {
  try {
    const response = await fetch("/api/audio/state", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`audio state failed: ${response.status}`);
    }
    broadcastAudioStationState(await response.json());
  } catch (error) {
    for (const rect of rectangles) {
      if (rect.kind === audioPaneKind && rect.audio) {
        rect.audio.message.textContent = error.message || "Audio station unavailable";
        rect.audio.message.classList.add("is-error");
      }
    }
  }
}

function connectAudioStationEvents() {
  window.clearTimeout(audioStationReconnectTimer);
  audioStationReconnectTimer = null;
  if (audioStationEvents || !rectangles.some((rect) => rect.kind === audioPaneKind)) {
    return;
  }
  audioStationEvents = new EventSource("/api/audio/events");
  audioStationEvents.addEventListener("state", (event) => {
    try {
      broadcastAudioStationState(JSON.parse(event.data));
    } catch (error) {
      console.warn(error);
    }
  });
  audioStationEvents.onerror = () => {
    audioStationEvents?.close();
    audioStationEvents = null;
    for (const rect of rectangles) {
      if (rect.kind === audioPaneKind && rect.audio && audioStationState?.status === "playing") {
        rect.audio.message.textContent = "Stream disconnected";
        rect.audio.message.classList.add("is-error");
      }
    }
    audioStationReconnectTimer = window.setTimeout(() => {
      void refreshAudioStationState();
      connectAudioStationEvents();
    }, 2000);
  };
}

async function requestAudioStation(path, method, body) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `audio request failed: ${response.status}`);
  }
  broadcastAudioStationState(data);
  return data;
}

function audioPosition(state) {
  let position = Number(state?.positionSeconds) || 0;
  if (state?.status === "playing" && state.seekable && state.startedAt) {
    position += Math.max(0, (Date.now() - Date.parse(state.startedAt)) / 1000);
  }
  return position;
}

function renderAudioPane(rect, state) {
  const view = rect.audio;
  if (!view) {
    return;
  }
  const source = state?.source || null;
  view.source.textContent = source?.label || "No source selected";
  view.play.textContent = state?.status === "playing" ? "Pause" : "Play";
  view.play.disabled = !source;
  view.stop.disabled = !source;
  view.seekRow.hidden = !state?.seekable;
  const position = audioPosition(state);
  if (!view.seeking) {
    view.seek.value = String(position);
  }
  view.elapsed.textContent = formatAudioTime(position);

  const sourceVersion = Number(state?.sourceVersion) || 0;
  if (source && view.sourceVersion !== sourceVersion) {
    view.element.pause();
    view.sourceVersion = sourceVersion;
    view.element.src = `/api/audio/stream?sourceVersion=${encodeURIComponent(sourceVersion)}`;
    view.element.load();
  } else if (!source && view.sourceVersion !== 0) {
    view.element.pause();
    view.element.removeAttribute("src");
    view.element.load();
    view.sourceVersion = 0;
  }

  view.message.classList.toggle("is-error", Boolean(state?.error));
  view.message.textContent = state?.error || state?.warning || (source?.kind === "terminal" && state?.captureError) || statusAudioMessage(state);
  view.join.hidden = true;

  if (state?.status === "playing" && source) {
    if (state.seekable && Math.abs((view.element.currentTime || 0) - position) > 2) {
      try {
        view.element.currentTime = position;
      } catch (_) {
        // Metadata may not be available yet; loadedmetadata retries below.
      }
    }
    const playResult = view.element.play();
    if (playResult?.catch) {
      playResult.catch((error) => {
        if (error?.name === "NotAllowedError") {
          view.join.hidden = false;
          view.message.textContent = "Tap to listen";
          view.message.classList.remove("is-error");
        } else if (audioStationState?.status === "playing") {
          view.message.textContent = "Stream disconnected";
          view.message.classList.add("is-error");
        }
      });
    }
  } else {
    view.element.pause();
    if (state?.status === "stopped" && state?.seekable) {
      try {
        view.element.currentTime = 0;
      } catch (_) {}
    }
  }
}

function statusAudioMessage(state) {
  if (!state?.source) {
    return "Choose a host file, stream URL, or Terminal pane.";
  }
  if (state.status === "playing") {
    return "Playing for all connected listeners";
  }
  if (state.status === "paused") {
    return "Paused";
  }
  return "Stopped";
}

function formatAudioTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, "0")}`;
}

async function chooseAudioFile(rect) {
  if (rect) {
    await openAudioFileBrowser(rect);
  }
}

async function chooseAudioURL(value) {
  if (!value?.trim()) {
    throw new Error("Enter a direct HTTP(S) audio URL");
  }
  await requestAudioStation("/api/audio/source", "PUT", { kind: "url", value: value.trim() });
}

async function chooseAudioTerminal(paneID) {
  const terminals = rectangles.filter((rect) => rect.kind === "terminal" && rect.terminal?.socket?.readyState === WebSocket.OPEN);
  if (terminals.length === 0) {
    throw new Error("Terminal is not running");
  }
  const selected = terminals.find((rect) => rect.id === paneID);
  if (!selected) {
    throw new Error("Select a listed Terminal pane");
  }
  await requestAudioStation("/api/audio/source", "PUT", {
    kind: "terminal",
    workspaceId: workspaceID,
    paneId: selected.id,
    label: selected.title || "Terminal",
  });
}

function mountAudioPane(rect) {
  rect.body.classList.add("is-audio");
  const root = document.createElement("div");
  root.className = "audio-pane";
  const source = document.createElement("div");
  source.className = "audio-source";
  source.textContent = "Loading audio station...";
  const sourceActions = document.createElement("div");
  sourceActions.className = "audio-source-actions";
  const chooseFile = audioButton("Choose File…");
  const chooseURL = audioButton("Set Stream URL…");
  const chooseTerminal = audioButton("Link Terminal…");
  sourceActions.append(chooseFile, chooseURL, chooseTerminal);

  const urlEditor = document.createElement("div");
  urlEditor.className = "audio-source-editor";
  urlEditor.hidden = true;
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder = "https://example.com/live.mp3";
  urlInput.setAttribute("aria-label", "Direct audio stream URL");
  const applyURL = audioButton("Use URL");
  const cancelURL = audioButton("Cancel");
  urlEditor.append(urlInput, applyURL, cancelURL);

  const terminalEditor = document.createElement("div");
  terminalEditor.className = "audio-source-editor";
  terminalEditor.hidden = true;
  const terminalSelect = document.createElement("select");
  terminalSelect.setAttribute("aria-label", "Running Terminal pane");
  const applyTerminal = audioButton("Link");
  const cancelTerminal = audioButton("Cancel");
  terminalEditor.append(terminalSelect, applyTerminal, cancelTerminal);

  const transport = document.createElement("div");
  transport.className = "audio-transport";
  const play = audioButton("Play");
  const stop = audioButton("Stop");
  const join = audioButton("Tap to listen");
  join.classList.add("audio-join");
  join.hidden = true;
  transport.append(play, stop, join);

  const seekRow = document.createElement("div");
  seekRow.className = "audio-seek-row";
  const seek = document.createElement("input");
  seek.type = "range";
  seek.min = "0";
  seek.max = "86400";
  seek.step = "0.1";
  seek.value = "0";
  seek.setAttribute("aria-label", "Audio position");
  const elapsed = document.createElement("output");
  elapsed.textContent = "0:00";
  seekRow.append(seek, elapsed);

  const listener = document.createElement("div");
  listener.className = "audio-listener-controls";
  const muteLabel = document.createElement("label");
  const mute = document.createElement("input");
  mute.type = "checkbox";
  muteLabel.append(mute, document.createTextNode(" Mute this browser"));
  const volume = document.createElement("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = String(readAudioVolume());
  volume.setAttribute("aria-label", "Browser volume");
  listener.append(muteLabel, volume);

  const message = document.createElement("div");
  message.className = "audio-message";
  const element = document.createElement("audio");
  element.preload = "metadata";
  element.volume = Number(volume.value);
  root.append(source, sourceActions, urlEditor, terminalEditor, transport, seekRow, listener, message, element);
  rect.body.appendChild(root);
  rect.audio = { root, source, play, stop, join, seekRow, seek, elapsed, mute, volume, message, element, sourceVersion: -1, seeking: false };

  const showError = (error) => {
    message.textContent = error.message || "Audio station unavailable";
    message.classList.add("is-error");
  };
  chooseFile.addEventListener("click", () => void chooseAudioFile(rect).catch(showError));
  chooseURL.addEventListener("click", () => {
    terminalEditor.hidden = true;
    urlInput.value = audioStationState?.source?.kind === "url" ? audioStationState.source.value : "https://";
    urlEditor.hidden = false;
    urlInput.focus();
    urlInput.select();
  });
  cancelURL.addEventListener("click", () => { urlEditor.hidden = true; });
  applyURL.addEventListener("click", () => void chooseAudioURL(urlInput.value).then(() => { urlEditor.hidden = true; }).catch(showError));
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyURL.click();
    } else if (event.key === "Escape") {
      urlEditor.hidden = true;
    }
  });
  chooseTerminal.addEventListener("click", () => {
    urlEditor.hidden = true;
    terminalSelect.replaceChildren();
    const terminals = rectangles.filter((pane) => pane.kind === "terminal" && pane.terminal?.socket?.readyState === WebSocket.OPEN);
    if (terminals.length === 0) {
      showError(new Error("Terminal is not running"));
      return;
    }
    for (const terminal of terminals) {
      const option = document.createElement("option");
      option.value = terminal.id;
      option.textContent = terminal.title || "Terminal";
      terminalSelect.appendChild(option);
    }
    terminalEditor.hidden = false;
    terminalSelect.focus();
  });
  cancelTerminal.addEventListener("click", () => { terminalEditor.hidden = true; });
  applyTerminal.addEventListener("click", () => void chooseAudioTerminal(terminalSelect.value).then(() => { terminalEditor.hidden = true; }).catch(showError));
  play.addEventListener("click", () => {
    const action = audioStationState?.status === "playing" ? "pause" : "play";
    void requestAudioStation("/api/audio/control", "POST", { action }).catch(showError);
  });
  stop.addEventListener("click", () => void requestAudioStation("/api/audio/control", "POST", { action: "stop" }).catch(showError));
  join.addEventListener("click", () => {
    element.play().then(() => { join.hidden = true; }).catch(showError);
  });
  seek.addEventListener("pointerdown", () => { rect.audio.seeking = true; });
  seek.addEventListener("input", () => {
    elapsed.textContent = formatAudioTime(seek.value);
  });
  seek.addEventListener("change", () => {
    rect.audio.seeking = false;
    void requestAudioStation("/api/audio/control", "POST", { action: "seek", positionSeconds: Number(seek.value) }).catch(showError);
  });
  volume.addEventListener("input", () => {
    element.volume = Number(volume.value);
    window.localStorage.setItem(audioVolumeStorageKey, volume.value);
  });
  mute.addEventListener("change", () => { element.muted = mute.checked; });
  element.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(element.duration)) {
      seek.max = String(element.duration);
    }
    if (audioStationState?.seekable) {
      try { element.currentTime = audioPosition(audioStationState); } catch (_) {}
    }
  });
  element.addEventListener("timeupdate", () => {
    if (!rect.audio?.seeking && audioStationState?.seekable) {
      seek.value = String(element.currentTime || 0);
      elapsed.textContent = formatAudioTime(element.currentTime);
    }
  });
  element.addEventListener("error", () => {
    if (audioStationState?.status === "playing") {
      message.textContent = "Stream disconnected";
      message.classList.add("is-error");
    }
  });

  if (audioStationState) {
    renderAudioPane(rect, audioStationState);
  }
}

function audioButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  return button;
}

function mountPaneFileBrowser(rect) {
  const body = rect.body;
  body.classList.add("is-file-browser");

  const shell = document.createElement("div");
  shell.className = "pane-file-browser";

  const toolbar = document.createElement("div");
  toolbar.className = "pane-file-browser-toolbar";

  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.className = "pane-file-browser-tool";
  upButton.textContent = "Up";
  upButton.title = "Open parent folder";
  upButton.setAttribute("aria-label", "Open parent folder");
  upButton.addEventListener("click", () => {
    const parent = rect.fileBrowserView?.data?.parent;
    if (parent) {
      void navigatePaneFileBrowser(rect, parent);
    }
  });

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "pane-file-browser-tool";
  refreshButton.textContent = "Refresh";
  refreshButton.title = "Refresh folder";
  refreshButton.addEventListener("click", () => {
    void navigatePaneFileBrowser(rect, rect.fileBrowserView?.data?.path || rect.cwd || "");
  });

  const uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.multiple = true;
  uploadInput.hidden = true;
  uploadInput.addEventListener("change", () => {
    const files = [...uploadInput.files];
    uploadInput.value = "";
    if (files.length > 0) {
      void uploadPaneFiles(rect, files);
    }
  });
  const uploadButton = paneFileBrowserTool("Upload", "Upload files into this folder", () => uploadInput.click());
  const downloadButton = paneFileBrowserTool("Download", "Download selected file", () => downloadPaneFileSelection(rect));

  const copyButton = paneFileBrowserTool("Copy", "Copy selected item", () => {
    queuePaneFileOperation(rect, "copy");
  });
  const pasteButton = paneFileBrowserTool("Paste", "Paste queued item into this folder", () => {
    void pastePaneFileOperation(rect);
  });
  const moveButton = paneFileBrowserTool("Move", "Move selected item, then paste it into another folder", () => {
    queuePaneFileOperation(rect, "move");
  });
  const deleteButton = paneFileBrowserTool("Delete", "Delete selected item", () => {
    void deletePaneFileSelection(rect);
  });

  const path = document.createElement("div");
  path.className = "pane-file-browser-path";

  toolbar.appendChild(upButton);
  toolbar.appendChild(refreshButton);
  toolbar.appendChild(uploadButton);
  toolbar.appendChild(downloadButton);
  toolbar.appendChild(copyButton);
  toolbar.appendChild(pasteButton);
  toolbar.appendChild(moveButton);
  toolbar.appendChild(deleteButton);
  toolbar.appendChild(path);

  const main = document.createElement("div");
  main.className = "pane-file-browser-main";
  const sidebar = document.createElement("nav");
  sidebar.className = "pane-file-browser-sidebar";
  sidebar.setAttribute("aria-label", "File locations");
  const sidebarResizeHandle = document.createElement("div");
  sidebarResizeHandle.className = "pane-file-browser-resize-handle";
  sidebarResizeHandle.setAttribute("role", "separator");
  sidebarResizeHandle.setAttribute("aria-orientation", "vertical");
  sidebarResizeHandle.setAttribute("aria-label", "Resize file locations panel");
  sidebarResizeHandle.addEventListener("pointerdown", (event) => {
    startFileBrowserSidebarResize(event, rect, sidebarResizeHandle);
  });
  const content = document.createElement("section");
  content.className = "pane-file-browser-content";
  content.setAttribute("aria-label", "Folder contents");
  content.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      content.classList.add("is-drop-target");
    }
  });
  content.addEventListener("dragleave", (event) => {
    if (!content.contains(event.relatedTarget)) {
      content.classList.remove("is-drop-target");
    }
  });
  content.addEventListener("drop", (event) => {
    event.preventDefault();
    content.classList.remove("is-drop-target");
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length > 0) {
      void uploadPaneFiles(rect, files);
    }
  });
  main.appendChild(sidebar);
  main.appendChild(sidebarResizeHandle);
  main.appendChild(content);

  shell.appendChild(toolbar);
  shell.appendChild(main);
  const transferStatus = document.createElement("div");
  transferStatus.className = "pane-file-browser-transfer";
  transferStatus.hidden = true;
  const transferText = document.createElement("span");
  const transferProgress = document.createElement("progress");
  transferProgress.max = 100;
  transferProgress.value = 0;
  transferStatus.append(transferText, transferProgress);
  shell.appendChild(transferStatus);
  shell.appendChild(uploadInput);
  body.appendChild(shell);

  rect.fileBrowserView = {
    data: null,
    selected: null,
    upButton,
    uploadButton,
    downloadButton,
    copyButton,
    pasteButton,
    moveButton,
    deleteButton,
    path,
    sidebar,
    sidebarResizeHandle,
    content,
    transferStatus,
    transferText,
    transferProgress,
    uploading: false,
    transferBatchID: 0,
    transferHideTimer: null,
  };
  updatePaneFileBrowserActions(rect);
  renderPaneFileBrowserMessage(rect, "Loading...");
  void navigatePaneFileBrowser(rect, rect.cwd || "");
}

function paneFileBrowserTool(label, title, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pane-file-browser-tool";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", action);
  return button;
}

async function navigatePaneFileBrowser(rect, path) {
  if (!rect?.fileBrowserView) {
    return;
  }
  const requestID = ++rect.fileBrowserRequestID;
  renderPaneFileBrowserMessage(rect, "Loading...");

  const url = path
    ? `/api/directories?files=1&path=${encodeURIComponent(path)}`
    : "/api/directories?files=1";
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `folder load failed: ${response.status}`);
    }
    if (requestID !== rect.fileBrowserRequestID || !rect.fileBrowserView) {
      return;
    }
    rect.fileBrowserView.data = data;
    setPaneCwd(rect, data.path || "");
    renderPaneFileBrowser(rect, data);
  } catch (error) {
    if (requestID === rect.fileBrowserRequestID) {
      renderPaneFileBrowserMessage(rect, error.message || "Could not load folder", true);
    }
  }
}

function renderPaneFileBrowser(rect, data) {
  const view = rect.fileBrowserView;
  if (!view) {
    return;
  }
  view.path.textContent = data.path || "Computer";
  view.path.title = data.path || "Computer";
  view.upButton.disabled = !data.parent;
  view.selected = null;
  view.sidebar.replaceChildren();

  appendPaneFileBrowserLocations(rect, view.sidebar, "Locations", data.locations || [], data.path);
  appendPaneFileBrowserLocations(rect, view.sidebar, "Drives", data.roots || [], data.path);

  view.content.replaceChildren();
  const header = document.createElement("div");
  header.className = "pane-file-browser-columns";
  const nameHeader = document.createElement("span");
  nameHeader.textContent = "Name";
  const typeHeader = document.createElement("span");
  typeHeader.textContent = "Type";
  header.appendChild(nameHeader);
  header.appendChild(typeHeader);
  view.content.appendChild(header);

  const list = document.createElement("div");
  list.className = "pane-file-browser-list";
  if ((data.entries || []).length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-file-browser-message";
    empty.textContent = "This folder is empty";
    list.appendChild(empty);
  }

  for (const entry of data.entries || []) {
    const canOpenInEditor = entry.kind === "file" && isTextEditorFilePath(entry.path);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pane-file-browser-entry";
    row.dataset.kind = entry.kind;
    row.dataset.openable = canOpenInEditor ? "true" : "false";
    row.title = canOpenInEditor ? `${entry.path}\nDouble-click to open in Text Editor` : entry.path;

    const name = document.createElement("span");
    name.className = "pane-file-browser-name";
    name.textContent = entry.name;
    const type = document.createElement("span");
    type.className = "pane-file-browser-type";
    type.textContent = entry.kind === "directory" ? "Folder" : canOpenInEditor ? "Text" : "File";
    row.appendChild(name);
    row.appendChild(type);

    row.addEventListener("click", () => {
      for (const selected of list.querySelectorAll(".is-selected")) {
        selected.classList.remove("is-selected");
      }
      row.classList.add("is-selected");
      view.selected = entry;
      updatePaneFileBrowserActions(rect);
    });
    row.addEventListener("dblclick", () => {
      if (entry.kind === "directory") {
        void navigatePaneFileBrowser(rect, entry.path);
      } else if (canOpenInEditor) {
        void openFileFromPaneFileBrowser(entry.path, rect);
      }
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (entry.kind === "directory" || canOpenInEditor)) {
        event.preventDefault();
        if (entry.kind === "directory") {
          void navigatePaneFileBrowser(rect, entry.path);
        } else {
          void openFileFromPaneFileBrowser(entry.path, rect);
        }
      }
    });
    list.appendChild(row);
  }
  view.content.appendChild(list);
  updatePaneFileBrowserActions(rect);
}

function isTextEditorFilePath(path) {
  const name = fileNameFromPath(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && textEditorFileExtensions.has(name.slice(dot));
}

function fileNameFromPath(path) {
  const trimmed = (path || "").replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function editorPathKey(path) {
  const normalized = (path || "").replaceAll("\\", "/");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

async function openFileFromPaneFileBrowser(path, sourceRect) {
  if (!isTextEditorFilePath(path)) {
    return;
  }
  const pathKey = editorPathKey(path);
  const existing = rectangles.find((rect) => (
    rect.kind === textEditorPaneKind && editorPathKey(rect.lastExportPath) === pathKey
  ));
  if (existing) {
    setMinimized(existing, false);
    setActivePane(existing, { raise: true, focusEditor: true });
    return;
  }

  try {
    const data = await readHostFile(path);
    const bounds = board.getBoundingClientRect();
    const width = Math.min(Math.max(480, sourceRect?.width || 640), Math.max(320, bounds.width - 24));
    const height = Math.min(Math.max(320, sourceRect?.height || 420), Math.max(220, bounds.height - tabHeight - 24));
    const rect = createRectangle(
      (sourceRect?.x || 48) + 32,
      (sourceRect?.y || tabHeight + 32) + 32,
      width,
      height,
      {
        kind: textEditorPaneKind,
        title: fileNameFromPath(data.path || path) || "Text Editor",
        text: data.text || "",
        cwd: parentPathFromFilePath(data.path || path),
        lastExportPath: data.path || path,
        zIndex: nextZIndex,
      },
    );
    clampIntoBoard(rect);
    setRectangle(rect, rect);
    setActivePane(rect, { raise: true, focusEditor: true });
    scheduleWorkspaceSave();
    setWorkspaceStatus("saved", "Opened", data.path || path);
  } catch (error) {
    console.warn(error);
    setWorkspaceStatus("error", "Open failed", error.message || "Could not open file");
  }
}

function appendPaneFileBrowserLocations(rect, sidebar, label, entries, currentPath) {
  if (entries.length === 0) {
    return;
  }
  const heading = document.createElement("div");
  heading.className = "pane-file-browser-sidebar-heading";
  heading.textContent = label;
  sidebar.appendChild(heading);

  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pane-file-browser-location";
    button.textContent = entry.name;
    button.title = entry.path;
    button.classList.toggle("is-current", entry.path === currentPath);
    button.addEventListener("click", () => void navigatePaneFileBrowser(rect, entry.path));
    sidebar.appendChild(button);
  }
}

function renderPaneFileBrowserMessage(rect, messageText, isError = false) {
  const view = rect.fileBrowserView;
  if (!view) {
    return;
  }
  view.content.replaceChildren();
  const message = document.createElement("div");
  message.className = `pane-file-browser-message${isError ? " is-error" : ""}`;
  message.textContent = messageText;
  view.content.appendChild(message);
}

function updatePaneFileBrowserActions(rect) {
  const view = rect?.fileBrowserView;
  if (!view) {
    return;
  }
  const hasSelection = Boolean(view.selected?.path);
  const hasSelectedFile = hasSelection && view.selected.kind === "file";
  view.uploadButton.disabled = view.uploading || !view.data?.path;
  view.downloadButton.disabled = !hasSelectedFile;
  view.copyButton.disabled = !hasSelection;
  view.moveButton.disabled = !hasSelection;
  view.deleteButton.disabled = !hasSelection;
  view.pasteButton.disabled = !paneFileClipboard || !view.data?.path;
  view.pasteButton.title = paneFileClipboard
    ? `${paneFileClipboard.action === "move" ? "Move" : "Copy"} ${paneFileClipboard.name} into this folder`
    : "Paste queued item into this folder";
}

function downloadPaneFileSelection(rect) {
  const selected = rect?.fileBrowserView?.selected;
  if (!selected?.path || selected.kind !== "file") {
    return;
  }
  const query = new URLSearchParams({ path: selected.path });
  const link = document.createElement("a");
  link.href = `/api/files/download?${query}`;
  link.download = selected.name || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function uploadPaneFiles(rect, files) {
  const view = rect?.fileBrowserView;
  const destination = view?.data?.path;
  if (!view || !destination || view.uploading || files.length === 0) {
    return;
  }
  window.clearTimeout(view.transferHideTimer);
  view.transferHideTimer = null;
  const batchID = ++view.transferBatchID;
  view.uploading = true;
  view.transferStatus.hidden = false;
  view.transferStatus.classList.remove("is-error");
  updatePaneFileBrowserActions(rect);
  let uploaded = 0;
  let skipped = 0;
  const failures = [];

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const updateProgress = (loaded) => {
      const percent = file.size > 0 ? Math.min(100, Math.round((loaded / file.size) * 100)) : 100;
      view.transferText.textContent = `Uploading ${file.name} (${index + 1}/${files.length})`;
      view.transferProgress.value = percent;
    };
    updateProgress(0);
    try {
      await uploadPaneFile(destination, file, false, updateProgress);
      uploaded++;
    } catch (error) {
      if (error.status === 409) {
        if (!window.confirm(`${file.name} already exists. Replace it?`)) {
          skipped++;
          continue;
        }
        try {
          await uploadPaneFile(destination, file, true, updateProgress);
          uploaded++;
          continue;
        } catch (retryError) {
          failures.push(`${file.name}: ${retryError.message}`);
          continue;
        }
      }
      failures.push(`${file.name}: ${error.message}`);
    }
  }

  view.uploading = false;
  view.transferProgress.value = 100;
  if (failures.length > 0) {
    view.transferText.textContent = `Uploaded ${uploaded}; ${failures.length} failed`;
    view.transferStatus.classList.add("is-error");
    setWorkspaceStatus("error", "Upload failed", failures.join("; "));
  } else {
    const skippedText = skipped > 0 ? `; ${skipped} skipped` : "";
    view.transferText.textContent = `Uploaded ${uploaded} ${uploaded === 1 ? "file" : "files"}${skippedText}`;
    setWorkspaceStatus("saved", "Upload finished", `${uploaded} uploaded${skippedText}`);
    view.transferHideTimer = window.setTimeout(() => {
      if (!view.uploading && view.transferBatchID === batchID) {
        view.transferStatus.hidden = true;
        view.transferHideTimer = null;
      }
    }, 2000);
  }
  updatePaneFileBrowserActions(rect);
  if (uploaded > 0) {
    await refreshPaneFileBrowsers();
  }
}

function uploadPaneFile(destination, file, overwrite, onProgress) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      directory: destination,
      name: file.name,
      overwrite: overwrite ? "1" : "0",
    });
    const request = new XMLHttpRequest();
    request.open("POST", `/api/files/upload?${query}`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.addEventListener("progress", (event) => onProgress(event.loaded));
    request.addEventListener("load", () => {
      let data = {};
      try {
        data = JSON.parse(request.responseText || "{}");
      } catch {
        // Non-JSON proxy errors still receive a useful status fallback below.
      }
      if (request.status >= 200 && request.status < 300) {
        onProgress(file.size);
        resolve(data);
        return;
      }
      const error = new Error(data.error || `upload failed: ${request.status}`);
      error.status = request.status;
      reject(error);
    });
    request.addEventListener("error", () => reject(new Error("server connection lost during upload")));
    request.addEventListener("abort", () => reject(new Error("upload cancelled")));
    request.send(file);
  });
}

function updateAllPaneFileBrowserActions() {
  for (const rect of rectangles) {
    if (rect.kind === fileBrowserPaneKind) {
      updatePaneFileBrowserActions(rect);
    }
  }
}

function queuePaneFileOperation(rect, action) {
  const selected = rect?.fileBrowserView?.selected;
  if (!selected?.path) {
    return;
  }
  paneFileClipboard = {
    action,
    source: selected.path,
    name: selected.name,
  };
  setWorkspaceStatus("saved", action === "move" ? "Move ready" : "Copied", selected.path);
  updateAllPaneFileBrowserActions();
}

async function pastePaneFileOperation(rect) {
  const destination = rect?.fileBrowserView?.data?.path;
  const operation = paneFileClipboard;
  if (!destination || !operation) {
    return;
  }
  try {
    await requestPaneFileOperation({
      action: operation.action,
      source: operation.source,
      destination,
    });
    if (operation.action === "move") {
      paneFileClipboard = null;
    }
    setWorkspaceStatus("saved", operation.action === "move" ? "Moved" : "Copied", operation.name);
    await refreshPaneFileBrowsers();
  } catch (error) {
    setWorkspaceStatus("error", "File operation failed", error.message || "Could not paste item");
  } finally {
    updateAllPaneFileBrowserActions();
  }
}

async function deletePaneFileSelection(rect) {
  const selected = rect?.fileBrowserView?.selected;
  if (!selected?.path) {
    return;
  }
  if (!window.confirm(`Delete ${selected.name}? This cannot be undone.`)) {
    return;
  }
  try {
    await requestPaneFileOperation({
      action: "delete",
      source: selected.path,
    });
    if (paneFileClipboard?.source === selected.path) {
      paneFileClipboard = null;
    }
    setWorkspaceStatus("saved", "Deleted", selected.path);
    await refreshPaneFileBrowsers();
  } catch (error) {
    setWorkspaceStatus("error", "Delete failed", error.message || "Could not delete item");
  } finally {
    updateAllPaneFileBrowserActions();
  }
}

async function requestPaneFileOperation(operation) {
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(operation),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `file operation failed: ${response.status}`);
  }
  return data;
}

async function refreshPaneFileBrowsers() {
  const refreshes = [];
  for (const rect of rectangles) {
    if (rect.kind === fileBrowserPaneKind && rect.fileBrowserView) {
      refreshes.push(navigatePaneFileBrowser(rect, rect.fileBrowserView.data?.path || rect.cwd || ""));
    }
  }
  await Promise.all(refreshes);
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

function normalizeWorksheetEditorMode(mode) {
  return mode === normalWorksheetEditorMode ? normalWorksheetEditorMode : defaultWorksheetEditorMode;
}

function normalizePaneFontSize(fontSize) {
  const parsed = Number(fontSize);
  if (!Number.isFinite(parsed)) {
    return defaultPaneFontSize;
  }
  return Math.max(minimumPaneFontSize, Math.min(maximumPaneFontSize, Math.round(parsed)));
}

function normalizeFileBrowserSidebarWidth(width) {
  const parsed = Number(width);
  if (!Number.isFinite(parsed)) {
    return defaultFileBrowserSidebarWidth;
  }
  return Math.max(minimumFileBrowserSidebarWidth, Math.min(maximumFileBrowserSidebarWidth, Math.round(parsed)));
}

function setFileBrowserSidebarWidth(rect, width) {
  if (!rect || rect.kind !== fileBrowserPaneKind) {
    return;
  }
  rect.fileBrowserSidebarWidth = normalizeFileBrowserSidebarWidth(width);
  rect.element.style.setProperty("--file-browser-sidebar-width", `${rect.fileBrowserSidebarWidth}px`);
}

function setPaneFontSize(rect, fontSize) {
  if (!rect || (rect.kind !== "terminal" && rect.kind !== "worksheet" && rect.kind !== textEditorPaneKind)) {
    return;
  }
  rect.fontSize = normalizePaneFontSize(fontSize);
  updatePaneFontSizeUI(rect);
  if (rect.kind === "terminal" && rect.terminal?.term) {
    rect.terminal.term.options.fontSize = rect.fontSize;
    requestTerminalFit(rect);
  } else {
    rect.editor?.requestMeasure();
  }
  scheduleWorkspaceSave();
}

function updatePaneFontSizeUI(rect) {
  if (!rect) {
    return;
  }
  rect.fontSize = normalizePaneFontSize(rect.fontSize);
  rect.element.style.setProperty("--pane-editor-font-size", `${rect.fontSize}px`);
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

function mountWorksheetEditor(rect) {
  if (!rect?.body) {
    return;
  }

  const previousSelection = rect.editor?.state.selection || EditorSelection.cursor(0);
  if (rect.editor) {
    cancelWorksheetLineSelection(rect.editor);
    rect.text = rect.commandSpinner
      ? rect.commandSpinner.textWithoutSpinner(rect.editor.state.doc.toString())
      : rect.editor.state.doc.toString();
    rect.editor.destroy();
    rect.editor = null;
  }

  const editorExtensions = [
    basicSetup,
    tesseraEditorTheme,
    worksheetFilenameWordChars,
  ];
  if (rect.editorMode !== normalWorksheetEditorMode) {
    editorExtensions.push(freeCursorExtension);
  }
  editorExtensions.push(
    Prec.highest(keymap.of([
      { key: "Mod-Enter", run: () => runPaneCommand(rect), preventDefault: true },
      { key: "Ctrl-Enter", run: () => runPaneCommand(rect), preventDefault: true },
    ])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const isSpinnerChange = update.transactions.every((transaction) => (
          transaction.annotation(Transaction.userEvent) === "input.tesseraSpinner"
        ));
        if (!isSpinnerChange) {
          rect.commandSpinner?.map(update.changes);
        }
        rect.text = rect.commandSpinner
          ? rect.commandSpinner.textWithoutSpinner(update.state.doc.toString())
          : update.state.doc.toString();
        if (!rect.running) {
          scheduleWorkspaceSave();
        }
      }
    }),
  );

  rect.editor = new EditorView({
    doc: rect.text,
    selection: clampEditorSelection(previousSelection, rect.text.length),
    extensions: editorExtensions,
    parent: rect.body,
  });
  attachEditorWheelSensitivity(rect.editor);
  rect.editor.dom.addEventListener("pointerdown", (event) => startWorksheetLineSelection(event, rect));
  updateWorksheetEditorModeUI(rect);
}

function mountTextEditor(rect, options = {}) {
  if (!rect?.body) {
    return;
  }
  const currentTab = activeTextEditorTab(rect);
  const previousSelection = options.selection ?? (rect.editor?.state.selection || EditorSelection.cursor(currentTab?.selection || 0));
  if (rect.editor) {
    if (!options.skipRemember) {
      rememberActiveTextEditorTab(rect);
    }
    rect.editor.destroy();
    rect.editor = null;
  }
  const languageExtension = textEditorLanguageExtension(rect.lastExportPath);
  rect.body.classList.add("is-text-editor");
  const tabBar = document.createElement("div");
  tabBar.className = "text-editor-tabs";
  const editorHost = document.createElement("div");
  editorHost.className = "text-editor-host";
  rect.body.replaceChildren(tabBar, editorHost);
  rect.textEditorTabBar = tabBar;
  rect.editor = new EditorView({
    doc: rect.text,
    selection: clampEditorSelection(previousSelection, rect.text.length),
    extensions: [
      basicSetup,
      tesseraEditorTheme,
      worksheetFilenameWordChars,
      ...(languageExtension ? [languageExtension] : []),
      Prec.highest(keymap.of([
        {
          key: "Mod-o",
          run: () => {
            void openEditorFileBrowser(rect, "import");
            return true;
          },
          preventDefault: true,
        },
        {
          key: "Mod-s",
          run: () => {
            void saveTextEditor(rect);
            return true;
          },
          preventDefault: true,
        },
      ])),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          rect.text = update.state.doc.toString();
          scheduleWorkspaceSave();
        }
      }),
    ],
    parent: editorHost,
  });
  attachEditorWheelSensitivity(rect.editor);
  renderTextEditorTabs(rect);
  updateTextEditorFileUI(rect);
}

function attachEditorWheelSensitivity(editor) {
  const scroller = editor?.scrollDOM;
  if (!scroller) {
    return;
  }
  scroller.addEventListener("wheel", (event) => {
    if (editorWheelSensitivity === 1 || event.deltaY === 0) {
      return;
    }
    const lineHeight = editor.defaultLineHeight || 20;
    const pageLines = Math.max(1, scroller.clientHeight / lineHeight);
    const lines = wheelDeltaUnits(event.deltaY, event.deltaMode, lineHeight, pageLines);
    event.preventDefault();
    scroller.scrollTop += lines * lineHeight * editorWheelSensitivity;
  }, { passive: false });
}

function renderTextEditorTabs(rect) {
  const tabBar = rect?.textEditorTabBar;
  if (!tabBar) {
    return;
  }
  tabBar.replaceChildren();
  rect.textEditorTabs.forEach((tab, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-editor-tab";
    button.classList.toggle("is-active", index === rect.activeTextEditorTab);
    button.textContent = fileNameFromPath(tab.path) || "Untitled";
    button.title = tab.path || "Untitled text file";
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      activateTextEditorTab(rect, index);
    });
    const close = document.createElement("span");
    close.className = "text-editor-tab-close";
    close.textContent = "×";
    close.title = "Close tab";
    close.addEventListener("pointerdown", (event) => event.stopPropagation());
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTextEditorTab(rect, index);
    });
    button.appendChild(close);
    tabBar.appendChild(button);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "text-editor-tab-add";
  add.textContent = "+";
  add.title = "Open file in a new tab";
  add.setAttribute("aria-label", add.title);
  add.addEventListener("pointerdown", (event) => event.stopPropagation());
  add.addEventListener("click", (event) => {
    event.preventDefault();
    void openEditorFileBrowser(rect, "import");
  });
  tabBar.appendChild(add);
}

function activateTextEditorTab(rect, index) {
  if (index < 0 || index >= rect.textEditorTabs.length || index === rect.activeTextEditorTab) {
    return;
  }
  rememberActiveTextEditorTab(rect);
  rect.activeTextEditorTab = index;
  syncActiveTextEditorTab(rect);
  const tab = activeTextEditorTab(rect);
  mountTextEditor(rect, { selection: EditorSelection.cursor(tab.selection), skipRemember: true });
  rect.editor?.focus();
  scheduleWorkspaceSave();
}

function closeTextEditorTab(rect, index) {
  if (index < 0 || index >= rect.textEditorTabs.length) {
    return;
  }
  rememberActiveTextEditorTab(rect);
  rect.textEditorTabs.splice(index, 1);
  if (rect.textEditorTabs.length === 0) {
    rect.textEditorTabs.push(newTextEditorTab());
  }
  rect.activeTextEditorTab = Math.max(0, Math.min(rect.activeTextEditorTab - (index < rect.activeTextEditorTab ? 1 : 0), rect.textEditorTabs.length - 1));
  syncActiveTextEditorTab(rect);
  const tab = activeTextEditorTab(rect);
  mountTextEditor(rect, { selection: EditorSelection.cursor(tab.selection), skipRemember: true });
  rect.editor?.focus();
  scheduleWorkspaceSave();
}

async function saveTextEditor(rect) {
  if (!rect?.editor || rect.kind !== textEditorPaneKind) {
    return;
  }
  if (rect.lastExportPath) {
    await saveEditorToFile(rect, { path: rect.lastExportPath });
  } else {
    await openEditorFileBrowser(rect, "export");
  }
}

function updateTextEditorFileUI(rect) {
  if (!rect || rect.kind !== textEditorPaneKind || !rect.filePathInput) {
    return;
  }
  rect.filePathInput.value = rect.lastExportPath || "";
  rect.filePathInput.title = rect.lastExportPath || "Untitled text file";
  renderTextEditorTabs(rect);
}

function clampEditorSelection(selection, docLength) {
  const head = selection?.main?.head ?? 0;
  return EditorSelection.cursor(Math.max(0, Math.min(head, docLength)));
}

function toggleWorksheetEditorMode(rect) {
  if (!rect?.editor) {
    return;
  }
  rect.editorMode = rect.editorMode === normalWorksheetEditorMode
    ? defaultWorksheetEditorMode
    : normalWorksheetEditorMode;
  mountWorksheetEditor(rect);
  rect.editor?.focus();
  scheduleWorkspaceSave();
}

function updateWorksheetEditorModeUI(rect) {
  if (!rect || rect.kind !== "worksheet") {
    return;
  }
  const mode = normalizeWorksheetEditorMode(rect.editorMode);
  rect.editorMode = mode;
  rect.element.dataset.editorMode = mode;
  if (rect.body) {
    rect.body.dataset.editorMode = mode;
  }
  if (rect.editorModeButton) {
    const isNormal = mode === normalWorksheetEditorMode;
    rect.editorModeButton.textContent = isNormal ? "Normal" : "Free";
    rect.editorModeButton.title = isNormal ? "Switch to free worksheet editing" : "Switch to normal text editing";
    rect.editorModeButton.setAttribute("aria-label", rect.editorModeButton.title);
    rect.editorModeButton.setAttribute("aria-pressed", isNormal ? "true" : "false");
  }
}

function setActivePane(rect, options = {}) {
  if (!rect || !rectangles.includes(rect)) {
    clearActivePane();
    return;
  }
  const wasActive = activePaneID === rect.id;
  clearActivePaneClass();
  activeRect = rect;
  activePaneID = rect.id;
  board.dataset.activePaneId = activePaneID;
  rect.element.dataset.activePane = "true";
  rect.element.classList.add("is-selected");
  setTerminalCursorBlink(rect, true);
  if (options.raise) {
    rect.zIndex = nextZIndex;
    nextZIndex += 1;
    rect.element.style.zIndex = String(rect.zIndex);
  }
  if (options.focusEditor) {
    if (rect.kind === "terminal") {
      rect.terminal?.term?.focus();
    } else {
      rect.editor?.focus();
    }
  } else if (options.focusElement) {
    rect.element.focus({ preventScroll: true });
  }
  if (!wasActive || options.raise) {
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
    setActivePane(rect, { raise: true, focusEditor: true });
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
  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
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

// Ghostty's cursor blinks continuously once started, so tie it to pane focus
// ourselves rather than leaving every terminal blinking at once. Disabling
// blink alone leaves a static cursor drawn (ghostty's stopCursorBlink()
// forces it visible), so also reach into the renderer to hide it entirely
// on panes that aren't focused.
function setTerminalCursorBlink(rect, blink) {
  if (rect?.kind !== "terminal" || !rect.terminal?.term) {
    return;
  }
  try {
    const { term } = rect.terminal;
    term.options.cursorBlink = blink;
    if (term.renderer) {
      term.renderer.cursorVisible = blink;
    }
    term.setRenderContinuous?.(blink && !rect.minimized);
    term.requestRender?.();
  } catch {
    // Terminal not fully initialized yet; ignore.
  }
}

function updateTerminalRenderState(rect) {
  const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
  if (!term) {
    return;
  }
  const paused = Boolean(rect.minimized);
  term.setRenderPaused?.(paused);
  term.setRenderContinuous?.(!paused && activeRect === rect);
  if (!paused) {
    term.requestRender?.();
  }
}

function updateTerminalDocumentVisibility() {
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
  hideEditorMenu();
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

async function openEditorFileBrowser(rect, mode) {
  if (!rect?.editor) {
    return;
  }
  fileBrowserRect = rect;
  fileBrowserMode = mode;
  fileBrowserFilePath = mode === "export" ? (rect.lastExportPath || "") : "";
  hideDockMenu();
  hideEditorMenu();
  hideWorkspaceMenu();
  directoryBrowser.hidden = false;

  const startPath = fileBrowserStartPath(rect);
  renderFileBrowserLoading(startPath);
  try {
    await loadFileBrowser(startPath);
  } catch (error) {
    renderFileBrowserError(error.message || "Could not load files");
  }
}

async function openAudioFileBrowser(rect) {
  fileBrowserRect = rect;
  fileBrowserMode = "audio";
  fileBrowserFilePath = "";
  hideDockMenu();
  hideEditorMenu();
  hideWorkspaceMenu();
  directoryBrowser.hidden = false;
  const current = audioStationState?.source?.kind === "file" ? audioStationState.source.value : "";
  const startPath = current ? parentPathFromFilePath(current) : (rect.cwd || "");
  renderFileBrowserLoading(startPath);
  try {
    await loadFileBrowser(startPath);
  } catch (error) {
    renderFileBrowserError(error.message || "Could not load audio files");
  }
}

async function chooseAudioHostFile(path) {
  try {
    await requestAudioStation("/api/audio/source", "PUT", { kind: "file", value: path });
    hideDirectoryBrowser();
  } catch (error) {
    renderFileBrowserError(error.message || "Could not select audio file");
  }
}

function fileBrowserStartPath(rect) {
  if (rect.lastExportPath) {
    return parentPathFromFilePath(rect.lastExportPath);
  }
  return rect.cwd || "";
}

async function loadFileBrowser(path) {
  const url = path
    ? `/api/directories?files=1&path=${encodeURIComponent(path)}`
    : "/api/directories?files=1";
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `file browser load failed: ${response.status}`);
  }
  fileBrowserPath = data.path || "";
  renderFileBrowser(data);
}

function renderFileBrowserLoading(path) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel(fileBrowserTitle());
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

function renderFileBrowserError(messageText) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel(fileBrowserTitle());
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

function renderFileBrowser(data) {
  directoryBrowser.replaceChildren();
  const panel = directoryBrowserPanel(fileBrowserTitle());

  const pathLine = document.createElement("div");
  pathLine.className = "directory-browser-path";
  pathLine.textContent = data.path || "host default";
  pathLine.title = data.path || "host default";

  const nav = document.createElement("div");
  nav.className = "directory-browser-nav";
  if (data.parent) {
    nav.appendChild(directoryBrowserButton("Up", () => loadFileBrowser(data.parent)));
  }
  for (const root of data.roots || []) {
    nav.appendChild(directoryBrowserButton(root.name, () => loadFileBrowser(root.path)));
  }

  const list = document.createElement("div");
  list.className = "directory-browser-list";
  if ((data.entries || []).length === 0) {
    const empty = document.createElement("div");
    empty.className = "directory-browser-message";
    empty.textContent = "No files";
    list.appendChild(empty);
  }
  for (const entry of data.entries || []) {
    const isDirectory = entry.kind === "directory";
    const button = directoryBrowserButton(`${isDirectory ? "[dir] " : ""}${entry.name}`, () => {
      if (isDirectory) {
        void loadFileBrowser(entry.path);
      } else if (fileBrowserMode === "audio") {
        void chooseAudioHostFile(entry.path);
      } else if (fileBrowserMode === "import") {
        void chooseImportFile(entry.path);
      } else {
        setFileBrowserExportPath(entry.path);
      }
    });
    button.className = `directory-browser-entry${isDirectory ? " is-directory" : " is-file"}`;
    button.title = entry.path;
    list.appendChild(button);
  }

  panel.appendChild(pathLine);
  panel.appendChild(nav);
  if (fileBrowserMode === "export") {
    panel.appendChild(renderExportFileField(data.path || ""));
  }
  panel.appendChild(list);
  panel.appendChild(renderFileBrowserActions(data.path || ""));
  directoryBrowser.appendChild(panel);
}

function renderExportFileField(folderPath) {
  const row = document.createElement("label");
  row.className = "directory-browser-file-row";
  const label = document.createElement("span");
  label.textContent = "File";
  const input = document.createElement("input");
  input.className = "directory-browser-file-input";
  input.type = "text";
  input.value = fileBrowserFilePath || defaultExportPath(folderPath);
  input.placeholder = "Path to export";
  input.addEventListener("input", () => {
    fileBrowserFilePath = input.value;
  });
  row.appendChild(label);
  row.appendChild(input);
  return row;
}

function renderFileBrowserActions(folderPath) {
  const actions = document.createElement("div");
  actions.className = "directory-browser-actions";
  if (fileBrowserMode === "export") {
    const label = fileBrowserRect?.kind === textEditorPaneKind ? "Save" : "Export";
    actions.appendChild(directoryBrowserButton(label, () => {
      void chooseExportFile(fileBrowserFilePath || defaultExportPath(folderPath));
    }));
  }
  actions.appendChild(directoryBrowserButton("Cancel", hideDirectoryBrowser));
  return actions;
}

function fileBrowserTitle() {
  if (fileBrowserMode === "audio") {
    return "Choose Audio File";
  }
  if (fileBrowserRect?.kind === textEditorPaneKind) {
    return fileBrowserMode === "export" ? "Save Text File" : "Open Text File";
  }
  return fileBrowserMode === "export" ? "Export Worksheet" : "Import Worksheet";
}

function setFileBrowserExportPath(path) {
  fileBrowserFilePath = path;
  void renderFileBrowserForCurrentPath();
}

async function renderFileBrowserForCurrentPath() {
  try {
    await loadFileBrowser(fileBrowserPath || "");
  } catch (error) {
    renderFileBrowserError(error.message || "Could not load files");
  }
}

async function chooseImportFile(path) {
  const rect = fileBrowserRect;
  hideDirectoryBrowser();
  if (!rect) {
    return;
  }
  await openFileIntoEditor(rect, path);
}

async function chooseExportFile(path) {
  const rect = fileBrowserRect;
  hideDirectoryBrowser();
  if (!rect) {
    return;
  }
  await saveEditorToFile(rect, { path });
}

function defaultExportPath(folderPath) {
  if (fileBrowserFilePath) {
    return fileBrowserFilePath;
  }
  if (fileBrowserRect?.lastExportPath) {
    return fileBrowserRect.lastExportPath;
  }
  const title = (fileBrowserRect?.title || "worksheet").trim() || "worksheet";
  return joinPath(folderPath || fileBrowserRect?.cwd || "", `${sanitizeFileName(title)}.txt`);
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "worksheet";
}

function joinPath(folderPath, fileName) {
  if (!folderPath) {
    return fileName;
  }
  const separator = folderPath.includes("\\") ? "\\" : "/";
  return folderPath.endsWith("\\") || folderPath.endsWith("/") ? `${folderPath}${fileName}` : `${folderPath}${separator}${fileName}`;
}

function parentPathFromFilePath(path) {
  const trimmed = (path || "").trim();
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slash === 2 && trimmed[1] === ":") {
    return trimmed.slice(0, 3);
  }
  return slash > 0 ? trimmed.slice(0, slash) : "";
}

function setRectangle(rect, next) {
  rect.x = Math.round(next.x);
  rect.y = Math.round(next.y);
  rect.width = Math.max(1, Math.round(next.width));
  rect.height = Math.max(1, Math.round(next.height));
  rect.element.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  rect.element.style.width = `${rect.width}px`;
  rect.element.style.height = `${rect.height}px`;
  if (rect.editor) {
    rect.editor.requestMeasure();
  }
  requestTerminalFit(rect);
  if (!isArrangingWindows) {
    arrangeOutSnapshot = null;
  }
  scheduleWorkspaceSave();
}

async function loadWorkspace() {
  isLoadingWorkspace = true;
  setWorkspaceStatus("loading", "Loading...");
  try {
    const response = await fetch(`/api/workspace/${encodeURIComponent(workspaceID)}`);
    if (!response.ok) {
      throw new Error(`load workspace failed: ${response.status}`);
    }
    const workspace = await response.json();
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
      const rect = createRectangle(pane.x ?? 80, pane.y ?? tabHeight + 56, pane.width || 360, pane.height || 240, {
        id: pane.id,
        kind: pane.kind || "worksheet",
        title: pane.title,
        text: pane.bufferText,
        editorMode: pane.editorMode,
        fontSize: pane.fontSize,
        cwd: pane.cwd,
        lastExportPath: pane.lastExportPath,
        editorTabs: pane.editorTabs,
        fileBrowserSidebarWidth: pane.fileBrowserSidebarWidth,
        browserUrl: pane.browserUrl,
        zIndex: pane.zIndex || 0,
        minimized: Boolean(pane.minimized),
        isFull: Boolean(pane.isFull),
        restoreBox: parseRestoreBox(pane.restoreBox),
      });
      highestZIndex = Math.max(highestZIndex, rect.zIndex);
    }

    reflowDockedPanesForTheme();

    nextZIndex = Math.max(nextZIndex, highestZIndex + 1);
    // A visible full pane owns the app surface after navigation, even if an
    // older saved active-pane ID points at a window behind it.
    const activeLoadedRect = rectangles.find((rect) => rect.isFull && !rect.minimized)
      || rectangles.find((rect) => rect.id === workspace.activePaneId && !rect.minimized)
      || null;
    if (activeLoadedRect) {
      setActivePane(activeLoadedRect, { raise: false, focusEditor: true });
    }
    await syncRunningCommands();
    updateDeskbar();
    setWorkspaceStatus("saved", "Saved", "Workspace loaded");
  } catch (error) {
    console.warn(error);
    setWorkspaceStatus("error", "Load failed", error.message || "Workspace load failed");
  } finally {
    isLoadingWorkspace = false;
  }
}

function clearRectanglesForLoad() {
  stopRunStreams();
  for (const rect of rectangles.splice(0)) {
    disposeTerminal(rect);
    disposeBrowserPane(rect);
    if (rect.audio) {
      rect.audio.element.pause();
      rect.audio.element.removeAttribute("src");
      rect.audio = null;
    }
    rect.editor?.destroy();
    rect.element.remove();
  }
  audioStationEvents?.close();
  audioStationEvents = null;
  window.clearTimeout(audioStationReconnectTimer);
  audioStationReconnectTimer = null;
  activeRect = null;
  activePaneID = "";
  delete board.dataset.activePaneId;
  interaction = null;
  contextMenuRect = null;
  editorMenuRect = null;
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
  window.clearTimeout(userSettingsSaveTimer);
  userSettingsSaveTimer = window.setTimeout(() => {
    void saveUserSettings().catch((error) => {
      console.warn(error);
      setWorkspaceStatus("error", "Settings save failed", error.message || "Settings save failed");
    });
  }, 250);
}

async function saveUserSettings() {
  window.clearTimeout(userSettingsSaveTimer);
  userSettingsSaveTimer = null;
  if (!currentUser) {
    return;
  }
  const response = await fetch(userAPIPath("settings"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      defaultPaneFontSize,
      defaultTheme,
      themeId: themeID,
      deskbarButtonEnabled,
      terminalWheelSensitivity,
      editorWheelSensitivity,
      oledWindowBorderSize,
      terminalTerm,
      terminalFont,
      terminalColorMode,
    }),
  });
  if (!response.ok) {
    throw new Error(`save user settings failed: ${response.status}`);
  }
}

async function flushUserSettingsSave() {
  if (userSettingsSaveTimer) {
    await saveUserSettings();
  }
}

async function flushAllPersistence() {
  await Promise.all([flushWorkspaceSave(), flushUserSettingsSave()]);
}

async function flushWorkspaceSave() {
  if (isLoadingWorkspace || workspaceSaveSuspended || workspaceNeedsRevalidation) {
    return;
  }
  window.clearTimeout(saveTimer);
  saveTimer = null;
  await saveWorkspace();
}

async function saveWorkspace() {
  if (isLoadingWorkspace || workspaceSaveSuspended) {
    return;
  }
  if (workspaceNeedsRevalidation) {
    workspaceSaveQueued = true;
    return;
  }
  if (workspaceSavePromise) {
    workspaceSaveQueued = true;
    return workspaceSavePromise;
  }
  workspaceSavePromise = performWorkspaceSave();
  try {
    await workspaceSavePromise;
  } finally {
    workspaceSavePromise = null;
    if (workspaceSaveQueued && !workspaceSaveSuspended && !workspaceNeedsRevalidation) {
      workspaceSaveQueued = false;
      await saveWorkspace();
    }
  }
}

async function performWorkspaceSave() {
  const revision = ++saveRevision;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  setWorkspaceStatus("saving", "Saving...");
  const savedRectangles = rectangles.filter((rect) => rect.kind !== "pending");
  const panes = savedRectangles.map((rect, index) => ({
    id: rect.id,
    title: rect.title,
    kind: rect.kind,
    bufferText: rect.kind === "terminal" ? "" : rect.text,
    editorMode: rect.kind === "worksheet" ? rect.editorMode : "",
    fontSize: rect.kind === "terminal" || rect.kind === "worksheet" || rect.kind === textEditorPaneKind ? rect.fontSize : defaultPaneFontSize,
    cwd: rect.cwd || "",
    lastExportPath: rect.kind === "terminal" ? "" : (rect.lastExportPath || ""),
    editorTabs: rect.kind === textEditorPaneKind ? serializedTextEditorTabs(rect) : "",
    fileBrowserSidebarWidth: rect.kind === fileBrowserPaneKind ? rect.fileBrowserSidebarWidth : defaultFileBrowserSidebarWidth,
    browserUrl: rect.kind === browserPaneKind ? rect.browserUrl : "",
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

  try {
    const response = await fetch(`/api/workspace/${encodeURIComponent(workspaceID)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: workspaceID,
        revision: workspaceRevision,
        name: currentSessionName || "Default",
        activePaneId: savedRectangles.some((rect) => rect.id === activePaneID) ? activePaneID : "",
        backgroundMode: workspaceBackgroundMode,
        layout: { panes: panes.map((pane) => pane.id) },
        panes,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const outcome = workspaceSaveOutcome(workspaceRevision, response.status, data.revision);
    if (outcome.suspended) {
      showWorkspaceConflict();
      return;
    }
    if (!response.ok) {
      throw new Error(`save workspace failed: ${response.status}`);
    }
    workspaceRevision = outcome.revision;
    if (revision === saveRevision && saveTimer === null) {
      setWorkspaceStatus("saved", "Saved");
    }
  } catch (error) {
    if (revision === saveRevision && saveTimer === null) {
      console.warn(error);
      setWorkspaceStatus("error", "Save failed", error.message || "Workspace save failed");
    }
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

function setWorkspaceStatus(state, text, title = "") {
  window.clearTimeout(workspaceStatusHideTimer);
  workspaceStatusHideTimer = null;
  workspaceStatus.hidden = false;
  workspaceStatus.dataset.state = state;
  workspaceStatus.textContent = text;
  workspaceStatus.title = title || text;
  if (state === "saved") {
    workspaceStatusHideTimer = window.setTimeout(() => {
      if (workspaceStatus.dataset.state === "saved") {
        workspaceStatus.hidden = true;
      }
      workspaceStatusHideTimer = null;
    }, 3000);
  }
}

async function syncRunningCommands() {
  try {
    const response = await fetch(`/api/runs?workspaceId=${encodeURIComponent(workspaceID)}`);
    if (!response.ok) {
      throw new Error(`load runs failed: ${response.status}`);
    }
    const data = await response.json();
    for (const run of data.runs || []) {
      const rect = rectangles.find((candidate) => candidate.id === run.paneId);
      if (!rect || runStreamControllers.has(run.runId)) {
        continue;
      }
      markPaneRunning(rect, run.runId);
      subscribeToRun(rect, run.runId);
    }
  } catch (error) {
    console.warn(error);
  }
}

function subscribeToRun(rect, runID) {
  const controller = new AbortController();
  runStreamControllers.set(runID, controller);
  void (async () => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runID)}/events`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`subscribe run failed: ${response.status}`);
      }
      await readRunEventStream(response, (event) => applyRunEvent(rect, event));
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn(error);
      }
    } finally {
      runStreamControllers.delete(runID);
      if (!controller.signal.aborted && rect.runID === runID) {
        clearPaneRunning(rect);
      }
    }
  })();
}

function stopRunStreams() {
  for (const controller of runStreamControllers.values()) {
    controller.abort();
  }
  runStreamControllers.clear();
}

function startWorksheetLineSelection(event, rect) {
  if (event.button !== 0 || !rect?.editor || !isLineNumberGutterTarget(event.target)) {
    return;
  }

  const lineNumber = lineNumberAtEditorY(rect.editor, event.clientY);
  if (!lineNumber) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  hideFloatingMenus();
  setActivePane(rect, { raise: true });
  worksheetLineDrag = {
    editor: rect.editor,
    pointerId: event.pointerId,
    startLineNumber: lineNumber,
  };
  selectWorksheetLineRange(rect.editor, lineNumber, lineNumber);

  const doc = rect.editor.dom.ownerDocument;
  doc.addEventListener("pointermove", continueWorksheetLineSelection);
  doc.addEventListener("pointerup", finishWorksheetLineSelection);
  doc.addEventListener("pointercancel", finishWorksheetLineSelection);
}

function continueWorksheetLineSelection(event) {
  if (!worksheetLineDrag || event.pointerId !== worksheetLineDrag.pointerId) {
    return;
  }
  if (event.buttons === 0) {
    finishWorksheetLineSelection(event);
    return;
  }

  const lineNumber = lineNumberAtEditorY(worksheetLineDrag.editor, event.clientY);
  if (!lineNumber) {
    return;
  }
  event.preventDefault();
  selectWorksheetLineRange(worksheetLineDrag.editor, worksheetLineDrag.startLineNumber, lineNumber);
}

function finishWorksheetLineSelection(event) {
  if (!worksheetLineDrag || event.pointerId !== worksheetLineDrag.pointerId) {
    return;
  }
  cancelWorksheetLineSelection();
}

function cancelWorksheetLineSelection(editor = null) {
  if (!worksheetLineDrag || (editor && worksheetLineDrag.editor !== editor)) {
    return;
  }
  const doc = worksheetLineDrag.editor.dom.ownerDocument;
  doc.removeEventListener("pointermove", continueWorksheetLineSelection);
  doc.removeEventListener("pointerup", finishWorksheetLineSelection);
  doc.removeEventListener("pointercancel", finishWorksheetLineSelection);
  worksheetLineDrag = null;
}

function startFileBrowserSidebarResize(event, rect, handle) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setActivePane(rect, { raise: true });
  fileBrowserSidebarResizeDrag = {
    rect,
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: rect.fileBrowserSidebarWidth,
  };
  handle.classList.add("is-dragging");
  document.addEventListener("pointermove", continueFileBrowserSidebarResize);
  document.addEventListener("pointerup", finishFileBrowserSidebarResize);
  document.addEventListener("pointercancel", finishFileBrowserSidebarResize);
}

function continueFileBrowserSidebarResize(event) {
  const drag = fileBrowserSidebarResizeDrag;
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  event.preventDefault();
  setFileBrowserSidebarWidth(drag.rect, drag.startWidth + (event.clientX - drag.startX));
  scheduleWorkspaceSave();
}

function finishFileBrowserSidebarResize(event) {
  const drag = fileBrowserSidebarResizeDrag;
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  drag.rect.fileBrowserView?.sidebarResizeHandle?.classList.remove("is-dragging");
  document.removeEventListener("pointermove", continueFileBrowserSidebarResize);
  document.removeEventListener("pointerup", finishFileBrowserSidebarResize);
  document.removeEventListener("pointercancel", finishFileBrowserSidebarResize);
  fileBrowserSidebarResizeDrag = null;
}

function isLineNumberGutterTarget(target) {
  const element = target instanceof Element ? target : null;
  if (!element) {
    return false;
  }
  return Boolean(element.closest(".cm-lineNumbers") && element.closest(".cm-gutterElement"));
}

function lineNumberAtEditorY(editor, clientY) {
  const contentBox = editor.contentDOM.getBoundingClientRect();
  if (contentBox.height <= 0 || contentBox.width <= 0) {
    return null;
  }

  const x = contentBox.left + Math.min(12, Math.max(1, contentBox.width / 2));
  const y = Math.min(Math.max(clientY, contentBox.top + 1), contentBox.bottom - 1);
  const pos = editor.posAtCoords({ x, y }, false);
  if (pos == null) {
    return clientY < contentBox.top ? 1 : editor.state.doc.lines;
  }
  return editor.state.doc.lineAt(pos).number;
}

function selectWorksheetLineRange(editor, startLineNumber, endLineNumber) {
  const doc = editor.state.doc;
  const fromLineNumber = Math.max(1, Math.min(startLineNumber, endLineNumber));
  const toLineNumber = Math.min(doc.lines, Math.max(startLineNumber, endLineNumber));
  const fromLine = doc.line(fromLineNumber);
  const toLine = doc.line(toLineNumber);
  editor.dispatch({
    selection: EditorSelection.single(fromLine.from, toLine.to),
    scrollIntoView: true,
    userEvent: "select.lineNumber",
  });
  editor.focus();
}

function loadGhosttyModule() {
  if (!ghosttyModulePromise) {
    ghosttyModulePromise = import("./vendor/terminal.js?v=terminal-rendering-2").then(async (module) => {
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
    if (!rect.terminalContainer || rect.kind !== "terminal") {
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
      fontFamily: terminalFontFamily(terminalFont),
      cursorBlink: activeRect === rect,
      theme: { ...terminalTheme },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(rect.terminalContainer);
    term.attachCustomKeyEventHandler((event) => {
      if (isTerminalPasteShortcut(event)) {
        void applyTerminalMenuAction("paste", rect);
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
    // ghostty focuses itself inside open(); hand focus back to the active
    // pane, or a session load's last-opened terminal ends up with the input.
    if (activeRect && activeRect !== rect) {
      setActivePane(activeRect, { focusEditor: true });
    }

    const dataDisposable = term.onData((data) => {
      sendTerminalInput(rect.terminal?.socket, data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendTerminalResize(rect.terminal?.socket, cols, rows);
    });
    rect.terminal = {
      term, fit, socket: null, dataDisposable, resizeDisposable, mouseBridge: null,
      reconnectTimer: null, reconnectAttempts: 0,
    };
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

function connectTerminalSocket(rect) {
  const terminalState = rect?.terminal;
  if (!terminalState?.term || rect.kind !== "terminal") {
    return;
  }
  terminalState.reconnectTimer = null;
  const { term } = terminalState;
  const socket = new WebSocket(terminalWebSocketURL(rect, term.cols, term.rows));
  socket.binaryType = "arraybuffer";
  terminalState.socket = socket;
  terminalState.mouseBridge?.dispose?.();
  terminalState.mouseBridge = attachTerminalMouseBridge(rect, term, socket);

  socket.addEventListener("open", () => {
    if (rect.terminal?.socket !== socket) {
      return;
    }
    terminalState.reconnectAttempts = 0;
    setPaneCwd(rect, rect.cwd, { silent: true });
    sendTerminalResize(socket, term.cols, term.rows);
    // Only the active pane's terminal may take focus when it comes up;
    // otherwise whichever terminal connects last steals it.
    if (activeRect === rect) {
      term.focus();
    }
  });
  socket.addEventListener("message", (event) => {
    if (rect.terminal?.socket !== socket) {
      return;
    }
    if (typeof event.data === "string") {
      term.write(event.data);
      return;
    }
    term.write(new Uint8Array(event.data));
  });
  socket.addEventListener("close", () => {
    if (rect.terminal?.socket === socket) {
      scheduleTerminalReconnect(rect, terminalState);
    }
  });
}

function scheduleTerminalReconnect(rect, terminalState) {
  if (terminalState.reconnectTimer !== null) {
    return;
  }
  const delay = terminalReconnectDelay(terminalState.reconnectAttempts);
  terminalState.reconnectAttempts += 1;
  terminalState.term.write(`\r\n[tessera terminal disconnected; reconnecting in ${Math.ceil(delay / 1000)}s]\r\n`);
  terminalState.reconnectTimer = window.setTimeout(() => {
    terminalState.reconnectTimer = null;
    if (rect.terminal === terminalState) {
      connectTerminalSocket(rect);
    }
  }, delay);
}

function attachTerminalMouseBridge(rect, term, socket) {
  const container = rect.terminalContainer;
  if (!container) {
    return null;
  }

  let activePointerID = null;
  let activeButtonCode = null;
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
    const buttonCode = terminalMouseButtonCode(event.button);
    if (buttonCode == null || !terminalShouldReportMouse(term, event)) {
      return;
    }
    const position = terminalMousePosition(term, container, event);
    if (!position) {
      return;
    }
    stopTerminalMouseEvent(event);
    hideFloatingMenus();
    setActivePane(rect, { raise: true });
    term.focus();
    activePointerID = event.pointerId;
    activeButtonCode = buttonCode;
    container.setPointerCapture?.(event.pointerId);
    sendTerminalMouseSequence(socket, terminalMouseEventCode(buttonCode, event), position, "M");
  };

  const onPointerMove = (event) => {
    if (activePointerID !== event.pointerId || activeButtonCode == null || event.buttons === 0 || !terminalShouldReportMouse(term, event)) {
      return;
    }
    const position = terminalMousePosition(term, container, event);
    if (!position) {
      return;
    }
    stopTerminalMouseEvent(event);
    sendTerminalMouseSequence(socket, terminalMouseEventCode(activeButtonCode + 32, event), position, "M");
  };

  const onPointerUp = (event) => {
    if (activePointerID !== event.pointerId || activeButtonCode == null || !terminalShouldReportMouse(term, event)) {
      if (activePointerID === event.pointerId) {
        container.releasePointerCapture?.(event.pointerId);
      }
      activePointerID = null;
      activeButtonCode = null;
      return;
    }
    const position = terminalMousePosition(term, container, event);
    stopTerminalMouseEvent(event);
    if (position) {
      sendTerminalMouseSequence(socket, terminalMouseEventCode(activeButtonCode, event), position, "m");
    }
    container.releasePointerCapture?.(event.pointerId);
    activePointerID = null;
    activeButtonCode = null;
  };

  const onPointerCancel = (event) => {
    if (activePointerID === event.pointerId) {
      activePointerID = null;
      activeButtonCode = null;
    }
  };

  const onContextMenu = (event) => {
    if (terminalShouldReportMouse(term, event)) {
      stopTerminalMouseEvent(event);
      return;
    }
    openTerminalMenu(event, rect);
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
  container.addEventListener("pointermove", onPointerMove, { capture: true });
  container.addEventListener("pointerup", onPointerUp, { capture: true });
  container.addEventListener("pointercancel", onPointerCancel, { capture: true });
  container.addEventListener("contextmenu", onContextMenu, { capture: true });
  term.attachCustomWheelEventHandler?.(onWheel);

  return {
    dispose() {
      container.removeEventListener("pointerdown", onPointerDown, { capture: true });
      container.removeEventListener("pointermove", onPointerMove, { capture: true });
      container.removeEventListener("pointerup", onPointerUp, { capture: true });
      container.removeEventListener("pointercancel", onPointerCancel, { capture: true });
      container.removeEventListener("contextmenu", onContextMenu, { capture: true });
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
  });
  return `${protocol}//${window.location.host}/api/terminal?${params.toString()}`;
}

function sendTerminalInput(socket, data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(terminalTextEncoder.encode(data));
  }
}

function sendTerminalResize(socket, cols, rows) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({
    type: "resize",
    cols,
    rows,
  }));
}

function requestTerminalFit(rect) {
  if (!rect?.terminal?.fit) {
    return;
  }
  window.requestAnimationFrame(() => {
    if (!rect.terminal?.fit) {
      return;
    }
    rect.terminal.fit.fit();
    sendTerminalResize(rect.terminal.socket, rect.terminal.term.cols, rect.terminal.term.rows);
  });
}

function disposeTerminal(rect, options = {}) {
  if (!rect?.terminal) {
    if (options.closeServer && rect?.kind === "terminal") {
      closeServerTerminal(rect);
    }
    return;
  }
  const terminalState = rect.terminal;
  rect.terminal = null;
  if (terminalState.reconnectTimer !== null) {
    window.clearTimeout(terminalState.reconnectTimer);
    terminalState.reconnectTimer = null;
  }
  if (options.closeServer) {
    closeServerTerminal(rect);
  }
  terminalState.dataDisposable?.dispose?.();
  terminalState.resizeDisposable?.dispose?.();
  terminalState.mouseBridge?.dispose?.();
  terminalState.fit?.dispose?.();
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
    : kind === fileBrowserPaneKind
      ? "File Browser"
    : kind === textEditorPaneKind
      ? "Text Editor"
      : kind === browserPaneKind
        ? "Browser"
      : kind === audioPaneKind
        ? "Audio"
      : kind === "worksheet"
        ? "Worksheet"
        : "Window";
  let highest = 0;
  for (const rect of rectangles) {
    const match = rect.title.trim().match(new RegExp(`^${base} (\\d+)$`));
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `${base} ${highest + 1}`;
}

function moveFreeCursorFromMouse(view, event) {
  if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }

  const target = freeCursorMouseTarget(view, event);
  if (!target) {
    return false;
  }

  event.preventDefault();
  return moveCursorToMaterializedColumn(view, target.lineNumber, target.column, "select.freeCursor");
}

function moveFreeCursorVertically(view, direction) {
  const selection = view.state.selection;
  const range = selection.main;
  if (!range.empty || selection.ranges.length > 1) {
    return false;
  }

  const line = view.state.doc.lineAt(range.head);
  const targetLineNumber = line.number + direction;
  if (targetLineNumber < 1) {
    return false;
  }

  return moveCursorToMaterializedColumn(view, targetLineNumber, range.head - line.from, "select.freeCursor");
}

function moveFreeCursorRight(view) {
  const selection = view.state.selection;
  const range = selection.main;
  if (!range.empty || selection.ranges.length > 1) {
    return false;
  }

  const line = view.state.doc.lineAt(range.head);
  if (range.head !== line.to) {
    return false;
  }

  return moveCursorToMaterializedColumn(view, line.number, line.length + 1, "input.freeCursor");
}

function freeCursorMouseTarget(view, event) {
  const lineHeight = Math.max(1, view.defaultLineHeight || 16);
  const doc = view.state.doc;
  const lineNumber = Math.max(1, Math.floor((event.clientY - view.documentTop) / lineHeight) + 1);

  if (lineNumber > doc.lines) {
    const column = mouseColumnAtLineStart(view, event.clientX, doc.line(doc.lines));
    return { lineNumber, column };
  }

  const line = doc.line(lineNumber);
  const column = mouseColumnAtLineStart(view, event.clientX, line);
  if (column <= line.length) {
    return null;
  }

  return { lineNumber, column };
}

function mouseColumnAtLineStart(view, clientX, line) {
  const charWidth = Math.max(1, view.defaultCharacterWidth || 8);
  const lineStart = view.coordsAtPos(line.from, 1) || view.coordsAtPos(line.to, -1);
  const contentBox = view.contentDOM.getBoundingClientRect();
  const textLeft = lineStart?.left ?? contentBox.left;
  return Math.max(0, Math.round((clientX - textLeft) / charWidth));
}

function moveCursorToMaterializedColumn(view, lineNumber, column, userEvent) {
  const state = view.state;
  const targetLineNumber = Math.max(1, lineNumber);
  const targetColumn = Math.max(0, column);

  if (targetLineNumber > state.doc.lines) {
    const missingLines = targetLineNumber - state.doc.lines;
    const insert = "\n".repeat(missingLines) + " ".repeat(targetColumn);
    const anchor = state.doc.length + missingLines + targetColumn;
    view.dispatch({
      changes: { from: state.doc.length, insert },
      selection: EditorSelection.cursor(anchor),
      scrollIntoView: true,
      userEvent,
    });
    view.focus();
    return true;
  }

  const line = state.doc.line(targetLineNumber);
  const padding = Math.max(0, targetColumn - line.length);
  const anchor = line.from + targetColumn;
  const transaction = {
    selection: EditorSelection.cursor(anchor),
    scrollIntoView: true,
    userEvent,
  };

  if (padding > 0) {
    transaction.changes = {
      from: line.to,
      insert: " ".repeat(padding),
    };
  }

  view.dispatch(transaction);
  view.focus();
  return true;
}

function openDockMenu(event, rect, offsetY = 0) {
  event.preventDefault();
  event.stopPropagation();
  if (rect.kind === "pending") {
    hideWindowTypeMenu({ finalizeDefault: false });
    finalizePendingRectangle(rect, "worksheet");
    return;
  }
  setActivePane(rect, { raise: true });
  hideEditorMenu();
  hideTerminalMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
  contextMenuRect = rect;
  renderDockMenu(rect);
  showMenuAt(dockMenu, event.clientX, event.clientY + offsetY);
}

function openEditorMenu(event, rect) {
  event.preventDefault();
  event.stopPropagation();
  setActivePane(rect, { raise: true });
  hideDockMenu();
  hideTerminalMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
  editorMenuRect = rect;
  renderEditorMenu(rect);
  showMenuAt(editorMenu, event.clientX, event.clientY);
}

function openTerminalMenu(event, rect) {
  event.preventDefault();
  event.stopPropagation();
  setActivePane(rect, { raise: true });
  rect.terminal?.term?.focus();
  hideDockMenu();
  hideEditorMenu();
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
  hideEditorMenu();
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

  const worksheetButton = document.createElement("button");
  worksheetButton.type = "button";
  worksheetButton.textContent = "New Worksheet";
  worksheetButton.className = "is-command";
  worksheetButton.addEventListener("click", () => {
    const point = workspaceMenuPoint || { x: 80, y: tabHeight + 56 };
    hideWorkspaceMenu();
    createWorksheetPane(point.x, point.y);
  });
  workspaceMenu.appendChild(worksheetButton);

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

  const audioButton = document.createElement("button");
  audioButton.type = "button";
  audioButton.textContent = "New Audio";
  audioButton.className = "is-command";
  audioButton.addEventListener("click", () => {
    const point = workspaceMenuPoint || { x: 80, y: tabHeight + 56 };
    hideWorkspaceMenu();
    createAudioPane(point.x, point.y);
  });
  workspaceMenu.appendChild(audioButton);

  const panes = rectangles.filter((rect) => rect.kind !== "pending").sort((a, b) => b.zIndex - a.zIndex);
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
      setActivePane(rect, { raise: true, focusEditor: true });
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
  const panes = rectangles.filter((rect) => rect.kind !== "pending").sort((a, b) => b.zIndex - a.zIndex);
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
    if (rect.running) {
      row.classList.add("is-running");
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-menu-name";
    button.textContent = workspaceMenuLabel(rect);
    button.title = rect.cwd ? `${button.textContent} (${rect.cwd})` : button.textContent;
    button.addEventListener("click", () => {
      hideDeskbar();
      setMinimized(rect, false);
      setActivePane(rect, { raise: true, focusEditor: true });
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

function openSettingsModal() {
  hideDeskbar();
  renderSettingsModal();
  settingsModal.hidden = false;
  window.requestAnimationFrame(() => settingsModal.querySelector("button, select")?.focus());
}

function hideSettingsModal() {
  settingsModal.hidden = true;
  settingsModal.replaceChildren();
}

function renderSettingsModal() {
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
    renderSettingsFontRow("Default", "Used for new terminal, worksheet, and text-editor panes in all sessions.", defaultPaneFontSize, (next) => {
      setDefaultPaneFontSize(next);
      renderSettingsModal();
    }),
    renderCurrentPaneFontRow(),
  ]));
  content.appendChild(renderSettingsSection("Scroll wheel", [
    renderSettingsWheelRow(
      "Terminal",
      "Controls terminal scrollback and wheel input in full-screen terminal apps.",
      terminalWheelSensitivity,
      (next) => setWheelSensitivity("terminal", next),
    ),
    renderSettingsWheelRow(
      "Editor",
      "Controls Worksheet and Text Editor scrolling.",
      editorWheelSensitivity,
      (next) => setWheelSensitivity("editor", next),
    ),
  ]));
  content.appendChild(renderSettingsSection("Terminal", [
    renderSettingsTerminalFontRow(),
    renderSettingsTerminalColorModeRow(),
    renderSettingsTerminalTERMRow(),
  ]));
  content.appendChild(renderSettingsSection("Theme", [
    renderSettingsThemeRow("Default", "Used for new windows in all of this user's sessions.", defaultTheme, (next) => setDefaultTheme(next)),
    renderSettingsThemeRow("Current", "Applied across this user's sessions immediately.", themeID, (next) => applyTheme(next)),
    renderSettingsOLEDWindowBorderRow(),
  ]));
  content.appendChild(renderSettingsSection("Background", [
    renderSettingsBackgroundRow(),
    renderSettingsBackgroundModeRow(),
  ]));
  panel.appendChild(content);
  settingsModal.appendChild(panel);
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
    ["Move an OLED window", "Right-click a pane border to arm Move mode, then left-drag the pane."],
    ["Move a standard window", "Drag its title tab."],
    ["Change the active title", "Run Set Window Title... from the command palette."],
  ]));
  content.appendChild(renderHelpSection("Keyboard shortcuts", [
    ["Command palette", "Ctrl/Cmd+K"],
    ["Window list", "Ctrl/Cmd+L"],
    ["Run worksheet command", "Ctrl/Cmd+Enter"],
    ["Destroy active window", "Ctrl/Cmd+Backspace"],
    ["Next / previous window", "Ctrl/Cmd+] / Ctrl/Cmd+["],
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
  if (!active || (active.kind !== "terminal" && active.kind !== "worksheet" && active.kind !== textEditorPaneKind)) {
    return renderSettingsFontRow("Current", "Select a terminal, worksheet, or text-editor pane to adjust its font.", defaultPaneFontSize, () => {}, true);
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
let paletteCodeInvokeTimer = null;
let windowListEntries = [];
let windowListSelection = 0;

function toggleCommandPalette() {
  if (commandPalette.hidden) {
    openCommandPalette();
  } else {
    hideCommandPalette();
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
  commandPalette.hidden = true;
  window.clearTimeout(paletteCodeInvokeTimer);
  paletteCodeInvokeTimer = null;
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
  renderWindowList();
  window.requestAnimationFrame(() => windowListPanel.focus());
}

function hideWindowList() {
  windowList.hidden = true;
}

function renderWindowList() {
  windowListEntries = rectangles
    .filter((rect) => rect.kind !== "pending")
    .sort((a, b) => b.zIndex - a.zIndex);
  const activeIndex = windowListEntries.findIndex((rect) => rect.id === activePaneID);
  windowListSelection = activeIndex >= 0 ? activeIndex : 0;
  windowListItems.replaceChildren();

  if (windowListEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-palette-empty";
    empty.textContent = "No windows";
    windowListItems.appendChild(empty);
    return;
  }

  windowListEntries.forEach((rect, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "command-palette-item window-list-item";
    row.tabIndex = -1;
    row.textContent = workspaceMenuLabel(rect);
    row.title = rect.minimized ? "Minimized" : "Focus window";
    row.setAttribute("aria-label", `${row.textContent}${rect.minimized ? ", minimized" : ""}`);
    row.addEventListener("pointermove", () => setWindowListSelection(index));
    row.addEventListener("click", () => selectWindowListEntry(index));
    windowListItems.appendChild(row);
  });
  setWindowListSelection(windowListSelection);
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
  setActivePane(rect, { raise: true, focusEditor: true });
}

function handleWindowListKeyboard(event) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    setWindowListSelection(windowListSelection + (event.key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectWindowListEntry();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
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
  serverHealthMonitorTimer = window.setInterval(() => void checkServerConnection(), serverHealthPollInterval);
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
  if (serverUpdateRestarting) {
    return healthy;
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

// Checks GitHub for a newer release via the server, applies it, and waits for
// the restarted server to come back before reloading the page.
async function runServerUpdate() {
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
  const deadline = Date.now() + 60000;
  let lastHealth = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const cacheBuster = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await fetch(`/api/health?update=${encodeURIComponent(cacheBuster)}`, {
        signal: AbortSignal.timeout(2000),
        cache: "no-store",
      });
      if (response.ok) {
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
      }
    } catch {
      // Server still restarting; keep polling.
    }
  }
  serverUpdateRestarting = false;
  if (lastHealth) {
    showUpdateStatus(
      `The server restarted as ${lastHealth.version || "an unknown version"}; expected ${check.latestVersion}.`,
      { closable: true },
    );
    return;
  }
  showUpdateStatus("The server did not come back within a minute. Use Reconnect once it is running.", { closable: true });
  await checkServerConnection({ force: true });
}

// Every action the workspace menu offers, flattened into searchable commands,
// plus jump-to-window entries (which also restore minimized panes).
function buildPaletteCommands() {
  const commands = [];
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
  commands.push({ id: "sessions", label: "Sessions...", hint: currentSessionName || "manage", run: () => void openSessionsModal() });
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
  commands.push({ id: "new-terminal", label: "New Terminal", hint: "create", run: () => {
    const point = paneSpawnPoint();
    createTerminalPane(point.x, point.y);
  } });
  commands.push({ id: "new-worksheet", label: "New Worksheet", hint: "create", run: () => {
    const point = paneSpawnPoint();
    createWorksheetPane(point.x, point.y);
  } });
  commands.push({ id: "new-file-browser", label: "New File Browser", hint: "create", run: () => {
    const point = paneSpawnPoint();
    createFileBrowserPane(point.x, point.y);
  } });
  commands.push({ id: "new-text-editor", label: "New Text Editor", hint: "create", run: () => {
    const point = paneSpawnPoint();
    createTextEditorPane(point.x, point.y);
  } });
  commands.push({ id: "new-browser", label: "New Browser", hint: "localhost development server", run: () => {
    const point = paneSpawnPoint();
    createBrowserPane(point.x, point.y);
  } });
  commands.push({ id: "new-audio", label: "New Audio", hint: "create", run: () => {
    const point = paneSpawnPoint();
    createAudioPane(point.x, point.y);
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
    commands.push({
      id: "rename-window",
      label: "Set Window Title...",
      hint: dockTarget.title,
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
    commands.push({ id: "destroy-window", label: "Destroy Window", hint: "Ctrl+Backspace", run: () => destroyActivePane() });
  }
  commands.push({ id: "settings", label: "Settings...", hint: "workspace", run: () => openSettingsModal() });
  commands.push({ id: "update-server", label: "Update Server", hint: "server", run: () => void runServerUpdate() });
  if (multiUser) {
    for (const name of userRoster) {
      if (name !== currentUser) {
        commands.push({ label: `Switch user: ${name}`, hint: "user", run: () => void jumpToUser(name) });
      }
    }
  }
  const panes = rectangles.filter((rect) => rect.kind !== "pending").sort((a, b) => b.zIndex - a.zIndex);
  for (const rect of panes) {
    commands.push({
      label: workspaceMenuLabel(rect),
      hint: rect.minimized ? "window, minimized" : "window",
      run: () => {
        setMinimized(rect, false);
        setActivePane(rect, { raise: true, focusEditor: true });
      },
    });
  }
  return commands;
}

// Fixed, hand-picked 2-letter codes for the static commands (identified by
// `id`, since a toggle command's label changes but its code shouldn't).
// Dynamic per-window/per-user entries have no `id` and so show no code —
// a "fixed set" can't cover an unbounded, runtime-dependent list.
const paletteShortcutCodes = {
  "help": "HP",
  "browse-local-port-help": "BL",
  "new-terminal": "NN",
  "new-worksheet": "NW",
  "new-file-browser": "NF",
  "new-text-editor": "NE",
  "new-browser": "NB",
  "new-audio": "NA",
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
  "settings": "ST",
  "update-server": "UP",
};

// Stamps each command with its fixed code (or none, for dynamic entries).
function assignPaletteShortcutCodes(commands) {
  for (const command of commands) {
    command.code = command.id ? paletteShortcutCodes[command.id] || null : null;
  }
}

function findPaletteCodeMatch(query, commands) {
  const typedCode = query.trim().toUpperCase();
  return typedCode.length === 2
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
  window.clearTimeout(paletteCodeInvokeTimer);
  paletteCodeInvokeTimer = null;

  const rawQuery = commandPaletteInput.value;
  const query = rawQuery.trim();
  const allCommands = buildPaletteCommands();
  assignPaletteShortcutCodes(allCommands);

  // Typing exactly one command's 2-letter code invokes it, after a short
  // pause — long enough to tell "typed a code" apart from "typing the start
  // of a longer search," which may briefly pass through a valid code too.
  const typedCode = query.toUpperCase();
  const codeMatch = findPaletteCodeMatch(query, allCommands);
  if (codeMatch) {
      paletteCodeInvokeTimer = window.setTimeout(() => {
        if (commandPaletteInput.value.trim().toUpperCase() === typedCode) {
          runPaletteCommand(codeMatch);
        }
      }, 350);
  }

  paletteEntries = allCommands
    .map((command) => ({ command, score: paletteScore(query, command.label) }))
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
  command.run();
}

function showWindowTypeMenu(rect, clientX, clientY) {
  if (!rect || rect.kind !== "pending" || !rectangles.includes(rect)) {
    return;
  }
  hideDockMenu();
  hideEditorMenu();
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
    ["worksheet", "Worksheet"],
    ["terminal", "Terminal"],
    [fileBrowserPaneKind, "File Browser"],
    [textEditorPaneKind, "Text Editor"],
    [browserPaneKind, "Browser"],
    [audioPaneKind, "Audio"],
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
  const paneKind = kind === "terminal" || kind === fileBrowserPaneKind || kind === textEditorPaneKind || kind === browserPaneKind || kind === audioPaneKind
    ? kind
    : "worksheet";
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
  setActivePane(nextRect, { raise: true, focusEditor: true });
  scheduleWorkspaceSave();
}

function workspaceMenuLabel(rect) {
  const index = rectangles.indexOf(rect);
  const name = rect.title.trim() || `Window ${index + 1}`;
  const kindSuffix = rect.kind === "terminal"
    ? " [terminal]"
    : rect.kind === fileBrowserPaneKind
      ? " [files]"
      : rect.kind === textEditorPaneKind
        ? " [editor]"
      : rect.kind === browserPaneKind
        ? " [browser]"
      : rect.kind === audioPaneKind
        ? " [audio]"
      : "";
  const runningSuffix = rect.running ? " !" : "";
  return `${name}${kindSuffix}${runningSuffix}`;
}

function createTerminalPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 640, 360, {
    kind: "terminal",
    cwd: activeRect?.cwd || "",
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focusEditor: true });
  scheduleWorkspaceSave();
}

function createWorksheetPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 480, 320, {
    kind: "worksheet",
    cwd: activeRect?.cwd || "",
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focusEditor: true });
  scheduleWorkspaceSave();
}

function createFileBrowserPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 560, 400, {
    kind: fileBrowserPaneKind,
    cwd: activeRect?.cwd || "",
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focusEditor: true });
  scheduleWorkspaceSave();
}

function createTextEditorPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 480, 320, {
    kind: textEditorPaneKind,
    cwd: activeRect?.cwd || "",
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focusEditor: true });
  scheduleWorkspaceSave();
}

function createAudioPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 520, 300, {
    kind: audioPaneKind,
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true });
  scheduleWorkspaceSave();
}

function createBrowserPane(x, y) {
  const rect = createRectangle(x, Math.max(y, tabHeight), 720, 480, {
    kind: browserPaneKind,
  });
  clampIntoBoard(rect);
  setRectangle(rect, rect);
  setActivePane(rect, { raise: true, focusEditor: true });
  rect.browser?.address.focus();
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

function renderEditorMenu(rect) {
  editorMenu.replaceChildren();
  const isTextEditor = rect.kind === textEditorPaneKind;
  const modeActionLabel = rect.editorMode === normalWorksheetEditorMode
    ? "Switch to Free Editing"
    : "Switch to Normal Editing";
  const actions = isTextEditor
    ? [
      ["import", "Open..."],
      ["exportLast", "Save"],
      ["export", "Save As..."],
      ["copy", "Copy"],
      ["cut", "Cut"],
      ["paste", "Paste"],
    ]
    : [
      ["toggleMode", modeActionLabel],
      ["run", "Run"],
      ["copy", "Copy"],
      ["cut", "Cut"],
      ["paste", "Paste"],
      ["import", "Import"],
      ["export", "Export"],
      ["exportLast", "Export As Last"],
    ];
  const hasSelection = hasEditorSelection(rect.editor);
  const canRun = Boolean(commandTargetForEditor(rect.editor)) && !rect.running;
  const canReadClipboard = Boolean(navigator.clipboard?.readText || document.queryCommandSupported?.("paste"));
  const canPaste = canReadClipboard || editorClipboardText.length > 0;

  for (const [action, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    if (action === "run") {
      button.disabled = !canRun;
    } else if (action === "copy" || action === "cut") {
      button.disabled = !hasSelection;
    } else if (action === "paste") {
      button.disabled = !canPaste;
    } else if (action === "exportLast") {
      button.disabled = !rect.lastExportPath;
    }
    button.addEventListener("click", () => {
      const actionRect = editorMenuRect;
      hideEditorMenu();
      void applyEditorMenuAction(action, actionRect);
    });
    editorMenu.appendChild(button);
  }
}

function renderTerminalMenu(rect) {
  terminalMenu.replaceChildren();
  const actions = [
    ["copy", "Copy"],
    ["paste", "Paste"],
  ];
  const term = rect?.terminal?.term;
  const hasSelection = Boolean(term?.hasSelection?.() || term?.getSelection?.());
  const canReadClipboard = Boolean(navigator.clipboard?.readText || document.queryCommandSupported?.("paste"));
  const canPaste = canReadClipboard || editorClipboardText.length > 0;

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
}

function applyDockAction(action, rect) {
  if (!rect) {
    return;
  }

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
    setActivePane(rect, { raise: true, focusEditor: true });
    return;
  }

  setActivePane(rect, { raise: true, focusEditor: true });

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
  return themeID === "oled-terminal" ? 0 : tabHeight;
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
// normal title-tab inset or the OLED theme's titleless edge-to-edge layout.
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
  const usableHeight = Math.max(16, bounds.height - tabHeight);
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
      y: tabHeight + row * cellHeight,
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

// Minimize hides the pane but keeps its live editor or terminal intact. The
// Deskbar is the persistent visual handle that restores it.
function setMinimized(rect, on) {
  if (!rect) {
    return;
  }
  const next = Boolean(on);
  if (rect.minimized === next) {
    return;
  }
  rect.minimized = next;
  rect.element.classList.toggle("is-minimized", next);
  updateTerminalRenderState(rect);
  if (next) {
    rect.element.setAttribute("aria-hidden", "true");
  } else {
    rect.element.removeAttribute("aria-hidden");
    window.requestAnimationFrame(() => {
      rect.editor?.requestMeasure();
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

async function applyEditorMenuAction(action, rect) {
  if (!rect?.editor) {
    return;
  }

  rect.editor.focus();

  if (action === "run") {
    await runPaneCommand(rect);
    return;
  }

  if (action === "toggleMode") {
    toggleWorksheetEditorMode(rect);
    return;
  }

  if (action === "copy") {
    const text = selectedEditorText(rect.editor);
    if (text) {
      await writeClipboardText(text);
    }
    rect.editor.focus();
    return;
  }

  if (action === "cut") {
    const text = selectedEditorText(rect.editor);
    if (text && await writeClipboardText(text)) {
      rect.editor.dispatch(rect.editor.state.replaceSelection(""));
    }
    rect.editor.focus();
    return;
  }

  if (action === "paste") {
    const text = await readClipboardText();
    if (text) {
      rect.editor.dispatch(rect.editor.state.replaceSelection(text));
    }
    rect.editor.focus();
    return;
  }

  if (action === "import") {
    await openEditorFileBrowser(rect, "import");
    return;
  }

  if (action === "export") {
    await openEditorFileBrowser(rect, "export");
    return;
  }

  if (action === "exportLast") {
    await saveEditorToFile(rect, { path: rect.lastExportPath });
  }
}

async function applyTerminalMenuAction(action, rect) {
  const term = rect?.terminal?.term;
  if (!term) {
    return;
  }

  term.focus();

  if (action === "copy") {
    const text = term.getSelection?.() || "";
    if (text) {
      await writeClipboardText(text);
    }
    term.focus();
    return;
  }

  if (action === "paste") {
    const text = await readClipboardText();
    if (text) {
      term.paste?.(text);
    }
    term.focus();
  }
}

async function openFileIntoEditor(rect, path) {
  if (!path) {
    rect.editor?.focus();
    return;
  }
  try {
    if (rect.kind === textEditorPaneKind) {
      const pathKey = editorPathKey(path);
      const existingIndex = rect.textEditorTabs.findIndex((tab) => editorPathKey(tab.path) === pathKey);
      if (existingIndex >= 0) {
        activateTextEditorTab(rect, existingIndex);
        setWorkspaceStatus("saved", "Opened", rect.textEditorTabs[existingIndex].path);
        return;
      }
    }
    const data = await readHostFile(path);
    if (rect.kind === textEditorPaneKind) {
      rememberActiveTextEditorTab(rect);
      rect.textEditorTabs.push(newTextEditorTab(data.path || path, data.text || ""));
      rect.activeTextEditorTab = rect.textEditorTabs.length - 1;
      syncActiveTextEditorTab(rect);
      mountTextEditor(rect, { selection: EditorSelection.cursor(0), skipRemember: true });
    } else {
      replaceEditorText(rect, data.text || "");
    }
    setWorkspaceStatus("saved", rect.kind === textEditorPaneKind ? "Opened" : "Imported", data.path || path);
    scheduleWorkspaceSave();
  } catch (error) {
    console.warn(error);
    setWorkspaceStatus("error", "Import failed", error.message || "Import failed");
  } finally {
    rect.editor?.focus();
  }
}

async function saveEditorToFile(rect, options = {}) {
  const path = options.path || "";
  if (!path) {
    rect.editor?.focus();
    return;
  }
  try {
    const data = await writeHostFile(path, rect.editor.state.doc.toString());
    rect.lastExportPath = data.path || path;
    if (rect.kind === textEditorPaneKind) {
      const tab = activeTextEditorTab(rect);
      if (tab) {
        tab.path = rect.lastExportPath;
        tab.text = rect.editor.state.doc.toString();
        tab.selection = rect.editor.state.selection.main.head;
      }
    }
    updateTextEditorFileUI(rect);
    setWorkspaceStatus("saved", rect.kind === textEditorPaneKind ? "Saved" : "Exported", rect.lastExportPath);
    scheduleWorkspaceSave();
  } catch (error) {
    console.warn(error);
    setWorkspaceStatus("error", "Export failed", error.message || "Export failed");
  } finally {
    rect.editor?.focus();
  }
}

async function readHostFile(path) {
  const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `file read failed: ${response.status}`);
  }
  return data;
}

async function writeHostFile(path, text) {
  const response = await fetch("/api/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, text }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `file write failed: ${response.status}`);
  }
  return data;
}

function replaceEditorText(rect, text) {
  const editor = rect.editor;
  if (!editor) {
    return;
  }
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    selection: EditorSelection.cursor(0),
    scrollIntoView: true,
    userEvent: "input.import",
  });
  rect.text = text;
}

function commandTargetForEditor(editor) {
  if (!editor) {
    return null;
  }

  const state = editor.state;
  const range = state.selection.main;
  if (!range.empty) {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const command = state.doc.sliceString(from, to).replace(/\r\n/g, "\n").trimEnd();
    if (command.trim() === "") {
      return null;
    }
    const commandStart = firstNonWhitespacePosition(state.doc, from, to);
    const commandStartLine = state.doc.lineAt(commandStart);
    const lastSelectedPos = Math.max(from, to - 1);
    return {
      command,
      insertPos: state.doc.lineAt(lastSelectedPos).to,
      outputPrefix: commandStartLine.text.slice(0, commandStart - commandStartLine.from),
    };
  }

  const line = state.doc.lineAt(range.head);
  const command = line.text.trimEnd();
  if (command.trim() === "") {
    return null;
  }
  const commandStartColumn = line.text.search(/\S/);
  return {
    command,
    insertPos: line.to,
    outputPrefix: commandStartColumn > 0 ? line.text.slice(0, commandStartColumn) : "",
  };
}

function firstNonWhitespacePosition(doc, from, to) {
  for (let pos = from; pos < to; pos += 1) {
    if (/\S/.test(doc.sliceString(pos, pos + 1))) {
      return pos;
    }
  }
  return from;
}

async function runPaneCommand(rect) {
  if (!rect?.editor || rect.running) {
    return true;
  }

  const target = commandTargetForEditor(rect.editor);
  if (!target) {
    return true;
  }

  await flushWorkspaceSave();
  setActivePane(rect, { raise: true });
  markPaneRunning(rect, "");

  const editor = rect.editor;
  const spinner = createCommandTextSpinner(editor, target.insertPos);
  rect.commandSpinner = spinner;
  spinner.start();
  const transcript = createTranscriptInserter(editor, spinner.after(), target.outputPrefix);
  let streamStarted = false;
  let sawExit = false;

  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspaceID,
        paneId: rect.id,
        command: target.command,
        cwd: rect.cwd || "",
        insertPos: target.insertPos,
        outputPrefix: target.outputPrefix,
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      transcript.appendHostMessage(`tessera: run failed ${response.status}${message ? ` ${message}` : ""}`);
      sawExit = true;
      return true;
    }

    streamStarted = true;
    await readRunEventStream(response, (event) => {
      applyRunEvent(rect, event);
      sawExit = sawExit || event.type === "exit";
    });
  } catch (error) {
    if (!streamStarted) {
      transcript.appendHostMessage(error.message || "run failed");
      sawExit = true;
    } else {
      console.warn(error);
    }
  } finally {
    try {
      spinner.stop();
    } finally {
      if (rect.commandSpinner === spinner) {
        rect.commandSpinner = null;
      }
    }
    rect.text = editor.state.doc.toString();
    if (sawExit || !streamStarted) {
      clearPaneRunning(rect);
      if (!streamStarted) {
        scheduleWorkspaceSave();
      }
    } else {
      void syncRunningCommands();
    }
  }

  return true;
}

function markPaneRunning(rect, runID) {
  rect.running = true;
  rect.runID = runID || rect.runID || "";
  rect.element.dataset.running = "true";
  updateDeskbar();
}

function clearPaneRunning(rect) {
  rect.running = false;
  rect.runID = "";
  delete rect.element.dataset.running;
  updateDeskbar();
}

function applyRunEvent(rect, event) {
  if (!rect?.editor || !event) {
    return;
  }
  if (event.runId) {
    markPaneRunning(rect, event.runId);
  }
  if (event.type === "snapshot") {
    replacePaneTextFromHost(rect, event.bufferText || "");
    if (event.cwd) {
      setPaneCwd(rect, event.cwd, { silent: true });
    }
    return;
  }
  if (event.type === "start" && event.cwd) {
    setPaneCwd(rect, event.cwd, { silent: true });
    return;
  }
  if (event.type === "insert") {
    insertPaneTextFromHost(rect, event.from || 0, event.text || "");
    return;
  }
  if (event.type === "error") {
    console.warn(event.error || "run error");
    return;
  }
  if (event.type === "exit") {
    if (event.cwd) {
      setPaneCwd(rect, event.cwd, { silent: true });
    }
    clearPaneRunning(rect);
  }
}

function replacePaneTextFromHost(rect, text) {
  const editor = rect.editor;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    userEvent: "input.tesseraHostSnapshot",
  });
  rect.text = text;
}

function insertPaneTextFromHost(rect, from, text) {
  if (!text) {
    return;
  }
  const editor = rect.editor;
  const insertAt = rect.commandSpinner
    ? rect.commandSpinner.displayPosition(from)
    : from;
  const safeInsertAt = Math.max(0, Math.min(insertAt, editor.state.doc.length));
  const transaction = {
    changes: { from: safeInsertAt, insert: text },
    userEvent: "input.tesseraRunOutput",
  };
  if (editor.hasFocus) {
    transaction.selection = EditorSelection.cursor(safeInsertAt + text.length);
    transaction.scrollIntoView = true;
  }
  editor.dispatch(transaction);
  rect.text = rect.commandSpinner
    ? rect.commandSpinner.textWithoutSpinner(editor.state.doc.toString())
    : editor.state.doc.toString();
}

function createCommandTextSpinner(editor, position) {
  let currentPosition = position;
  let currentText = "";
  let frameIndex = 0;
  let timer = null;

  const dispatchSpinnerText = (nextText) => {
    const previousLength = currentText.length;
    const from = Math.min(currentPosition, editor.state.doc.length);
    const to = Math.min(from + previousLength, editor.state.doc.length);
    currentPosition = from;
    currentText = nextText;
    editor.dispatch({
      changes: { from, to, insert: nextText },
      userEvent: "input.tesseraSpinner",
    });
  };

  return {
    start() {
      dispatchSpinnerText(` ${commandSpinnerFrames[frameIndex]}`);
      timer = window.setInterval(() => {
        frameIndex = (frameIndex + 1) % commandSpinnerFrames.length;
        dispatchSpinnerText(` ${commandSpinnerFrames[frameIndex]}`);
      }, commandSpinnerIntervalMs);
    },
    after() {
      return currentPosition + currentText.length;
    },
    displayPosition(position) {
      if (currentText && position >= currentPosition) {
        return position + currentText.length;
      }
      return position;
    },
    map(changes) {
      currentPosition = changes.mapPos(currentPosition, -1);
    },
    stop() {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      if (currentText) {
        const previousLength = currentText.length;
        const from = Math.min(currentPosition, editor.state.doc.length);
        const to = Math.min(from + previousLength, editor.state.doc.length);
        currentPosition = from;
        currentText = "";
        editor.dispatch({
          changes: { from, to, insert: "" },
          userEvent: "input.tesseraSpinner",
        });
      }
    },
    textWithoutSpinner(text) {
      if (!currentText) {
        return text;
      }
      return text.slice(0, currentPosition) + text.slice(currentPosition + currentText.length);
    },
  };
}

function createTranscriptInserter(editor, insertPos, outputPrefix = "") {
  let cursor = insertPos;
  let commandOutputChars = 0;
  let lastInsertedChar = "\n";

  const insert = (text, commandOutputCharCount = 0) => {
    if (!text) {
      return;
    }
    text = text.replace(/\r\n?/g, "\n");
    cursor = Math.min(cursor, editor.state.doc.length);
    editor.dispatch({
      changes: { from: cursor, insert: text },
      selection: EditorSelection.cursor(cursor + text.length),
      scrollIntoView: true,
      userEvent: "input.tesseraRunOutput",
    });
    cursor += text.length;
    lastInsertedChar = text[text.length - 1];
    commandOutputChars += commandOutputCharCount;
  };

  const textAtOutputColumn = (text) => {
    if (!outputPrefix) {
      return text;
    }

    let prefixed = "";
    let atLineStart = lastInsertedChar === "\n";
    for (const char of text) {
      if (atLineStart && char !== "\n") {
        prefixed += outputPrefix;
        atLineStart = false;
      }
      prefixed += char;
      if (char === "\n") {
        atLineStart = true;
      }
    }
    return prefixed;
  };

  return {
    startOutputBelowCommand() {
      insert("\n");
    },
    appendCommandOutput(text) {
      insert(textAtOutputColumn(text), text.length);
    },
    appendHostMessage(message) {
      if (lastInsertedChar !== "\n") {
        insert("\n");
      }
      insert(textAtOutputColumn(`[${message}]\n`));
    },
    finish(exitCode) {
      if (commandOutputChars === 0 || exitCode !== 0) {
        if (lastInsertedChar !== "\n") {
          insert("\n");
        }
        insert(textAtOutputColumn(`[exit ${exitCode}]\n`));
      }
    },
  };
}

async function readRunEventStream(response, onEvent) {
  if (!response.body) {
    const text = await response.text();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        onEvent(JSON.parse(line));
      }
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  for (;;) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        onEvent(JSON.parse(line));
      }
    }

    if (done) {
      break;
    }
  }

  if (pending.trim()) {
    onEvent(JSON.parse(pending));
  }
}

function hasEditorSelection(editor) {
  return editor?.state.selection.ranges.some((range) => !range.empty) ?? false;
}

function selectedEditorText(editor) {
  return editor.state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => editor.state.doc.sliceString(range.from, range.to))
    .join("\n");
}

async function writeClipboardText(text) {
  editorClipboardText = text;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the synchronous copy fallback below.
    }
  }
  copyTextWithHiddenField(text);
  return true;
}

async function readClipboardText() {
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Fall through to the synchronous paste fallback below.
    }
  }
  const pastedText = pasteTextWithHiddenField();
  return pastedText === null ? editorClipboardText : pastedText;
}

function copyTextWithHiddenField(text) {
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
  if (editorMenuRect === rect) {
    editorMenuRect = null;
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
  if (rect.audio) {
    rect.audio.element.pause();
    rect.audio.element.removeAttribute("src");
    rect.audio = null;
    if (!rectangles.some((pane) => pane.kind === audioPaneKind)) {
      audioStationEvents?.close();
      audioStationEvents = null;
      window.clearTimeout(audioStationReconnectTimer);
      audioStationReconnectTimer = null;
    }
  }
  cancelWorksheetLineSelection(rect.editor);
  rect.editor?.destroy();
  rect.editor = null;
  rect.element.remove();
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

  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "l" || event.key === "L")) {
    event.preventDefault();
    event.stopPropagation();
    toggleWindowList();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "k" || event.key === "K")) {
    event.preventDefault();
    event.stopPropagation();
    toggleCommandPalette();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === "Enter") {
    event.preventDefault();
    runPaneCommand(getActivePane());
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "Backspace" || event.code === "Backspace")) {
    event.preventDefault();
    event.stopPropagation();
    destroyActivePane();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "]" || event.code === "BracketRight")) {
    event.preventDefault();
    event.stopPropagation();
    focusAdjacentPane(1);
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "[" || event.code === "BracketLeft")) {
    event.preventDefault();
    event.stopPropagation();
    focusAdjacentPane(-1);
    return;
  }

  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "F10") {
    event.preventDefault();
    toggleFullRestore(getActivePane());
    return;
  }

  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "F9") {
    event.preventDefault();
    toggleMinimize(getActivePane());
    return;
  }

  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "F7") {
    event.preventDefault();
    toggleArrangeWindows();
  }
}

function focusAdjacentPane(direction) {
  const visiblePanes = rectangles.filter((rect) => rect.kind !== "pending" && !rect.minimized);
  if (visiblePanes.length === 0) {
    return;
  }

  const current = getActivePane();
  const currentIndex = current ? visiblePanes.indexOf(current) : -1;
  const nextIndex = (currentIndex + direction + visiblePanes.length) % visiblePanes.length;
  setActivePane(visiblePanes[nextIndex], { raise: true, focusEditor: true });
}

function focusTopVisiblePane() {
  const next = rectangles
    .filter((rect) => rect.kind !== "pending" && !rect.minimized)
    .sort((a, b) => b.zIndex - a.zIndex)[0] || null;
  if (next) {
    setActivePane(next, { raise: false, focusEditor: true });
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
  if (!editorMenu.hidden && !editorMenu.contains(event.target)) {
    hideEditorMenu();
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
  hideFloatingMenus();
  hideDirectoryBrowser();
  hideCommandPalette();
  hideWindowList();
  hideDeskbar();
  hideSettingsModal();
  hideHelpModal();
  hideRenameWindowModal();
  hideSessionsModal();
  hideSessionActionModal();
}

function hideFloatingMenus() {
  hideDockMenu();
  hideEditorMenu();
  hideTerminalMenu();
  hideWorkspaceMenu();
  hideWindowTypeMenu();
}

function hideDockMenu() {
  dockMenu.hidden = true;
  contextMenuRect = null;
}

function hideEditorMenu() {
  editorMenu.hidden = true;
  editorMenuRect = null;
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
  fileBrowserRect = null;
  fileBrowserMode = "";
  fileBrowserPath = "";
  fileBrowserFilePath = "";
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
