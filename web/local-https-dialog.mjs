import { localHTTPSConfigWithCurrentHostname, localHTTPSDraft, localHTTPSNextURL, validateLocalHTTPSDraft } from "./local-https-settings.mjs";
import { shouldShowIPadHTTPGuidance } from "./ipad-http-guidance.mjs";

// Local HTTPS configuration UI and iPad HTTP guidance.
// State is owned here. Dependencies are lazy feature providers, so construction
// has no DOM/network effects and the composition root can link cyclic UI actions.
/**
 * @param {{
 *   deskbar: () => ReturnType<typeof import("./deskbar.mjs").createDeskbar>,
 * }} dependencies
 * @param {typeof globalThis} [platform] Browser capabilities; injectable for tests.
 */
export function createHttps(dependencies, platform = globalThis) {
  // Initialize fields in the explicit startup phases below; factories are inert.
  const feature = {
    ipadHTTPGuidanceDismissedKey: undefined,
    localHTTPSModal: undefined,
  };

  async function openLocalHTTPSModal() {
    dependencies.deskbar().hideDeskbar();
    feature.localHTTPSModal.hidden = false;
    feature.localHTTPSModal.replaceChildren();
    const loading = platform.document.createElement("section");
    loading.className = "settings-panel local-https-panel";
    loading.textContent = "Loading Local HTTPS settings...";
    feature.localHTTPSModal.appendChild(loading);
    try {
      const response = await platform.fetch("/api/host/https", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      body.config = localHTTPSConfigWithCurrentHostname(body.config, platform.window.location.hostname);
      feature.renderLocalHTTPSModal(body);
    } catch (error) {
      feature.renderLocalHTTPSError(error.message || String(error));
    }
  }

  function hideLocalHTTPSModal() {
    feature.localHTTPSModal.hidden = true;
    feature.localHTTPSModal.replaceChildren();
  }

  function showIPadHTTPGuidanceIfNeeded() {
    let dismissed = false;
    try {
      dismissed = platform.window.localStorage.getItem(feature.ipadHTTPGuidanceDismissedKey) === "true";
    } catch {
      // Show the guidance when persistent browser storage is unavailable.
    }
    const device = {
      userAgent: platform.navigator.userAgent || "",
      platform: platform.navigator.platform || "",
      maxTouchPoints: platform.navigator.maxTouchPoints || 0,
    };
    if (!shouldShowIPadHTTPGuidance({ protocol: platform.window.location.protocol, device, dismissed })) return;

    feature.localHTTPSModal.replaceChildren();
    feature.localHTTPSModal.hidden = false;
    const panel = platform.document.createElement("section");
    panel.className = "settings-panel ipad-http-info-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "ipad-http-info-title");

    const title = platform.document.createElement("h2");
    title.id = "ipad-http-info-title";
    title.textContent = "Use HTTPS for the best iPad experience";
    const explanation = platform.document.createElement("p");
    explanation.textContent = "Tessera works over HTTP, but iPadOS limits clipboard access and other browser features on connections that are not secure.";
    const recommendation = platform.document.createElement("p");
    recommendation.textContent = "Set up Tessera Local HTTPS for more reliable terminal copy and paste, and for hardware video decoding in RDP windows. HTTP will remain available on port 7331 for recovery and certificate enrollment.";

    const actions = platform.document.createElement("div");
    actions.className = "rename-window-actions";
    const continueHTTP = platform.document.createElement("button");
    continueHTTP.type = "button";
    continueHTTP.textContent = "Continue with HTTP";
    continueHTTP.addEventListener("click", () => {
      try {
        platform.window.localStorage.setItem(feature.ipadHTTPGuidanceDismissedKey, "true");
      } catch {
        // The modal still closes for this page when storage is unavailable.
      }
      feature.hideLocalHTTPSModal();
    });
    const setupHTTPS = platform.document.createElement("button");
    setupHTTPS.type = "button";
    setupHTTPS.textContent = "Set up HTTPS";
    setupHTTPS.addEventListener("click", () => void feature.openLocalHTTPSModal());
    actions.append(continueHTTP, setupHTTPS);
    panel.append(title, explanation, recommendation, actions);
    feature.localHTTPSModal.appendChild(panel);
    platform.window.requestAnimationFrame(() => setupHTTPS.focus());
  }

  function renderLocalHTTPSError(message) {
    feature.localHTTPSModal.replaceChildren();
    const panel = platform.document.createElement("section");
    panel.className = "settings-panel local-https-panel";
    const title = platform.document.createElement("h2");
    title.textContent = "Local HTTPS";
    const error = platform.document.createElement("p");
    error.className = "local-https-error";
    error.textContent = message;
    const close = platform.document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", feature.hideLocalHTTPSModal);
    panel.append(title, error, close);
    feature.localHTTPSModal.appendChild(panel);
  }

  function localHTTPSField(labelText, detailText, control) {
    const field = platform.document.createElement("label");
    field.className = "local-https-field";
    const label = platform.document.createElement("strong");
    label.textContent = labelText;
    const detail = platform.document.createElement("span");
    detail.textContent = detailText;
    field.append(label, detail, control);
    return field;
  }

  function renderLocalHTTPSModal(state, message = "") {
    feature.localHTTPSModal.replaceChildren();
    const config = state.config || {};
    const panel = platform.document.createElement("section");
    panel.className = "settings-panel local-https-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "local-https-title");

    const titleBar = platform.document.createElement("div");
    titleBar.className = "settings-title";
    const title = platform.document.createElement("h2");
    title.id = "local-https-title";
    title.textContent = "Local HTTPS";
    const close = platform.document.createElement("button");
    close.type = "button";
    close.className = "settings-close";
    close.textContent = "X";
    close.setAttribute("aria-label", "Close Local HTTPS settings");
    close.addEventListener("click", feature.hideLocalHTTPSModal);
    titleBar.append(title, close);

    const form = platform.document.createElement("form");
    form.className = "local-https-form";
    const introduction = platform.document.createElement("p");
    introduction.className = "local-https-introduction";
    introduction.textContent = "Tessera keeps the workspace available over HTTP and can also serve it over HTTPS with a private certificate authority. The root stays stable across service restarts and upgrades.";

    const enabled = platform.document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = Boolean(config.enabled);
    const enabledField = feature.localHTTPSField("Enable Local HTTPS", "HTTP remains available on the primary listener while HTTPS uses its own port.", enabled);
    enabledField.classList.add("local-https-check-field");
    const httpsAddress = platform.document.createElement("input");
    httpsAddress.type = "text";
    httpsAddress.value = config.httpsAddress || "0.0.0.0:7332";
    httpsAddress.placeholder = "0.0.0.0:7332";
    const dnsNames = platform.document.createElement("textarea");
    dnsNames.rows = 2;
    dnsNames.value = (config.dnsNames || []).join("\n");
    dnsNames.placeholder = "tessera.local";
    const ipAddresses = platform.document.createElement("textarea");
    ipAddresses.rows = 2;
    ipAddresses.value = (config.ipAddresses || []).join("\n");
    ipAddresses.placeholder = "192.168.1.50\n100.64.0.10";
    const dependent = [httpsAddress, dnsNames, ipAddresses];
    const updateDisabled = () => {
      for (const control of dependent) control.disabled = !enabled.checked;
    };
    enabled.addEventListener("change", updateDisabled);
    updateDisabled();

    form.append(
      introduction,
      enabledField,
      feature.localHTTPSField("HTTPS listener", "Separate TLS address in host:port form. The default is port 7332; HTTP stays on port 7331.", httpsAddress),
      feature.localHTTPSField("Certificate DNS names", "One per line or comma-separated. Include every hostname used from the iPad.", dnsNames),
      feature.localHTTPSField("Certificate IP addresses", "Include LAN and VPN addresses that may be entered directly in Safari.", ipAddresses),
    );

    if (state.hasCA) {
      const identity = platform.document.createElement("div");
      identity.className = "local-https-identity";
      const identityTitle = platform.document.createElement("strong");
      identityTitle.textContent = state.rootName || "Tessera Root CA";
      const fingerprint = platform.document.createElement("code");
      fingerprint.textContent = state.fingerprint || "Fingerprint unavailable";
      const download = platform.document.createElement("a");
      download.href = "/api/host/https/ca";
      download.textContent = "Download public root certificate";
      identity.append(identityTitle, fingerprint, download);
      if (state.enrollmentURL) {
        const enrollment = platform.document.createElement("a");
        enrollment.href = state.enrollmentURL;
        enrollment.target = "_blank";
        enrollment.rel = "noopener";
        enrollment.textContent = "Open HTTP enrollment page";
        identity.appendChild(enrollment);
      }
      form.appendChild(identity);
    }

    const guidance = platform.document.createElement("p");
    guidance.className = "local-https-guidance";
    guidance.textContent = "On iPadOS, install the downloaded profile, then enable it under General → About → Certificate Trust Settings. Private keys never leave this Tessera host.";
    const status = platform.document.createElement("div");
    status.className = "local-https-status";
    status.setAttribute("role", "status");
    status.textContent = message;
    const actions = platform.document.createElement("div");
    actions.className = "rename-window-actions local-https-actions";
    const cancel = platform.document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", feature.hideLocalHTTPSModal);
    const save = platform.document.createElement("button");
    save.type = "submit";
    save.textContent = "Save and apply";
    actions.append(cancel, save);
    form.append(guidance, status, actions);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const draft = localHTTPSDraft({
        enabled: enabled.checked,
        httpsAddress: httpsAddress.value,
        dnsNames: dnsNames.value,
        ipAddresses: ipAddresses.value,
      });
      const validation = validateLocalHTTPSDraft(draft);
      if (validation) {
        status.textContent = validation;
        status.classList.add("is-error");
        return;
      }
      status.classList.remove("is-error");
      status.textContent = "Saving host settings and preparing certificates...";
      save.disabled = true;
      cancel.disabled = true;
      let enrollmentTab = null;
      if (draft.enabled) {
        enrollmentTab = platform.window.open("about:blank", "tessera-enrollment");
        if (enrollmentTab) enrollmentTab.opener = null;
      }
      try {
        const response = await platform.fetch("/api/host/https", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
        if (!body.restarting) {
          enrollmentTab?.close();
          feature.renderLocalHTTPSModal(body, "Settings are already applied.");
          return;
        }
        feature.localHTTPSModal.replaceChildren();
        const restarting = platform.document.createElement("section");
        restarting.className = "settings-panel local-https-restarting";
        const heading = platform.document.createElement("h2");
        heading.textContent = "Applying Local HTTPS";
        const explanation = platform.document.createElement("p");
        const nextURL = localHTTPSNextURL(body, platform.window.location.href);
        explanation.textContent = body.config.enabled && body.enrollmentURL
          ? "Tessera is applying HTTPS. The HTTP enrollment page is opening in a new tab."
          : "Tessera is applying the listener settings and will reopen over HTTP.";
        restarting.append(heading, explanation);
        if (body.config.enabled && body.enrollmentURL) {
          const enrollmentLink = platform.document.createElement("a");
          enrollmentLink.href = body.enrollmentURL;
          enrollmentLink.target = "_blank";
          enrollmentLink.rel = "noopener";
          enrollmentLink.textContent = "Open enrollment page";
          restarting.appendChild(enrollmentLink);
          if (enrollmentTab) enrollmentTab.location.replace(body.enrollmentURL);
        } else {
          enrollmentTab?.close();
          platform.window.setTimeout(() => platform.window.location.assign(nextURL), 1000);
        }
        feature.localHTTPSModal.appendChild(restarting);
      } catch (error) {
        enrollmentTab?.close();
        status.textContent = error.message || String(error);
        status.classList.add("is-error");
        save.disabled = false;
        cancel.disabled = false;
      }
    });

    panel.append(titleBar, form);
    feature.localHTTPSModal.appendChild(panel);
    platform.window.requestAnimationFrame(() => enabled.focus());
  }

  function initializeIpadHTTPGuidanceDismissedKey() {
    feature.ipadHTTPGuidanceDismissedKey = "tessera.ipad-http-guidance-dismissed.v1";
  }

  function initializeLocalHTTPSModal() {
    feature.localHTTPSModal = platform.document.createElement("div");
    feature.localHTTPSModal.className = "settings-modal local-https-modal";
    feature.localHTTPSModal.hidden = true;
    feature.localHTTPSModal.addEventListener("pointerdown", (event) => {
      if (event.target === feature.localHTTPSModal) {
        feature.hideLocalHTTPSModal();
      }
    });
    platform.document.body.appendChild(feature.localHTTPSModal);
  }

  Object.assign(feature, {
    openLocalHTTPSModal,
    hideLocalHTTPSModal,
    showIPadHTTPGuidanceIfNeeded,
    renderLocalHTTPSError,
    localHTTPSField,
    renderLocalHTTPSModal,
    initializeIpadHTTPGuidanceDismissedKey,
    initializeLocalHTTPSModal,
  });
  return feature;
}
