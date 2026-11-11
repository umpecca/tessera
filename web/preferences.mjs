import { WindowWobble } from "./window-wobble.mjs";
import { MosaicScreensaver } from "./screensaver.mjs";
import { normalizePredictionMode } from "./terminal-prediction.mjs";
import { defaultTerminalTERM, normalizeTerminalTERM, defaultTerminalRowSpacing, normalizeTerminalRowSpacing } from "./terminal-settings.mjs";
import { defaultTerminalFont, loadTerminalFont, normalizeTerminalFont, terminalFontFamily, terminalPrimaryFontFamily } from "./terminal-font.mjs";
import { defaultTerminalColorMode, normalizeTerminalColorMode, recreateOpenTerminalViews, terminalColorModes } from "./terminal-colors.mjs";
import { defaultRDPWheelSpeed, normalizeRDPWheelSpeed } from "./rdp-pane.mjs";
import { SettingsPersistence } from "./settings-persistence.mjs";
import { normalizeTerminalBacklogLimit } from "./terminal-replica.mjs";
import { defaultOLEDBorderSize, normalizeOLEDBorderSize } from "./oled-border-size.mjs";
import { defaultWheelSensitivity, normalizeWheelSensitivity } from "./wheel-sensitivity.mjs";
import { defaultInterfaceFontSize, normalizeInterfaceFontSize } from "./interface-font.mjs";

