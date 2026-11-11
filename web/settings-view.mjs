import { clipboardBridgeNeedsUpdate } from "./clipboard-bridge.mjs";
import { compatibilityDiagnostics, detectCompatibility } from "./compatibility.mjs";
import { KeyReadout, keyReadoutShouldPreventKeydown } from "./key-readout.mjs";
import { terminalRowSpacings } from "./terminal-settings.mjs";
import { terminalFonts } from "./terminal-font.mjs";
import { terminalColorModes } from "./terminal-colors.mjs";
import { rdpWheelSpeedOptions } from "./rdp-pane.mjs";
import { SettingsDialog } from "./settings-dialog.mjs";
import { focusPane } from "./pane-activation.mjs";
import { formatOutputTiming } from "./terminal-output-timing.mjs";
import { describeHostClipboard } from "./clipboard-image.mjs";
import { maximumOLEDBorderSize, minimumOLEDBorderSize } from "./oled-border-size.mjs";
import { wheelSensitivityOptions } from "./wheel-sensitivity.mjs";
import { minimumInterfaceFontSize, maximumInterfaceFontSize } from "./interface-font.mjs";

// Settings control builders, diagnostics and dialog composition.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   background: () => ReturnType<typeof import("./workspace-background.mjs").createBackground>,
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   connectivity: () => ReturnType<typeof import("./server-connectivity.mjs").createConnectivity>,
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   palette: () => ReturnType<typeof import("./command-palette.mjs").createPalette>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   sessionList: () => ReturnType<typeof import("./session-list-view.mjs").createSessionList>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   windows: () => ReturnType<typeof import("./window-list-view.mjs").createWindows>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createSettings(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    settingsModal: undefined,
    settingsDialog: undefined,
    keyReadout: undefined,
  };

  function renderSettingsSystemNotificationsRow() {
    const row = platform.document.createElement("div");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "System notifications";
    const detail = platform.document.createElement("span");
    detail.textContent = "Show notifications from terminal programs (OSC 9 and OSC 777) and command finished notices as system notifications while Tessera is in the background. They always appear in the corner of the page. Saved in this browser.";
    label.append(name, detail);
    const button = platform.document.createElement("button");
    button.type = "button";
    const update = () => {
      const permission = platform.window.Notification.permission;
      button.disabled = permission === "denied";
      button.textContent = permission === "denied" ? "Blocked by browser" : dependencies.preferences().systemNotificationsEnabled && permission === "granted" ? "Turn off" : "Turn on";
      button.title = permission === "denied" ? "Allow notifications for this site in the browser's settings" : "";
    };
    button.addEventListener("click", async () => {
      if (dependencies.preferences().systemNotificationsEnabled && platform.window.Notification.permission === "granted") {
        dependencies.preferences().systemNotificationsEnabled = false;
      } else {
        // Asked inside the click: Safari allows the request only then.
        const permission = platform.window.Notification.permission === "granted" ? "granted" : await platform.window.Notification.requestPermission();
        dependencies.preferences().systemNotificationsEnabled = permission === "granted";
      }
      dependencies.preferences().saveBrowserSetting(dependencies.preferences().systemNotificationsStorageKey, dependencies.preferences().systemNotificationsEnabled);
      update();
    });
    update();
    row.append(label, button);
    return row;
  }

  function openSettingsModal(options = {}) {
    feature.settingsDialog.open(options);
  }

  function containSettingsFocus(event) {
    feature.settingsDialog.containFocus(event);
  }

  function handleSettingsKeyboard(event) {
    feature.settingsDialog.keydown(event);
  }

  function settingsDiagnosticsOpen() {
    return feature.settingsDialog.diagnosticsOpen();
  }

  function hideSettingsModal() {
    feature.settingsDialog.close();
  }

  function setTerminalRenderingMetricsEnabled(enabled) {
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal") {
        rect.terminal?.term?.setRenderingMetricsEnabled?.(enabled);
      }
    }
  }

  function renderSettingsModal() {
    feature.settingsDialog.render();
  }

  function currentCompatibility() {
    const info = detectCompatibility({
      userAgent: platform.navigator.userAgent,
      platform: platform.navigator.userAgentData?.platform || platform.navigator.platform || "Unknown",
      secureContext: platform.window.isSecureContext,
      clipboard: platform.navigator.clipboard,
      extension: dependencies.clipboard().clipboardBridge.status,
      displayPixelRatio: platform.window.devicePixelRatio || 1,
      olderMacMode: dependencies.preferences().olderMacMode,
      experimentalTerminalRenderer: dependencies.preferences().experimentalTerminalRenderer,
      online: platform.navigator.onLine !== false,
      serverHealthy: dependencies.connectivity().serverConnectionLastHealthy,
      serverState: dependencies.connectivity().serverConnectionState.state,
    });
    info.rendererRows = [];
    info.renderingCosts = dependencies.desktop().rectangles.filter(rect => rect.kind === "terminal" && rect.terminal?.term)
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
    info.enhancedClipboard = describeHostClipboard(dependencies.clipboard().hostClipboardStatus, { failed: dependencies.clipboard().hostClipboardStatusFailed });
    info.paintCoalescing = dependencies.preferences().terminalPaintCoalescing;
    info.outputCoalescing = dependencies.preferences().terminalOutputCoalescing;
    info.typingPrediction = dependencies.desktop().rectangles.filter(rect => rect.kind === "terminal" && rect.terminal?.term?.predictionStatistics)
      .map((rect, index) => {
        const stats = rect.terminal.term.predictionStatistics();
        return `Terminal ${index + 1}: ${feature.describeTypingPrediction(stats)}${feature.describeEchoBreakdown(stats.breakdown)}`;
      });
    info.outputTiming = dependencies.desktop().rectangles.filter(rect => rect.kind === "terminal" && rect.terminal?.term)
      .map((rect, index) => rect.terminal.outputTiming
        ? `Terminal ${index + 1}${rect.terminal.replica?.timing ? " (capturing)" : ""}: ${formatOutputTiming(rect.terminal.outputTiming.summary())}`
        : "")
      .filter(Boolean);
    return info;
  }

  // describeTypingPrediction says whether predictions are drawn and why, from
  // the echo time the predictor has measured.
  function describeTypingPrediction({ mode, latencyMs, showing, underlined }) {
    const label = { auto: "Auto", always: "Always", off: "Off" }[mode] || mode;
    if (mode === "off") return "Off";
    const measured = latencyMs === null ? "no echo measured yet" : `echo ${latencyMs} ms`;
    const marks = "underlined above 80 ms or after a wrong guess";
    const drawing = underlined ? "drawing underlined" : "drawing";
    if (mode === "always") return `${label}, ${drawing} (${measured}; ${marks})`;
    return `${label}, ${showing ? drawing : "not drawing"} (${measured}; draws above 20 ms, ${marks})`;
  }

  // describeEchoBreakdown splits recent echoes into time in the page before
  // sending, on the network and server until the page handles the reply, and
  // applying it. Each figure is a median, so they need not add up.
  function describeEchoBreakdown(breakdown) {
    if (!breakdown) return "";
    const ms = value => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
    return `; last ${breakdown.count} echoes, medians: ${ms(breakdown.total)} total, ${ms(breakdown.beforeSend)} before sending, ${ms(breakdown.transit)} until the reply is handled, ${ms(breakdown.apply)} applying`;
  }

  function renderSettingsCompatibilityRow() {
    const row = platform.document.createElement("div");
    row.className = "settings-compatibility";
    row.id = "settings-compatibility";
    const grid = platform.document.createElement("dl");
    grid.className = "settings-compatibility-grid";
    const status = platform.document.createElement("p");
    status.className = "settings-compatibility-status";
    status.setAttribute("role", "status");
    const actions = platform.document.createElement("div");
    actions.className = "settings-compatibility-actions";
    const refreshButton = platform.document.createElement("button");
    refreshButton.type = "button";
    refreshButton.textContent = "Refresh checks";
    const copyButton = platform.document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy diagnostics";
    const captureButton = platform.document.createElement("button");
    captureButton.type = "button";
    captureButton.textContent = `Capture output timing (${dependencies.terminal().terminalTimingCaptureSeconds} s)`;
    captureButton.addEventListener("click", () => {
      dependencies.terminal().startTerminalTimingCapture();
      update();
      status.textContent = "Capturing output timing. Close Settings and keep the terminal visible.";
    });

    const update = () => {
      const info = feature.currentCompatibility();
      const items = [
        ["Clipboard support", info.nativeClipboard ? "Native API available" : "Native API unavailable"],
        ["Extension connection", info.extension],
        ["Terminal extension writes", info.terminalClipboard],
        ["Enhanced copy/paste", info.enhancedClipboard],
        ["Rendering scale", `${info.renderScale} · ${info.performanceProfile} (${info.renderScaleDetail})`],
        ["Connection status", info.connection],
        ["Painting limit", dependencies.preferences().olderMacMode ? "30 FPS (input temporarily bypasses cap)" : "Display refresh rate"],
        ["Terminal renderer", info.terminalRenderer],
        ["Renderer row paths", info.rendererRows.join("; ") || (dependencies.preferences().experimentalTerminalRenderer ? "No rows painted yet" : "Available in Experimental mode")],
        ["Rendering costs", info.renderingCosts.join("; ") || "No terminals open"],
        ["Typing prediction", info.typingPrediction.join("; ") || "No terminals open"],
        ["Output timing", info.outputTiming.join("; ") || `Not captured. Start a capture, close Settings, and leave the terminal visible for ${dependencies.terminal().terminalTimingCaptureSeconds} s.`],
      ];
      captureButton.disabled = dependencies.terminal().terminalTimingCaptureTimer !== null;
      grid.replaceChildren();
      for (const [name, value] of items) {
        const term = platform.document.createElement("dt");
        term.textContent = name;
        const description = platform.document.createElement("dd");
        description.textContent = value;
        grid.append(term, description);
      }
      return info;
    };

    const refresh = async () => {
      refreshButton.disabled = true;
      status.textContent = "Checking browser and server…";
      const [, healthResult] = await Promise.allSettled([
        dependencies.clipboard().clipboardBridge.check(),
        dependencies.connectivity().probeServerHealth(),
        dependencies.clipboard().refreshHostClipboardStatus(),
      ]);
      if (healthResult.status === "fulfilled") dependencies.connectivity().serverConnectionLastHealthy = healthResult.value;
      if (!row.isConnected) return;
      update();
      status.textContent = "Checks updated.";
      refreshButton.disabled = false;
    };

    refreshButton.addEventListener("click", refresh);
    copyButton.addEventListener("click", async () => {
      copyButton.disabled = true;
      const copied = await dependencies.clipboard().writeClipboardText(compatibilityDiagnostics(update()));
      if (!row.isConnected) return;
      status.textContent = copied
        ? "Diagnostics copied to the system clipboard."
        : "The browser blocked the system clipboard. Diagnostics are available to Tessera Paste.";
      copyButton.disabled = false;
    });
    actions.append(refreshButton, copyButton, captureButton);
    row.append(grid, actions, status);
    update();
    feature.settingsDialog.startDiagnostics(() => {
      if (row.isConnected && !platform.document.hidden) update();
    });
    void refresh();
    return row;
  }

  // renderSettingsKeyReadoutRow lists what the browser reports for keys typed
  // into its test field. See key-readout.mjs.
  function renderSettingsKeyReadoutRow() {
    const row = platform.document.createElement("div");
    row.className = "settings-compatibility settings-key-readout";
    const instructions = platform.document.createElement("p");
    instructions.textContent = "Key test: press keys in the field to see what the browser reports for each one. The text does not change. A combination that adds no line never reaches Tessera.";
    const field = platform.document.createElement("textarea");
    field.id = "settings-key-test";
    field.rows = 1;
    field.spellcheck = false;
    field.setAttribute("aria-label", "Key test");
    field.setAttribute("autocapitalize", "off");
    field.setAttribute("autocomplete", "off");
    field.setAttribute("autocorrect", "off");
    // Text on both sides of the cursor gives a delete in either direction
    // something to act on, so the browser still reports the edit.
    const sample = "Press keys here";
    const resetField = () => {
      field.value = sample;
      if (platform.document.activeElement === field) field.setSelectionRange(6, 6);
    };
    const log = platform.document.createElement("ol");
    log.className = "settings-key-readout-log";
    log.reversed = true;
    const status = platform.document.createElement("p");
    status.className = "settings-compatibility-status";
    status.setAttribute("role", "status");
    const actions = platform.document.createElement("div");
    actions.className = "settings-compatibility-actions";
    const copyButton = platform.document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy key log";
    const clearButton = platform.document.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "Clear";

    const update = () => {
      log.replaceChildren(...feature.keyReadout.entries.map(entry => {
        const item = platform.document.createElement("li");
        item.textContent = entry;
        return item;
      }));
      copyButton.disabled = clearButton.disabled = feature.keyReadout.entries.length === 0;
    };
    field.addEventListener("keydown", (event) => {
      feature.keyReadout.record(event);
      if (keyReadoutShouldPreventKeydown(event)) event.preventDefault();
      update();
    });
    // Record the edit, then cancel it so the field stays empty.
    field.addEventListener("beforeinput", (event) => {
      feature.keyReadout.record(event);
      event.preventDefault();
      update();
    });
    // Composition and some deletes cannot be cancelled.
    field.addEventListener("input", resetField);
    field.addEventListener("keyup", resetField);
    field.addEventListener("focus", resetField);
    copyButton.addEventListener("click", async () => {
      const info = feature.currentCompatibility();
      const copied = await dependencies.clipboard().writeClipboardText(feature.keyReadout.text(`Tessera key readout · ${info.browser} · ${info.platform}`));
      if (!row.isConnected) return;
      status.textContent = copied
        ? "Key log copied to the system clipboard."
        : "The browser blocked the system clipboard. The key log is available to Tessera Paste.";
    });
    clearButton.addEventListener("click", () => {
      feature.keyReadout.clear();
      status.textContent = "";
      update();
      field.focus();
    });
    actions.append(copyButton, clearButton);
    row.append(instructions, field, log, actions, status);
    resetField();
    update();
    return row;
  }

  function renderSettingsClipboardRow() {
    const row = platform.document.createElement("div");
    row.className = "settings-clipboard";
    row.id = "settings-clipboard";
    if (dependencies.clipboard().clipboardBridge.kind === "native") {
      const status = platform.document.createElement("p");
      status.setAttribute("role", "status");
      const detail = platform.document.createElement("p");
      detail.textContent = "The iPad app handles text and image clipboard access, including over HTTP. Paste asks for native confirmation and any iPadOS paste permission. Cancelled pastes never use an older copy. Terminal-initiated native writes are disabled.";
      const check = platform.document.createElement("button");
      check.type = "button";
      check.textContent = "Check native clipboard";
      const update = () => { status.textContent = dependencies.clipboard().clipboardBridge.status ? "Native iPad clipboard connected." : "Native clipboard unavailable for this page."; };
      check.addEventListener("click", async () => {
        check.disabled = true;
        await dependencies.clipboard().clipboardBridge.check();
        check.disabled = false;
        update();
      });
      update();
      row.append(status, detail, check);
      return row;
    }
    const status = platform.document.createElement("p");
    status.setAttribute("role", "status");
    const instructions = platform.document.createElement("p");
    instructions.textContent = "The optional Firefox extension enables text Copy/Paste commands on older Firefox and HTTP connections. After installation, open its toolbar button and enable this Tessera address. Terminal-initiated copying is a separate extension option.";
    const address = platform.document.createElement("code");
    address.textContent = platform.window.location.origin;
    const actions = platform.document.createElement("div");
    actions.className = "settings-clipboard-actions";
    const check = platform.document.createElement("button");
    check.type = "button";
    check.textContent = "Check connection";
    const download = platform.document.createElement("a");
    download.hidden = true;
    const help = platform.document.createElement("a");
    help.href = "/extensions/firefox-clipboard-help.html";
    help.target = "_blank";
    help.rel = "noopener noreferrer";
    help.textContent = "Installation instructions";
    const packageStatus = platform.document.createElement("p");
    packageStatus.textContent = "Checking bundled extension…";
    let bundle = null;
    const update = () => {
      const connected = dependencies.clipboard().clipboardBridge.status;
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
      await dependencies.clipboard().clipboardBridge.check();
      if (!row.isConnected) return;
      if (dependencies.clipboard().clipboardBridge.status) dependencies.clipboard().clipboardSetupPrompt.hidden = true;
      check.disabled = false;
      update();
    });
    void platform.fetch("/extensions/firefox-clipboard.json", { cache: "no-store" })
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

  function renderSettingsPerformanceRow() {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Profile";
    const detail = platform.document.createElement("span");
    detail.textContent = "Use Older Mac to reduce visual effects and improve responsiveness on slower devices. Saved in this browser; applies immediately.";
    label.append(name, detail);
    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", "Performance profile");
    for (const [value, text] of [["standard", "Standard"], ["older-mac", "Older Mac"]]) {
      const option = platform.document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = dependencies.preferences().olderMacMode === (value === "older-mac");
      select.appendChild(option);
    }
    select.addEventListener("change", () => dependencies.preferences().setOlderMacMode(select.value === "older-mac"));
    row.append(label, select);
    return row;
  }

  function renderSettingsTerminalBacklogRow() {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Terminal output backlog";
    const detail = platform.document.createElement("span");
    detail.textContent = "Caps output waiting to be processed per terminal. Auto uses the server's budget (normally 4 MiB). A full queue catches up automatically while commands keep running. Saved in this browser; applies immediately.";
    label.append(name, detail);
    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", "Terminal output backlog");
    for (const value of ["auto", "8", "16", "32"]) {
      const option = platform.document.createElement("option");
      option.value = value;
      option.textContent = value === "auto" ? "Auto" : `${value} MiB`;
      option.selected = dependencies.preferences().terminalBacklogLimit === value;
      select.appendChild(option);
    }
    select.addEventListener("change", () => dependencies.preferences().setTerminalBacklogLimit(select.value));
    row.append(label, select);
    return row;
  }

  function renderSettingsExperimentalRendererRow() {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Terminal renderer";
    const detail = platform.document.createElement("span");
    detail.textContent = "Experimental is the default hybrid, color-aware ASCII fast path. Stable uses Ghostty's original renderer. Saved in this browser; applies immediately.";
    label.append(name, detail);
    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", "Terminal renderer");
    for (const [value, text] of [["stable", "Stable"], ["experimental", "Experimental"]]) {
      const option = platform.document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = dependencies.preferences().experimentalTerminalRenderer === (value === "experimental");
      select.appendChild(option);
    }
    select.addEventListener("change", () => dependencies.preferences().setExperimentalTerminalRenderer(select.value === "experimental"));
    row.append(label, select);
    return row;
  }

  function renderSettingsToggleRow(nameText, description, enabled, onChange) {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = nameText;
    const detail = platform.document.createElement("span");
    detail.textContent = description;
    label.append(name, detail);
    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", nameText);
    for (const [value, text] of [["off", "Off"], ["on", "On"]]) {
      const option = platform.document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = enabled === (value === "on");
      select.appendChild(option);
    }
    select.addEventListener("change", () => onChange(select.value === "on"));
    row.append(label, select);
    return row;
  }

  function renderSettingsFontRow(labelText, description, value, onChange, disabled = false, minimum = dependencies.preferences().minimumPaneFontSize, maximum = dependencies.preferences().maximumPaneFontSize) {
    const row = platform.document.createElement("div");
    row.className = "settings-row";
    const label = platform.document.createElement("div");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = labelText;
    const detail = platform.document.createElement("span");
    detail.textContent = description;
    label.append(name, detail);

    const control = platform.document.createElement("div");
    control.className = "settings-font-control";
    const decreaseButton = platform.document.createElement("button");
    decreaseButton.type = "button";
    decreaseButton.textContent = "A−";
    decreaseButton.setAttribute("aria-label", `Decrease ${labelText.toLowerCase()} font size`);
    const size = platform.document.createElement("output");
    size.textContent = disabled ? "—" : `${value}px`;
    const increaseButton = platform.document.createElement("button");
    increaseButton.type = "button";
    increaseButton.textContent = "A+";
    increaseButton.setAttribute("aria-label", `Increase ${labelText.toLowerCase()} font size`);
    decreaseButton.disabled = disabled || value <= minimum;
    increaseButton.disabled = disabled || value >= maximum;
    decreaseButton.addEventListener("click", () => onChange(value - 1));
    increaseButton.addEventListener("click", () => onChange(value + 1));
    control.append(decreaseButton, size, increaseButton);
    row.append(label, control);
    return row;
  }

  function renderCurrentPaneFontRow() {
    const active = dependencies.desktop().getActivePane();
    if (!active || (active.kind !== "terminal")) {
      return feature.renderSettingsFontRow("Current terminal", "Select a terminal pane to adjust its font.", dependencies.preferences().defaultPaneFontSize, () => {}, true);
    }
    return feature.renderSettingsFontRow("Current terminal", `${active.title} only. This value saves with the pane.`, active.fontSize, (next) => {
      dependencies.desktop().setPaneFontSize(active, next);
      feature.renderSettingsModal();
    });
  }

  function renderSettingsInterfaceFontSizeRow() {
    return feature.renderSettingsFontRow("Interface", "Scales menus, window titles and controls. 12px is the default; terminal text and remote content stay unchanged.",
      dependencies.preferences().interfaceFontSize, next => {
        dependencies.preferences().setInterfaceFontSize(next);
        feature.renderSettingsModal();
      }, false, minimumInterfaceFontSize, maximumInterfaceFontSize);
  }

  function renderSettingsThemeRow(labelText, description, value, onChange) {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = labelText;
    const detail = platform.document.createElement("span");
    detail.textContent = description;
    label.append(name, detail);
    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", `${labelText} theme`);
    for (const [id, theme] of Object.entries(dependencies.preferences().themes)) {
      const option = platform.document.createElement("option");
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
    const row = platform.document.createElement("div");
    row.className = "settings-row";
    const label = platform.document.createElement("div");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "OLED border";
    const detail = platform.document.createElement("span");
    detail.textContent = "Window border size used by the OLED Terminal theme.";
    label.append(name, detail);

    const control = platform.document.createElement("div");
    control.className = "settings-font-control";
    const decreaseButton = platform.document.createElement("button");
    decreaseButton.type = "button";
    decreaseButton.textContent = "−";
    decreaseButton.setAttribute("aria-label", "Decrease OLED window border size");
    decreaseButton.disabled = dependencies.preferences().oledWindowBorderSize <= minimumOLEDBorderSize;
    decreaseButton.addEventListener("click", () => {
      dependencies.preferences().setOLEDWindowBorderSize(dependencies.preferences().oledWindowBorderSize - 1);
      feature.renderSettingsModal();
    });
    const size = platform.document.createElement("output");
    size.textContent = `${dependencies.preferences().oledWindowBorderSize}px`;
    const increaseButton = platform.document.createElement("button");
    increaseButton.type = "button";
    increaseButton.textContent = "+";
    increaseButton.setAttribute("aria-label", "Increase OLED window border size");
    increaseButton.disabled = dependencies.preferences().oledWindowBorderSize >= maximumOLEDBorderSize;
    increaseButton.addEventListener("click", () => {
      dependencies.preferences().setOLEDWindowBorderSize(dependencies.preferences().oledWindowBorderSize + 1);
      feature.renderSettingsModal();
    });
    control.append(decreaseButton, size, increaseButton);
    row.append(label, control);
    return row;
  }

  function renderSettingsWheelRow(labelText, description, value, onChange, options = wheelSensitivityOptions) {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = labelText;
    const detail = platform.document.createElement("span");
    detail.textContent = description;
    label.append(name, detail);

    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", `${labelText} wheel speed`);
    for (const multiplier of options) {
      const option = platform.document.createElement("option");
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
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "TERM";
    const detail = platform.document.createElement("span");
    detail.textContent = "Terminal capability name used by new terminal sessions. Existing terminals keep their current value.";
    label.append(name, detail);

    const input = platform.document.createElement("input");
    input.className = "settings-text-input";
    input.type = "text";
    input.maxLength = 64;
    input.spellcheck = false;
    input.autocapitalize = "none";
    input.setAttribute("aria-label", "Terminal TERM value");
    input.value = dependencies.preferences().terminalTerm;
    input.addEventListener("change", () => {
      dependencies.preferences().setTerminalTERM(input.value);
      input.value = dependencies.preferences().terminalTerm;
    });
    row.append(label, input);
    return row;
  }

  function renderSettingsTerminalFontRow() {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Font";
    const detail = platform.document.createElement("span");
    detail.textContent = "Used throughout Tessera: terminals, window titles, menus and controls. Applies immediately; text sizes stay unchanged.";
    label.append(name, detail);

    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", "Application font");
    for (const [id, font] of Object.entries(terminalFonts)) {
      const option = platform.document.createElement("option");
      option.value = id;
      option.textContent = font.label;
      option.selected = id === dependencies.preferences().terminalFont;
      select.appendChild(option);
    }
    select.addEventListener("change", () => void dependencies.preferences().setTerminalFont(select.value));
    row.append(label, select);
    return row;
  }

  function renderSettingsTerminalRowSpacingRow() {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Row spacing";
    const detail = platform.document.createElement("span");
    detail.textContent = "Tight is the default. Comfortable adds space above and below text. Changes apply to open terminals immediately.";
    label.append(name, detail);

    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", "Terminal row spacing");
    for (const [id, spacing] of Object.entries(terminalRowSpacings)) {
      const option = platform.document.createElement("option");
      option.value = id;
      option.textContent = spacing.label;
      option.selected = id === dependencies.preferences().terminalRowSpacing;
      select.appendChild(option);
    }
    select.addEventListener("change", () => dependencies.preferences().setTerminalRowSpacing(select.value));
    row.append(label, select);
    return row;
  }

  function renderSettingsTerminalColorModeRow() {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Default colors";
    const detail = platform.document.createElement("span");
    detail.textContent = "Used by terminals set to Use default. Choose colors for one terminal from its right-click menu.";
    label.append(name, detail);

    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", "Terminal color mode");
    for (const [id, mode] of Object.entries(terminalColorModes)) {
      const option = platform.document.createElement("option");
      option.value = id;
      option.textContent = mode.label;
      option.selected = id === dependencies.preferences().terminalColorMode;
      select.appendChild(option);
    }
    select.addEventListener("change", () => void dependencies.preferences().setTerminalColorMode(select.value));
    row.append(label, select);
    return row;
  }

  function renderSettingsTerminalPredictionRow() {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Typing prediction";
    const detail = platform.document.createElement("span");
    detail.textContent = "Shows typed characters before the server echoes them, underlined only over a slow connection or after a wrong guess. Auto turns on over slow connections; nothing is shown where the program does not echo, such as password prompts. Saved in this browser.";
    label.append(name, detail);
    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", "Typing prediction");
    for (const [value, text] of [["auto", "Auto"], ["always", "Always"], ["off", "Off"]]) {
      const option = platform.document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = value === dependencies.preferences().terminalPredictionMode;
      select.appendChild(option);
    }
    select.addEventListener("change", () => dependencies.preferences().setTerminalPredictionMode(select.value));
    row.append(label, select);
    return row;
  }

  function renderSettingsBackgroundRow() {
    const row = platform.document.createElement("div");
    row.className = "settings-row";
    const label = platform.document.createElement("div");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Board image";
    const detail = platform.document.createElement("span");
    detail.textContent = dependencies.background().workspaceHasBackground
      ? "Shown behind this workspace's panes. New sessions start with a copy of it."
      : "None set. Sessions created from here will also start without one.";
    label.append(name, detail);

    const control = platform.document.createElement("div");
    control.className = "settings-background-control";
    const setButton = platform.document.createElement("button");
    setButton.type = "button";
    setButton.className = "settings-background-button";
    setButton.textContent = dependencies.background().workspaceHasBackground ? "Change..." : "Set...";
    setButton.addEventListener("click", () => dependencies.background().backgroundFileInput.click());
    control.appendChild(setButton);

    if (dependencies.background().workspaceHasBackground) {
      const clearButton = platform.document.createElement("button");
      clearButton.type = "button";
      clearButton.className = "settings-background-button";
      clearButton.textContent = "Clear";
      clearButton.addEventListener("click", () => void dependencies.background().clearBackground());
      control.appendChild(clearButton);
    }

    row.append(label, control);
    return row;
  }

  function renderSettingsBackgroundModeRow() {
    const row = platform.document.createElement("label");
    row.className = "settings-row";
    const label = platform.document.createElement("span");
    label.className = "settings-row-label";
    const name = platform.document.createElement("strong");
    name.textContent = "Display";
    const detail = platform.document.createElement("span");
    detail.textContent = dependencies.background().workspaceHasBackground
      ? "Fill crops, Fit preserves the full image, Stretch fills both dimensions, Center keeps natural size."
      : "Set a board image to choose how it is displayed.";
    label.append(name, detail);

    const select = platform.document.createElement("select");
    select.className = "settings-theme-select";
    select.setAttribute("aria-label", "Background display mode");
    select.disabled = !dependencies.background().workspaceHasBackground;
    for (const [id, mode] of Object.entries(dependencies.background().backgroundDisplayModes)) {
      const option = platform.document.createElement("option");
      option.value = id;
      option.textContent = mode.label;
      option.selected = id === dependencies.background().workspaceBackgroundMode;
      select.appendChild(option);
    }
    select.addEventListener("change", () => dependencies.background().setWorkspaceBackgroundMode(select.value));
    row.append(label, select);
    return row;
  }

  function initializeSettingsModal() {
    feature.settingsModal = platform.document.createElement("div");
    feature.settingsModal.className = "settings-modal";
    feature.settingsModal.hidden = true;
    feature.settingsModal.addEventListener("pointerdown", (event) => {
      if (event.target === feature.settingsModal) {
        feature.hideSettingsModal();
      }
    });
    platform.document.body.appendChild(feature.settingsModal);
    feature.settingsDialog = new SettingsDialog({
      document: platform.document,
      window: platform.window,
      modal: feature.settingsModal,
      state: () => ({
        defaultPaneFontSize: dependencies.preferences().defaultPaneFontSize, defaultTheme: dependencies.preferences().defaultTheme, themeID: dependencies.preferences().themeID, windowWobbleEnabled: dependencies.preferences().windowWobbleEnabled,
        terminalShellIntegration: dependencies.preferences().terminalShellIntegration, commandNoticesEnabled: dependencies.preferences().commandNoticesEnabled, terminalWheelSensitivity: dependencies.preferences().terminalWheelSensitivity,
        rdpWheelSpeed: dependencies.preferences().rdpWheelSpeed, rdpWheelSpeedOptions, terminalPaintCoalescing: dependencies.preferences().terminalPaintCoalescing, terminalOutputCoalescing: dependencies.preferences().terminalOutputCoalescing,
        authMode: dependencies.navigation().authMode, scope: dependencies.preferences().displaySettingsScope(),
      }),
      rows: {
        font: feature.renderSettingsFontRow, currentPaneFont: feature.renderCurrentPaneFontRow,
        interfaceFontSize: feature.renderSettingsInterfaceFontSizeRow,
        theme: feature.renderSettingsThemeRow, oledBorder: feature.renderSettingsOLEDWindowBorderRow,
        toggle: feature.renderSettingsToggleRow, terminalFont: feature.renderSettingsTerminalFontRow,
        rowSpacing: feature.renderSettingsTerminalRowSpacingRow, terminalColor: feature.renderSettingsTerminalColorModeRow,
        prediction: feature.renderSettingsTerminalPredictionRow, notifications: feature.renderSettingsSystemNotificationsRow,
        wheel: feature.renderSettingsWheelRow, background: feature.renderSettingsBackgroundRow,
        backgroundMode: feature.renderSettingsBackgroundModeRow, clipboard: feature.renderSettingsClipboardRow,
        performance: feature.renderSettingsPerformanceRow, term: feature.renderSettingsTerminalTERMRow,
        renderer: feature.renderSettingsExperimentalRendererRow, backlog: feature.renderSettingsTerminalBacklogRow,
        compatibility: feature.renderSettingsCompatibilityRow, keyReadout: feature.renderSettingsKeyReadoutRow,
      },
      actions: {
        defaultPaneFontSize: dependencies.preferences().setDefaultPaneFontSize, defaultTheme: dependencies.preferences().setDefaultTheme,
        theme: dependencies.preferences().applyTheme, windowWobble: dependencies.preferences().setWindowWobbleEnabled,
        shellIntegration: dependencies.preferences().setTerminalShellIntegration, commandNotices: dependencies.preferences().setCommandNoticesEnabled,
        terminalWheel: dependencies.preferences().setTerminalWheelSensitivity, rdpWheel: dependencies.preferences().setRDPWheelSpeed,
        shortcuts: dependencies.navigation().openShortcuts, paintCoalescing: dependencies.preferences().setTerminalPaintCoalescing,
        outputCoalescing: dependencies.preferences().setTerminalOutputCoalescing,
      },
      hideDeskbar: dependencies.deskbar().hideDeskbar,
      otherOverlay: () => !dependencies.palette().commandPalette.hidden || !dependencies.windows().windowList.hidden || !dependencies.sessionList().sessionList.hidden,
      focusWorkspace: () => {
        if (dependencies.desktop().getActivePane()) focusPane(dependencies.desktop().getActivePane());
        else if (!dependencies.deskbar().deskbarButton.hidden) dependencies.deskbar().deskbarButton.focus();
      },
      metrics: feature.setTerminalRenderingMetricsEnabled,
      recovery: dependencies.navigation().signInRecovery,
    });
  }

  function initializeKeyReadout() {
    feature.keyReadout = new KeyReadout();
  }

  Object.assign(feature, {
    renderSettingsSystemNotificationsRow,
    openSettingsModal,
    containSettingsFocus,
    handleSettingsKeyboard,
    settingsDiagnosticsOpen,
    hideSettingsModal,
    setTerminalRenderingMetricsEnabled,
    renderSettingsModal,
    currentCompatibility,
    describeTypingPrediction,
    describeEchoBreakdown,
    renderSettingsCompatibilityRow,
    renderSettingsKeyReadoutRow,
    renderSettingsClipboardRow,
    renderSettingsPerformanceRow,
    renderSettingsTerminalBacklogRow,
    renderSettingsExperimentalRendererRow,
    renderSettingsToggleRow,
    renderSettingsFontRow,
    renderSettingsInterfaceFontSizeRow,
    renderCurrentPaneFontRow,
    renderSettingsThemeRow,
    renderSettingsOLEDWindowBorderRow,
    renderSettingsWheelRow,
    renderSettingsTerminalTERMRow,
    renderSettingsTerminalFontRow,
    renderSettingsTerminalRowSpacingRow,
    renderSettingsTerminalColorModeRow,
    renderSettingsTerminalPredictionRow,
    renderSettingsBackgroundRow,
    renderSettingsBackgroundModeRow,
    initializeSettingsModal,
    initializeKeyReadout,
  });
  return feature;
}
