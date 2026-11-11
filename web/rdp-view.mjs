import { normalizeRDPScaleMode, rdpCanvasDisplaySize, rdpDoubledRatio, rdpFollowsWindow, rdpCanvasPoint, rdpClipboardText, rdpCtrlAltDelete, rdpDesktopSize, rdpScaledLayout, rdpWheelAmount, rdpWheelStartNotch, rdpScanCode, rdpHideDelayMs, rdpWiggleIntervalMs, rdpWigglePoints, rdpWindowsKey } from "./rdp-pane.mjs";
import { createRDPStatsOverlay, readRDPStatsPreference, saveRDPStatsPreference } from "./rdp-stats.mjs";

// RDP canvas, controls, pointer/keyboard input and clipboard UI.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   browser: () => ReturnType<typeof import("./browser-view.mjs").createBrowser>,
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   preferences: () => ReturnType<typeof import("./preferences.mjs").createPreferences>,
 *   rdp: () => ReturnType<typeof import("./rdp-session.mjs").createRdp>,
 *   rdpDialogs: () => ReturnType<typeof import("./rdp-dialogs.mjs").createRdpDialogs>,
 *   terminal: () => ReturnType<typeof import("./terminal-view.mjs").createTerminal>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createRdpView(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    rdpLockKeyCodes: undefined,
  };

  function mountRDPPane(rect) {
    rect.body.classList.add("is-rdp");
    const pane = platform.document.createElement("div");
    pane.className = "rdp-pane";
    const toolbar = platform.document.createElement("div");
    toolbar.className = "rdp-toolbar";
    const address = platform.document.createElement("input");
    address.className = "rdp-address";
    address.type = "text";
    address.placeholder = "host:3389";
    address.value = rect.rdpTarget;
    address.spellcheck = false;
    address.setAttribute("aria-label", "RDP target");
    const connect = dependencies.browser().browserToolbarButton("Connect", "Connect or disconnect RDP");
    connect.classList.add("rdp-connect");
    const detach = dependencies.browser().browserToolbarButton("Detach", "Stop viewing but keep the session logged in and connected on the Tessera host; Connect attaches again");
    detach.classList.add("rdp-detach");
    detach.hidden = true;
    const ctrlAltDelete = dependencies.browser().browserToolbarButton("CAD", "Send Ctrl+Alt+Del");
    const windowsKey = dependencies.browser().browserToolbarButton("Win", "Send the Windows key");
    const scale = platform.document.createElement("select");
    scale.className = "rdp-select";
    scale.setAttribute("aria-label", "RDP scaling");
    for (const [value, label] of [["fit", "Fit"], ["one-to-one", "1:1"], ["resize", "Resize"], ["resize-2x", "Resize ×2"]]) {
      const option = platform.document.createElement("option");
      option.value = value;
      option.textContent = label;
      scale.appendChild(option);
    }
    scale.value = rect.rdpScaleMode;
    const wiggle = platform.document.createElement("select");
    wiggle.className = "rdp-select";
    wiggle.setAttribute("aria-label", "Mouse wiggle");
    wiggle.title = "Move the remote mouse a pixel and back once a minute, so the remote session doesn't go idle or lock: only while this window isn't the one you're using, or always, even while it is. Remembered for this window.";
    for (const [value, label] of [["off", "No wiggle"], ["away", "Wiggle when away"], ["always", "Wiggle always"]]) {
      const option = platform.document.createElement("option");
      option.value = value;
      option.textContent = label;
      wiggle.appendChild(option);
    }
    wiggle.value = rect.rdpWiggle ? (rect.rdpWiggleAlways ? "always" : "away") : "off";
    const sendClipboard = dependencies.browser().browserToolbarButton("↑", "Send local clipboard to remote");
    const copyClipboard = dependencies.browser().browserToolbarButton("↓", "Copy remote clipboard locally");
    // The badge also shows and hides the stats overlay.
    const video = platform.document.createElement("button");
    video.type = "button";
    video.className = "rdp-video";
    video.textContent = "H.264";
    video.title = feature.rdpVideoTitle(false);
    video.hidden = true;
    const keptLabel = platform.document.createElement("span");
    keptLabel.className = "rdp-video";
    keptLabel.textContent = "On host";
    keptLabel.title = "This session keeps running on the Tessera host when you close this page";
    keptLabel.hidden = true;
    const message = platform.document.createElement("div");
    message.className = "rdp-message";
    message.textContent = rect.rdpTarget ? "Ready to connect." : "Enter an RDP server address.";
    const screen = platform.document.createElement("div");
    screen.className = "rdp-screen";
    screen.hidden = true;
    const canvas = platform.document.createElement("canvas");
    canvas.className = "rdp-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Remote desktop");
    screen.appendChild(canvas);
    const dialog = platform.document.createElement("form");
    dialog.className = "rdp-dialog";
    dialog.hidden = true;
    dialog.addEventListener("keydown", (event) => dependencies.rdpDialogs().cyclePaneDialogFocus(dialog, event));

    const view = {
      pane, address, connect, detach, ctrlAltDelete, windowsKey, scale, sendClipboard, copyClipboard, video, keptLabel, message, screen, canvas, dialog,
      module: null, session: null, connecting: false, attempt: 0, dialogResolve: null, intentionalDisconnect: false,
      remoteClipboard: "", lastSentClipboard: "", clipboardRequested: false, resizeTimer: null, resizeObserver: null, canvasObserver: null,
      pointerFrame: 0, pendingPointer: null, wiggleTimer: null, wiggleSent: "", shownSent: true, hideTimer: null,
      // Where this page last put the remote pointer, in desktop pixels.
      lastPointer: null,
      h264: null, h264Drawn: false, h264FullColor: false, kept: false, detached: false,
      // The stats overlay while it shows (rdp-stats.mjs).
      stats: null,
      wheelVertical: { remainder: 0 }, wheelHorizontal: { remainder: 0 },
      // Desktop pixels per CSS pixel: above 1 in sharp mode.
      pixelRatio: 1,
      // Whether the desktop has a size chosen at sign-in rather than the
      // window's: Resize mode then leaves it until chosen again.
      fixedSize: false,
      // In full-size sharp mode, the 2x layout asked for once the server's
      // display runs (rdpScaledLayout), and whether it was asked for yet.
      scaled: null,
      scaledLaidOut: false,
      // The scaled layout being watched for a picture at its size, and a count
      // that retires older watches (see sendRDPScaledLayout).
      scaledWanted: null,
      scaledGeneration: 0,
    };
    rect.rdp = view;
    toolbar.append(address, connect, detach, ctrlAltDelete, windowsKey, scale, wiggle, sendClipboard, copyClipboard, video, keptLabel);
    pane.append(toolbar, message, screen, dialog);
    rect.body.appendChild(pane);
    feature.updateRDPControls(rect);

    address.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void dependencies.rdp().connectRDPPane(rect);
      }
    });
    video.addEventListener("click", () => {
      const storage = feature.rdpPreferenceStorage();
      saveRDPStatsPreference(storage, !readRDPStatsPreference(storage));
      for (const other of dependencies.desktop().rectangles) {
        if (other.rdp) feature.syncRDPStats(other);
      }
    });
    address.addEventListener("input", () => {
      rect.rdpTarget = address.value;
      if (rect.rdpStatusInput) {
        rect.rdpStatusInput.value = rect.rdpTarget;
      }
      dependencies.workspace().scheduleWorkspaceSave();
    });
    connect.addEventListener("click", () => {
      if (view.session || view.connecting) {
        feature.disconnectRDPPane(rect);
      } else {
        void dependencies.rdp().connectRDPPane(rect);
      }
    });
    detach.addEventListener("click", () => feature.detachRDPPane(rect));
    ctrlAltDelete.addEventListener("click", () => feature.sendRDPKeys(rect, rdpCtrlAltDelete));
    windowsKey.addEventListener("click", () => feature.sendRDPKeys(rect, rdpWindowsKey));
    scale.addEventListener("change", () => {
      rect.rdpScaleMode = normalizeRDPScaleMode(scale.value);
      // Choosing Resize means following the window, even from a fixed size.
      if (rdpFollowsWindow(rect.rdpScaleMode)) view.fixedSize = false;
      feature.layoutRDPCanvas(rect);
      feature.scheduleRDPResize(rect);
      dependencies.workspace().scheduleWorkspaceSave();
    });
    sendClipboard.addEventListener("click", () => void feature.sendRDPClipboard(rect));
    copyClipboard.addEventListener("click", () => void feature.copyRDPClipboard(rect));
    wiggle.addEventListener("change", () => {
      rect.rdpWiggle = wiggle.value !== "off";
      rect.rdpWiggleAlways = wiggle.value === "always";
      feature.syncRDPWiggle(rect);
      dependencies.workspace().scheduleWorkspaceSave();
    });
    view.wiggleTimer = platform.window.setInterval(() => feature.wiggleRDPPointer(rect), rdpWiggleIntervalMs);

    canvas.addEventListener("pointerdown", (event) => {
      if (!view.session) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture?.(event.pointerId);
      feature.syncRDPLockKeys(rect, event);
      feature.cancelRDPPointerMove(view);
      const { DeviceEvent } = view.module.Backend;
      feature.sendRDPInput(rect, [feature.rdpPointerMove(rect, event), DeviceEvent.mouseButtonPressed(event.button)]);
    });
    // Pointer moves arrive up to 120 times a second and IronRDP decodes on the
    // same thread, so only the latest position is sent, once per frame.
    canvas.addEventListener("pointermove", (event) => {
      if (!view.session) return;
      view.pendingPointer = { clientX: event.clientX, clientY: event.clientY };
      view.pointerFrame ||= platform.requestAnimationFrame(() => {
        view.pointerFrame = 0;
        const pointer = view.pendingPointer;
        view.pendingPointer = null;
        if (pointer && view.session) feature.sendRDPInput(rect, [feature.rdpPointerMove(rect, pointer)]);
      });
    });
    for (const type of ["pointerup", "pointercancel"]) {
      canvas.addEventListener(type, (event) => {
        if (!view.session) return;
        feature.cancelRDPPointerMove(view);
        feature.sendRDPInput(rect, [feature.rdpPointerMove(rect, event), view.module.Backend.DeviceEvent.mouseButtonReleased(event.button)]);
      });
    }
    canvas.addEventListener("wheel", (event) => {
      if (!view.session) return;
      event.preventDefault();
      const vertical = event.deltaY !== 0;
      const axis = vertical ? view.wheelVertical : view.wheelHorizontal;
      // A gesture's first movement goes as a whole notch, so the server
      // scrolls at once instead of after a trackpad's small deltas add up.
      const amount = rdpWheelStartNotch(axis,
        rdpWheelAmount(axis, vertical ? event.deltaY : event.deltaX, event.deltaMode, dependencies.preferences().rdpWheelSpeed), event.timeStamp);
      if (amount) {
        // RotationUnit 0: pixels.
        feature.sendRDPInput(rect, [view.module.Backend.DeviceEvent.wheelRotations(vertical, amount, 0)]);
      }
    }, { passive: false });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("keydown", (event) => feature.handleRDPKey(rect, event));
    canvas.addEventListener("keyup", (event) => feature.handleRDPKey(rect, event));
    canvas.addEventListener("blur", () => view.session?.releaseAllInputs());

    if (typeof platform.ResizeObserver === "function") {
      view.resizeObserver = new platform.ResizeObserver(() => {
        feature.layoutRDPCanvas(rect);
        feature.scheduleRDPResize(rect);
      });
      view.resizeObserver.observe(screen);
    }
    // IronRDP sizes the canvas itself when the session starts and when the
    // remote desktop is resized, and never calls canvasResizedCallback, so the
    // canvas's width and height attributes are the signal to lay it out again.
    view.canvasObserver = new platform.MutationObserver(() => {
      feature.layoutRDPCanvas(rect);
    });
    view.canvasObserver.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    // A session the host kept for this window attaches by itself.
    void dependencies.rdp().autoAttachKeptRDP(rect).catch((error) => feature.setRDPMessage(rect, dependencies.rdp().rdpFailureMessage(error), true));
  }

  function setRDPMessage(rect, text, error = false) {
    if (!rect.rdp) {
      return;
    }
    rect.rdp.message.textContent = text;
    rect.rdp.message.classList.toggle("is-error", error);
    rect.rdp.message.hidden = false;
  }

  function updateRDPControls(rect) {
    const view = rect.rdp;
    if (!view) {
      return;
    }
    const connected = Boolean(view.session);
    view.connect.textContent = connected ? "Disconnect" : view.connecting ? "Cancel" : "Connect";
    view.address.disabled = connected || view.connecting;
    view.ctrlAltDelete.disabled = !connected;
    view.windowsKey.disabled = !connected;
    view.sendClipboard.disabled = !connected || view.kept;
    view.sendClipboard.title = view.kept ? "Clipboard isn't available for sessions kept on the host" : "Send local clipboard to remote";
    view.copyClipboard.disabled = !view.remoteClipboard;
    view.video.hidden = !(connected && view.h264Drawn);
    view.video.textContent = view.h264FullColor ? "H.264 4:4:4" : "H.264";
    view.video.title = `${feature.rdpVideoTitle(view.h264FullColor)}. Click to show or hide stats.`;
    view.keptLabel.hidden = !(connected && view.kept);
    view.detach.hidden = !(connected && view.kept);
    feature.syncRDPStats(rect);
  }

  // Shows the stats overlay over a connected session while it's turned on in
  // this browser, and takes it away otherwise.
  function syncRDPStats(rect) {
    const view = rect.rdp;
    if (!view) return;
    const wanted = Boolean(view.session) && readRDPStatsPreference(feature.rdpPreferenceStorage());
    if (wanted && !view.stats) {
      view.stats = createRDPStatsOverlay({
        container: view.screen,
        read: () => (view.kept ? view.session?.stats?.() : view.h264?.stats()) ?? null,
        title: () => `${view.kept ? "kept on host" : "in page"} · ${view.canvas.width}×${view.canvas.height}`,
      });
    } else if (!wanted && view.stats) {
      view.stats.close();
      view.stats = null;
    }
    view.video.classList.toggle("is-active", Boolean(view.stats));
  }

  // Fit scales the desktop into the pane; 1:1 and Resize show it unscaled.
  function layoutRDPCanvas(rect) {
    const view = rect.rdp;
    if (!view) {
      return;
    }
    const ratio = dependencies.rdp().rdpDisplayRatio(rect, view);
    const size = rdpCanvasDisplaySize(rect.rdpScaleMode, view.canvas.width / ratio, view.canvas.height / ratio, view.screen.clientWidth, view.screen.clientHeight);
    view.canvas.style.width = `${size.width}px`;
    view.canvas.style.height = `${size.height}px`;
    view.screen.classList.toggle("is-one-to-one", rect.rdpScaleMode !== "fit");
    if (rect.rdpStatusInput) {
      rect.rdpStatusInput.value = view.session
        ? `${rect.rdpTarget} · ${view.canvas.width}×${view.canvas.height}`
        : rect.rdpTarget;
    }
  }

  // In Resize and Resize ×2 modes the remote desktop follows the pane's size,
  // once the pane has settled, through the Display Control channel.
  function scheduleRDPResize(rect) {
    const view = rect.rdp;
    if (!view) {
      return;
    }
    platform.window.clearTimeout(view.resizeTimer);
    if (!view.session || !rdpFollowsWindow(rect.rdpScaleMode) || view.fixedSize) {
      return;
    }
    view.resizeTimer = platform.window.setTimeout(() => {
      if (!view.session || !rdpFollowsWindow(rect.rdpScaleMode) || view.fixedSize || !view.screen.clientWidth) return;
      if (rect.rdpScaleMode === "resize-2x") {
        const size = rdpDesktopSize(view.screen.clientWidth * rdpDoubledRatio, view.screen.clientHeight * rdpDoubledRatio);
        if (size.width === view.canvas.width && size.height === view.canvas.height) return;
        view.session.resize(size.width, size.height);
        return;
      }
      if (view.scaled) {
        // Full-size sharp mode: a 2x layout within Remotr's limits.
        const layout = rdpScaledLayout(view.screen.clientWidth, view.screen.clientHeight);
        if (layout.width === view.canvas.width && layout.height === view.canvas.height) return;
        dependencies.rdp().sendRDPScaledLayout(view, layout, () => rect.rdp === view);
        return;
      }
      const ratio = view.pixelRatio || 1;
      const size = rdpDesktopSize(view.screen.clientWidth * ratio, view.screen.clientHeight * ratio);
      if (size.width === view.canvas.width && size.height === view.canvas.height) return;
      view.session.resize(size.width, size.height);
    }, 300);
  }

  function sendRDPInput(rect, events) {
    const view = rect.rdp;
    if (!view?.session) {
      return;
    }
    const transaction = new view.module.Backend.InputTransaction();
    for (const event of events) {
      transaction.addEvent(event);
    }
    view.session.applyInputs(transaction);
  }

  function sendRDPKeys(rect, scanCodes) {
    const view = rect.rdp;
    if (!view?.session) {
      return;
    }
    const { DeviceEvent } = view.module.Backend;
    feature.sendRDPInput(rect, [
      ...scanCodes.map((code) => DeviceEvent.keyPressed(code)),
      ...[...scanCodes].reverse().map((code) => DeviceEvent.keyReleased(code)),
    ]);
    view.canvas.focus({ preventScroll: true });
  }

  // A button press or release carries its own position, so a move still
  // waiting for the next frame is dropped rather than sent after it.
  function cancelRDPPointerMove(view) {
    platform.cancelAnimationFrame(view.pointerFrame);
    view.pointerFrame = 0;
    view.pendingPointer = null;
  }

  function rdpPointerMove(rect, event) {
    const view = rect.rdp;
    const point = rdpCanvasPoint(event.clientX, event.clientY, view.canvas.getBoundingClientRect(), view.canvas.width, view.canvas.height);
    view.lastPointer = point;
    return view.module.Backend.DeviceEvent.mouseMove(point.x, point.y);
  }

  // The mouse wiggler: while the window isn't the one in use (another window
  // is, or this page isn't in front), or always if the window asks for that, a
  // pixel's move and back keeps the remote session from going idle or locking.
  // The host wiggles a kept session itself, even with this page closed, so this
  // page only tells it the window's state.
  function wiggleRDPPointer(rect) {
    const view = rect.rdp;
    if (view?.session?.setWiggle) {
      feature.syncRDPWiggle(rect);
      return;
    }
    if (!rect.rdpWiggle || !view?.session || feature.rdpWiggleInUse(rect)) return;
    const { DeviceEvent } = view.module.Backend;
    const points = rdpWigglePoints(view.lastPointer, view.canvas.width, view.canvas.height);
    feature.sendRDPInput(rect, points.map((point) => DeviceEvent.mouseMove(point.x, point.y)));
  }

  // Tells the host keeping this window's session whether to wiggle, when that
  // changes.
  function syncRDPWiggle(rect) {
    const view = rect.rdp;
    if (!view?.session?.setWiggle) return;
    const inUse = feature.rdpWiggleInUse(rect);
    const state = `${rect.rdpWiggle} ${inUse}`;
    if (view.wiggleSent === state) return;
    view.wiggleSent = state;
    view.session.setWiggle(rect.rdpWiggle, inUse);
  }

  // Tells the host keeping this window's session whether the window can be
  // seen; while it can't, the server's video pauses. A minimized or covered
  // window waits rdpHideDelayMs first, so a window dragged across, or minimized
  // and restored, doesn't stop the stream only to ask for the whole screen
  // again. A hidden page says so at once: its timers may never run (iPad
  // suspends it).
  function syncRDPShown(rect) {
    const view = rect.rdp;
    const session = view?.session;
    if (!session?.setShown) return;
    if (!dependencies.terminal().paneUnseen(rect)) {
      platform.window.clearTimeout(view.hideTimer);
      view.hideTimer = null;
      if (!view.shownSent) {
        view.shownSent = true;
        session.setShown(true);
      }
      return;
    }
    if (!view.shownSent) return;
    const hide = () => {
      view.hideTimer = null;
      if (view.session !== session || !view.shownSent || !dependencies.terminal().paneUnseen(rect)) return;
      view.shownSent = false;
      session.setShown(false);
    };
    if (platform.document.hidden) {
      platform.window.clearTimeout(view.hideTimer);
      hide();
    } else if (view.hideTimer === null) {
      view.hideTimer = platform.window.setTimeout(hide, rdpHideDelayMs);
    }
  }

  // Whether the wiggler counts the window as in use, and so leaves it be. A
  // window that wiggles always never is.
  function rdpWiggleInUse(rect) {
    return !rect.rdpWiggleAlways && dependencies.terminal().terminalPaneFocused(rect);
  }

  function syncRDPLockKeys(rect, event) {
    rect.rdp?.session?.synchronizeLockKeys(
      event.getModifierState("ScrollLock"),
      event.getModifierState("NumLock"),
      event.getModifierState("CapsLock"),
      event.getModifierState("KanaMode"),
    );
  }

  function handleRDPKey(rect, event) {
    const view = rect.rdp;
    if (!view?.session) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Lock keys are mirrored from the browser's state rather than toggled, so
    // the two sides cannot drift apart.
    if (feature.rdpLockKeyCodes.has(event.code)) {
      if (event.type === "keyup") feature.syncRDPLockKeys(rect, event);
      return;
    }
    const code = rdpScanCode(event.code);
    if (code === null) {
      return;
    }
    const { DeviceEvent } = view.module.Backend;
    feature.sendRDPInput(rect, [event.type === "keydown" ? DeviceEvent.keyPressed(code) : DeviceEvent.keyReleased(code)]);
    // macOS never sends keyup for keys released while Command is held, so
    // letting go of Command releases everything still marked down.
    if (event.type === "keyup" && dependencies.interactions().appleKeyboardLayout && (event.code === "MetaLeft" || event.code === "MetaRight")) {
      view.session.releaseAllInputs();
    }
  }

  // Where the RDP dialog's choices are remembered, or null when this browser
  // won't store them.
  function rdpPreferenceStorage() {
    try {
      return platform.window.localStorage;
    } catch {
      return null;
    }
  }

  function rdpVideoTitle(fullColor) {
    return fullColor
      ? "The remote desktop arrives as H.264 4:4:4 video, decoded and combined into full color by this browser"
      : "The remote desktop arrives as H.264 video, decoded by this browser";
  }

  function rdpTransportIsPrivate(locationLike) {
    return locationLike.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(locationLike.hostname);
  }

  function receiveRDPClipboard(rect, view, data) {
    const items = data.items().map((item) => ({ mimeType: item.mimeType(), value: item.value() }));
    const text = rdpClipboardText(items);
    if (!text || rect.rdp !== view) {
      return;
    }
    view.remoteClipboard = text;
    feature.updateRDPControls(rect);
  }

  async function sendRDPClipboardText(rect, text) {
    const view = rect.rdp;
    // Sessions kept on the host don't carry the clipboard yet.
    if (!view?.session || view.kept) {
      return;
    }
    const data = new view.module.Backend.ClipboardData();
    if (text) {
      data.addText("text/plain", text);
    }
    await view.session.onClipboardPaste(data);
  }

  function showRDPClipboardEntry(rect) {
    const view = rect.rdp;
    if (!view?.session) return;
    view.dialog.replaceChildren();
    const field = platform.document.createElement("textarea");
    field.placeholder = "Paste text to send to the remote desktop";
    field.setAttribute("aria-label", "Remote clipboard text");
    const send = platform.document.createElement("button");
    send.type = "submit";
    send.textContent = "Send";
    const cancel = platform.document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    view.dialog.append(field, send, cancel);
    void dependencies.rdpDialogs().showRDPDialog(rect, cancel, () => field.value, null, field).then((text) => {
      if (text === null) return;
      view.lastSentClipboard = text;
      void feature.sendRDPClipboardText(rect, text);
      view.canvas.focus({ preventScroll: true });
    });
  }

  async function sendRDPClipboard(rect) {
    const view = rect.rdp;
    if (!view?.session) return;
    try {
      const text = await dependencies.clipboard().readClipboardText();
      if (dependencies.clipboard().clipboardReadFellBack) throw new Error("clipboard unavailable");
      view.lastSentClipboard = text;
      await feature.sendRDPClipboardText(rect, text);
      view.canvas.focus({ preventScroll: true });
    } catch {
      feature.showRDPClipboardEntry(rect);
    }
  }

  async function copyRDPClipboard(rect) {
    const text = rect.rdp?.remoteClipboard;
    if (!text) return;
    if (!await dependencies.clipboard().writeClipboardText(text)) {
      dependencies.workspace().setWorkspaceStatus("error", "Clipboard blocked", "The remote text is available to Tessera's own Paste.");
    }
    rect.rdp?.canvas.focus({ preventScroll: true });
  }

  function disconnectRDPPane(rect) {
    dependencies.rdp().rdpController.disconnect(rect);
  }

  // Stops viewing a session the host keeps without ending it: the host stays
  // signed in to the server, as when this page closes.
  function detachRDPPane(rect) {
    dependencies.rdp().rdpController.detach(rect);
  }

  function disposeRDPPane(rect) {
    dependencies.rdp().rdpController.dispose(rect);
  }

  function initializeRdpLockKeyCodes() {
    feature.rdpLockKeyCodes = new Set(["CapsLock", "NumLock", "ScrollLock", "KanaMode"]);
  }

  Object.assign(feature, {
    mountRDPPane,
    setRDPMessage,
    updateRDPControls,
    syncRDPStats,
    layoutRDPCanvas,
    scheduleRDPResize,
    sendRDPInput,
    sendRDPKeys,
    cancelRDPPointerMove,
    rdpPointerMove,
    wiggleRDPPointer,
    syncRDPWiggle,
    syncRDPShown,
    rdpWiggleInUse,
    syncRDPLockKeys,
    handleRDPKey,
    rdpPreferenceStorage,
    rdpVideoTitle,
    rdpTransportIsPrivate,
    receiveRDPClipboard,
    sendRDPClipboardText,
    showRDPClipboardEntry,
    sendRDPClipboard,
    copyRDPClipboard,
    disconnectRDPPane,
    detachRDPPane,
    disposeRDPPane,
    initializeRdpLockKeyCodes,
  });
  return feature;
}
