import { createDesktop } from "./desktop-panes.mjs";
import { createGeometry } from "./desktop-geometry.mjs";
import { createInteractions } from "./desktop-interactions.mjs";
import { createNavigation } from "./session-navigation.mjs";
import { createPreferences } from "./preferences.mjs";
import { createBackground } from "./workspace-background.mjs";
import { createWorkspace } from "./workspace-lifecycle.mjs";
import { createBrowser } from "./browser-view.mjs";
import { createVnc } from "./vnc-view.mjs";
import { createRdp } from "./rdp-session.mjs";
import { createRdpView } from "./rdp-view.mjs";
import { createRdpDialogs } from "./rdp-dialogs.mjs";
import { createTerminal } from "./terminal-view.mjs";
import { createTerminalInput } from "./terminal-input-bridge.mjs";
import { createPhone } from "./phone-workspace.mjs";
import { createMenus } from "./workspace-menus.mjs";
import { createDeskbar } from "./deskbar.mjs";
import { createSessionsDialog } from "./sessions-dialog.mjs";
import { createSettings } from "./settings-view.mjs";
import { createHttps } from "./local-https-dialog.mjs";
import { createHelp } from "./help-dialog.mjs";
import { createPalette } from "./command-palette.mjs";
import { createWindows } from "./window-list-view.mjs";
import { createSessionList } from "./session-list-view.mjs";
import { createSwitcher } from "./window-switcher-view.mjs";
import { createConnectivity } from "./server-connectivity.mjs";
import { createClipboard } from "./clipboard-access.mjs";
import { createDirectory } from "./directory-dialog.mjs";
import { createEvents } from "./application-events.mjs";
import { createNativeApp } from "./native-app.mjs";

