import { offerLoginToBrowser } from "./password-manager.mjs";
import { normalizeRDPTarget, parseRDPResolution, rdpDoubledRatio, rdpFollowsWindow, rdpCertificateTrust, rdpDesktopSize, rdpOffersSharp, rdpPixelRatio, rdpScaledLayout, rdpScaledLayoutDelayMs, rdpScaledLayoutWatchMs, rdpErrorMessage, rdpWebSocketURL } from "./rdp-pane.mjs";
import { createRDPH264Presenter, rdpH264Supported, readRDPFullColorPreference } from "./rdp-h264.mjs";
import { keptRDPCreateBody, keptRDPPaneBody } from "./rdp-kept.mjs";
import { connectRDPViewer, rdpViewerModule, rdpViewerURL } from "./rdp-viewer.mjs";
import { RDPController } from "./rdp-controller.mjs";

// RDP connection attempts, kept viewers, reattachment and codec lifetime.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   rdpDialogs: () => ReturnType<typeof import("./rdp-dialogs.mjs").createRdpDialogs>,
 *   rdpView: () => ReturnType<typeof import("./rdp-view.mjs").createRdpView>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createRdp(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    rdpModulePromise: undefined,
    rdpController: undefined,
    rdpPaneKind: undefined,
    rdpDetachedMessage: undefined,
    rdpReattachDelayMs: undefined,
    rdpH264Support: undefined,
  };

  function loadRDPModule() {
    if (!feature.rdpModulePromise) {
      // A prebuilt, patched IronRDP (third_party/ironrdp). It inlines its
      // WebAssembly as a data: URL, which the CSP permits (connect-src data:,
      // script-src 'wasm-unsafe-eval').
      feature.rdpModulePromise = import("./vendor/rdp.js?v=ironrdp-7fc80c4d-tessera.3").then(async (module) => {
        await module.init("warn");
        return module;
      });
      feature.rdpModulePromise.catch(() => {
        feature.rdpModulePromise = null;
      });
    }
    return feature.rdpModulePromise;
  }

  function rdpConnectionIsCurrent(rect, view, attempt) {
    return rect.rdp === view && view.attempt === attempt && dependencies.desktop().rectangles.includes(rect);
  }

  async function rdpProxyRequest(path, body) {
    return feature.rdpController.request(path, body);
  }

  // What the host keeps for this window: whether it keeps sessions at all, for
  // how long without a viewer, and the window's own session, if any.
  async function rdpKeptState(rect, options) {
    return feature.rdpController.state(rect, options);
  }

  // Ends the session the host keeps for this window, if any.
  function endKeptRDP(rect, workspaceID) {
    return feature.rdpController.end(rect, workspaceID);
  }

  // Shows a session as live, whether IronRDP runs it in this page or the host
  // keeps it and this page only views it.
  function activateRDPSession(rect, view, session) {
    view.session = session;
    view.wiggleSent = "";
    dependencies.rdpView().syncRDPWiggle(rect);
    // A viewer attaches shown.
    platform.window.clearTimeout(view.hideTimer);
    view.hideTimer = null;
    view.shownSent = true;
    dependencies.rdpView().syncRDPShown(rect);
    const desktop = session.desktopSize();
    view.canvas.width = desktop.width;
    view.canvas.height = desktop.height;
    view.screen.hidden = false;
    view.message.hidden = true;
    dependencies.rdpView().layoutRDPCanvas(rect);
    dependencies.rdpView().syncRDPStats(rect);
    view.canvas.focus({ preventScroll: true });
    if (view.clipboardRequested) {
      view.clipboardRequested = false;
      void dependencies.rdpView().sendRDPClipboardText(rect, view.lastSentClipboard);
    }
    void feature.runRDPSession(rect, view, session);
  }

  // Attaches this window to the session the host keeps for it.
  async function attachKeptRDP(rect, view, kept, current) {
    dependencies.rdpView().setRDPMessage(rect, "Attaching to the session kept on the host...");
    if (kept.target && kept.target !== rect.rdpTarget) {
      rect.rdpTarget = kept.target;
      view.address.value = kept.target;
      if (rect.rdpStatusInput) {
        rect.rdpStatusInput.value = kept.target;
      }
      dependencies.workspace().scheduleWorkspaceSave();
    }
    feature.closeRDPH264(view);
    view.canvas.style.cursor = "";
    // The desktop was sized for the browser that kept the session.
    view.scaled = kept.scaledWidth
      ? { width: kept.scaledWidth, height: kept.scaledHeight, scale: kept.scaleFactor, ratio: kept.pixelRatio || 1 }
      : null;
    view.pixelRatio = view.scaled ? 1 : kept.pixelRatio || 1;
    view.fixedSize = Boolean(rect.rdpResolution) && !rdpFollowsWindow(rect.rdpScaleMode);
    const session = await connectRDPViewer({
      url: rdpViewerURL(dependencies.navigation().workspaceID, rect.id, platform.window.location),
      canvas: view.canvas,
      onFirstPicture: () => {
        view.h264Drawn = true;
        dependencies.rdpView().updateRDPControls(rect);
      },
      fullColor: readRDPFullColorPreference(dependencies.rdpView().rdpPreferenceStorage()),
      onFullColor: () => {
        view.h264FullColor = true;
        dependencies.rdpView().updateRDPControls(rect);
      },
    });
    if (!current()) {
      session.shutdown();
      return;
    }
    view.module = rdpViewerModule;
    view.kept = true;
    feature.activateRDPSession(rect, view, session);
  }

  // Handles a window whose session the host keeps. It returns true when it
  // dealt with the connection: attached to it, asked for the password to rejoin
  // it, or was cancelled; false when the session is over and a new one is needed.
  async function resumeKeptRDP(rect, view, kept, current) {
    const workspaceID = dependencies.navigation().workspaceID;
    if (kept.state === "active") {
      await feature.attachKeptRDP(rect, view, kept, current);
      return true;
    }
    if (kept.state === "lost" && kept.canRejoin) {
      rect.rdpTarget = kept.target || rect.rdpTarget;
      const credentials = await dependencies.rdpDialogs().askRDPCredentials(rect, { rejoin: true });
      if (!credentials || !current()) {
        if (current()) dependencies.rdpView().setRDPMessage(rect, "Connection cancelled.");
        return true;
      }
      dependencies.rdpView().setRDPMessage(rect, `Rejoining ${kept.target}...`);
      await feature.rdpProxyRequest("/api/rdp-kept/rejoin", keptRDPPaneBody(workspaceID, rect.id, credentials.password));
      void offerLoginToBrowser({ username: rect.rdpUsername, password: credentials.password, name: `${rect.rdpUsername} — ${rect.rdpTarget}` });
      credentials.password = "";
      feature.rdpController.invalidate();
      if (!current()) return true;
      await feature.attachKeptRDP(rect, view, kept, current);
      return true;
    }
    return false;
  }

  // When a window appears (the page opened, or its workspace loaded), attaches to
  // the session the host kept for it, so the desktop is where it was left.
  async function autoAttachKeptRDP(rect) {
    const view = rect.rdp;
    const kept = await feature.rdpKeptState(rect);
    if (!kept.session || rect.rdp !== view || view.session || view.connecting) {
      return;
    }
    if (kept.session.state === "active") {
      view.address.value ||= kept.session.target || "";
      void feature.connectRDPPane(rect);
    } else if (kept.session.state === "lost") {
      dependencies.rdpView().setRDPMessage(rect, "The connection to the RDP server was lost. Choose Connect to rejoin the session.");
    }
  }

  async function connectRDPPane(rect) {
    const view = rect?.rdp;
    if (!view || view.session || view.connecting) {
      return;
    }
    const target = normalizeRDPTarget(view.address.value);
    if (!target) {
      dependencies.rdpView().setRDPMessage(rect, "Enter a host, host:port, or bracketed IPv6 address.", true);
      return;
    }
    const workspaceID = dependencies.navigation().workspaceID;
    const user = dependencies.navigation().currentUser;
    const account = dependencies.navigation().signedInAccount;
    const attempt = ++view.attempt;
    const current = () => feature.rdpConnectionIsCurrent(rect, view, attempt)
      && dependencies.navigation().workspaceID === workspaceID
      && dependencies.navigation().currentUser === user
      && dependencies.navigation().signedInAccount === account;
    // This attempt's H.264 presenter; view.h264 may belong to a newer attempt.
    let h264 = null;
    view.connecting = true;
    view.videoFailure = "";
    view.intentionalDisconnect = false;
    dependencies.rdpDialogs().hideRDPDialog(rect);
    dependencies.rdpView().updateRDPControls(rect);
    dependencies.rdpView().setRDPMessage(rect, `Checking ${target}...`);
    try {
      // A window whose session the host keeps attaches to it, or rejoins it.
      const kept = await feature.rdpKeptState(rect, { fresh: true });
      if (!current()) return;
      if (kept.session && await feature.resumeKeptRDP(rect, view, kept.session, current)) return;
      const certificate = await feature.rdpProxyRequest("/api/rdp-proxy/certificate", { workspaceId: workspaceID, target });
      if (!current()) return;
      rect.rdpTarget = certificate.target;
      view.address.value = rect.rdpTarget;
      if (rect.rdpStatusInput) {
        rect.rdpStatusInput.value = rect.rdpTarget;
      }
      // Account-level approval takes precedence over stale pane settings. Older
      // servers omit these fields and retain their existing per-pane behavior.
      const remembered = certificate.trustedFingerprint || "";
      const trust = rdpCertificateTrust(remembered
        ? { trustedTarget: certificate.target, trustedFingerprint: remembered }
        : certificate.allowPaneTrust === false ? null
          : { trustedTarget: rect.rdpTrustedTarget, trustedFingerprint: rect.rdpTrustedFingerprint }, certificate.target, certificate.fingerprint);
      if (trust !== "trusted") {
        if (!await dependencies.rdpDialogs().confirmRDPCertificate(rect, certificate, trust)) {
          if (current()) dependencies.rdpView().setRDPMessage(rect, "Connection cancelled.");
          return;
        }
        if (!current()) return;
      }
      if (Object.hasOwn(certificate, "trustedFingerprint") && remembered !== certificate.fingerprint) {
        // Explicitly accepted now, or the matching legacy pane was accepted
        // earlier by this user. Never overwrite newer trust from another client.
        await feature.rdpProxyRequest("/api/rdp-proxy/trust", {
          workspaceId: workspaceID, target: certificate.target, fingerprint: certificate.fingerprint,
          previousFingerprint: remembered,
        });
        if (!current()) return;
      }
      if (rect.rdpTrustedTarget !== certificate.target || rect.rdpTrustedFingerprint !== certificate.fingerprint) {
        rect.rdpTrustedTarget = certificate.target;
        rect.rdpTrustedFingerprint = certificate.fingerprint;
        dependencies.workspace().scheduleWorkspaceSave();
      }
      const credentials = await dependencies.rdpDialogs().askRDPCredentials(rect, {
        keep: kept.available,
        idleLimitSeconds: kept.idleLimitSeconds,
        h264: await feature.rdpH264Available(),
        sharp: rdpOffersSharp(platform.window.devicePixelRatio),
      });
      if (!credentials || !current()) {
        if (current()) dependencies.rdpView().setRDPMessage(rect, "Connection cancelled.");
        return;
      }
      rect.rdpUsername = credentials.username;
      rect.rdpDomain = credentials.domain;
      dependencies.workspace().scheduleWorkspaceSave();
      const area = view.screen.hidden ? view.message : view.screen;
      // Full-size sharp mode connects at the plain size and asks for the 2x
      // layout once the display runs; plain sharp mode asks for the screen's
      // own pixels from the start.
      // A fixed resolution is asked for as it is, and Resize ×2 asks for half
      // the window, both with sharp mode off.
      const fixed = parseRDPResolution(credentials.resolution);
      const doubled = !fixed && rect.rdpScaleMode === "resize-2x";
      const sharp = credentials.sharp && !doubled;
      const scaled = !fixed && sharp && credentials.fullSize ? rdpScaledLayout(area.clientWidth, area.clientHeight) : null;
      const ratio = fixed || scaled ? 1 : rdpPixelRatio(sharp, platform.window.devicePixelRatio);
      const size = fixed || (doubled
        ? rdpDesktopSize(area.clientWidth * rdpDoubledRatio, area.clientHeight * rdpDoubledRatio)
        : rdpDesktopSize(area.clientWidth * ratio, area.clientHeight * ratio));
      view.fixedSize = Boolean(fixed);
      if (fixed && rdpFollowsWindow(rect.rdpScaleMode)) {
        // Resize would replace the chosen size at once.
        rect.rdpScaleMode = "fit";
        view.scale.value = rect.rdpScaleMode;
        dependencies.workspace().scheduleWorkspaceSave();
      }
      if (credentials.keep) {
        // The host runs the session, so it outlives this page.
        dependencies.rdpView().setRDPMessage(rect, `Logging in to ${certificate.target}...`);
        await feature.rdpProxyRequest("/api/rdp-kept", keptRDPCreateBody({
          workspaceId: workspaceID,
          pane: rect.id,
          target: certificate.target,
          fingerprint: certificate.fingerprint,
          credentials,
          size,
          h264: await feature.rdpH264Available(),
          pixelRatio: scaled ? scaled.ratio : ratio,
          scaled,
        }));
        // The host logged in: the login works.
        void offerLoginToBrowser({ username: credentials.username, password: credentials.password, name: `${credentials.username} — ${certificate.target}` });
        credentials.password = "";
        feature.rdpController.invalidate();
        if (!current()) {
          void feature.endKeptRDP(rect, workspaceID);
          return;
        }
        await feature.attachKeptRDP(rect, view, {
          target: certificate.target,
          pixelRatio: scaled ? scaled.ratio : ratio,
          scaledWidth: scaled?.width,
          scaledHeight: scaled?.height,
          scaleFactor: scaled?.scale,
        }, current);
        return;
      }
      dependencies.rdpView().setRDPMessage(rect, `Connecting to ${certificate.target}...`);
      const [module, proxy] = await Promise.all([
        feature.loadRDPModule(),
        feature.rdpProxyRequest("/api/rdp-proxy", { workspaceId: workspaceID, target: certificate.target, fingerprint: certificate.fingerprint }),
      ]);
      if (!current()) return;
      view.module = module;
      const { Backend } = module;
      const builder = new Backend.SessionBuilder();
      builder.proxyAddress(rdpWebSocketURL(proxy.path, platform.window.location));
      builder.destination(certificate.target);
      builder.serverDomain(credentials.domain);
      builder.username(credentials.username);
      builder.password(credentials.password);
      // The capability path authorizes the socket; IronRDP requires a token.
      builder.authToken("tessera");
      builder.desktopSize(new Backend.DesktopSize(size.width, size.height));
      view.pixelRatio = ratio;
      view.scaled = scaled;
      view.scaledLaidOut = false;
      builder.renderCanvas(view.canvas);
      builder.setCursorStyleCallbackContext(view);
      builder.setCursorStyleCallback((kind, data, hotspotX, hotspotY) => feature.setRDPCursor(view, kind, data, hotspotX, hotspotY));
      builder.remoteClipboardChangedCallback((data) => dependencies.rdpView().receiveRDPClipboard(rect, view, data));
      builder.forceClipboardUpdateCallback(() => {
        if (view.session) {
          void dependencies.rdpView().sendRDPClipboardText(rect, view.lastSentClipboard);
        } else {
          view.clipboardRequested = true;
        }
      });
      builder.extension(module.displayControl(true));
      // Pointer shapes are the browser's own: with the server's, input felt
      // slower on iPad.
      builder.extension(module.enableServerPointer(false));
      feature.closeRDPH264(view);
      if (await feature.rdpH264Available()) {
        if (!current()) return;
        h264 = createRDPH264Presenter({
          canvas: view.canvas,
          onFirstPicture: () => {
            view.h264Drawn = true;
            dependencies.rdpView().updateRDPControls(rect);
            feature.scheduleRDPScaledLayout(view, current);
          },
          onPicture: () => feature.noteRDPScaledPicture(view),
          onBacklogExceeded: () => {
            if (!current()) return;
            // IronRDP's in-page API cannot suppress video. Do not leave a live
            // but permanently frozen canvas when the bounded queue fills.
            view.videoFailure = "RDP video could not keep up. Choose Connect to reconnect, or disable Full color (4:4:4).";
            view.session?.shutdown();
          },
          fullColor: credentials.fullColor,
          onFullColor: () => {
            view.h264FullColor = true;
            dependencies.rdpView().updateRDPControls(rect);
          },
        });
        view.h264 = h264;
        // The graphics pipeline only with H.264: its other codecs are decoded
        // in WebAssembly and are slower on iPad than the plain bitmap updates.
        builder.extension(module.enableEgfx(true));
        builder.extension(module.h264FrameCallback((data, regions, surfaceId, frameView) => h264.push(data, regions, frameView, surfaceId)));
      }
      const session = await builder.connect();
      void offerLoginToBrowser({ username: credentials.username, password: credentials.password, name: `${credentials.username} — ${certificate.target}` });
      credentials.password = "";
      if (!current()) {
        h264?.close();
        session.shutdown();
        return;
      }
      if (view.videoFailure) {
        session.shutdown();
        throw new Error(view.videoFailure);
      }
      view.kept = false;
      feature.activateRDPSession(rect, view, session);
      // Without H.264 there is no first picture to wait for.
      if (!h264) feature.scheduleRDPScaledLayout(view, current);
    } catch (error) {
      h264?.close();
      if (current()) dependencies.rdpView().setRDPMessage(rect, feature.rdpFailureMessage(error), true);
    } finally {
      if (rect.rdp === view && view.attempt === attempt) {
        view.connecting = false;
        dependencies.rdpView().updateRDPControls(rect);
      }
    }
  }

  async function runRDPSession(rect, view, session) {
    let text = "";
    let failed = false;
    // A kept session's viewer can stop while the session stays logged in on
    // the host: Detach, a dropped connection, or another viewer taking over.
    let stillOnHost = false;
    let takenOver = false;
    try {
      const info = await session.run();
      text = info?.reason?.() || "";
      stillOnHost = info?.stillOnHost === true;
      takenOver = info?.takenOver === true;
    } catch (error) {
      failed = true;
      text = feature.rdpFailureMessage(error);
    }
    if (rect.rdp !== view || view.session !== session) {
      return;
    }
    if (view.videoFailure) {
      text = view.videoFailure;
      failed = true;
      view.videoFailure = "";
    }
    platform.window.clearTimeout(view.resizeTimer);
    feature.closeRDPH264(view);
    view.session = null;
    view.kept = false;
    view.screen.hidden = true;
    dependencies.rdpView().layoutRDPCanvas(rect);
    dependencies.rdpDialogs().hideRDPDialog(rect);
    if (view.detached) {
      dependencies.rdpView().setRDPMessage(rect, `Detached. ${feature.rdpDetachedMessage}`);
    } else if (stillOnHost && !view.intentionalDisconnect) {
      dependencies.rdpView().setRDPMessage(rect, takenOver ? `Detached: ${text}. ${feature.rdpDetachedMessage}` : `Detached: the connection to Tessera dropped. Attaching again... ${feature.rdpDetachedMessage}`);
      // A connection that dropped, as when an iPad sleeps, comes back by itself.
      if (!takenOver) feature.reattachKeptRDPWhenShown(rect);
    } else if (view.intentionalDisconnect) {
      dependencies.rdpView().setRDPMessage(rect, "Disconnected.");
    } else if (failed) {
      dependencies.rdpView().setRDPMessage(rect, text, true);
    } else {
      dependencies.rdpView().setRDPMessage(rect, text ? `Disconnected: ${text}` : "Disconnected.");
    }
    view.intentionalDisconnect = false;
    view.detached = false;
    dependencies.rdpView().updateRDPControls(rect);
  }

  // Attaches a kept session's window again after its connection to the host
  // dropped, once this page can be seen, unless the window has moved on.
  function reattachKeptRDPWhenShown(rect) {
    const view = rect.rdp;
    // Returns true once there is nothing left to wait for.
    const attach = () => {
      if (rect.rdp !== view || view.session || view.connecting) return true;
      if (platform.document.visibilityState !== "visible") return false;
      void feature.autoAttachKeptRDP(rect).catch((error) => dependencies.rdpView().setRDPMessage(rect, feature.rdpFailureMessage(error), true));
      return true;
    };
    platform.window.setTimeout(() => {
      if (attach()) return;
      const onVisible = () => {
        if (attach()) platform.document.removeEventListener("visibilitychange", onVisible);
      };
      platform.document.addEventListener("visibilitychange", onVisible);
    }, feature.rdpReattachDelayMs);
  }

  // Desktop pixels per CSS pixel of what the pane shows: Resize ×2's, the
  // full-size 2x layout's once the server has laid it out, else the
  // connection's.
  function rdpDisplayRatio(rect, view) {
    if (rect.rdpScaleMode === "resize-2x" && !view.fixedSize) return rdpDoubledRatio;
    const scaled = view.scaled;
    if (scaled && view.canvas.width === scaled.width && view.canvas.height === scaled.height) {
      return scaled.ratio;
    }
    return view.pixelRatio || 1;
  }

  // Asks once per connection, a moment after the first picture shows the
  // server's display running, for the full-size 2x layout (see
  // rdpScaledLayoutDelayMs). The host does this for kept sessions.
  function scheduleRDPScaledLayout(view, current) {
    if (!view.scaled || view.scaledLaidOut) return;
    view.scaledLaidOut = true;
    platform.window.setTimeout(() => {
      if (!current() || !view.session || view.kept || !view.scaled) return;
      feature.sendRDPScaledLayout(view, view.scaled, current);
    }, rdpScaledLayoutDelayMs);
  }

  // Asks for a scaled layout and, in a session with H.264 whose pictures show
  // when the server switched, falls back to the plain layout if none shows at
  // its size (see rdpScaledLayoutWatchMs): the connection then stays plain. The
  // host does this for kept sessions.
  function sendRDPScaledLayout(view, layout, current) {
    view.scaled = layout;
    view.scaledWanted = layout;
    view.session.resize(layout.width, layout.height, layout.scale);
    const generation = ++view.scaledGeneration;
    if (view.kept || !view.h264) return;
    platform.window.setTimeout(() => {
      if (!current() || !view.session || view.scaledGeneration !== generation || view.scaledWanted !== layout) return;
      view.scaled = null;
      view.scaledWanted = null;
      view.pixelRatio = 1;
      const plain = rdpDesktopSize(view.screen.clientWidth, view.screen.clientHeight);
      view.session.resize(plain.width, plain.height);
    }, rdpScaledLayoutWatchMs);
  }

  // A picture at the watched layout's size shows the server switched.
  function noteRDPScaledPicture(view) {
    const wanted = view.scaledWanted;
    if (wanted && view.canvas.width === wanted.width && view.canvas.height === wanted.height) {
      view.scaledWanted = null;
    }
  }

  // H.264 needs the browser's decoder, which exists only over HTTPS. Checked
  // once per page.
  function rdpH264Available() {
    feature.rdpH264Support ||= rdpH264Supported();
    return feature.rdpH264Support;
  }

  function closeRDPH264(view) {
    view.h264?.close();
    view.h264 = null;
    view.h264Drawn = false;
    view.h264FullColor = false;
  }

  // IronRDP rejects with an IronError object rather than an Error.
  function rdpFailureMessage(error) {
    if (typeof error?.kind === "function") {
      const detail = String(error.backtrace?.() || "").split("\n")[0].slice(0, 200);
      return rdpErrorMessage(error.kind(), error.rdcleanpathDetails?.(), detail);
    }
    return error?.message || "Could not connect to the RDP server.";
  }

  function setRDPCursor(view, kind, data, hotspotX, hotspotY) {
    if (kind === "hidden") {
      view.canvas.style.cursor = "none";
    } else if (kind === "url" && data && hotspotX !== undefined && hotspotY !== undefined) {
      view.canvas.style.cursor = `url(${data}) ${Math.round(hotspotX)} ${Math.round(hotspotY)}, default`;
    } else {
      view.canvas.style.cursor = "default";
    }
  }

  function initializeRdpModulePromise() {
    feature.rdpModulePromise = null;
  }

  function initializeRdpController() {
    feature.rdpController = new RDPController({
      fetch: (...args) => platform.fetch(...args),
      context: () => ({ user: dependencies.navigation().currentUser, workspaceID: dependencies.navigation().workspaceID }),
      hideDialog: dependencies.rdpDialogs().hideRDPDialog, message: dependencies.rdpView().setRDPMessage, controls: dependencies.rdpView().updateRDPControls,
      cancelPointer: dependencies.rdpView().cancelRDPPointerMove, closeVideo: feature.closeRDPH264, timers: platform.window,
    });
  }

  function initializeRdpPaneKind() {
    feature.rdpPaneKind = "rdp";
  }

  function initializeRdpDetachedMessage() {
    feature.rdpDetachedMessage = "The session is still logged in and connected on the Tessera host; Connect attaches again.";
    // How long a dropped kept-session viewer waits before attaching again, so a
    // host that is restarting or a network that is coming back has a moment.
    feature.rdpReattachDelayMs = 2000;
    feature.rdpH264Support = null;
  }

  Object.assign(feature, {
    loadRDPModule,
    rdpConnectionIsCurrent,
    rdpProxyRequest,
    rdpKeptState,
    endKeptRDP,
    activateRDPSession,
    attachKeptRDP,
    resumeKeptRDP,
    autoAttachKeptRDP,
    connectRDPPane,
    runRDPSession,
    reattachKeptRDPWhenShown,
    rdpDisplayRatio,
    scheduleRDPScaledLayout,
    sendRDPScaledLayout,
    noteRDPScaledPicture,
    rdpH264Available,
    closeRDPH264,
    rdpFailureMessage,
    setRDPCursor,
    initializeRdpModulePromise,
    initializeRdpController,
    initializeRdpPaneKind,
    initializeRdpDetachedMessage,
  });
  return feature;
}
