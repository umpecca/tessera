import { browserWakeDetected, nextServerConnectionState } from "./server-connection.mjs";
import { isExpectedServerVersion, isSystemdUpdateCheck } from "./server-update.mjs";

// Health probes, wake recovery, offline/update dialogs and polling.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   phone: () => ReturnType<typeof import("./phone-workspace.mjs").createPhone>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createConnectivity(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    serverHealthPollInterval: undefined,
    serverConnectionState: undefined,
    serverConnectionLastHealthy: undefined,
    serverHealthMonitorTimer: undefined,
    serverHealthProbe: undefined,
    serverUpdateRestarting: undefined,
    browserWakeSample: undefined,
    browserWakePending: undefined,
    wakeRecoveryID: undefined,
    wakeRecoveryActive: undefined,
    wakeRecoveryHealthReady: undefined,
    wakeRecoveryStatusHideTimer: undefined,
    wakeRecoveryTerminals: undefined,
    serverUpdateModal: undefined,
    serverConnectionModal: undefined,
    wakeRecoveryStatus: undefined,
  };

  function handleDocumentVisibilityChange() {
    feature.checkForBrowserWake();
    dependencies.terminal().updateTerminalDocumentVisibility();
    dependencies.terminal().updateTerminalFocus();
    if (feature.serverHealthMonitorTimer !== null) feature.scheduleServerHealthPolling();
    if (platform.document.hidden) {
      // A phone put away isn't using the size it took; the host gives it back
      // after a while. Coming back reconnects the terminal, which takes it
      // again, before then without resizing the shell at all.
      const open = dependencies.phone().phoneView.active ? dependencies.desktop().rectangles.find((rect) => rect.id === dependencies.phone().phoneView.openPaneID) : null;
      if (open?.terminal?.phoneFit) dependencies.phone().releasePhoneTerminalSize(open.terminal, { later: true });
      // A backgrounded tab may be discarded without ever running code again,
      // so anything scheduled goes out now. This one takes the ordinary path:
      // the page is still here to read the response and keep its revision in
      // step, which the exit flush cannot do.
      void dependencies.workspace().saveWorkspace();
      void dependencies.preferences().flushUserSettingsSave().catch(dependencies.preferences().reportSettingsSaveError);
      return;
    }
    // A backgrounded tab has its timers throttled, so a pane that went to
    // sleep waiting may be well past the moment it meant to try again — and
    // after a machine suspends, the socket it was holding can be gone without
    // having said so.
    // ResizeObserver delivery can also be throttled while hidden, so measure
    // every visible terminal before resuming its connection.
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal" && !rect.minimized) dependencies.terminal().requestTerminalFit(rect);
    }
    dependencies.terminal().resumeTerminalConnections();
    void feature.checkServerConnection({ force: true });
    if (dependencies.phone().phoneView.active) void dependencies.phone().refreshPhoneWorkspace();
  }

  function checkForBrowserWake() {
    const sample = { wall: platform.Date.now(), monotonic: platform.performance.now() };
    if (browserWakeDetected(feature.browserWakeSample, sample)) feature.browserWakePending = true;
    feature.browserWakeSample = sample;
    if (!feature.browserWakePending || platform.document.hidden) return;
    feature.browserWakePending = false;
    void feature.recoverAfterBrowserWake();
  }

  async function recoverAfterBrowserWake() {
    const recoveryID = ++feature.wakeRecoveryID;
    feature.wakeRecoveryActive = true;
    feature.wakeRecoveryHealthReady = false;
    feature.wakeRecoveryTerminals.clear();
    platform.window.clearTimeout(feature.wakeRecoveryStatusHideTimer);
    feature.wakeRecoveryStatusHideTimer = null;

    for (const rect of dependencies.desktop().rectangles) {
      const terminalState = rect.kind === "terminal" ? rect.terminal : null;
      if (!terminalState?.term) continue;
      if (terminalState.outputPaused) continue;
      dependencies.terminal().requestTerminalFit(rect);
      terminalState.term.requestFullRedraw?.();
      if (rect.terminalStatus && !rect.terminalStatus.reconnect) continue;

      feature.wakeRecoveryTerminals.add(terminalState);
      terminalState.wakeRecoveryID = recoveryID;
      if (terminalState.reconnectTimer !== null) {
        platform.window.clearTimeout(terminalState.reconnectTimer);
        terminalState.reconnectTimer = null;
      }
      terminalState.reconnectAttempts = 0;
      const oldSocket = terminalState.socket;
      dependencies.terminal().connectTerminalSocket(rect);
      if (oldSocket?.readyState === platform.WebSocket.OPEN || oldSocket?.readyState === platform.WebSocket.CONNECTING) {
        oldSocket.close(1000, "Reconnecting after wake");
      }
    }
    feature.updateWakeRecoveryStatus();

    const healthy = await feature.checkServerConnection({ force: true });
    if (recoveryID !== feature.wakeRecoveryID) return;
    if (healthy) feature.wakeRecoveryHealthReady = true;
    feature.updateWakeRecoveryStatus();
  }

  function completeTerminalWakeRecovery(terminalState) {
    if (!feature.wakeRecoveryActive || terminalState?.wakeRecoveryID !== feature.wakeRecoveryID) return;
    terminalState.wakeRecoveryID = 0;
    feature.wakeRecoveryTerminals.delete(terminalState);
    feature.updateWakeRecoveryStatus();
  }

  function updateWakeRecoveryStatus() {
    if (!feature.wakeRecoveryActive) return;
    const pending = feature.wakeRecoveryTerminals.size;
    if (!feature.wakeRecoveryHealthReady || pending > 0) {
      feature.wakeRecoveryStatus.textContent = pending > 0
        ? `Reconnecting after wake… ${pending} terminal${pending === 1 ? "" : "s"}`
        : "Checking Tessera after wake…";
      feature.wakeRecoveryStatus.hidden = false;
      return;
    }
    feature.wakeRecoveryActive = false;
    feature.wakeRecoveryStatus.textContent = "Ready after wake";
    feature.wakeRecoveryStatus.hidden = false;
    feature.wakeRecoveryStatusHideTimer = platform.window.setTimeout(() => {
      feature.wakeRecoveryStatus.hidden = true;
      feature.wakeRecoveryStatusHideTimer = null;
    }, 2000);
  }

  function startServerConnectionMonitor() {
    if (feature.serverHealthMonitorTimer !== null) {
      return;
    }
    platform.window.addEventListener("offline", feature.handleBrowserOffline);
    platform.window.addEventListener("online", feature.handleBrowserOnline);
    void feature.checkServerConnection();
    feature.scheduleServerHealthPolling();
  }

  function scheduleServerHealthPolling() {
    platform.window.clearInterval(feature.serverHealthMonitorTimer);
    feature.serverHealthMonitorTimer = platform.window.setInterval(() => {
      feature.checkForBrowserWake();
      void feature.checkServerConnection();
    }, platform.document.hidden ? 30000 : feature.serverHealthPollInterval);
  }

  function handleBrowserOffline() {
    if (feature.serverUpdateRestarting) {
      return;
    }
    dependencies.workspace().markWorkspaceDisconnected();
    feature.serverConnectionState = nextServerConnectionState(feature.serverConnectionState, {
      healthy: false,
      online: false,
      force: true,
    });
    feature.showServerConnectionModal(feature.serverConnectionState.state);
  }

  function handleBrowserOnline() {
    if (feature.serverUpdateRestarting) {
      return;
    }
    if (!feature.serverConnectionModal.hidden) {
      feature.showServerConnectionModal("checking");
    }
    feature.checkForBrowserWake();
    // The panes do not wait for the probe to confirm what the browser just
    // said; a failed attempt costs one round trip and reschedules itself.
    dependencies.terminal().resumeTerminalConnections();
    void feature.checkServerConnection({ force: true });
  }

  async function probeServerHealth() {
    if (!feature.serverHealthProbe) {
      const probe = (async () => {
        try {
          const response = await platform.fetch("/api/health", {
            signal: platform.AbortSignal.timeout(2000),
            cache: "no-store",
          });
          return response.ok;
        } catch {
          return false;
        }
      })();
      feature.serverHealthProbe = probe;
      probe.finally(() => {
        if (feature.serverHealthProbe === probe) {
          feature.serverHealthProbe = null;
        }
      });
    }
    return feature.serverHealthProbe;
  }

  async function checkServerConnection({ manual = false, force = false } = {}) {
    if (feature.serverUpdateRestarting) {
      return false;
    }
    if (manual) {
      feature.showServerConnectionModal("checking");
    }
    const previousState = feature.serverConnectionState.state;
    const healthy = await feature.probeServerHealth();
    feature.serverConnectionLastHealthy = healthy;
    if (feature.serverUpdateRestarting) {
      return healthy;
    }
    if (healthy && feature.wakeRecoveryActive) {
      feature.wakeRecoveryHealthReady = true;
      feature.updateWakeRecoveryStatus();
    }
    // The probe reaches the server over the same network the terminal sockets
    // use, so an answer after a spell of trouble is the earliest evidence a
    // waiting pane could act on. Only the recovery is interesting: healthy
    // polls during ordinary operation move nothing.
    if (healthy && previousState) {
      dependencies.terminal().resumeTerminalConnections();
    }
    feature.serverConnectionState = nextServerConnectionState(feature.serverConnectionState, {
      healthy,
      online: platform.navigator.onLine !== false,
      force,
    });

    if (!healthy && feature.serverConnectionState.state) {
      dependencies.workspace().markWorkspaceDisconnected();
    }
    if (healthy && dependencies.workspace().workspacePersistence.needsRevalidation) {
      const current = await dependencies.workspace().revalidateWorkspaceRevision();
      if (!current) {
        return true;
      }
    }
    if (dependencies.workspace().workspacePersistence.suspended) {
      return healthy;
    }
    if (healthy && manual) {
      feature.showServerConnectionModal("restored", { reloading: true });
      platform.window.setTimeout(() => platform.window.location.reload(), 250);
      return true;
    }
    if (feature.serverConnectionState.state && (manual || force || feature.serverConnectionModal.hidden || feature.serverConnectionState.state !== previousState)) {
      feature.showServerConnectionModal(feature.serverConnectionState.state);
    }
    return healthy;
  }

  function showServerConnectionModal(state, { reloading = false } = {}) {
    if (feature.serverUpdateRestarting || dependencies.workspace().workspacePersistence.suspended) {
      return;
    }
    feature.serverConnectionModal.replaceChildren();

    const panel = platform.document.createElement("section");
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
      const current = controls.indexOf(platform.document.activeElement);
      const next = event.shiftKey
        ? (current <= 0 ? controls.length - 1 : current - 1)
        : (current < 0 || current === controls.length - 1 ? 0 : current + 1);
      event.preventDefault();
      controls[next].focus();
    });

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "server-connection-title";
    title.textContent = state === "restored" ? "Connection Restored" : "Connection Lost";
    titleBar.appendChild(title);

    const content = platform.document.createElement("div");
    content.className = "settings-content server-connection-content";
    const status = platform.document.createElement("p");
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

    const actions = platform.document.createElement("div");
    actions.className = "rename-window-actions server-connection-actions";
    const refreshButton = platform.document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "settings-background-button";
    refreshButton.textContent = "Refresh Page";
    refreshButton.addEventListener("click", () => platform.window.location.reload());

    const primaryButton = platform.document.createElement("button");
    primaryButton.type = "button";
    primaryButton.className = "settings-background-button server-connection-primary";
    if (state === "restored") {
      primaryButton.textContent = reloading ? "Reloading..." : "Reload Tessera";
      primaryButton.disabled = reloading;
      if (!reloading) {
        primaryButton.addEventListener("click", () => platform.window.location.reload());
      }
    } else if (state === "checking") {
      primaryButton.textContent = "Checking...";
      primaryButton.disabled = true;
    } else {
      primaryButton.textContent = "Reconnect";
      primaryButton.addEventListener("click", () => void feature.checkServerConnection({ manual: true, force: true }));
    }

    actions.append(refreshButton, primaryButton);
    content.append(status, actions);
    panel.append(titleBar, content);
    feature.serverConnectionModal.appendChild(panel);
    feature.serverConnectionModal.hidden = false;
    platform.window.requestAnimationFrame(() => (primaryButton.disabled ? refreshButton : primaryButton).focus());
  }

  function hideServerConnectionModal() {
    const shown = !feature.serverConnectionModal.hidden;
    feature.serverConnectionModal.hidden = true;
    feature.serverConnectionModal.replaceChildren();
    // Its button took focus, which can leave a phone's page scrolled.
    if (shown) dependencies.phone().phoneView.restoreViewport();
  }

  // Shows the server-update status modal with a message. Closable steps get a
  // Close button and backdrop dismissal; in-flight steps (download, restart)
  // keep the modal locked so the flow isn't abandoned half-way.
  function showUpdateStatus(message, { closable = false, busy = false } = {}) {
    feature.serverUpdateModal.replaceChildren();
    feature.serverUpdateModal.dataset.closable = String(closable);

    const panel = platform.document.createElement("section");
    panel.className = "settings-panel server-update-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "server-update-title");

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "server-update-title";
    title.textContent = "Update Server";
    titleBar.appendChild(title);

    const content = platform.document.createElement("div");
    content.className = "settings-content server-update-content";
    const status = platform.document.createElement("p");
    status.className = "server-update-status";
    if (busy) {
      status.classList.add("is-busy");
    }
    status.textContent = message;
    content.appendChild(status);

    if (closable) {
      const actions = platform.document.createElement("div");
      actions.className = "rename-window-actions";
      const closeButton = platform.document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "settings-background-button";
      closeButton.textContent = "Close";
      closeButton.addEventListener("click", feature.hideServerUpdateModal);
      actions.appendChild(closeButton);
      content.appendChild(actions);
      platform.window.requestAnimationFrame(() => closeButton.focus());
    }

    panel.append(titleBar, content);
    feature.serverUpdateModal.appendChild(panel);
    feature.serverUpdateModal.hidden = false;
  }

  function hideServerUpdateModal() {
    feature.serverUpdateModal.hidden = true;
    feature.serverUpdateModal.replaceChildren();
  }

  function showSystemdUpdatePrompt(check) {
    feature.serverUpdateModal.replaceChildren();
    feature.serverUpdateModal.dataset.closable = "true";

    const panel = platform.document.createElement("section");
    panel.className = "settings-panel server-update-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "server-update-title");

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "server-update-title";
    title.textContent = "Update Server";
    titleBar.appendChild(title);

    const content = platform.document.createElement("div");
    content.className = "settings-content server-update-content";
    const status = platform.document.createElement("p");
    status.className = "server-update-status";
    status.textContent = `Tessera ${check.latestVersion} is available. This systemd installation needs sudo authorization in a Terminal.`;

    const actions = platform.document.createElement("div");
    actions.className = "rename-window-actions";
    const cancelButton = platform.document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "settings-background-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", feature.hideServerUpdateModal);
    const terminalButton = platform.document.createElement("button");
    terminalButton.type = "button";
    terminalButton.textContent = "Open Update Terminal";
    terminalButton.addEventListener("click", () => {
      dependencies.desktop().createTerminalPane(null, {
        title: "Update Tessera",
        terminalStartupCommand: check.updateCommand,
      });
      feature.hideServerUpdateModal();
      feature.hideServerConnectionModal();
      feature.serverUpdateRestarting = true;
      void feature.waitForUpdatedServer(check, {
        timeoutMs: 5 * 60 * 1000,
        timeoutMessage: "The service update did not complete within five minutes. Inspect the Update Tessera terminal or the systemd journal.",
      });
    });
    actions.append(cancelButton, terminalButton);
    content.append(status, actions);
    panel.append(titleBar, content);
    feature.serverUpdateModal.appendChild(panel);
    feature.serverUpdateModal.hidden = false;
    platform.window.requestAnimationFrame(() => terminalButton.focus());
  }

  async function waitForUpdatedServer(check, { timeoutMs = 60000, timeoutMessage = "The server did not come back within a minute. Use Reconnect once it is running." } = {}) {
    const deadline = platform.Date.now() + timeoutMs;
    let lastHealth = null;
    while (platform.Date.now() < deadline) {
      await new Promise((resolve) => platform.setTimeout(resolve, 500));
      try {
        const cacheBuster = `${platform.Date.now()}-${Math.random().toString(36).slice(2)}`;
        const response = await platform.fetch(`/api/health?update=${encodeURIComponent(cacheBuster)}`, {
          signal: platform.AbortSignal.timeout(2000),
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
        feature.serverUpdateRestarting = false;
        feature.serverConnectionState = { failures: 0, state: "" };
        feature.showUpdateStatus(`Updated to ${health.version || check.latestVersion} — reloading...`, { busy: true });
        platform.window.setTimeout(() => platform.window.location.reload(), 800);
        // If navigation is blocked or stalls, restore an actionable client UI
        // instead of leaving the locked update dialog on screen indefinitely.
        platform.window.setTimeout(() => {
          feature.hideServerUpdateModal();
          feature.showServerConnectionModal("restored");
        }, 5000);
        return;
      } catch {
        // Server still restarting; keep polling.
      }
    }
    feature.serverUpdateRestarting = false;
    if (lastHealth && !isExpectedServerVersion(lastHealth, check.currentVersion)) {
      feature.showUpdateStatus(
        `The server restarted as ${lastHealth.version || "an unknown version"}; expected ${check.latestVersion}.`,
        { closable: true },
      );
    } else {
      feature.showUpdateStatus(timeoutMessage, { closable: true });
    }
    await feature.checkServerConnection({ force: true });
  }

  // Checks GitHub for a newer release via the server, chooses the direct or
  // systemd-owned install path, and waits for the expected version before reload.
  async function runServerUpdate() {
    feature.showUpdateStatus("Checking for updates...", { busy: true });
    let check;
    try {
      const response = await platform.fetch("/api/update");
      const body = await response.json();
      if (!response.ok) {
        feature.showUpdateStatus(`Update check failed: ${body.error || response.status}`, { closable: true });
        return;
      }
      check = body;
    } catch (error) {
      feature.showUpdateStatus(`Update check failed: ${error.message}`, { closable: true });
      return;
    }
    if (!check.updateAvailable) {
      feature.showUpdateStatus(`Tessera is up to date (${check.currentVersion}).`, { closable: true });
      return;
    }

    if (isSystemdUpdateCheck(check)) {
      feature.showSystemdUpdatePrompt(check);
      return;
    }

    feature.showUpdateStatus(`Updating ${check.currentVersion} → ${check.latestVersion} — downloading...`, { busy: true });
    let updatePostError = null;
    try {
      const response = await platform.fetch("/api/update", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        feature.showUpdateStatus(`Update failed: ${body.error || response.status}`, { closable: true });
        return;
      }
      if (body.status !== "restarting") {
        feature.showUpdateStatus(`Tessera is up to date (${body.currentVersion}).`, { closable: true });
        return;
      }
      feature.serverUpdateRestarting = true;
      feature.hideServerConnectionModal();
    } catch (error) {
      // Shutdown can close the request after installation but before the JSON
      // acknowledgement arrives. The new server version is authoritative.
      updatePostError = error;
      feature.serverUpdateRestarting = true;
      feature.hideServerConnectionModal();
    }

    feature.showUpdateStatus(updatePostError
      ? "The update connection closed. Waiting for the updated server..."
      : "Restarting server...", { busy: true });
    await feature.waitForUpdatedServer(check);
  }

  function initializeServerHealthPollInterval() {
    feature.serverHealthPollInterval = 5000;
  }

  function initializeServerConnectionState() {
    feature.serverConnectionState = { failures: 0, state: "" };
    feature.serverConnectionLastHealthy = null;
  }

  function initializeServerHealthMonitorTimer() {
    feature.serverHealthMonitorTimer = null;
    feature.serverHealthProbe = null;
    feature.serverUpdateRestarting = false;
    feature.browserWakeSample = { wall: platform.Date.now(), monotonic: platform.performance.now() };
    feature.browserWakePending = false;
    feature.wakeRecoveryID = 0;
    feature.wakeRecoveryActive = false;
    feature.wakeRecoveryHealthReady = false;
    feature.wakeRecoveryStatusHideTimer = null;
    feature.wakeRecoveryTerminals = new Set();
  }

  function initializeServerUpdateModal() {
    feature.serverUpdateModal = platform.document.createElement("div");
    feature.serverUpdateModal.className = "settings-modal server-update-modal";
    feature.serverUpdateModal.hidden = true;
    feature.serverUpdateModal.addEventListener("pointerdown", (event) => {
      if (event.target === feature.serverUpdateModal && feature.serverUpdateModal.dataset.closable === "true") {
        feature.hideServerUpdateModal();
      }
    });
    platform.document.body.appendChild(feature.serverUpdateModal);
    feature.serverConnectionModal = platform.document.createElement("div");
    feature.serverConnectionModal.className = "settings-modal server-connection-modal";
    feature.serverConnectionModal.hidden = true;
    platform.document.body.appendChild(feature.serverConnectionModal);
  }

  function initializeWakeRecoveryStatus() {
    feature.wakeRecoveryStatus = platform.document.createElement("div");
    feature.wakeRecoveryStatus.className = "wake-recovery-status";
    feature.wakeRecoveryStatus.hidden = true;
    feature.wakeRecoveryStatus.setAttribute("role", "status");
    feature.wakeRecoveryStatus.setAttribute("aria-live", "polite");
    platform.document.body.appendChild(feature.wakeRecoveryStatus);
  }

  Object.assign(feature, {
    handleDocumentVisibilityChange,
    checkForBrowserWake,
    recoverAfterBrowserWake,
    completeTerminalWakeRecovery,
    updateWakeRecoveryStatus,
    startServerConnectionMonitor,
    scheduleServerHealthPolling,
    handleBrowserOffline,
    handleBrowserOnline,
    probeServerHealth,
    checkServerConnection,
    showServerConnectionModal,
    hideServerConnectionModal,
    showUpdateStatus,
    hideServerUpdateModal,
    showSystemdUpdatePrompt,
    waitForUpdatedServer,
    runServerUpdate,
    initializeServerHealthPollInterval,
    initializeServerConnectionState,
    initializeServerHealthMonitorTimer,
    initializeServerUpdateModal,
    initializeWakeRecoveryStatus,
  });
  return feature;
}
