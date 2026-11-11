import { TerminalAudioPlayer, terminalAudioMuteKey } from "./terminal-audio.mjs";
import { TerminalFiles } from "./terminal-files.mjs";
import { terminalBacklogCloseCode, terminalStatusLabel } from "./terminal-reconnect.mjs";
import { isTerminalCopyShortcut, terminalCommandArrowSequence, terminalControlSequence, terminalNavigationSequence, terminalPromptJumpDirection, terminalPasteSource, terminalShouldSwallowCommandKey } from "./terminal-keyboard.mjs";
import { TerminalFindBar } from "./terminal-find.mjs";
import { loadTerminalFont, terminalFontFamily, terminalPrimaryFontFamily } from "./terminal-font.mjs";
import { terminalColorTheme } from "./terminal-colors.mjs";
import { installTerminalBlockRenderer } from "./terminal-block-renderer.mjs";
import { TerminalConnections } from "./terminal-connections.mjs";
import { openTerminalWithoutFocus } from "./pane-activation.mjs";
import { TerminalFitScheduler } from "./terminal-fit-scheduler.mjs";
import { terminalIsCovered } from "./terminal-visibility.mjs";
import { TerminalWriteScheduler } from "./terminal-write-scheduler.mjs";
import { TerminalReplica } from "./terminal-replica.mjs";
import { TerminalOutputTiming } from "./terminal-output-timing.mjs";
import { terminalWorkingDirectory } from "./terminal-working-directory.mjs";
import { terminalKittyKeyEvent } from "./terminal-kitty-keyboard.mjs";
import { acceptTerminalAlert, mergeTerminalAttention, showSystemNotification, terminalCommandFailed, terminalNoticeText, TerminalNotices } from "./terminal-attention.mjs";
import { terminalProgressDescription, terminalProgressFromMessage, terminalProgressLifetimeMs, terminalProgressWidth } from "./terminal-progress.mjs";

