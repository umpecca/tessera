import { workspaceDocument } from "./workspace-document.mjs";
import { WorkspacePersistence } from "./workspace-persistence.mjs";
import { activePaneOnLoad } from "./pane-activation.mjs";

// Workspace restoration, persistence composition, conflicts and status.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   background: () => ReturnType<typeof import("./workspace-background.mjs").createBackground>,
 *   browser: () => ReturnType<typeof import("./browser-view.mjs").createBrowser>,
 *   connectivity: () => ReturnType<typeof import("./server-connectivity.mjs").createConnectivity>,
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   geometry: () => ReturnType<typeof import("./desktop-geometry.mjs").createGeometry>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   menus: () => ReturnType<typeof import("./workspace-menus.mjs").createMenus>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   phone: () => ReturnType<typeof import("./phone-workspace.mjs").createPhone>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   rdpView: () => ReturnType<typeof import("./rdp-view.mjs").createRdpView>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   vnc: () => ReturnType<typeof import("./vnc-view.mjs").createVnc>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createWorkspace(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    isLoadingWorkspace: undefined,
    workspaceStatusHideTimer: undefined,
    workspacePersistence: undefined,
    workspaceConflictModal: undefined,
    workspaceStatus: undefined,
    savedStatusHideMs: undefined,
  };

  async function fetchWorkspace(id) {
    const response = await platform.fetch(`/api/workspace/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`load workspace failed: ${response.status}`);
    const workspace = await response.json();
    if (!workspace || workspace.id !== id || typeof workspace.revision !== "string"
      || !Array.isArray(workspace.panes) || workspace.panes.some((pane) => !pane || typeof pane.id !== "string")) {
      throw new Error("Invalid workspace response");
    }
    return workspace;
  }

  function loadWorkspace(workspace) {
    feature.isLoadingWorkspace = true;
    feature.setWorkspaceStatus("loading", "Loading...");
    try {
      dependencies.navigation().workspaceID = workspace.id || "default";
      feature.workspacePersistence.reset(dependencies.navigation().workspaceID, workspace.revision || "");
      feature.workspaceConflictModal.hidden = true;
      dependencies.background().applyWorkspaceBackground(Boolean(workspace.hasBackground), workspace.backgroundVersion || "", workspace.backgroundMode);
      feature.clearRectanglesForLoad();

      let highestZIndex = 0;
      for (const pane of workspace.panes || []) {
        // Retired Audio panes in imported documents have no terminal to play on.
        if (pane.kind === "audio") continue;
        const rect = dependencies.desktop().createRectangle(pane.x ?? 80, pane.y ?? dependencies.desktop().tabHeight + 56, pane.width || 360, pane.height || 240, {
          id: pane.id,
          kind: pane.kind || "terminal",
          title: pane.title,
          text: pane.bufferText,
          editorMode: pane.editorMode,
          fontSize: pane.fontSize,
          terminalColorMode: pane.terminalColorMode,
          cwd: pane.cwd,
          lastExportPath: pane.lastExportPath,
          editorTabs: pane.editorTabs,
          browserUrl: pane.browserUrl,
          vncTarget: pane.vncTarget,
          vncViewOnly: Boolean(pane.vncViewOnly),
          vncScaleMode: pane.vncScaleMode,
          rdpTarget: pane.rdpTarget,
          rdpUsername: pane.rdpUsername,
          rdpDomain: pane.rdpDomain,
          rdpScaleMode: pane.rdpScaleMode,
          rdpTrustedTarget: pane.rdpTrustedTarget,
          rdpTrustedFingerprint: pane.rdpTrustedFingerprint,
          rdpFullSize: Boolean(pane.rdpFullSize),
          rdpWiggle: Boolean(pane.rdpWiggle),
          rdpWiggleAlways: Boolean(pane.rdpWiggleAlways),
          rdpResolution: pane.rdpResolution || "",
          zIndex: pane.zIndex || 0,
          minimized: Boolean(pane.minimized),
          isFull: Boolean(pane.isFull),
          restoreBox: dependencies.geometry().parseRestoreBox(pane.restoreBox),
        });
        highestZIndex = Math.max(highestZIndex, rect.zIndex);
      }

      dependencies.geometry().reflowDockedPanesForTheme();

      dependencies.desktop().nextZIndex = Math.max(dependencies.desktop().nextZIndex, highestZIndex + 1);
      const activeLoadedRect = activePaneOnLoad(dependencies.desktop().rectangles, workspace.activePaneId);
      if (activeLoadedRect) {
        dependencies.desktop().setActivePane(activeLoadedRect, { raise: false, focus: true });
      }
      dependencies.deskbar().updateDeskbar();
      dependencies.phone().phoneView.reset();
      feature.setWorkspaceStatus("saved", "Saved", "Workspace loaded");
    } finally {
      feature.isLoadingWorkspace = false;
    }
  }

  function clearRectanglesForLoad() {
    dependencies.background().backgroundRequestID += 1;
    // Whatever is loaded next is the server's copy, not the content this browser
    // last pushed, so the next save carries its documents again.
    feature.workspacePersistence.forgetPaneContent();
    for (const rect of dependencies.desktop().rectangles.splice(0)) {
      platform.window.clearTimeout(rect.fontSizeIndicatorTimer);
      dependencies.terminal().disposeTerminal(rect);
      dependencies.browser().disposeBrowserPane(rect);
      dependencies.vnc().disposeVNCPane(rect);
      dependencies.rdpView().disposeRDPPane(rect);
      rect.element.remove();
    }
    dependencies.desktop().activeRect = null;
    dependencies.desktop().activePaneID = "";
    delete dependencies.desktop().board.dataset.activePaneId;
    dependencies.interactions().interaction = null;
    dependencies.menus().contextMenuRect = null;
    dependencies.menus().hideAllMenus();
    dependencies.desktop().nextZIndex = 1;
    dependencies.deskbar().updateDeskbar();
  }

  function scheduleWorkspaceSave() {
    feature.workspacePersistence.schedule();
  }

  function scheduleUserSettingsSave() {
    dependencies.preferences().settingsPersistence.schedule();
  }

  async function flushAllPersistence() {
    await Promise.all([feature.flushWorkspaceSave(), dependencies.preferences().flushUserSettingsSave()]);
  }

  async function flushWorkspaceSave() {
    await feature.workspacePersistence.flush();
  }

  // A scheduled save lives in a timer, and a page that goes away takes the timer
  // with it: the pane you just focused, moved or renamed is lost, and the next
  // load restores the state from before it. This is the last moment the page is
  // given to run code, so the request goes out here and is asked to outlive the
  // document rather than awaited, since nothing here will be resumed.
  function saveWorkspaceOnExit() {
    feature.workspacePersistence.saveOnExit();
  }

  async function saveWorkspace() {
    return feature.workspacePersistence.save();
  }

  function showWorkspaceConflict() {
    feature.setWorkspaceStatus("error", "Newer workspace available", "Reload to use the workspace saved by another browser");
    dependencies.connectivity().serverConnectionModal.hidden = true;
    feature.workspaceConflictModal.replaceChildren();

    const panel = platform.document.createElement("section");
    panel.className = "settings-panel workspace-conflict-panel";
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "workspace-conflict-title");
    panel.setAttribute("aria-describedby", "workspace-conflict-status");

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "workspace-conflict-title";
    title.textContent = "Newer Workspace Available";
    titleBar.appendChild(title);

    const content = platform.document.createElement("div");
    content.className = "settings-content";
    const status = platform.document.createElement("p");
    status.id = "workspace-conflict-status";
    status.className = "workspace-conflict-status";
    status.textContent = "Another browser saved this workspace after this page loaded. Autosave is paused so this older copy cannot overwrite it.";
    content.appendChild(status);

    const actions = platform.document.createElement("div");
    actions.className = "rename-window-actions";
    const reloadButton = platform.document.createElement("button");
    reloadButton.type = "button";
    reloadButton.className = "settings-background-button server-connection-primary";
    reloadButton.textContent = "Reload Latest Workspace";
    reloadButton.addEventListener("click", () => platform.window.location.reload());
    actions.appendChild(reloadButton);

    panel.append(titleBar, content, actions);
    feature.workspaceConflictModal.appendChild(panel);
    feature.workspaceConflictModal.hidden = false;
    reloadButton.focus();
  }

  function markWorkspaceDisconnected() {
    feature.workspacePersistence.markDisconnected();
  }

  async function revalidateWorkspaceRevision() {
    return feature.workspacePersistence.revalidate();
  }

  // A status that reports a condition the operator has to act on stays up until
  // something replaces it. One that only narrates a moment — a save, or a copy
  // that had nothing to copy — takes an autoHideMs and clears itself.
  function setWorkspaceStatus(state, text, title = "", options = {}) {
    const autoHideMs = options.autoHideMs ?? (state === "saved" ? feature.savedStatusHideMs : 0);
    // Dragging a window calls this every pointer move with the same "Saving..."
    // arguments, so skip the DOM writes when nothing about the status changed.
    // A hidden status still needs re-showing, and one that auto-hides needs its
    // timer re-armed, so both fall through.
    if (
      !feature.workspaceStatus.hidden
      && !autoHideMs
      && feature.workspaceStatus.dataset.state === state
      && feature.workspaceStatus.textContent === text
      && feature.workspaceStatus.title === (title || text)
    ) {
      return;
    }
    platform.window.clearTimeout(feature.workspaceStatusHideTimer);
    feature.workspaceStatusHideTimer = null;
    feature.workspaceStatus.hidden = false;
    feature.workspaceStatus.dataset.state = state;
    feature.workspaceStatus.textContent = text;
    feature.workspaceStatus.title = title || text;
    if (autoHideMs) {
      feature.workspaceStatusHideTimer = platform.window.setTimeout(() => {
        // Anything that replaced this status owns the strip now, and clears the
        // timer on its way in; this only guards against a stale firing.
        if (feature.workspaceStatus.dataset.state === state && feature.workspaceStatus.textContent === text) {
          feature.workspaceStatus.hidden = true;
        }
        feature.workspaceStatusHideTimer = null;
      }, autoHideMs);
    }
  }

  function initializeIsLoadingWorkspace() {
    feature.isLoadingWorkspace = false;
    feature.workspaceStatusHideTimer = null;
  }

  function initializeWorkspacePersistence() {
    feature.workspacePersistence = new WorkspacePersistence({
      fetch: (...args) => platform.fetch(...args),
      timers: platform.window,
      getDocument: (revision, savedContent) => workspaceDocument({
        id: dependencies.navigation().workspaceID, revision, name: dependencies.navigation().currentSessionName, activePaneID: dependencies.desktop().activePaneID,
        backgroundMode: dependencies.background().workspaceBackgroundMode, panes: dependencies.desktop().rectangles, defaultPaneFontSize: dependencies.preferences().defaultPaneFontSize,
      }, savedContent),
      isLoading: () => feature.isLoadingWorkspace,
      setStatus: feature.setWorkspaceStatus,
      onConflict: feature.showWorkspaceConflict,
    });
  }

  function initializeWorkspaceConflictModal() {
    feature.workspaceConflictModal = platform.document.createElement("div");
    feature.workspaceConflictModal.className = "settings-modal workspace-conflict-modal";
    feature.workspaceConflictModal.hidden = true;
    platform.document.body.appendChild(feature.workspaceConflictModal);
  }

  function initializeWorkspaceStatus() {
    feature.workspaceStatus = platform.document.createElement("div");
    feature.workspaceStatus.className = "workspace-status";
    feature.workspaceStatus.setAttribute("role", "status");
    feature.workspaceStatus.setAttribute("aria-live", "polite");
    feature.workspaceStatus.dataset.state = "idle";
    feature.workspaceStatus.textContent = "Loading...";
    platform.document.body.appendChild(feature.workspaceStatus);
  }

  function initializeSavedStatusHideMs() {
    feature.savedStatusHideMs = 3000;
  }

  Object.assign(feature, {
    fetchWorkspace,
    loadWorkspace,
    clearRectanglesForLoad,
    scheduleWorkspaceSave,
    scheduleUserSettingsSave,
    flushAllPersistence,
    flushWorkspaceSave,
    saveWorkspaceOnExit,
    saveWorkspace,
    showWorkspaceConflict,
    markWorkspaceDisconnected,
    revalidateWorkspaceRevision,
    setWorkspaceStatus,
    initializeIsLoadingWorkspace,
    initializeWorkspacePersistence,
    initializeWorkspaceConflictModal,
    initializeWorkspaceStatus,
    initializeSavedStatusHideMs,
  });
  return feature;
}