// Device/account preferences and their live application effects.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   phone: () => ReturnType<typeof import("./phone-workspace.mjs").createPhone>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createPreferences(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    systemNotificationsStorageKey: undefined,
    systemNotificationsEnabled: undefined,
    commandNoticesStorageKey: undefined,
    commandNoticesEnabled: undefined,
    fallbackPaneFontSize: undefined,
    minimumPaneFontSize: undefined,
    maximumPaneFontSize: undefined,
    defaultPaneFontSize: undefined,
    interfaceFontSize: undefined,
    deskbarButtonEnabled: undefined,
    terminalWheelSensitivity: undefined,
    oledWindowBorderSize: undefined,
    terminalTerm: undefined,
    terminalShellIntegration: undefined,
    terminalFont: undefined,
    nativeFrameLimit: undefined,
    terminalRowSpacing: undefined,
    terminalColorMode: undefined,
    olderMacModeStorageKey: undefined,
    olderMacMode: undefined,
    experimentalTerminalRendererStorageKey: undefined,
    experimentalTerminalRenderer: undefined,
    terminalPaintCoalescingStorageKey: undefined,
    terminalPaintCoalescing: undefined,
    terminalOutputCoalescingStorageKey: undefined,
    terminalOutputCoalescing: undefined,
    terminalPredictionStorageKey: undefined,
    terminalPredictionMode: undefined,
    terminalBacklogLimitStorageKey: undefined,
    terminalBacklogLimit: undefined,
    windowWobbleStorageKey: undefined,
    windowWobbleEnabled: undefined,
    settingsPersistence: undefined,
    defaultThemeID: undefined,
    themes: undefined,
    defaultTheme: undefined,
    themeID: undefined,
    reducedWindowMotion: undefined,
    windowWobble: undefined,
    screensaver: undefined,
    rdpWheelSpeedStorageKey: undefined,
    rdpWheelSpeed: undefined,
  };

  function setWindowWobbleEnabled(enabled) {
    feature.windowWobbleEnabled = enabled === true;
    feature.saveBrowserSetting(feature.windowWobbleStorageKey, feature.windowWobbleEnabled);
    if (!feature.windowWobbleEnabled) feature.windowWobble.stop();
  }

  function setDefaultTheme(id) {
    feature.defaultTheme = feature.themes[id] ? id : feature.defaultThemeID;
    dependencies.workspace().scheduleUserSettingsSave();
  }

  function setDefaultPaneFontSize(fontSize) {
    feature.defaultPaneFontSize = dependencies.desktop().normalizePaneFontSize(fontSize);
    dependencies.workspace().scheduleUserSettingsSave();
  }

  function setInterfaceFontSize(value, { save = true } = {}) {
    // A larger phone input bar is another UI-only layout change. Keep a fitted
    // shared shell at its current grid until the next actual terminal input.
    if (save) {
      const phone = dependencies.phone();
      if (phone.phoneView?.active && phone.phoneView.openPaneID) phone.changePhoneInteractionMode(phone.phoneView.openPaneID);
    }
    feature.interfaceFontSize = normalizeInterfaceFontSize(value);
    platform.document.documentElement.style.setProperty("--tessera-ui-font-scale", String(feature.interfaceFontSize / defaultInterfaceFontSize));
    if (save) dependencies.workspace().scheduleUserSettingsSave();
  }

  function setRDPWheelSpeed(value) {
    feature.rdpWheelSpeed = normalizeRDPWheelSpeed(value);
    feature.saveBrowserSetting(feature.rdpWheelSpeedStorageKey, feature.rdpWheelSpeed);
  }

  function setTerminalWheelSensitivity(value) {
    const normalized = normalizeWheelSensitivity(value);
    feature.terminalWheelSensitivity = normalized;
    dependencies.workspace().scheduleUserSettingsSave();
  }

  function setOLEDWindowBorderSize(value, { save = true } = {}) {
    feature.oledWindowBorderSize = normalizeOLEDBorderSize(value);
    platform.document.documentElement.style.setProperty("--oled-window-border-size", `${feature.oledWindowBorderSize}px`);
    if (save) {
      dependencies.workspace().scheduleUserSettingsSave();
    }
  }

  function setTerminalShellIntegration(enabled) {
    feature.terminalShellIntegration = enabled === true;
    dependencies.workspace().scheduleUserSettingsSave();
  }

  function setCommandNoticesEnabled(enabled) {
    feature.commandNoticesEnabled = enabled === true;
    feature.saveBrowserSetting(feature.commandNoticesStorageKey, feature.commandNoticesEnabled);
  }

  function setTerminalTERM(value) {
    feature.terminalTerm = normalizeTerminalTERM(value);
    dependencies.workspace().scheduleUserSettingsSave();
  }

  function applyApplicationFont() {
    platform.document.documentElement.style.setProperty("--tessera-font", terminalFontFamily(feature.terminalFont));
  }

  async function setTerminalFont(value, { save = true } = {}) {
    const font = normalizeTerminalFont(value);
    feature.terminalFont = font;
    feature.applyApplicationFont();
    if (save) {
      dependencies.workspace().scheduleUserSettingsSave();
    }
    const terminalPanes = dependencies.desktop().rectangles.filter((rect) => rect.kind === "terminal" && rect.terminal?.term);
    // Load the interface faces even when no terminal is open. Canvas terminal
    // metrics still wait for regular/bold faces at each pane's current size.
    await Promise.all([...new Set([feature.fallbackPaneFontSize || 14, ...terminalPanes.map((rect) => rect.fontSize)])]
      .map((fontSize) => loadTerminalFont(platform.document.fonts, font, fontSize)));
    if (feature.terminalFont !== font) return;
    const family = terminalPrimaryFontFamily(font);
    const symbolFamily = terminalFontFamily(font);
    for (const rect of terminalPanes) {
      rect.terminal.term.setFontFamilies(family, symbolFamily);
      dependencies.terminal().requestTerminalFit(rect);
    }
  }

  function setTerminalRowSpacing(value, { save = true } = {}) {
    feature.terminalRowSpacing = normalizeTerminalRowSpacing(value);
    if (save) dependencies.workspace().scheduleUserSettingsSave();
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal" && rect.terminal?.term) {
        rect.terminal.term.setRowSpacing(feature.terminalRowSpacing);
        dependencies.terminal().requestTerminalFit(rect);
      }
    }
  }

  async function setTerminalColorMode(value, { save = true } = {}) {
    const nextMode = normalizeTerminalColorMode(value);
    if (nextMode === feature.terminalColorMode) {
      return;
    }
    feature.terminalColorMode = nextMode;
    if (save) {
      dependencies.workspace().scheduleUserSettingsSave();
    }
    await recreateOpenTerminalViews(dependencies.desktop().rectangles.filter((rect) => !rect.terminalColorMode), dependencies.terminal().disposeTerminal, dependencies.terminal().startTerminal);
  }

  async function setPaneTerminalColorMode(rect, value) {
    if (rect?.kind !== "terminal") return;
    const nextMode = Object.hasOwn(terminalColorModes, value) ? value : "";
    if (rect.terminalColorMode === nextMode) return;
    rect.terminalColorMode = nextMode;
    dependencies.workspace().scheduleWorkspaceSave();
    await recreateOpenTerminalViews([rect], dependencies.terminal().disposeTerminal, dependencies.terminal().startTerminal);
  }

  function setOlderMacMode(enabled, { save = true } = {}) {
    feature.olderMacMode = enabled === true;
    if (save) {
      try {
        platform.window.localStorage.setItem(feature.olderMacModeStorageKey, String(feature.olderMacMode));
      } catch {
        // Keep the selection for this page when browser storage is unavailable.
      }
    }
    platform.document.documentElement.dataset.performanceProfile = feature.olderMacMode ? "older-mac" : "standard";
    for (const rect of dependencies.desktop().rectangles) {
      const term = rect.kind === "terminal" ? rect.terminal?.term : null;
      if (!term) continue;
      term.setRenderPixelRatioCap?.(feature.olderMacMode ? 1 : 0);
      term.setPaintFPSLimit?.(feature.olderMacMode ? 30 : feature.nativeFrameLimit || 0);
      term.setCursorBlinkEnabled?.(!feature.olderMacMode);
      term.options.smoothScrollDuration = feature.olderMacMode ? 0 : 100;
      dependencies.terminal().updateTerminalRenderState(rect);
    }
  }

  function setExperimentalTerminalRenderer(enabled) {
    feature.experimentalTerminalRenderer = enabled === true;
    try {
      platform.window.localStorage.setItem(feature.experimentalTerminalRendererStorageKey, String(feature.experimentalTerminalRenderer));
    } catch {
      // Keep the selection for this page when browser storage is unavailable.
    }
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal") {
        rect.terminal?.term?.setExperimentalRenderer?.(feature.experimentalTerminalRenderer);
      }
    }
  }

  function saveBrowserSetting(key, value) {
    try {
      platform.window.localStorage.setItem(key, String(value));
    } catch {
      // Keep the selection for this page when browser storage is unavailable.
    }
  }

  function setTerminalPaintCoalescing(enabled) {
    feature.terminalPaintCoalescing = enabled === true;
    feature.saveBrowserSetting(feature.terminalPaintCoalescingStorageKey, feature.terminalPaintCoalescing);
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal") {
        rect.terminal?.term?.setPaintCoalescing?.(feature.terminalPaintCoalescing);
      }
    }
  }

  function setTerminalPredictionMode(mode) {
    feature.terminalPredictionMode = normalizePredictionMode(mode);
    feature.saveBrowserSetting(feature.terminalPredictionStorageKey, feature.terminalPredictionMode);
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal") rect.terminal?.term?.setPredictionMode?.(feature.terminalPredictionMode);
    }
  }

  function sendTerminalOutputCoalescing(terminalState) {
    if (terminalState?.socket?.readyState === platform.WebSocket.OPEN) {
      terminalState.socket.send(JSON.stringify({ type: "output-coalescing", enabled: feature.terminalOutputCoalescing }));
    }
  }

  function setTerminalOutputCoalescing(enabled) {
    feature.terminalOutputCoalescing = enabled === true;
    feature.saveBrowserSetting(feature.terminalOutputCoalescingStorageKey, feature.terminalOutputCoalescing);
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal") feature.sendTerminalOutputCoalescing(rect.terminal);
    }
  }

  function setTerminalBacklogLimit(value) {
    feature.terminalBacklogLimit = normalizeTerminalBacklogLimit(value);
    feature.saveBrowserSetting(feature.terminalBacklogLimitStorageKey, feature.terminalBacklogLimit);
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal") rect.terminal?.replica?.setBacklogLimit(feature.terminalBacklogLimit);
    }
  }

  function applyTheme(id, { save = true } = {}) {
    feature.windowWobble.stop();
    feature.themeID = feature.themes[id] ? id : feature.defaultThemeID;
    if (feature.themeID !== "oled-terminal") {
      dependencies.desktop().rectangles.forEach((rect) => dependencies.interactions().setOLEDMoveMode(rect, false));
    }
    platform.document.documentElement.dataset.theme = feature.themeID;
    platform.window.tesseraStartup?.cacheTheme(dependencies.navigation().currentUser, feature.themeID);
    dependencies.geometry().reflowDockedPanesForTheme();
    // Operator puts its title bar inside the window; other themes use an
    // external tab. Re-measure contents after the chrome changes, never on move.
    for (const rect of dependencies.desktop().rectangles) {
      dependencies.terminal().requestTerminalFit(rect);
    }
    dependencies.terminal().scheduleTerminalVisibilityUpdate();
    if (save) {
      dependencies.workspace().scheduleUserSettingsSave();
    }
  }

  // The settings that suit one kind of screen; phones keep their own.
  function displaySettingsOf(settings) {
    return {
      defaultPaneFontSize: settings.defaultPaneFontSize,
      interfaceFontSize: settings.interfaceFontSize,
      defaultTheme: settings.defaultTheme,
      themeId: settings.themeId,
      deskbarButtonEnabled: settings.deskbarButtonEnabled,
      terminalWheelSensitivity: settings.terminalWheelSensitivity,
      oledWindowBorderSize: settings.oledWindowBorderSize,
      terminalFont: settings.terminalFont,
      terminalRowSpacing: settings.terminalRowSpacing,
      terminalColorMode: settings.terminalColorMode,
    };
  }

  // Which devices share the display settings this one shows.
  function displaySettingsScope() {
    return dependencies.phone().phoneDevice ? "on phones" : "on desktops and iPads";
  }

  function userSettingsPayload() {
    const display = feature.displaySettingsOf({
      defaultPaneFontSize: feature.defaultPaneFontSize, interfaceFontSize: feature.interfaceFontSize, defaultTheme: feature.defaultTheme, themeId: feature.themeID, deskbarButtonEnabled: feature.deskbarButtonEnabled, terminalWheelSensitivity: feature.terminalWheelSensitivity,
      oledWindowBorderSize: feature.oledWindowBorderSize, terminalFont: feature.terminalFont, terminalRowSpacing: feature.terminalRowSpacing, terminalColorMode: feature.terminalColorMode,
    });
    return {
      ...(dependencies.phone().phoneDevice ? dependencies.phone().otherDisplaySettings : display),
      // Left out, the host keeps the phones' settings as they are.
      phone: dependencies.phone().phoneDevice ? display : dependencies.phone().otherDisplaySettings || undefined,
      terminalTerm: feature.terminalTerm,
      terminalShellIntegrationOff: !feature.terminalShellIntegration,
      // Clear the legacy account-wide value when settings are next saved.
      olderMacMode: false,
    };
  }

  function reportSettingsSaveError(error) {
    platform.console.warn(error);
    dependencies.workspace().setWorkspaceStatus("error", "Settings save failed", error.message || "Settings save failed");
  }

  function saveUserSettingsOnExit() {
    feature.settingsPersistence.saveOnExit();
  }

  async function flushUserSettingsSave() {
    await feature.settingsPersistence.save();
  }

  function initializeSystemNotificationsStorageKey() {
    feature.systemNotificationsStorageKey = "tessera.system-notifications.v1";
    feature.systemNotificationsEnabled = false;
    // Notices when a long command finishes in a window you aren't looking at.
    feature.commandNoticesStorageKey = "tessera.command-notices.v1";
    feature.commandNoticesEnabled = true;
    try {
      feature.commandNoticesEnabled = platform.window.localStorage.getItem(feature.commandNoticesStorageKey) !== "false";
    } catch {
      // Browser storage is unavailable; notices stay on.
    }
    try {
      feature.systemNotificationsEnabled = platform.window.localStorage.getItem(feature.systemNotificationsStorageKey) === "true";
    } catch {
      // Browser storage is unavailable; notifications stay in the page.
    }
  }

  function initializeFallbackPaneFontSize() {
    // Pane text sizes stay independent of the shared interface/terminal family.
    // Canvas font families use concrete strings; DOM text uses --tessera-font.
    feature.fallbackPaneFontSize = 14;
    feature.minimumPaneFontSize = 10;
    feature.maximumPaneFontSize = 24;
    feature.defaultPaneFontSize = feature.fallbackPaneFontSize;
    feature.interfaceFontSize = defaultInterfaceFontSize;
    feature.deskbarButtonEnabled = true;
    feature.terminalWheelSensitivity = defaultWheelSensitivity;
    feature.oledWindowBorderSize = defaultOLEDBorderSize;
    feature.terminalTerm = defaultTerminalTERM;
    // Starting zsh and bash set up to mark prompts and report their directory.
    feature.terminalShellIntegration = true;
    feature.terminalFont = defaultTerminalFont;
    feature.nativeFrameLimit = 0;
    feature.terminalRowSpacing = defaultTerminalRowSpacing;
    feature.terminalColorMode = defaultTerminalColorMode;
    feature.olderMacModeStorageKey = "tessera.older-mac-mode.v1";
    feature.olderMacMode = false;
    feature.experimentalTerminalRendererStorageKey = "tessera.experimental-terminal-renderer.v1";
    feature.experimentalTerminalRenderer = true;
    feature.terminalPaintCoalescingStorageKey = "tessera.terminal-paint-coalescing.v1";
    feature.terminalPaintCoalescing = true;
    feature.terminalOutputCoalescingStorageKey = "tessera.terminal-output-coalescing.v1";
    feature.terminalOutputCoalescing = false;
    feature.terminalPredictionStorageKey = "tessera.terminal-prediction.v1";
    feature.terminalPredictionMode = "auto";
    feature.terminalBacklogLimitStorageKey = "tessera.terminal-output-backlog.v1";
    feature.terminalBacklogLimit = "auto";
    feature.windowWobbleStorageKey = "tessera.window-wobble.v1";
    feature.windowWobbleEnabled = true;
    try {
      feature.olderMacMode = platform.window.localStorage.getItem(feature.olderMacModeStorageKey) === "true";
      feature.experimentalTerminalRenderer = platform.window.localStorage.getItem(feature.experimentalTerminalRendererStorageKey) !== "false";
      feature.terminalPaintCoalescing = platform.window.localStorage.getItem(feature.terminalPaintCoalescingStorageKey) !== "false";
      feature.terminalOutputCoalescing = platform.window.localStorage.getItem(feature.terminalOutputCoalescingStorageKey) === "true";
      feature.terminalBacklogLimit = normalizeTerminalBacklogLimit(platform.window.localStorage.getItem(feature.terminalBacklogLimitStorageKey));
      feature.terminalPredictionMode = normalizePredictionMode(platform.window.localStorage.getItem(feature.terminalPredictionStorageKey));
      feature.windowWobbleEnabled = platform.window.localStorage.getItem(feature.windowWobbleStorageKey) !== "false";
    } catch {
      // Storage can be unavailable in hardened or private browser contexts.
    }
  }

  function initializeSettingsPersistence() {
    feature.settingsPersistence = new SettingsPersistence({
      fetch: (...args) => platform.fetch(...args),
      timers: platform.window,
      getDocument: feature.userSettingsPayload,
      onError: feature.reportSettingsSaveError,
    });
  }

  function initializeDefaultThemeID() {
    feature.defaultThemeID = "next-tessera";
    feature.themes = {
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
    feature.defaultTheme = feature.defaultThemeID;
    feature.themeID = Object.hasOwn(feature.themes, platform.document.documentElement.dataset.theme)
      ? platform.document.documentElement.dataset.theme : feature.defaultThemeID;
    feature.reducedWindowMotion = platform.window.matchMedia("(prefers-reduced-motion: reduce)");
    feature.windowWobble = new WindowWobble({
      enabled: () => feature.themeID === "operator" && feature.windowWobbleEnabled && !feature.olderMacMode && !feature.reducedWindowMotion.matches,
    });
    feature.reducedWindowMotion.addEventListener("change", () => feature.windowWobble.stop());
    feature.screensaver = new MosaicScreensaver({
      reducedMotion: () => feature.reducedWindowMotion.matches,
      onClose: () => dependencies.switcher().restorePaneFocusAfterOverlayDismiss(feature.screensaver.element),
    });
    platform.document.addEventListener("visibilitychange", () => { if (platform.document.hidden) feature.windowWobble.stop(); });
    feature.rdpWheelSpeedStorageKey = "tessera.rdp-wheel-speed.v1";
    feature.rdpWheelSpeed = defaultRDPWheelSpeed;
    try {
      feature.rdpWheelSpeed = normalizeRDPWheelSpeed(platform.window.localStorage.getItem(feature.rdpWheelSpeedStorageKey) ?? defaultRDPWheelSpeed);
    } catch {
      // Storage can be unavailable in hardened or private browser contexts.
    }
  }

  Object.assign(feature, {
    setWindowWobbleEnabled,
    setDefaultTheme,
    setDefaultPaneFontSize,
    setInterfaceFontSize,
    setRDPWheelSpeed,
    setTerminalWheelSensitivity,
    setOLEDWindowBorderSize,
    setTerminalShellIntegration,
    setCommandNoticesEnabled,
    setTerminalTERM,
    applyApplicationFont,
    setTerminalFont,
    setTerminalRowSpacing,
    setTerminalColorMode,
    setPaneTerminalColorMode,
    setOlderMacMode,
    setExperimentalTerminalRenderer,
    saveBrowserSetting,
    setTerminalPaintCoalescing,
    setTerminalPredictionMode,
    sendTerminalOutputCoalescing,
    setTerminalOutputCoalescing,
    setTerminalBacklogLimit,
    applyTheme,
    displaySettingsOf,
    displaySettingsScope,
    userSettingsPayload,
    reportSettingsSaveError,
    saveUserSettingsOnExit,
    flushUserSettingsSave,
    initializeSystemNotificationsStorageKey,
    initializeFallbackPaneFontSize,
    initializeSettingsPersistence,
    initializeDefaultThemeID,
  });
  return feature;
}