// Link feature-owned state and actions before running any browser effects.
const desktop = createDesktop({
  browser: () => browser,
  deskbar: () => deskbar,
  directory: () => directory,
  geometry: () => geometry,
  interactions: () => interactions,
  menus: () => menus,
  preferences: () => preferences,
  rdp: () => rdp,
  rdpView: () => rdpView,
  switcher: () => switcher,
  terminal: () => terminal,
  vnc: () => vnc,
  windows: () => windows,
  workspace: () => workspace,
});
const geometry = createGeometry({
  deskbar: () => deskbar,
  desktop: () => desktop,
  interactions: () => interactions,
  preferences: () => preferences,
  terminal: () => terminal,
  workspace: () => workspace,
});
const interactions = createInteractions({
  clipboard: () => clipboard,
  connectivity: () => connectivity,
  desktop: () => desktop,
  directory: () => directory,
  geometry: () => geometry,
  help: () => help,
  https: () => https,
  menus: () => menus,
  navigation: () => navigation,
  palette: () => palette,
  phone: () => phone,
  preferences: () => preferences,
  sessionList: () => sessionList,
  sessionsDialog: () => sessionsDialog,
  settings: () => settings,
  switcher: () => switcher,
  terminal: () => terminal,
  windows: () => windows,
  workspace: () => workspace,
});
const navigation = createNavigation({
  background: () => background,
  clipboard: () => clipboard,
  connectivity: () => connectivity,
  deskbar: () => deskbar,
  desktop: () => desktop,
  https: () => https,
  menus: () => menus,
  palette: () => palette,
  phone: () => phone,
  preferences: () => preferences,
  sessionsDialog: () => sessionsDialog,
  switcher: () => switcher,
  workspace: () => workspace,
});
const preferences = createPreferences({
  desktop: () => desktop,
  geometry: () => geometry,
  interactions: () => interactions,
  navigation: () => navigation,
  phone: () => phone,
  switcher: () => switcher,
  terminal: () => terminal,
  workspace: () => workspace,
});
const background = createBackground({
  desktop: () => desktop,
  navigation: () => navigation,
  settings: () => settings,
  workspace: () => workspace,
});
const workspace = createWorkspace({
  background: () => background,
  browser: () => browser,
  connectivity: () => connectivity,
  deskbar: () => deskbar,
  desktop: () => desktop,
  geometry: () => geometry,
  interactions: () => interactions,
  menus: () => menus,
  navigation: () => navigation,
  phone: () => phone,
  preferences: () => preferences,
  rdpView: () => rdpView,
  terminal: () => terminal,
  vnc: () => vnc,
});
const browser = createBrowser({
  connectivity: () => connectivity,
  desktop: () => desktop,
  help: () => help,
  interactions: () => interactions,
  switcher: () => switcher,
  workspace: () => workspace,
});
const vnc = createVnc({
  browser: () => browser,
  clipboard: () => clipboard,
  desktop: () => desktop,
  navigation: () => navigation,
  rdpDialogs: () => rdpDialogs,
  workspace: () => workspace,
});
const rdp = createRdp({
  desktop: () => desktop,
  navigation: () => navigation,
  rdpDialogs: () => rdpDialogs,
  rdpView: () => rdpView,
  workspace: () => workspace,
});
const rdpView = createRdpView({
  browser: () => browser,
  clipboard: () => clipboard,
  desktop: () => desktop,
  interactions: () => interactions,
  preferences: () => preferences,
  rdp: () => rdp,
  rdpDialogs: () => rdpDialogs,
  terminal: () => terminal,
  workspace: () => workspace,
});
const rdpDialogs = createRdpDialogs({
  rdpView: () => rdpView,
  workspace: () => workspace,
});
const terminal = createTerminal({
  clipboard: () => clipboard,
  connectivity: () => connectivity,
  deskbar: () => deskbar,
  desktop: () => desktop,
  geometry: () => geometry,
  interactions: () => interactions,
  menus: () => menus,
  navigation: () => navigation,
  phone: () => phone,
  preferences: () => preferences,
  rdpView: () => rdpView,
  settings: () => settings,
  terminalInput: () => terminalInput,
  workspace: () => workspace,
});
const terminalInput = createTerminalInput({
  clipboard: () => clipboard,
  desktop: () => desktop,
  interactions: () => interactions,
  menus: () => menus,
  phone: () => phone,
  preferences: () => preferences,
  terminal: () => terminal,
  workspace: () => workspace,
});
const phone = createPhone({
  clipboard: () => clipboard,
  deskbar: () => deskbar,
  desktop: () => desktop,
  geometry: () => geometry,
  interactions: () => interactions,
  menus: () => menus,
  navigation: () => navigation,
  preferences: () => preferences,
  sessionsDialog: () => sessionsDialog,
  terminal: () => terminal,
  workspace: () => workspace,
});
const menus = createMenus({
  browser: () => browser,
  clipboard: () => clipboard,
  deskbar: () => deskbar,
  desktop: () => desktop,
  directory: () => directory,
  geometry: () => geometry,
  help: () => help,
  https: () => https,
  interactions: () => interactions,
  navigation: () => navigation,
  palette: () => palette,
  preferences: () => preferences,
  rdp: () => rdp,
  sessionList: () => sessionList,
  sessionsDialog: () => sessionsDialog,
  settings: () => settings,
  terminal: () => terminal,
  terminalInput: () => terminalInput,
  vnc: () => vnc,
  windows: () => windows,
  workspace: () => workspace,
});
const deskbar = createDeskbar({
  desktop: () => desktop,
  geometry: () => geometry,
  menus: () => menus,
  navigation: () => navigation,
  phone: () => phone,
  preferences: () => preferences,
  sessionsDialog: () => sessionsDialog,
  settings: () => settings,
  windows: () => windows,
  workspace: () => workspace,
});
const sessionsDialog = createSessionsDialog({
  menus: () => menus,
  navigation: () => navigation,
  palette: () => palette,
  workspace: () => workspace,
});
const settings = createSettings({
  background: () => background,
  clipboard: () => clipboard,
  connectivity: () => connectivity,
  deskbar: () => deskbar,
  desktop: () => desktop,
  navigation: () => navigation,
  palette: () => palette,
  preferences: () => preferences,
  sessionList: () => sessionList,
  terminal: () => terminal,
  windows: () => windows,
});
const https = createHttps({
  deskbar: () => deskbar,
});
const help = createHelp({
  browser: () => browser,
  deskbar: () => deskbar,
  desktop: () => desktop,
  palette: () => palette,
});
const palette = createPalette({
  browser: () => browser,
  clipboard: () => clipboard,
  connectivity: () => connectivity,
  deskbar: () => deskbar,
  desktop: () => desktop,
  geometry: () => geometry,
  help: () => help,
  https: () => https,
  interactions: () => interactions,
  menus: () => menus,
  navigation: () => navigation,
  phone: () => phone,
  preferences: () => preferences,
  sessionList: () => sessionList,
  sessionsDialog: () => sessionsDialog,
  settings: () => settings,
  switcher: () => switcher,
  terminal: () => terminal,
  windows: () => windows,
});
const windows = createWindows({
  deskbar: () => deskbar,
  desktop: () => desktop,
  geometry: () => geometry,
  menus: () => menus,
  navigation: () => navigation,
  palette: () => palette,
  switcher: () => switcher,
  workspace: () => workspace,
});
const sessionList = createSessionList({
  menus: () => menus,
  navigation: () => navigation,
  sessionsDialog: () => sessionsDialog,
  switcher: () => switcher,
});
const switcher = createSwitcher({
  desktop: () => desktop,
  help: () => help,
  https: () => https,
  navigation: () => navigation,
  palette: () => palette,
  preferences: () => preferences,
  sessionList: () => sessionList,
  sessionsDialog: () => sessionsDialog,
  settings: () => settings,
  windows: () => windows,
});
const connectivity = createConnectivity({
  desktop: () => desktop,
  phone: () => phone,
  preferences: () => preferences,
  terminal: () => terminal,
  workspace: () => workspace,
});
const clipboard = createClipboard({
  desktop: () => desktop,
  interactions: () => interactions,
  menus: () => menus,
  settings: () => settings,
  workspace: () => workspace,
});
const directory = createDirectory({
  desktop: () => desktop,
  menus: () => menus,
});
const events = createEvents({
  browser: () => browser,
  clipboard: () => clipboard,
  connectivity: () => connectivity,
  desktop: () => desktop,
  interactions: () => interactions,
  menus: () => menus,
  navigation: () => navigation,
  preferences: () => preferences,
  phone: () => phone,
  rdpView: () => rdpView,
  sessionList: () => sessionList,
  settings: () => settings,
  switcher: () => switcher,
  terminal: () => terminal,
  vnc: () => vnc,
  windows: () => windows,
  workspace: () => workspace,
});

