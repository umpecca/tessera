import { renderSignedInDevices } from "./sign-in.mjs";
import { renderSignInSettings } from "./sign-in-settings.mjs";

// Modal focus, disclosures and diagnostics lifetime are independent of the
// preference effects. Row builders and actions are supplied by the application.
export class SettingsDialog {
  constructor({ modal, state, rows, actions, hideDeskbar, otherOverlay, focusWorkspace, metrics,
    recovery, document = globalThis.document, window = globalThis.window,
    renderSignIn = renderSignInSettings, renderDevices = renderSignedInDevices }) {
    Object.assign(this, { modal, state, rows, actions, hideDeskbar, otherOverlay, focusWorkspace,
      metrics, recovery, document, window, renderSignIn, renderDevices });
    this.returnFocus = null;
    this.diagnosticsTimer = null;
  }

  ownsFocus() {
    return !this.modal.hidden && ![...this.document.querySelectorAll(".settings-modal")]
      .some(modal => modal !== this.modal && !modal.hidden);
  }

  controls() {
    return [...this.modal.querySelectorAll("button, a[href], input, select, textarea, summary, [tabindex]")]
      .filter(control => control.tabIndex >= 0 && !control.matches(":disabled")
        && !control.closest("[hidden], [inert]") && control.getClientRects().length > 0);
  }

  containFocus(event) {
    if (this.ownsFocus() && !this.modal.contains(event.target)) this.controls()[0]?.focus();
  }