// Terminal creation, replica integration, focus, alerts, sizing and disposal.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
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
 *   settings: () => ReturnType<typeof import("./settings-view.mjs").createSettings>,
 *   terminalInput: () => ReturnType<typeof import("./terminal-input-bridge.mjs").createTerminalInput>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createTerminal(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    terminalVisibilityFrame: undefined,
    terminalHostName: undefined,
    terminalNoticeList: undefined,
    terminalNotices: undefined,
    ghosttyModulePromise: undefined,
    terminalTextEncoder: undefined,
    terminalAudioPlayer: undefined,
    terminalConnections: undefined,
    terminalTimingCaptureSeconds: undefined,
    terminalTimingCaptureTimer: undefined,
    terminalFits: undefined,
  };

  // Only the active pane blinks. The adapter requests a frame per blink tick
  // and hides inactive cursors without keeping an idle animation loop alive.
  // Selection also transfers parsing priority to the active visible terminal.
  function setTerminalCursorBlink(rect, blink) {
    if (rect?.kind !== "terminal" || !rect.terminal?.term) {
      return;
    }
    try {
      const { term } = rect.terminal;
      const active = blink && !platform.document.hidden && !rect.minimized && !term.renderPaused;
      rect.terminal.output?.setActive?.(active);
      term.setCursorActive?.(active);
    } catch {
      // Terminal not fully initialized yet; ignore.
    }
  }

  // Whether nobody can see the pane: the page is hidden, the pane is minimized
  // or covered, or the phone view shows another pane.
  function paneUnseen(rect) {
    return dependencies.phone().phoneView.active ? platform.document.hidden || dependencies.phone().phoneView.openPaneID !== rect.id
      : platform.document.hidden || Boolean(rect.minimized) || terminalIsCovered(rect, dependencies.desktop().rectangles);
  }

  // Pauses what a pane draws while nobody can see it.
  function updatePaneRenderState(rect) {
    feature.updateTerminalRenderState(rect);
    dependencies.rdpView().syncRDPShown(rect);
  }

  function updateTerminalRenderState(rect) {
    const term = rect?.kind === "terminal" ? rect.terminal?.term : null;
    if (!term) {
      return;
    }
    const paused = feature.paneUnseen(rect);
    const wasPaused = term.renderPaused;
    term.setRenderPaused?.(paused);
    rect.terminal.output?.setActive?.(!paused && dependencies.desktop().activeRect === rect);
    term.setCursorActive?.(!paused && dependencies.desktop().activeRect === rect);
    if (!paused && wasPaused) {
      term.requestFullRedraw?.();
    }
    // Output pauses only for terminals nobody is perceiving. One playing a
    // stream is still being listened to, and resuming would replace its socket
    // and restart the stream. Decide once, on hiding, so a track change while
    // hidden can't pause it.
    const terminalState = rect.terminal;
    if (!paused) terminalState.liveWhileHidden = false;
    else if (!terminalState.outputPaused && !terminalState.liveWhileHidden) {
      terminalState.liveWhileHidden = feature.terminalAudioPlayer.streaming(terminalState.audioKey);
    }
    feature.setTerminalOutputPaused(rect, paused && !terminalState.liveWhileHidden);
    feature.updateTerminalFocus();
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
      if (terminalState.socket?.readyState === platform.WebSocket.OPEN) {
        terminalState.socket.send(JSON.stringify({ type: "pause-output" }));
      }
      const replica = terminalState.replica;
      replica.disconnect();
      if (terminalState.reconnectTimer !== null) {
        platform.window.clearTimeout(terminalState.reconnectTimer);
        terminalState.reconnectTimer = null;
      }
      dependencies.connectivity().completeTerminalWakeRecovery(terminalState);
      return;
    }
    if (rect.terminalStatus && !rect.terminalStatus.reconnect) return;
    // Small gaps replay from the applied cursor; larger gaps use a snapshot.
    // An unchanged terminal keeps selection and scroll. Replace the socket so late
    // messages from the discarded stream stay inert.
    const oldSocket = terminalState.socket;
    terminalState.reconnectAttempts = 0;
    feature.connectTerminalSocket(rect);
    if (oldSocket?.readyState === platform.WebSocket.OPEN || oldSocket?.readyState === platform.WebSocket.CONNECTING) {
      oldSocket.send(JSON.stringify({ type: "file-handoff" }));
      oldSocket.close(1000, "Restoring visible terminal");
    }
  }

  function scheduleTerminalVisibilityUpdate() {
    if (feature.terminalVisibilityFrame !== null) return;
    feature.terminalVisibilityFrame = platform.window.requestAnimationFrame(() => {
      feature.terminalVisibilityFrame = null;
      for (const rect of dependencies.desktop().rectangles) feature.updatePaneRenderState(rect);
    });
  }

  function updateTerminalDocumentVisibility() {
    // Do this synchronously: a hidden document can throttle both timers and RAF.
    for (const rect of dependencies.desktop().rectangles) feature.updatePaneRenderState(rect);
    if (!feature.ghosttyModulePromise) {
      return;
    }
    void feature.ghosttyModulePromise
      .then((module) => module.setTerminalDocumentVisible?.(!platform.document.hidden))
      .catch(() => {});
  }

  function loadGhosttyModule() {
    if (!feature.ghosttyModulePromise) {
      feature.ghosttyModulePromise = import("./vendor/terminal.js?v=selection-recovery-1").then(async (module) => {
        await module.init();
        installTerminalBlockRenderer(module.CanvasRenderer, module.CellFlags);
        module.setTerminalDocumentVisible?.(!platform.document.hidden);
        return module;
      });
    }
    return feature.ghosttyModulePromise;
  }

  async function startTerminal(rect) {
    if (!rect?.terminalContainer || rect.terminal) {
      return;
    }

    rect.terminalContainer.textContent = "Starting terminal...";
    try {
      const modulePromise = feature.loadGhosttyModule();
      await loadTerminalFont(platform.document.fonts, dependencies.preferences().terminalFont, rect.fontSize);
      const { FitAddon, Terminal, WrappedHTTPLinkProvider } = await modulePromise;
      if (!rect.terminalContainer || rect.kind !== "terminal" || !dependencies.desktop().rectangles.includes(rect)) {
        return;
      }

      rect.terminalContainer.replaceChildren();
      // ANSI assigns color roles rather than RGB values. The terminal's neutral
      // light/dark mode supplies an xterm-compatible palette independently from
      // Tessera's decorative workspace theme.
      const terminalTheme = terminalColorTheme(rect.terminalColorMode || dependencies.preferences().terminalColorMode);
      rect.terminalContainer.style.background = terminalTheme.background;
      const term = new Terminal({
        openLink: dependencies.desktop().openTerminalLink,
        cols: 80,
        rows: 24,
        fontSize: rect.fontSize,
        fontFamily: terminalPrimaryFontFamily(dependencies.preferences().terminalFont),
        symbolFontFamily: terminalFontFamily(dependencies.preferences().terminalFont),
        rowSpacing: dependencies.preferences().terminalRowSpacing,
        cursorBlink: dependencies.desktop().activeRect === rect,
        cursorBlinkEnabled: !dependencies.preferences().olderMacMode,
        renderPixelRatioCap: dependencies.preferences().olderMacMode ? 1 : 0,
        paintFPSLimit: dependencies.preferences().olderMacMode ? 30 : dependencies.preferences().nativeFrameLimit || 0,
        paintCoalescing: dependencies.preferences().terminalPaintCoalescing,
        predictionMode: dependencies.preferences().terminalPredictionMode,
        renderMetricsEnabled: dependencies.settings().settingsDiagnosticsOpen(),
        experimentalRenderer: dependencies.preferences().experimentalTerminalRenderer,
        smoothScrollDuration: dependencies.preferences().olderMacMode ? 0 : 100,
        theme: { ...terminalTheme },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      openTerminalWithoutFocus(term, rect.terminalContainer);
      // Keys sent under the Kitty keyboard protocol and not yet released, by
      // physical key, with the key each was sent as.
      const kittyKeysDown = new Map();
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown") feature.claimTerminalSize(rect);
        if (isTerminalCopyShortcut(event)) {
          void dependencies.menus().applyTerminalMenuAction("copy", rect);
          return true;
        }
        const promptJump = terminalPromptJumpDirection(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout });
        if (promptJump) {
          term.scrollToPrompt?.(promptJump);
          return true;
        }
        // Returning true tells ghostty-web the key was handled, which also calls
        // preventDefault(). Doing that for the platform's paste accelerator would
        // cancel the browser's paste event that ghostty-web itself listens for.
        const pasteSource = terminalPasteSource(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout });
        if (pasteSource === "native") {
          return false;
        }
        if (pasteSource === "clipboard") {
          void dependencies.menus().applyTerminalMenuAction("paste", rect);
          return true;
        }
        // A program that turned on the Kitty keyboard protocol gets every key
        // from Ghostty's encoder, which takes care of what follows for
        // ordinary encoding (Command, Home and End, numpad keys).
        const kittyFlags = term.kittyKeyboardFlags?.() || 0;
        if (kittyFlags) {
          const fields = terminalKittyKeyEvent(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout, action: event.repeat ? "repeat" : "press" });
          if (!fields) return true;
          kittyKeysDown.set(event.code, fields.key);
          const data = term.encodeKeyEvent(fields, kittyFlags);
          if (data) {
            term.scrollToBottom();
            term.noteInteractiveInput?.();
            feature.sendTerminalKeys(rect, data);
          }
          return true;
        }
        const controlSequence = terminalControlSequence(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout });
        if (controlSequence) {
          feature.sendTerminalKeys(rect, controlSequence);
          return true;
        }
        const commandArrowSequence = terminalCommandArrowSequence(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout });
        if (commandArrowSequence) {
          feature.sendTerminalKeys(rect, commandArrowSequence);
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
          appleKeyboard: dependencies.interactions().appleKeyboardLayout,
        });
        if (!sequence) {
          return false;
        }
        feature.sendTerminalKeys(rect, sequence);
        return true;
      });
      // Releases are reported only for keys whose press was, and only when the
      // program asked for them (flag 2).
      rect.terminalContainer.addEventListener("keyup", (event) => {
        const key = kittyKeysDown.get(event.code);
        if (key === undefined) return;
        kittyKeysDown.delete(event.code);
        const kittyFlags = term.kittyKeyboardFlags?.() || 0;
        if (!(kittyFlags & 2)) return;
        const fields = terminalKittyKeyEvent(event, { appleKeyboard: dependencies.interactions().appleKeyboardLayout, action: "release" });
        if (!fields) return;
        const data = term.encodeKeyEvent({ ...fields, key }, kittyFlags);
        if (data) feature.sendTerminalKeys(rect, data);
      });
      rect.terminalContainer.addEventListener("blur", () => kittyKeysDown.clear());
      term.registerLinkProvider(new WrappedHTTPLinkProvider(term, dependencies.desktop().openTerminalLink));
      fit.fit();
      fit.observeResize();
      const dataDisposable = term.onData((data) => {
        term.scrollToBottom();
        term.noteInteractiveInput?.();
        feature.claimTerminalSize(rect);
        feature.sendTerminalKeys(rect, data);
      });
      const resizeDisposable = term.onResize(() => {
        feature.requestTerminalGridSize(rect.terminal);
      });
      const titleDisposable = term.onTitleChange(title => dependencies.desktop().applyTerminalWindowTitle(rect, title));
      const linkHoverDisposable = term.onLinkHover(uri => feature.showTerminalLinkHover(rect, uri));
      const workingDirectoryDisposable = term.onWorkingDirectoryChange((report) => {
        const path = terminalWorkingDirectory(report, feature.terminalHostName);
        if (path) dependencies.desktop().setPaneCwd(rect, path);
      });
      rect.terminal = {
        term, fit, socket: null, dataDisposable, resizeDisposable, titleDisposable, linkHoverDisposable, workingDirectoryDisposable, mouseBridge: null,
        pasteBridge: dependencies.terminalInput().attachTerminalPasteBridge(rect, term),
        output: new TerminalWriteScheduler((data) => term.write(data)),
        reconnectTimer: null, reconnectAttempts: 0, outputPaused: false, snapshotIfChanged: false,
        backlogRecoveryAttempts: 0, lastBacklogRecoveryAt: 0,
        sentCols: 0, sentRows: 0,
        // What this pane holds of the server's stream, so a reconnect can ask
        // for the remainder instead of the whole scrollback.
        stream: { epoch: "", offset: 0 },
      };
      rect.terminal.replica = new TerminalReplica(term, rect.terminal.output, term.coreID, (text) => {
        void dependencies.clipboard().applyTerminalClipboardWrite(text);
      }, (error) => rect.terminal?.socket?.close(4500, error.message.slice(0, 100)), {
        backlogLimit: dependencies.preferences().terminalBacklogLimit,
        onBacklogExceeded: () => feature.recoverTerminalBacklog(rect),
      });
      feature.attachTerminalAudio(rect);
      rect.terminal.files = new TerminalFiles({ workspaceId: dependencies.navigation().workspaceID, paneId: rect.id, container: rect.body,
        send: message => { const socket = rect.terminal?.socket; if (socket?.readyState === platform.WebSocket.OPEN) socket.send(JSON.stringify(message)); },
        onPending: count => { rect.filePendingCount = count; dependencies.deskbar().updateDeskbar(); feature.requestTerminalFit(rect); },
      });
      feature.updateTerminalRenderState(rect);
      // A terminal opened on a phone before it had started fits it too.
      if (dependencies.phone().phoneView.active && dependencies.phone().phoneView.openPaneID === rect.id) dependencies.phone().setPhoneTerminalFit(rect.id, true);
      feature.connectTerminalSocket(rect);
      feature.requestTerminalFit(rect);
    } catch (error) {
      platform.console.warn(error);
      if (rect.terminalContainer) {
        rect.terminalContainer.textContent = error.message || "Terminal failed to start";
      }
    }
  }

  function recoverTerminalBacklog(rect) {
    const terminalState = rect.terminal;
    if (!terminalState) return;
    const now = platform.Date.now();
    if (now - terminalState.lastBacklogRecoveryAt > 30000) terminalState.backlogRecoveryAttempts = 0;
    terminalState.lastBacklogRecoveryAt = now;
    terminalState.socket?.close(terminalBacklogCloseCode, "terminal output backlog exceeded");
  }

  function connectTerminalSocket(rect) {
    feature.terminalConnections.connect(rect);
  }

  // Application effects after transport setup: focus, sizing and startup input.
  function terminalSocketOpened(rect, terminalState, socket) {
    const { term } = terminalState;
    feature.updateTerminalFocus();
    if (!rect.terminalAttention && rect.terminalAlertsSeen?.id) feature.sendTerminalAlertSeen(rect, rect.terminalAlertsSeen);
    terminalState.files?.subscribe(socket);
    feature.clearTerminalStatus(rect);
    dependencies.desktop().setPaneCwd(rect, rect.cwd, { silent: true });
    if (terminalState.outputPaused) socket.send(JSON.stringify({ type: "pause-output" }));
    if (feature.browserInUse()) feature.sendTerminalGridSize(terminalState);
    if (dependencies.preferences().terminalOutputCoalescing) dependencies.preferences().sendTerminalOutputCoalescing(terminalState);
    if (terminalState.replica.timing) feature.sendTerminalTimingEnabled(terminalState);
    if (!terminalState.outputPaused && dependencies.desktop().activeRect === rect && (platform.document.activeElement === platform.document.body || rect.element.contains(platform.document.activeElement))) {
      if (!dependencies.phone().phoneView.active || dependencies.terminalInput().phoneTypingInto(rect)) term.focus();
    }
    if (rect.terminalStartupCommand) {
      const command = rect.terminalStartupCommand;
      rect.terminalStartupCommand = "";
      feature.sendTerminalKeys(rect, `${command}\r`);
    }
  }

  function terminalControlMessage(rect, terminalState, message, data) {
    if (feature.handleTerminalAudioMessage(rect, data)) return true;
    if (message?.type === "terminal-alert") {
      feature.handleTerminalAlert(rect, message);
      return true;
    }
    const progress = terminalProgressFromMessage(message);
    if (progress === undefined) return false;
    feature.applyTerminalProgress(rect, progress);
    return true;
  }

  function attachTerminalAudio(rect) {
    const key = terminalAudioMuteKey(dependencies.navigation().workspaceID, rect.id);
    rect.terminal.audioKey = key;
    let muted = false;
    try { muted = platform.window.localStorage.getItem(key) === "true"; } catch {}
    feature.terminalAudioPlayer.attach(key, { muted, onStatus: status => {
      if (rect.terminal?.audioKey === key) feature.renderTerminalAudioStatus(rect, status);
    } });
  }

  function handleTerminalAudioMessage(rect, data) {
    let message;
    try { message = JSON.parse(data); } catch { return false; }
    if (message?.type === "audio-events") return true;
    if (message?.type !== "terminal-audio") return false;
    feature.terminalAudioPlayer.receive(rect.terminal?.audioKey, message);
    return true;
  }

  // A pane is focused while it is the active window and this page has the
  // keyboard. Programs that ask (mode 1004) are told when that changes; the
  // host combines what every browser showing the pane says.
  function terminalPaneFocused(rect) {
    if (dependencies.phone().phoneView.active) return rect.id === dependencies.phone().phoneView.openPaneID && !platform.document.hidden && platform.document.hasFocus();
    return rect === dependencies.desktop().activeRect && !rect.minimized && !platform.document.hidden && platform.document.hasFocus();
  }

  function updateTerminalFocus() {
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind !== "terminal" || !rect.terminal) continue;
      const focused = feature.terminalPaneFocused(rect);
      if (focused) feature.clearTerminalAttention(rect);
      const terminalState = rect.terminal;
      if (terminalState.focusSent === focused || terminalState.socket?.readyState !== platform.WebSocket.OPEN) continue;
      terminalState.focusSent = focused;
      terminalState.socket.send(JSON.stringify({ type: "focus", focused }));
    }
    // A kept RDP session's host wiggles its mouse only while its window isn't in use.
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.rdp) dependencies.rdpView().syncRDPWiggle(rect);
    }
  }

  // A bell or notification from the pane's program. One in the pane being
  // looked at is seen already; any other marks the window until it is shown,
  // and a notification is also shown in the corner, or by the system while
  // this page is in the background, if allowed in Settings.
  function handleTerminalAlert(rect, message) {
    rect.terminalAlertsSeen ??= { epoch: "", id: 0 };
    const alert = acceptTerminalAlert(rect.terminalAlertsSeen, message);
    if (!alert) return;
    if (feature.terminalPaneFocused(rect) || (alert.kind === "command" && !dependencies.preferences().commandNoticesEnabled)) {
      feature.sendTerminalAlertSeen(rect, alert);
      return;
    }
    rect.terminalAttention = mergeTerminalAttention(rect.terminalAttention, alert);
    feature.renderTerminalAttention(rect);
    if (alert.kind === "bell") return;
    const text = terminalNoticeText(alert, rect.title);
    feature.terminalNotices.show(rect.id, text);
    if (dependencies.preferences().systemNotificationsEnabled && (platform.document.hidden || !platform.document.hasFocus())) {
      showSystemNotification(platform.window.Notification, { ...text, body: text.source ? `${text.body}\n${text.source}` : text.body, tag: `tessera-${rect.id}` }, () => {
        platform.window.focus();
        feature.openPaneFromNotice(rect.id);
      });
    }
  }

  function sendTerminalAlertSeen(rect, alert) {
    const socket = rect.terminal?.socket;
    if (socket?.readyState === platform.WebSocket.OPEN) socket.send(JSON.stringify({ type: "alert-seen", epoch: alert.epoch, alert: alert.id }));
  }

  function clearTerminalAttention(rect) {
    if (!rect.terminalAttention) return;
    feature.sendTerminalAlertSeen(rect, rect.terminalAttention);
    rect.terminalAttention = null;
    feature.terminalNotices.dismiss(rect.id);
    feature.renderTerminalAttention(rect);
  }

  function renderTerminalAttention(rect) {
    const kind = rect.terminalAttention?.kind || "";
    if (kind) rect.element.dataset.attention = kind;
    else delete rect.element.dataset.attention;
    if (rect.attentionMark) {
      rect.attentionMark.hidden = !kind;
      rect.attentionMark.title = kind === "notification" ? "Notification" : kind === "bell" ? "Bell"
        : kind === "command" ? (terminalCommandFailed(rect.terminalAttention) ? "Command failed" : "Command finished") : "";
    }
    dependencies.desktop().updatePaneTitleLabels(rect);
    dependencies.deskbar().updateDeskbar();
  }

  // A program's progress report (OSC 9;4), as a bar along the title bar. It
  // goes when the program removes it, or after a while without a report.
  function applyTerminalProgress(rect, progress) {
    platform.window.clearTimeout(rect.progressTimer);
    rect.progressTimer = progress ? platform.window.setTimeout(() => feature.applyTerminalProgress(rect, null), terminalProgressLifetimeMs) : null;
    const bar = rect.progressBar;
    if (!bar) return;
    bar.hidden = !progress;
    if (!progress) return;
    const width = terminalProgressWidth(progress);
    bar.dataset.state = progress.state;
    bar.classList.toggle("is-indeterminate", width === null);
    bar.firstChild.style.width = width === null ? "" : `${width}%`;
    if (progress.percent === null) bar.removeAttribute("aria-valuenow");
    else bar.setAttribute("aria-valuenow", String(progress.percent));
    bar.title = terminalProgressDescription(progress);
    bar.setAttribute("aria-label", bar.title);
  }

  function openPaneFromNotice(paneID) {
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.id === paneID);
    if (!rect) return;
    if (dependencies.phone().phoneView.active) {
      if (rect.kind === "terminal") dependencies.phone().phoneView.open(rect.id);
      return;
    }
    dependencies.geometry().setMinimized(rect, false);
    dependencies.desktop().setActivePane(rect, { raise: true, focus: true });
  }

  function renderTerminalAudioStatus(rect, status) {
    if (!rect.body || !rect.terminal) return;
    let badge = rect.terminalAudioBadge;
    if (!status) { if (badge) badge.hidden = true; return; }
    if (!badge || badge.parentElement !== rect.body) {
      badge = platform.document.createElement("button");
      badge.type = "button";
      badge.className = "terminal-audio-badge";
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        if (badge.dataset.kind === "enable") void feature.terminalAudioPlayer.enable().catch(() => {
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

  // Brings the pending attempt forward. Whoever asks — a person watching the
  // pane, or a health probe that just got an answer — knows more about the
  // server than the backoff does, so the retry also restarts it: the next
  // automatic wait should be short again, not wherever the cycle had crept to
  // while nobody was looking.
  function retryTerminalNow(rect) {
    feature.terminalConnections.retry(rect);
  }

  // A pane waiting out its backoff has no way to learn that the server came
  // back: the schedule is the only thing that moves it, and a backgrounded tab
  // does not even run that on time. Anything that does know brings every
  // waiting pane forward at once.
  function resumeTerminalConnections() {
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal") {
        feature.retryTerminalNow(rect);
      }
    }
  }

  function setTerminalStatus(rect, status) {
    rect.terminalStatus = status;
    feature.stopTerminalStatusCountdown(rect);
    feature.renderTerminalStatusBadge(rect);
    if (status?.retryAt) {
      // Twice a second, so the displayed count is never a stale second behind.
      rect.terminalStatusTimer = platform.window.setInterval(() => {
        if (!platform.document.hidden) feature.renderTerminalStatusBadge(rect);
      }, 500);
    }
  }

  function clearTerminalStatus(rect) {
    rect.terminalStatus = null;
    feature.stopTerminalStatusCountdown(rect);
    feature.renderTerminalStatusBadge(rect);
  }

  function stopTerminalStatusCountdown(rect) {
    if (rect?.terminalStatusTimer) {
      platform.window.clearInterval(rect.terminalStatusTimer);
      rect.terminalStatusTimer = null;
    }
  }

  // Shows where the OSC 8 link under the pointer goes, along the bottom of the
  // pane like a browser's status bar. It moves to the right while the pointer
  // is low on the left, so it never covers the link being read.
  function showTerminalLinkHover(rect, uri) {
    let label = rect.terminalLinkHover;
    if (!uri) {
      if (label) label.hidden = true;
      return;
    }
    if (!rect.body) {
      return;
    }
    if (label?.parentElement !== rect.body) {
      label = platform.document.createElement("div");
      label.className = "terminal-link-hover";
      rect.body.appendChild(label);
      rect.terminalLinkHover = label;
    }
    label.textContent = uri;
    const pointer = rect.terminal?.term?.linkHover?.pointer;
    const bounds = rect.body.getBoundingClientRect();
    label.classList.toggle("is-right", Boolean(pointer
      && pointer.clientY > bounds.bottom - 36
      && pointer.clientX < bounds.left + bounds.width / 2));
    label.hidden = false;
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
    const badge = platform.document.createElement("button");
    badge.type = "button";
    badge.className = "terminal-status-badge";
    badge.hidden = true;
    badge.setAttribute("role", "status");
    // A link broken in the middle reads as "disconnected" at badge size,
    // where a plug's prongs would not; a power symbol says the shell is gone
    // rather than out of reach. Both are built up front and swapped by state.
    badge.appendChild(feature.terminalStatusIcon(
      "is-link-icon",
      ["M9.5 17H7.5a5 5 0 0 1 0-10h2", "M14.5 7h2a5 5 0 0 1 0 10h-2", "M13.8 9.6l-3.6 4.8"],
    ));
    badge.appendChild(feature.terminalStatusIcon(
      "is-power-icon",
      ["M12 4.5v7", "M7.8 7.3a6.4 6.4 0 1 0 8.4 0"],
    ));
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      feature.retryTerminalNow(rect);
    });
    rect.body.appendChild(badge);
    rect.terminalStatusBadge = badge;
    return badge;
  }

  function terminalStatusIcon(className, paths) {
    const svg = platform.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = platform.document.createElementNS("http://www.w3.org/2000/svg", "path");
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
    const badge = status ? feature.terminalStatusBadge(rect) : rect.terminalStatusBadge;
    if (!badge) {
      return;
    }
    if (!status) {
      badge.hidden = true;
      return;
    }
    const label = terminalStatusLabel(status, status.retryAt ? status.retryAt - platform.Date.now() : 0);
    badge.title = label;
    badge.setAttribute("aria-label", label);
    badge.dataset.state = status.state;
    badge.classList.toggle("is-settled", Boolean(status.settled));
    // Only a pane with an attempt still to come has anything a click can do.
    badge.disabled = !status.reconnect || status.state === "connecting";
    badge.hidden = false;
  }

  // Every keystroke passes the typing predictor first: a printable character
  // may be drawn before the server echoes it, and anything else ends the run.
  function sendTerminalKeys(rect, data) {
    const socket = rect.terminal?.socket;
    if (socket?.readyState === platform.WebSocket.OPEN) rect.terminal?.term?.predictInput?.(data);
    feature.sendTerminalInput(socket, data);
    rect.terminal?.term?.noteInputSent?.();
  }

  function sendTerminalInput(socket, data) {
    if (socket?.readyState === platform.WebSocket.OPEN) {
      socket.send(feature.terminalTextEncoder.encode(data));
    }
  }

  function sendTerminalTimingEnabled(terminalState) {
    if (terminalState?.socket?.readyState === platform.WebSocket.OPEN) {
      terminalState.socket.send(JSON.stringify({ type: "timing", enabled: Boolean(terminalState.replica?.timing) }));
    }
  }

  function setTerminalTimingHooks(terminalState, timing) {
    terminalState.replica.timing = timing;
    terminalState.term.outputTiming = timing;
    feature.sendTerminalTimingEnabled(terminalState);
  }

  // Leaves Settings free to close: a capture runs for a fixed time while the
  // terminal is visible, and its results stay on the pane for later review.
  function startTerminalTimingCapture() {
    feature.stopTerminalTimingCapture();
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind !== "terminal" || !rect.terminal?.replica) continue;
      rect.terminal.outputTiming = new TerminalOutputTiming();
      feature.setTerminalTimingHooks(rect.terminal, rect.terminal.outputTiming);
    }
    feature.terminalTimingCaptureTimer = platform.window.setTimeout(feature.stopTerminalTimingCapture, feature.terminalTimingCaptureSeconds * 1000);
  }

  function stopTerminalTimingCapture() {
    platform.window.clearTimeout(feature.terminalTimingCaptureTimer);
    feature.terminalTimingCaptureTimer = null;
    for (const rect of dependencies.desktop().rectangles) {
      if (rect.kind === "terminal" && rect.terminal?.replica?.timing) {
        rect.terminal.replica.timing.stop();
        feature.setTerminalTimingHooks(rect.terminal, null);
      }
    }
  }

  function requestTerminalFit(rect) {
    feature.terminalFits.request(rect?.terminal);
  }

  function repairTerminalView(rect) {
    const state = rect?.kind === "terminal" ? rect.terminal : null;
    if (!state?.term || !state.fit || !dependencies.desktop().rectangles.includes(rect)) return;
    dependencies.geometry().setMinimized(rect, false);
    // Discard cached fit/send decisions so an unchanged window can repair stale
    // desired geometry and resend its measured size to the existing shell.
    state.fit.lastColumns = undefined;
    state.fit.lastRows = undefined;
    state.term.desiredCols = state.term.cols;
    state.term.desiredRows = state.term.rows;
    state.sentCols = 0;
    state.sentRows = 0;
    feature.requestTerminalFit(rect);
    state.term.requestFullRedraw();
    dependencies.workspace().setWorkspaceStatus("saved", "Terminal view repair requested");
  }

  // Re-measures every terminal on screen and gives each shell this browser's
  // size, for when another browser showing the same terminals resized them.
  // The fit runs in the next frame; the claim is queued behind it so it sends
  // the grid just measured, and sends it at once rather than after the settle
  // delay a dragged pane waits for.
  function refreshTerminalSizes() {
    let refreshed = 0;
    for (const rect of dependencies.desktop().rectangles) {
      const state = rect.kind === "terminal" && !rect.minimized ? rect.terminal : null;
      if (!state?.term || !state.fit) continue;
      state.fit.lastColumns = undefined;
      state.fit.lastRows = undefined;
      feature.requestTerminalFit(rect);
      platform.window.requestAnimationFrame(() => {
        if (rect.terminal === state) feature.terminalFits.claimGridSize(state);
      });
      refreshed += 1;
    }
    dependencies.workspace().setWorkspaceStatus("saved", refreshed === 1 ? "Terminal size refreshed" : `${refreshed} terminal sizes refreshed`);
  }

  function sendTerminalGridSize(terminalState) {
    feature.terminalFits.sendGridSize(terminalState);
  }

  // Whether someone is using this browser right now, rather than it sitting in
  // a background tab or on another device's desk.
  function browserInUse() {
    return !platform.window?.tesseraNativeSuspended && !platform.document.hidden && platform.document.hasFocus();
  }

  // Typing into or clicking a terminal takes its shell's size back for this
  // browser after another one, showing the same terminal, resized it.
  function claimTerminalSize(rect) {
    if (rect?.kind === "terminal" && feature.browserInUse()) {
      if (rect.terminal) rect.terminal.nativeUIHold = false;
      if (dependencies.phone().phoneView?.mode !== "scroll" && rect.terminal) rect.terminal.phoneModeHold = false;
      feature.terminalFits.claimGridSize(rect.terminal);
    }
  }

  function requestTerminalGridSize(terminalState) {
    feature.terminalFits.requestGridSize(terminalState);
  }

  // Find in the terminal's scrollback. A one-line selection becomes the text
  // to find.
  function openTerminalFind(rect) {
    const term = rect?.terminal?.term;
    if (!term?.search || !rect.body) return;
    rect.findBar ??= new TerminalFindBar({ term, container: rect.body, onClose: () => term.focus() });
    const selection = term.getSelection?.() || "";
    rect.findBar.open(selection && !selection.includes("\n") && selection.length <= 200 ? selection : "");
  }

  function moveTerminalFind(rect, older) {
    if (!rect?.findBar?.isOpen) feature.openTerminalFind(rect);
    else rect.findBar.select(older);
  }

  function disposeTerminal(rect, options = {}) {
    if (!rect?.terminal) {
      if (options.closeServer && rect?.kind === "terminal") {
        feature.closeServerTerminal(rect);
      }
      return;
    }
    const terminalState = rect.terminal;
    rect.findBar?.dispose();
    rect.findBar = null;
    dependencies.connectivity().completeTerminalWakeRecovery(terminalState);
    feature.terminalAudioPlayer.detach(terminalState.audioKey);
    terminalState.files?.dispose();
    rect.terminalAudioBadge?.remove();
    rect.terminalAudioBadge = null;
    rect.terminal = null;
    if (terminalState.reconnectTimer !== null) {
      platform.window.clearTimeout(terminalState.reconnectTimer);
      terminalState.reconnectTimer = null;
    }
    feature.clearTerminalStatus(rect);
    feature.terminalFits.cancel(terminalState);
    if (options.closeServer) {
      feature.closeServerTerminal(rect);
    }
    terminalState.dataDisposable?.dispose?.();
    terminalState.resizeDisposable?.dispose?.();
    terminalState.titleDisposable?.dispose?.();
    terminalState.linkHoverDisposable?.dispose?.();
    terminalState.workingDirectoryDisposable?.dispose?.();
    feature.showTerminalLinkHover(rect, "");
    terminalState.mouseBridge?.dispose?.();
    terminalState.pasteBridge?.dispose?.();
    terminalState.output?.dispose?.();
    terminalState.fit?.dispose?.();
    terminalState.fit = null;
    terminalState.term?.dispose?.();
    if (terminalState.socket?.readyState === platform.WebSocket.OPEN || terminalState.socket?.readyState === platform.WebSocket.CONNECTING) {
      terminalState.socket.close();
    }
  }

  function closeServerTerminal(rect) {
    if (!rect?.id) {
      return;
    }
    const params = new URLSearchParams({ workspaceId: dependencies.navigation().workspaceID, paneId: rect.id });
    platform.fetch(`/api/terminal?${params.toString()}`, {
      method: "DELETE",
      keepalive: true,
    }).catch((error) => platform.console.warn(error));
  }

  function initializeTerminalVisibilityFrame() {
    feature.terminalVisibilityFrame = null;
  }

  function initializeTerminalHostName() {
    // The host's name, from the terminal attach message. A shell's OSC 7 report
    // must name it (or localhost) for the pane to follow the shell's directory.
    feature.terminalHostName = "";
  }

  function initializeTerminalNoticeList() {
    feature.terminalNoticeList = platform.document.createElement("div");
    feature.terminalNoticeList.className = "terminal-notices";
    feature.terminalNoticeList.hidden = true;
    feature.terminalNoticeList.setAttribute("aria-live", "polite");
    platform.document.body.appendChild(feature.terminalNoticeList);
    feature.terminalNotices = new TerminalNotices(feature.terminalNoticeList, { onOpen: feature.openPaneFromNotice });
  }

  function initializeGhosttyModulePromise() {
    feature.ghosttyModulePromise = null;
  }

  function initializeTerminalTextEncoder() {
    feature.terminalTextEncoder = new TextEncoder();
  }

  function initializeTerminalAudioPlayer() {
    feature.terminalAudioPlayer = new TerminalAudioPlayer();
    platform.window.addEventListener("pagehide", (event) => {
      if (event.persisted) feature.terminalAudioPlayer.disable();
      else feature.terminalAudioPlayer.dispose();
    });
  }

  function initializeTerminalConnections() {
    feature.terminalConnections = new TerminalConnections({
      Socket: platform.WebSocket,
      timers: platform.window,
      fetch: (...args) => platform.fetch(...args),
      context: () => ({ workspaceID: dependencies.navigation().workspaceID, location: platform.window.location, watch: dependencies.phone().phoneViewWanted(),
        colorMode: dependencies.preferences().terminalColorMode, authMode: dependencies.navigation().authMode, serverReported: !dependencies.connectivity().serverConnectionModal.hidden }),
      opened: feature.terminalSocketOpened,
      control: feature.terminalControlMessage,
      mouseBridge: dependencies.terminalInput().attachTerminalMouseBridge,
      setStatus: feature.setTerminalStatus,
      disconnectAudio: key => feature.terminalAudioPlayer.disconnect(key),
      reauthenticate: () => dependencies.navigation().signInRecovery.ensureSignedIn(),
      retire: dependencies.desktop().destroyRectangle,
      host: name => { feature.terminalHostName = name; },
      attached: dependencies.connectivity().completeTerminalWakeRecovery,
    });
  }

  function initializeTerminalTimingCaptureSeconds() {
    feature.terminalTimingCaptureSeconds = 10;
    feature.terminalTimingCaptureTimer = null;
    feature.terminalFits = new TerminalFitScheduler({
      watchesSize: (state) => dependencies.phone().terminalWatchesSize(state),
      sizeIsTemporary: (state) => Boolean(state?.phoneFit),
    });
  }

  Object.assign(feature, {
    setTerminalCursorBlink,
    paneUnseen,
    updatePaneRenderState,
    updateTerminalRenderState,
    setTerminalOutputPaused,
    scheduleTerminalVisibilityUpdate,
    updateTerminalDocumentVisibility,
    loadGhosttyModule,
    startTerminal,
    recoverTerminalBacklog,
    connectTerminalSocket,
    terminalSocketOpened,
    terminalControlMessage,
    attachTerminalAudio,
    handleTerminalAudioMessage,
    terminalPaneFocused,
    updateTerminalFocus,
    handleTerminalAlert,
    sendTerminalAlertSeen,
    clearTerminalAttention,
    renderTerminalAttention,
    applyTerminalProgress,
    openPaneFromNotice,
    renderTerminalAudioStatus,
    retryTerminalNow,
    resumeTerminalConnections,
    setTerminalStatus,
    clearTerminalStatus,
    stopTerminalStatusCountdown,
    showTerminalLinkHover,
    terminalStatusBadge,
    terminalStatusIcon,
    renderTerminalStatusBadge,
    sendTerminalKeys,
    sendTerminalInput,
    sendTerminalTimingEnabled,
    setTerminalTimingHooks,
    startTerminalTimingCapture,
    stopTerminalTimingCapture,
    requestTerminalFit,
    repairTerminalView,
    refreshTerminalSizes,
    sendTerminalGridSize,
    browserInUse,
    claimTerminalSize,
    requestTerminalGridSize,
    openTerminalFind,
    moveTerminalFind,
    disposeTerminal,
    closeServerTerminal,
    initializeTerminalVisibilityFrame,
    initializeTerminalHostName,
    initializeTerminalNoticeList,
    initializeGhosttyModulePromise,
    initializeTerminalTextEncoder,
    initializeTerminalAudioPlayer,
    initializeTerminalConnections,
    initializeTerminalTimingCaptureSeconds,
  });
  return feature;
}
