import { normalizeVNCScaleMode, vncCredentialFields } from "./vnc-pane.mjs";
import { VNCController } from "./vnc-controller.mjs";

// VNC pane mounting, credential/verification dialogs and controller composition.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   browser: () => ReturnType<typeof import("./browser-view.mjs").createBrowser>,
 *   clipboard: () => ReturnType<typeof import("./clipboard-access.mjs").createClipboard>,
 *   desktop: () => ReturnType<typeof import("./desktop-panes.mjs").createDesktop>,
 *   navigation: () => ReturnType<typeof import("./session-navigation.mjs").createNavigation>,
 *   rdpDialogs: () => ReturnType<typeof import("./rdp-dialogs.mjs").createRdpDialogs>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createVnc(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    vncController: undefined,
    vncPaneKind: undefined,
  };

  function mountVNCPane(rect) {
    rect.body.classList.add("is-vnc");
    const pane = platform.document.createElement("div");
    pane.className = "vnc-pane";
    const toolbar = platform.document.createElement("div");
    toolbar.className = "vnc-toolbar";
    const address = platform.document.createElement("input");
    address.className = "vnc-address";
    address.type = "text";
    address.placeholder = "host:5900";
    address.value = rect.vncTarget;
    address.spellcheck = false;
    address.setAttribute("aria-label", "VNC target");
    const connect = dependencies.browser().browserToolbarButton("Connect", "Connect or disconnect VNC");
    connect.classList.add("vnc-connect");
    const ctrlAltDelete = dependencies.browser().browserToolbarButton("CAD", "Send Ctrl+Alt+Del");
    const scale = platform.document.createElement("select");
    scale.className = "vnc-select";
    scale.setAttribute("aria-label", "VNC scaling");
    for (const [value, label] of [["fit", "Fit"], ["one-to-one", "1:1"]]) {
      const option = platform.document.createElement("option");
      option.value = value;
      option.textContent = label;
      scale.appendChild(option);
    }
    scale.value = rect.vncScaleMode;
    const viewOnlyLabel = platform.document.createElement("label");
    viewOnlyLabel.className = "vnc-toggle";
    const viewOnly = platform.document.createElement("input");
    viewOnly.type = "checkbox";
    viewOnly.checked = rect.vncViewOnly;
    viewOnlyLabel.append(viewOnly, "View only");
    const sendClipboard = dependencies.browser().browserToolbarButton("↑", "Send local clipboard to remote");
    const copyClipboard = dependencies.browser().browserToolbarButton("↓", "Copy remote clipboard locally");
    const message = platform.document.createElement("div");
    message.className = "vnc-message";
    message.textContent = rect.vncTarget ? "Ready to connect." : "Enter a VNC server address.";
    const screen = platform.document.createElement("div");
    screen.className = "vnc-screen";
    screen.tabIndex = 0;
    screen.hidden = true;
    const dialog = platform.document.createElement("form");
    dialog.className = "vnc-dialog";
    dialog.hidden = true;
    dialog.addEventListener("keydown", (event) => dependencies.rdpDialogs().cyclePaneDialogFocus(dialog, event));

    rect.vnc = {
      pane, address, connect, ctrlAltDelete, scale, viewOnly, sendClipboard, copyClipboard,
      message, screen, dialog, rfb: null, credentials: {}, remoteClipboard: "", intentionalDisconnect: false,
    };
    toolbar.append(address, connect, ctrlAltDelete, scale, viewOnlyLabel, sendClipboard, copyClipboard);
    pane.append(toolbar, message, screen, dialog);
    rect.body.appendChild(pane);
    feature.updateVNCControls(rect);

    address.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void feature.connectVNCPane(rect);
      }
    });
    address.addEventListener("input", () => {
      rect.vncTarget = address.value;
      if (rect.vncStatusInput) {
        rect.vncStatusInput.value = rect.vncTarget;
      }
      dependencies.workspace().scheduleWorkspaceSave();
    });
    connect.addEventListener("click", () => {
      if (rect.vnc?.rfb) {
        feature.disconnectVNCPane(rect);
      } else {
        void feature.connectVNCPane(rect);
      }
    });
    ctrlAltDelete.addEventListener("click", () => rect.vnc?.rfb?.sendCtrlAltDel());
    scale.addEventListener("change", () => {
      rect.vncScaleMode = normalizeVNCScaleMode(scale.value);
      feature.applyVNCPreferences(rect);
      dependencies.workspace().scheduleWorkspaceSave();
    });
    viewOnly.addEventListener("change", () => {
      rect.vncViewOnly = viewOnly.checked;
      feature.applyVNCPreferences(rect);
      dependencies.workspace().scheduleWorkspaceSave();
    });
    sendClipboard.addEventListener("click", () => void feature.sendVNCClipboard(rect));
    copyClipboard.addEventListener("click", () => void feature.copyVNCClipboard(rect));
  }

  function updateVNCControls(rect) {
    feature.vncController.controls(rect);
  }

  function applyVNCPreferences(rect) {
    feature.vncController.preferences(rect);
  }

  async function connectVNCPane(rect) {
    return feature.vncController.connect(rect);
  }

  function showVNCCredentials(rect, rfb, requestedTypes) {
    const view = rect.vnc;
    if (!view || view.rfb !== rfb) return;
    const fields = vncCredentialFields(requestedTypes);
    view.dialog.replaceChildren();
    const title = platform.document.createElement("strong");
    title.textContent = "Credentials required";
    view.dialog.appendChild(title);
    const inputs = {};
    for (const type of fields) {
      const input = platform.document.createElement("input");
      input.type = type === "password" ? "password" : "text";
      input.placeholder = type === "target" ? "Target or session" : type[0].toUpperCase() + type.slice(1);
      input.autocomplete = type === "password" ? "current-password" : "off";
      input.setAttribute("aria-label", input.placeholder);
      input.value = view.credentials[type] || "";
      inputs[type] = input;
      view.dialog.appendChild(input);
    }
    const submit = platform.document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Continue";
    const cancel = platform.document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => feature.disconnectVNCPane(rect));
    view.dialog.append(submit, cancel);
    view.dialog.onsubmit = (event) => {
      event.preventDefault();
      for (const [type, input] of Object.entries(inputs)) view.credentials[type] = input.value;
      feature.hideVNCDialog(rect);
      rfb.sendCredentials({ ...view.credentials });
    };
    view.dialog.hidden = false;
    inputs[fields[0]]?.focus();
  }

  async function showVNCVerification(rect, rfb, details) {
    const view = rect.vnc;
    if (!view || view.rfb !== rfb) return;
    let identity = details?.type || "unknown type";
    if (details?.publickey instanceof Uint8Array && platform.crypto.subtle) {
      const digest = new Uint8Array(await platform.crypto.subtle.digest("SHA-256", details.publickey));
      identity += ` SHA-256 ${[...digest].map((value) => value.toString(16).padStart(2, "0")).join(":")}`;
    }
    if (!rect.vnc || view.rfb !== rfb) return;
    view.dialog.replaceChildren();
    const message = platform.document.createElement("span");
    message.textContent = `Verify this VNC server identity before continuing: ${identity}`;
    const approve = platform.document.createElement("button");
    approve.type = "button";
    approve.textContent = "Trust once";
    approve.addEventListener("click", () => {
      feature.hideVNCDialog(rect);
      rfb.approveServer();
    });
    const cancel = platform.document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => feature.disconnectVNCPane(rect));
    view.dialog.append(message, approve, cancel);
    view.dialog.hidden = false;
    approve.focus();
  }

  function showVNCClipboardEntry(rect) {
    const view = rect.vnc;
    if (!view?.rfb) return;
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
    cancel.addEventListener("click", () => feature.hideVNCDialog(rect));
    view.dialog.append(field, send, cancel);
    view.dialog.onsubmit = (event) => {
      event.preventDefault();
      view.rfb?.clipboardPasteFrom(field.value);
      feature.hideVNCDialog(rect);
      view.rfb?.focus({ preventScroll: true });
    };
    view.dialog.hidden = false;
    field.focus();
  }

  function hideVNCDialog(rect) {
    if (!rect.vnc) return;
    rect.vnc.dialog.hidden = true;
    rect.vnc.dialog.onsubmit = null;
    rect.vnc.dialog.replaceChildren();
  }

  async function sendVNCClipboard(rect) {
    return feature.vncController.sendClipboard(rect);
  }

  async function copyVNCClipboard(rect) {
    return feature.vncController.copyClipboard(rect);
  }

  function disconnectVNCPane(rect) {
    feature.vncController.disconnect(rect);
  }

  function disposeVNCPane(rect) {
    feature.vncController.dispose(rect);
  }

  function initializeVncController() {
    feature.vncController = new VNCController({
      location: platform.window.location,
      fetch: (...args) => platform.fetch(...args),
      workspaceID: () => dependencies.navigation().workspaceID,
      containsPane: rect => dependencies.desktop().rectangles.includes(rect),
      changed: dependencies.workspace().scheduleWorkspaceSave,
      hideDialog: feature.hideVNCDialog,
      credentials: feature.showVNCCredentials,
      verify: feature.showVNCVerification,
      clipboardEntry: feature.showVNCClipboardEntry,
      readClipboard: async () => {
        const text = await dependencies.clipboard().readClipboardText();
        if (dependencies.clipboard().clipboardReadFellBack) throw new Error("clipboard unavailable");
        return text;
      },
      writeClipboard: dependencies.clipboard().writeClipboardText,
      setStatus: dependencies.workspace().setWorkspaceStatus,
    });
  }

  function initializeVncPaneKind() {
    feature.vncPaneKind = "vnc";
  }

  Object.assign(feature, {
    mountVNCPane,
    updateVNCControls,
    applyVNCPreferences,
    connectVNCPane,
    showVNCCredentials,
    showVNCVerification,
    showVNCClipboardEntry,
    hideVNCDialog,
    sendVNCClipboard,
    copyVNCClipboard,
    disconnectVNCPane,
    disposeVNCPane,
    initializeVncController,
    initializeVncPaneKind,
  });
  return feature;
}