  keydown(event) {
    if (event.defaultPrevented || !this.ownsFocus()) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); this.close(); return;
    }
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
    const controls = this.controls(), current = controls.indexOf(this.document.activeElement);
    if (current < 0 || (event.shiftKey ? current === 0 : current === controls.length - 1)) {
      event.preventDefault(); event.stopPropagation();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  }

  open(options = {}) {
    if (this.modal.hidden) this.returnFocus = this.document.activeElement;
    this.hideDeskbar();
    this.render();
    this.modal.hidden = false;
    this.window.requestAnimationFrame(() => {
      if (!this.ownsFocus()) return;
      const row = options.clipboard ? this.modal.querySelector("#settings-clipboard") : null;
      row?.scrollIntoView({ block: "center" });
      (row?.querySelector("button, a") || this.modal.querySelector("button, select"))?.focus();
    });
  }

  clearDiagnostics() {
    this.window.clearInterval(this.diagnosticsTimer);
    this.diagnosticsTimer = null;
  }

  startDiagnostics(callback) {
    this.clearDiagnostics();
    this.diagnosticsTimer = this.window.setInterval(callback, 1000);
  }

  diagnosticsOpen() {
    return !this.modal.hidden && this.modal.querySelector("#settings-diagnostics")?.open === true;
  }

  close() {
    const wasOpen = !this.modal.hidden, returnFocus = this.returnFocus;
    this.returnFocus = null;
    this.clearDiagnostics();
    this.modal.hidden = true;
    this.modal.replaceChildren();
    this.metrics(false);
    if (!wasOpen) return;
    this.window.requestAnimationFrame(() => {
      if (!this.modal.hidden || [...this.document.querySelectorAll(".settings-modal")].some(modal => !modal.hidden)
        || this.otherOverlay() || this.document.activeElement !== this.document.body) return;
      if (returnFocus?.isConnected && !returnFocus.matches(":disabled")
        && !returnFocus.closest("[hidden], [inert]") && returnFocus.getClientRects().length) returnFocus.focus();
      else this.focusWorkspace();
    });
  }

  section(titleText, rows) {
    const section = this.document.createElement("section");
    section.className = "settings-section";
    const title = this.document.createElement("h3");
    title.textContent = titleText;
    section.append(title, ...rows);
    return section;
  }

  render() {
    const { modal, document, rows, actions } = this;
    const state = this.state();
    const scrollTop = modal.querySelector(".settings-content")?.scrollTop || 0;
    const advancedOpen = modal.querySelector("#settings-advanced")?.open === true;
    const diagnosticsOpen = modal.querySelector("#settings-diagnostics")?.open === true;
    const focused = modal.contains(document.activeElement) ? document.activeElement : null;
    this.clearDiagnostics();
    modal.replaceChildren();
    const panel = document.createElement("section");
    panel.className = "settings-panel settings-main-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "settings-title");
    const titleBar = document.createElement("div");
    titleBar.className = "settings-title";
    const title = document.createElement("h2");
    title.id = "settings-title"; title.textContent = "Settings";
    const close = document.createElement("button");
    close.type = "button"; close.className = "settings-close"; close.textContent = "X";
    close.setAttribute("aria-label", "Close settings");
    close.addEventListener("click", () => this.close());
    titleBar.append(title, close);
    panel.appendChild(titleBar);
    const content = document.createElement("div");
    content.className = "settings-content";
    content.appendChild(this.section("Font", [
      rows.terminalFont(),
      rows.interfaceFontSize(),
      rows.font("Terminal default", "Text size for new terminal panes in all sessions; does not change menus.", state.defaultPaneFontSize, next => {
        actions.defaultPaneFontSize(next); this.render();
      }), rows.currentPaneFont(),
    ]));
    content.appendChild(this.section("Theme", [
      rows.theme("Default", `Used for new windows in all of this user's sessions, ${state.scope}.`, state.defaultTheme, actions.defaultTheme),
      rows.theme("Current", `Applied across this user's sessions immediately, ${state.scope}.`, state.themeID, actions.theme),
      rows.oledBorder(),
      rows.toggle("Wobbly windows", "Gentle elasticity when dragging Operator windows. Applies to this browser; reduced motion and Older Mac mode disable the effect.", state.windowWobbleEnabled, actions.windowWobble),
    ]));
    content.appendChild(this.section("Terminal", [
      rows.rowSpacing(), rows.terminalColor(), rows.prediction(),
      rows.toggle("Shell integration", "Starts zsh and bash set up to mark their prompts and commands and report their directory, for prompt jumps, Copy Command Output, the window's directory and command finished notices. Applies to new terminals.", state.terminalShellIntegration, actions.shellIntegration),
      rows.toggle("Command finished notices", "A notice when a command that ran for 5 seconds or more finishes in a window you aren't looking at. Needs the shell's prompt marks (Shell integration). Saved in this browser.", state.commandNoticesEnabled, actions.commandNotices),
      ...("Notification" in this.window ? [rows.notifications()] : []),
    ]));
    content.appendChild(this.section("Scroll wheel", [
      rows.wheel("Terminal", "Controls terminal scrollback and wheel input in full-screen terminal apps.", state.terminalWheelSensitivity, actions.terminalWheel),
      rows.wheel("Remote desktop", "Wheel and two-finger scrolling in RDP windows. Lower it if a scroll moves too far. Applies to this browser.", state.rdpWheelSpeed, actions.rdpWheel, state.rdpWheelSpeedOptions),
    ]));
    const shortcuts = document.createElement("button");
    shortcuts.type = "button"; shortcuts.textContent = "Manage shortcuts...";
    shortcuts.addEventListener("click", actions.shortcuts);
    content.appendChild(this.section("Shortcuts", [shortcuts]));
    content.appendChild(this.section("Background", [rows.background(), rows.backgroundMode()]));
    content.appendChild(this.section("Clipboard", [rows.clipboard()]));
    content.appendChild(this.section("Performance", [rows.performance()]));
    const signIn = this.section("Sign-in", []);
    void this.renderSignIn(signIn, { recovery: this.recovery });
    content.appendChild(signIn);
    if (state.authMode !== "off") {
      const devices = this.section("Signed-in devices", []);
      void this.renderDevices(devices); content.appendChild(devices);
    }
    const advanced = document.createElement("details");
    advanced.id = "settings-advanced"; advanced.className = "settings-disclosure"; advanced.open = advancedOpen;
    const advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "Advanced";
    const advancedContent = document.createElement("div");
    advancedContent.className = "settings-disclosure-content";
    advancedContent.append(
      this.section("Terminal", [rows.term()]),
      this.section("Performance", [
        rows.renderer(),
        rows.toggle("Paint coalescing", "While terminal output is streaming, wait up to one frame for a 3 ms pause before painting so animation frames split across many writes are not drawn in pieces. Applies to this browser only.", state.terminalPaintCoalescing, actions.paintCoalescing),
        rows.toggle("Server output coalescing", "Ask the server to join terminal output that arrives within 2 ms (holding at most 8 ms) into one WebSocket message. Applies to this browser's connections only.", state.terminalOutputCoalescing, actions.outputCoalescing),
        rows.backlog(),
      ]),
    );
    advanced.append(advancedSummary, advancedContent);
    const diagnostics = document.createElement("details");
    diagnostics.id = "settings-diagnostics"; diagnostics.className = "settings-disclosure"; diagnostics.open = diagnosticsOpen;
    const diagnosticsSummary = document.createElement("summary");
    diagnosticsSummary.textContent = "Diagnostics";
    const diagnosticsContent = document.createElement("div");
    diagnosticsContent.className = "settings-disclosure-content";
    let rendered = null;
    const update = () => {
      if (!diagnostics.isConnected || modal.hidden || rendered === diagnostics.open) return;
      rendered = diagnostics.open;
      this.clearDiagnostics();
      this.metrics(diagnostics.open);
      diagnosticsContent.replaceChildren();
      if (diagnostics.open) diagnosticsContent.append(rows.compatibility(), rows.keyReadout());
    };
    diagnostics.addEventListener("toggle", update);
    diagnostics.append(diagnosticsSummary, diagnosticsContent);
    content.append(advanced, diagnostics); panel.appendChild(content); modal.appendChild(panel);
    update();
    if (focused && this.ownsFocus()) {
      const controls = this.controls();
      const replacement = controls.find(control => {
        if (control.tagName !== focused.tagName) return false;
        if (focused.id) return control.id === focused.id;
        const label = focused.getAttribute("aria-label");
        return label ? control.getAttribute("aria-label") === label : control.textContent === focused.textContent;
      });
      (replacement || controls[0])?.focus({ preventScroll: true });
    }
    content.scrollTop = scrollTop;
  }
}
