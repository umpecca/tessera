import { formatRDPFingerprint, normalizeRDPResolution, rdpResolutions, splitRDPTarget, readRDPSharpPreference, saveRDPSharpPreference } from "./rdp-pane.mjs";
import { readRDPFullColorPreference, saveRDPFullColorPreference } from "./rdp-h264.mjs";
import { rdpKeepLabelText, readRDPKeepPreference, saveRDPKeepPreference } from "./rdp-kept.mjs";

// RDP certificate/credential prompts and cancellable pane dialogs.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   rdpView: () => ReturnType<typeof import("./rdp-view.mjs").createRdpView>,
 *   workspace: () => ReturnType<typeof import("./workspace-lifecycle.mjs").createWorkspace>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createRdpDialogs(dependencies, platform = globalThis) {
  const feature = {};

  function confirmRDPCertificate(rect, certificate, trust) {
    const view = rect.rdp;
    view.dialog.replaceChildren();
    const title = platform.document.createElement("strong");
    title.textContent = trust === "changed"
      ? "Warning: this RDP server's certificate has changed"
      : "Verify this RDP server's certificate";
    const note = platform.document.createElement("span");
    note.textContent = trust === "changed"
      ? "The server presented a different certificate from the one you trusted. Continue only if you know why it changed."
      : "Check the fingerprint against the server before sending your password.";
    note.textContent += " Acceptance is remembered for your Tessera user and this host/port across windows and devices.";
    const details = platform.document.createElement("dl");
    details.className = "rdp-certificate";
    for (const [label, value] of [
      ["Target", certificate.target],
      ["Subject", certificate.subject],
      ["Issuer", certificate.issuer],
      ["Expires", certificate.notAfter],
      ["SHA-256", formatRDPFingerprint(certificate.fingerprint)],
    ]) {
      const term = platform.document.createElement("dt");
      term.textContent = label;
      const definition = platform.document.createElement("dd");
      definition.textContent = value || "—";
      details.append(term, definition);
    }
    const approve = platform.document.createElement("button");
    approve.type = "submit";
    approve.textContent = trust === "changed" ? "Trust the new certificate" : "Trust and continue";
    const cancel = platform.document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    view.dialog.append(title, note, details, approve, cancel);
    return feature.showRDPDialog(rect, cancel, () => true, false, trust === "changed" ? cancel : approve);
  }

  // Asks for the sign-in. With options.keep the dialog offers to keep the session
  // on the Tessera host; with options.rejoin it asks only for the password, to
  // rejoin a session the host kept after its connection to the server dropped.
  function askRDPCredentials(rect, options = {}) {
    const view = rect.rdp;
    view.dialog.replaceChildren();
    const title = platform.document.createElement("strong");
    title.textContent = options.rejoin ? "Rejoin RDP session" : "Sign in to RDP server";
    // The server, for reading; it is changed in the toolbar's address field.
    const server = splitRDPTarget(rect.rdpTarget);
    const details = platform.document.createElement("dl");
    details.className = "rdp-certificate";
    for (const [label, value] of [["Address", server.host], ["Port", server.port]]) {
      const term = platform.document.createElement("dt");
      term.textContent = label;
      const definition = platform.document.createElement("dd");
      definition.textContent = value || "—";
      details.append(term, definition);
    }
    // Names and autocomplete tokens let the browser's password manager fill and
    // save the login.
    const username = platform.document.createElement("input");
    username.type = "text";
    username.name = "username";
    username.id = `rdp-${rect.id}-username`;
    username.placeholder = "User name";
    username.autocomplete = "username";
    username.value = rect.rdpUsername;
    const domain = platform.document.createElement("input");
    domain.type = "text";
    domain.placeholder = "Domain (optional)";
    domain.autocomplete = "off";
    domain.value = rect.rdpDomain;
    const password = platform.document.createElement("input");
    password.type = "password";
    password.name = "password";
    password.id = `rdp-${rect.id}-password`;
    password.placeholder = "Password";
    password.autocomplete = "current-password";
    for (const input of [username, domain, password]) {
      input.spellcheck = false;
      input.setAttribute("aria-label", input.placeholder);
    }
    if (options.rejoin) {
      const note = platform.document.createElement("span");
      note.textContent = "The connection to the server was lost. Enter your password to rejoin the same session.";
      // The account, unseen, so a password manager knows whose password this is.
      username.hidden = true;
      username.tabIndex = -1;
      view.dialog.append(title, details, note, username, password);
    } else {
      view.dialog.append(title, details, username, domain, password);
    }
    let keep = null;
    const storage = dependencies.rdpView().rdpPreferenceStorage();
    if (options.keep && !options.rejoin) {
      const keepLabel = platform.document.createElement("label");
      keepLabel.className = "rdp-keep";
      keep = platform.document.createElement("input");
      keep.type = "checkbox";
      keep.checked = readRDPKeepPreference(storage);
      keepLabel.append(keep, platform.document.createTextNode(rdpKeepLabelText(options.idleLimitSeconds)));
      view.dialog.appendChild(keepLabel);
    }
    let resolution = null;
    if (!options.rejoin) {
      const resolutionLabel = platform.document.createElement("label");
      resolutionLabel.className = "rdp-resolution";
      resolutionLabel.title = "The remote desktop's size. This window's size follows the window when it is resized in Resize mode; a fixed size stays as chosen and is fitted to the window or shown 1:1. Remembered for this window.";
      resolution = platform.document.createElement("select");
      resolution.className = "rdp-select";
      const choices = rdpResolutions.includes(rect.rdpResolution) || !rect.rdpResolution ? rdpResolutions : [...rdpResolutions, rect.rdpResolution];
      for (const value of ["", ...choices]) {
        const option = platform.document.createElement("option");
        option.value = value;
        option.textContent = value ? value.replace("x", " × ") : "This window's size";
        resolution.appendChild(option);
      }
      resolution.value = rect.rdpResolution;
      resolutionLabel.append(platform.document.createTextNode("Resolution"), resolution);
      view.dialog.appendChild(resolutionLabel);
    }
    let sharp = null;
    let fullSize = null;
    let sharpLabel = null;
    if (options.sharp && !options.rejoin) {
      sharpLabel = platform.document.createElement("label");
      sharpLabel.className = "rdp-keep";
      sharpLabel.title = "Ask for the desktop at this screen's full resolution, so text is crisp on a Retina screen. The remote desktop's text and windows look smaller, with more room. Sends about four times the pixels: leave it off on slow connections.";
      sharp = platform.document.createElement("input");
      sharp.type = "checkbox";
      sharp.checked = readRDPSharpPreference(storage);
      sharpLabel.append(sharp, platform.document.createTextNode("Sharp on this high-resolution screen (more bandwidth)"));
      view.dialog.appendChild(sharpLabel);
      // Remembered for this window, since it is about the server.
      const fullSizeLabel = platform.document.createElement("label");
      fullSizeLabel.className = "rdp-keep rdp-keep-sub";
      fullSizeLabel.title = "Without this, sharp mode shows the remote desktop at this screen's own resolution, with its text and windows smaller. With it, Remotr lays out a Retina (2×) desktop so they keep their size. Remotr does this only up to 1920 pixels wide, 1920×1200 pixels in all, and no wider than 16:9, so a larger or wider window gets the largest desktop within those limits, enlarged a little. Remotr shows its Connecting screen for a moment after connecting while it switches; if it doesn't come back within 5 seconds, the connection returns to the usual size. Remembered for this window.";
      fullSize = platform.document.createElement("input");
      fullSize.type = "checkbox";
      fullSize.checked = rect.rdpFullSize;
      fullSizeLabel.append(fullSize, platform.document.createTextNode("Keep the remote text full size (Remotr Retina mode)"));
      // Sharp mode sizes the desktop from the window, so a fixed size or
      // Resize ×2 hides it.
      const syncSharp = () => {
        sharpLabel.hidden = Boolean(resolution?.value) || rect.rdpScaleMode === "resize-2x";
        fullSizeLabel.hidden = sharpLabel.hidden || !sharp.checked;
      };
      syncSharp();
      sharp.addEventListener("change", syncSharp);
      resolution?.addEventListener("change", syncSharp);
      view.dialog.appendChild(fullSizeLabel);
    }
    // Full color applies to how this browser shows H.264, so it is offered
    // only when H.264 is.
    let fullColor = null;
    if (options.h264 && !options.rejoin) {
      const fullColorLabel = platform.document.createElement("label");
      fullColorLabel.className = "rdp-keep";
      fullColorLabel.title = "When the server sends H.264 4:4:4 (AVC444), combine it into full color for sharper colored text. Uses more of this device's graphics processor.";
      fullColor = platform.document.createElement("input");
      fullColor.type = "checkbox";
      fullColor.checked = readRDPFullColorPreference(storage);
      fullColorLabel.append(fullColor, platform.document.createTextNode("Full color (4:4:4) when the server sends it"));
      view.dialog.appendChild(fullColorLabel);
    }
    if (!dependencies.rdpView().rdpTransportIsPrivate(platform.window.location)) {
      const warning = platform.document.createElement("span");
      warning.className = "rdp-warning";
      warning.textContent = "This page is not served over HTTPS, so the remote desktop session crosses the network between this browser and Tessera unencrypted.";
      view.dialog.appendChild(warning);
    }
    const submit = platform.document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Connect";
    const cancel = platform.document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    view.dialog.append(submit, cancel);
    const read = () => {
      const credentials = {
        username: username.value.trim(),
        domain: domain.value.trim(),
        password: password.value,
        keep: Boolean(keep?.checked),
        fullColor: fullColor ? fullColor.checked : readRDPFullColorPreference(storage),
        resolution: resolution ? normalizeRDPResolution(resolution.value) : "",
        sharp: sharp ? sharp.checked : false,
        fullSize: Boolean(sharp?.checked && fullSize?.checked),
      };
      if (resolution && rect.rdpResolution !== credentials.resolution) {
        rect.rdpResolution = credentials.resolution;
        dependencies.workspace().scheduleWorkspaceSave();
      }
      if (keep) saveRDPKeepPreference(storage, keep.checked);
      if (fullColor) saveRDPFullColorPreference(storage, fullColor.checked);
      if (sharp) saveRDPSharpPreference(storage, sharp.checked);
      if (sharp?.checked && fullSize && rect.rdpFullSize !== fullSize.checked) {
        rect.rdpFullSize = fullSize.checked;
        dependencies.workspace().scheduleWorkspaceSave();
      }
      password.value = "";
      return credentials;
    };
    return feature.showRDPDialog(rect, cancel, read, null, username.value || options.rejoin ? password : username);
  }

  // Moves Tab and Shift+Tab through every control of a VNC or RDP pane's
  // dialog, wrapping around inside it. Browsers would otherwise leave the
  // dialog for the toolbar behind it, and Safari by default moves only between
  // text fields.
  function cyclePaneDialogFocus(dialog, event) {
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const controls = [...dialog.querySelectorAll("input, select, textarea, button")]
      .filter((control) => !control.disabled && control.type !== "hidden" && control.getClientRects().length > 0);
    if (!controls.length) return;
    const current = controls.indexOf(platform.document.activeElement);
    const next = event.shiftKey
      ? (current <= 0 ? controls.length - 1 : current - 1)
      : (current + 1) % controls.length;
    event.preventDefault();
    event.stopPropagation();
    controls[next].focus();
  }

  // Resolves with onSubmit()'s value, or cancelValue when the dialog is
  // cancelled or replaced.
  function showRDPDialog(rect, cancel, onSubmit, cancelValue, focus) {
    const view = rect.rdp;
    return new Promise((resolve) => {
      view.dialogResolve = () => resolve(cancelValue);
      cancel.addEventListener("click", () => feature.hideRDPDialog(rect));
      view.dialog.onsubmit = (event) => {
        event.preventDefault();
        const value = onSubmit();
        view.dialogResolve = null;
        feature.hideRDPDialog(rect);
        resolve(value);
      };
      view.dialog.hidden = false;
      focus?.focus();
    });
  }

  function hideRDPDialog(rect) {
    const view = rect.rdp;
    if (!view) return;
    view.dialog.hidden = true;
    view.dialog.onsubmit = null;
    view.dialog.replaceChildren();
    const resolve = view.dialogResolve;
    view.dialogResolve = null;
    resolve?.();
  }

  Object.assign(feature, {
    confirmRDPCertificate,
    askRDPCredentials,
    cyclePaneDialogFocus,
    showRDPDialog,
    hideRDPDialog,
  });
  return feature;
}