const nativeApp = createNativeApp({
  desktop: () => desktop, navigation: () => navigation, terminal: () => terminal,
  preferences: () => preferences, connectivity: () => connectivity, phone: () => phone,
  clipboard: () => clipboard, menus: () => menus, palette: () => palette,
  windows: () => windows, sessionList: () => sessionList, settings: () => settings,
  events: () => events,
});

// Preserve startup ordering: preferences/controllers, DOM, event routing, startup.
desktop.initializeBoard();
terminal.initializeTerminalVisibilityFrame();
desktop.initializeActivePaneID();
interactions.initializeInteraction();
geometry.initializeArrangeOutSnapshot();
desktop.initializeNextZIndex();
menus.initializeContextMenuRect();
directory.initializeDirectoryBrowserRect();
clipboard.initializeClipboardText();
navigation.initializeWorkspaceID();
terminal.initializeTerminalHostName();
preferences.initializeSystemNotificationsStorageKey();
terminal.initializeTerminalNoticeList();
phone.initializePhoneViewOverride();
navigation.initializeCurrentSessionName();
sessionsDialog.initializeSessionSelection();
background.initializeWorkspaceHasBackground();
workspace.initializeIsLoadingWorkspace();
clipboard.initializeClipboardBridge();
https.initializeIpadHTTPGuidanceDismissedKey();
events.registerFocus();
terminal.initializeGhosttyModulePromise();
rdp.initializeRdpModulePromise();
terminal.initializeTerminalTextEncoder();
preferences.initializeFallbackPaneFontSize();
terminal.initializeTerminalAudioPlayer();
connectivity.initializeServerHealthPollInterval();
workspace.initializeWorkspacePersistence();
preferences.initializeSettingsPersistence();
vnc.initializeVncController();
browser.initializeBrowserController();
terminal.initializeTerminalConnections();
rdp.initializeRdpController();
connectivity.initializeServerConnectionState();
clipboard.initializeHostClipboardStatus();
connectivity.initializeServerHealthMonitorTimer();
preferences.initializeDefaultThemeID();
navigation.initializeUserStorageKey();
background.initializeMaxBackgroundBytes();
vnc.initializeVncPaneKind();
rdp.initializeRdpPaneKind();
interactions.initializeAppleKeyboardLayout();
browser.initializeBrowserPaneKind();
menus.initializeDockMenu();
directory.initializeDirectoryBrowser();
navigation.initializeUserSelect();
background.initializeBackgroundFileInput();
deskbar.initializeDeskbarButton();
settings.initializeSettingsModal();
navigation.initializeShortcutsUI();
https.initializeLocalHTTPSModal();
clipboard.initializeClipboardSetupPrompt();
desktop.initializeRenameWindowModal();
clipboard.initializeLastClipboardSave();
sessionsDialog.initializeSessionsModal();
connectivity.initializeServerUpdateModal();
workspace.initializeWorkspaceConflictModal();
help.initializeHelpModal();
palette.initializeCommandPalette();
windows.initializeWindowList();
sessionList.initializeSessionList();
switcher.initializeWindowSwitcher();
palette.initializePaletteLauncher();
workspace.initializeWorkspaceStatus();
connectivity.initializeWakeRecoveryStatus();
events.registerDesktopEvents();
nativeApp.initialize();
rdpView.initializeRdpLockKeyCodes();
rdp.initializeRdpDetachedMessage();
workspace.initializeSavedStatusHideMs();
phone.initializePhoneWorkspaceRefresh();
terminal.initializeTerminalTimingCaptureSeconds();
settings.initializeKeyReadout();
palette.initializePaletteEntries();
windows.initializeWindowListEntries();
sessionList.initializeSessionListEntries();
switcher.initializeWindowSwitcherHideTimer();
palette.initializePaletteShortcutCodes();
geometry.registerViewportResize();
phone.registerEvents();
geometry.registerViewportScroll();
clipboard.initializeEmptyCopyStatusHideMs();

// All feature state, DOM and listeners are ready before the first request.
void navigation.openStartupWorkspace();
