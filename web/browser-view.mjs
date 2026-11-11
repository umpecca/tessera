import { normalizeBrowserAddress } from "./browser-pane.mjs";
import { BrowserController } from "./browser-controller.mjs";

// Browser pane mounting, frame event routing and proxy composition.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   connectivity: () => ReturnType<typeof import("./server-connectivity.mjs").createConnectivity>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   help: () => ReturnType<typeof import("./help-dialog.mjs").createHelp>,
 *   interactions: () => ReturnType<typeof import("./desktop-interactions.mjs").createInteractions>,
 *   switcher: () => ReturnType<typeof import("./window-switcher-view.mjs").createSwitcher>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createBrowser(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    browserController: undefined,
    browserPaneKind: undefined,
    browserPaneRelayedKeys: undefined,
  };

  function mountBrowserPane(rect) {
    rect.body.classList.add("is-browser");
    const pane = platform.document.createElement("div");
    pane.className = "browser-pane";
    const toolbar = platform.document.createElement("div");
    toolbar.className = "browser-toolbar";
    const back = feature.browserToolbarButton("\u2190", "Back");
    const forward = feature.browserToolbarButton("\u2192", "Forward");
    const reload = feature.browserToolbarButton("\u21bb", "Reload");
    const address = platform.document.createElement("input");
    address.className = "browser-address";
    address.type = "text";
    address.placeholder = "localhost:8080";
    address.value = rect.browserUrl;
    address.spellcheck = false;
    address.setAttribute("aria-label", "Browser address");
    const localPortHelp = feature.browserNetworkHelpButton();
    const openExternal = feature.browserToolbarButton("\u2197", "Open externally");
    const clearSiteData = feature.browserToolbarButton("\u232b", "Clear site data: this development server's localStorage and cookies, and this window's sessionStorage, which Tessera keeps for it");
    const message = platform.document.createElement("div");
    message.className = "browser-message";
    message.textContent = rect.browserUrl ? "Connecting..." : "Enter a loopback development-server address.";
    const frame = platform.document.createElement("iframe");
    frame.className = "browser-frame";
    frame.title = rect.title;
    frame.hidden = true;
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-downloads");
    // Gamepads are allowed only same-origin unless delegated, and the sandbox
    // makes the page's origin opaque, so a plain "gamepad" (the src origin)
    // can't be relied on to match: "*" grants it to the page and its frames.
    frame.setAttribute("allow", "gamepad *");
    frame.setAttribute("referrerpolicy", "no-referrer");

    rect.browser = { pane, address, frame, message, sessionID: "" };
    back.addEventListener("click", () => frame.contentWindow?.postMessage("tessera-browser-back", "*"));
    forward.addEventListener("click", () => frame.contentWindow?.postMessage("tessera-browser-forward", "*"));
    reload.addEventListener("click", () => {
      if (rect.browser?.sessionID) {
        frame.contentWindow?.postMessage("tessera-browser-reload", "*");
      } else if (rect.browserUrl) {
        void feature.navigateBrowserPane(rect, rect.browserUrl);
      }
    });
    localPortHelp.addEventListener("click", () => dependencies.help().openBrowserPortHelp(rect));
    clearSiteData.addEventListener("click", () => void feature.clearBrowserSiteData(rect));
    openExternal.addEventListener("click", () => {
      if (rect.browserUrl) {
        platform.window.open(rect.browserUrl, "_blank", "noopener,noreferrer");
      }
    });
    address.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void feature.navigateBrowserPane(rect, address.value);
      }
    });

    toolbar.append(back, forward, reload, address, localPortHelp, clearSiteData, openExternal);
    pane.append(toolbar, message, frame);
    rect.body.appendChild(pane);
    if (rect.browserUrl) {
      void feature.navigateBrowserPane(rect, rect.browserUrl);
    }
  }

  function browserToolbarButton(label, title) {
    const button = platform.document.createElement("button");
    button.type = "button";
    button.className = "browser-toolbar-button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    return button;
  }

  function browserNetworkHelpButton() {
    const button = feature.browserToolbarButton("", "Browse local port help");
    button.classList.add("browser-toolbar-icon");
    const svg = platform.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const links = platform.document.createElementNS("http://www.w3.org/2000/svg", "path");
    links.setAttribute("d", "M12 12 5 5m7 7 7-7m-7 7v7");
    links.setAttribute("fill", "none");
    links.setAttribute("stroke", "currentColor");
    links.setAttribute("stroke-width", "1.8");
    links.setAttribute("stroke-linecap", "round");
    for (const [cx, cy] of [[5, 5], [19, 5], [12, 12], [12, 19]]) {
      const node = platform.document.createElementNS("http://www.w3.org/2000/svg", "circle");
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
    return feature.browserController.navigate(rect, value);
  }

  function handleBrowserPaneMessage(event) {
    if (event.data?.type === "tessera-browser-draw") {
      feature.handleBrowserPaneDraw(event);
      return;
    }
    if (event.data?.type === "tessera-browser-key") {
      feature.handleBrowserPaneShortcut(event);
      return;
    }
    if (event.data?.type === "tessera-browser-keyup") {
      if (feature.browserPaneHoldingWindow(event.source)) {
        dependencies.switcher().handleWindowSwitcherKeyup({ key: event.data.key });
      }
      return;
    }
    if (event.data?.type === "tessera-browser-escape") {
      feature.handleBrowserPaneEscape(event);
      return;
    }
    if (event.data?.type !== "tessera-browser-location" || typeof event.data.url !== "string") {
      return;
    }
    const rect = dependencies.desktop().rectangles.find((candidate) => candidate.kind === feature.browserPaneKind && candidate.browser?.frame.contentWindow === event.source);
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
    dependencies.workspace().scheduleWorkspaceSave();
  }

  // A proxied page that navigates its frame to one of Tessera's own paths, such
  // as location.href = "/", lands on the server's escape page, which reports the
  // path so the frame can go back through the pane's proxy session instead.
  function handleBrowserPaneEscape(event) {
    const path = event.data.path;
    if (typeof path !== "string" || !path.startsWith("/")) return;
    const rect = dependencies.desktop().rectangles.find(candidate => candidate.kind === feature.browserPaneKind && candidate.browser?.frame.contentWindow === event.source);
    if (!rect?.browser.sessionID) return;
    // Replace the escape page so Back returns to the page that navigated.
    event.source.location.replace(`/browser-proxy/${encodeURIComponent(rect.browser.sessionID)}${path}`);
  }

  function handleBrowserPaneDraw(event) {
    const data = event.data;
    const rect = dependencies.desktop().rectangles.find(candidate => candidate.kind === feature.browserPaneKind && candidate.browser?.frame.contentWindow === event.source);
    if (!rect || rect.minimized || rect.browser.frame.hidden || !dependencies.connectivity().serverConnectionModal.hidden) return;
    if (!Number.isInteger(data.pointerId) || data.pointerId < 0 || !Number.isFinite(data.clientX) || !Number.isFinite(data.clientY)) return;
    const frame = rect.browser.frame, bounds = frame.getBoundingClientRect();
    const width = frame.clientWidth, height = frame.clientHeight;
    if (!width || !height) return;
    const pointer = {
      pointerId: data.pointerId, button: 1, target: dependencies.desktop().board, shiftKey: data.shiftKey === true,
      clientX: bounds.left + data.clientX * bounds.width / width,
      clientY: bounds.top + data.clientY * bounds.height / height,
      preventDefault() {}, stopPropagation() {},
    };
    if (data.phase === "start") {
      if (dependencies.interactions().interaction || data.clientX < 0 || data.clientX > width || data.clientY < 0 || data.clientY > height) return;
      // The iframe owns native pointer capture and relays the whole drag.
      dependencies.interactions().startDrawing(pointer, { capture: false });
      dependencies.interactions().interaction.browserFrame = frame;
    } else if (dependencies.interactions().interaction?.type === "draw" && dependencies.interactions().interaction.browserFrame === frame && dependencies.interactions().interaction.id === data.pointerId) {
      if (data.phase === "move") dependencies.interactions().continueInteraction(pointer);
      else if (data.phase === "end" || data.phase === "cancel") {
        dependencies.interactions().finishInteraction({ ...pointer, type: data.phase === "cancel" ? "pointercancel" : "pointerup" });
      }
    }
  }

  // The pane whose frame holds source, at any depth: a page's own frames relay
  // keys straight to this window. parent is readable across origins, and a
  // window that is its own parent is a top.
  function browserPaneHoldingWindow(source) {
    for (let win = source, depth = 0; win && depth < 32; depth++) {
      const rect = dependencies.desktop().rectangles.find((candidate) => candidate.kind === feature.browserPaneKind && candidate.browser?.frame.contentWindow === win);
      if (rect) return rect;
      if (win.parent === win) return null;
      win = win.parent;
    }
    return null;
  }

  // Keystrokes typed while a browser pane's iframe holds focus never reach this
  // document, so the proxy bootstrap relays the window-management ones here.
  function handleBrowserPaneShortcut(event) {
    if (!dependencies.connectivity().serverConnectionModal.hidden) {
      return;
    }
    const keys = event.data;
    const rect = feature.browserPaneHoldingWindow(event.source);
    if (!rect) {
      return;
    }
    // Page content can post anything, so only the non-destructive window
    // shortcuts are honored from an iframe.
    if (!feature.browserPaneRelayedKeys.has(keys.key) && !feature.browserPaneRelayedKeys.has(keys.code)) {
      return;
    }
    const shortcut = dependencies.interactions().paneShortcutAction(keys);
    if (!shortcut) {
      return;
    }
    // The iframe swallowed the click that focused it, so make sure the shortcut
    // acts on the pane the keystroke actually came from.
    if (dependencies.desktop().getActivePane() !== rect) {
      dependencies.desktop().setActivePane(rect, { raise: false });
    }
    shortcut.run();
  }

  function disposeBrowserPane(rect) {
    feature.browserController.dispose(rect);
  }

  // Clears what Tessera keeps for the pane's development server (task 242) and
  // reloads the page without it.
  async function clearBrowserSiteData(rect) {
    return feature.browserController.clearSiteData(rect);
  }

  function initializeBrowserController() {
    feature.browserController = new BrowserController({
      window: platform.window,
      fetch: (...args) => platform.fetch(...args),
      containsPane: rect => dependencies.desktop().rectangles.includes(rect),
      changed: dependencies.workspace().scheduleWorkspaceSave,
      beforeDispose: rect => {
        if (dependencies.interactions().interaction?.type === "draw" && dependencies.interactions().interaction.browserFrame === rect.browser.frame) {
          dependencies.interactions().finishInteraction({ pointerId: dependencies.interactions().interaction.id, type: "pointercancel" });
        }
      },
    });
  }

  function initializeBrowserPaneKind() {
    feature.browserPaneKind = "browser";
    // Window-management keystrokes a browser pane's iframe may relay to the app.
    feature.browserPaneRelayedKeys = new Set(["[", "]", "BracketLeft", "BracketRight", "k", "K", "l", "L", ";", "Semicolon", "F7", "F9", "F10", "ArrowUp", "ArrowDown"]);
  }

  Object.assign(feature, {
    mountBrowserPane,
    browserToolbarButton,
    browserNetworkHelpButton,
    navigateBrowserPane,
    handleBrowserPaneMessage,
    handleBrowserPaneEscape,
    handleBrowserPaneDraw,
    browserPaneHoldingWindow,
    handleBrowserPaneShortcut,
    disposeBrowserPane,
    clearBrowserSiteData,
    initializeBrowserController,
    initializeBrowserPaneKind,
  });
  return feature;
}
