import { renderSignedInDevices } from "./sign-in.mjs";
import { renderSignInSettings } from "./sign-in-settings.mjs";

export const settingsCategories = Object.freeze([
  { id: "appearance", label: "Appearance", icon: "◐", detail: "Themes, window styling and workspace background." },
  { id: "fonts", label: "Fonts", icon: "Aa", detail: "Font family and text sizes for your workspace." },
  { id: "terminal", label: "Terminal", icon: ">_", detail: "Terminal appearance, typing and shell behavior." },
  { id: "input", label: "Input & Shortcuts", icon: "⌘", detail: "Scrolling sensitivity and launch shortcuts." },
  { id: "clipboard", label: "Clipboard", icon: "▣", detail: "Copy, paste and browser clipboard access." },
  { id: "performance", label: "Performance", icon: "↗", detail: "Choose the rendering profile for this browser." },
  { id: "security", label: "Sign-in & Devices", icon: "●", detail: "Host sign-in, secure connections and remembered devices." },
  { id: "advanced", label: "Advanced", icon: "⚙", detail: "Technical terminal and transport options." },
  { id: "diagnostics", label: "Diagnostics", icon: "+", detail: "Inspect browser support, rendering costs and keyboard input." },
].map(category => Object.freeze(category)));

// Modal focus, category navigation and diagnostics lifetime are independent of the
// preference effects. Row builders and actions are supplied by the application.
export class SettingsDialog {
  constructor({ modal, state, rows, actions, hideDeskbar, otherOverlay, focusWorkspace, metrics,
    recovery, document = globalThis.document, window = globalThis.window,
    renderSignIn = renderSignInSettings, renderDevices = renderSignedInDevices }) {
    Object.assign(this, { modal, state, rows, actions, hideDeskbar, otherOverlay, focusWorkspace,
      metrics, recovery, document, window, renderSignIn, renderDevices });
    this.returnFocus = null;
    this.diagnosticsTimer = null;
    this.category = "appearance";
    this.renderedCategory = null;
    this.pageScroll = new Map();
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
    if (options.clipboard) this.category = "clipboard";
    this.modal.hidden = false;
    this.render();
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
    return !this.modal.hidden && this.renderedCategory === "diagnostics";
  }

  close() {
    const wasOpen = !this.modal.hidden, returnFocus = this.returnFocus;
    this.returnFocus = null;
    this.clearDiagnostics();
    this.modal.hidden = true;
    this.modal.replaceChildren();
    this.renderedCategory = null;
    this.pageScroll.clear();
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
    const title = this.document.createElement("h4");
    title.textContent = titleText;
    section.append(title, ...rows);
    return section;
  }

  selectCategory(id, focusNavigation = false) {
    if (this.modal.hidden || !settingsCategories.some(category => category.id === id) || id === this.category) return;
    this.category = id;
    this.render();
    if (focusNavigation) this.modal.querySelector(`#settings-category-${id}`)?.focus({ preventScroll: true });
  }

  renderPage(content, state) {
    const { rows, actions } = this;
    switch (this.category) {
    case "fonts":
      content.appendChild(this.section("Font", [
        rows.terminalFont(),
        rows.interfaceFontSize(),
        rows.font("Terminal default", "Text size for new terminal panes in all sessions; does not change menus.", state.defaultPaneFontSize, next => {
          actions.defaultPaneFontSize(next); this.render();
        }), rows.currentPaneFont(),
      ]));
      break;
    case "appearance":
      content.appendChild(this.section("Theme", [
        rows.theme("Default", `Used for new windows in all of this user's sessions, ${state.scope}.`, state.defaultTheme, actions.defaultTheme),
        rows.theme("Current", `Applied across this user's sessions immediately, ${state.scope}.`, state.themeID, actions.theme),
        rows.oledBorder(),
        rows.toggle("Wobbly windows", "Gentle elasticity when dragging Operator windows. Applies to this browser; reduced motion and Older Mac mode disable the effect.", state.windowWobbleEnabled, actions.windowWobble),
      ]));
      content.appendChild(this.section("Background", [rows.background(), rows.backgroundMode()]));
      break;
    case "terminal":
      content.appendChild(this.section("Terminal", [
        rows.rowSpacing(), rows.terminalColor(), rows.prediction(),
        rows.toggle("Shell integration", "Starts zsh and bash set up to mark their prompts and commands and report their directory, for prompt jumps, Copy Command Output, the window's directory and command finished notices. Applies to new terminals.", state.terminalShellIntegration, actions.shellIntegration),
        rows.toggle("Command finished notices", "A notice when a command that ran for 5 seconds or more finishes in a window you aren't looking at. Needs the shell's prompt marks (Shell integration). Saved in this browser.", state.commandNoticesEnabled, actions.commandNotices),
        ...("Notification" in this.window ? [rows.notifications()] : []),
      ]));
      break;
    case "input": {
      content.appendChild(this.section("Scroll wheel", [
        rows.wheel("Terminal", "Controls terminal scrollback and wheel input in full-screen terminal apps.", state.terminalWheelSensitivity, actions.terminalWheel),
        rows.wheel("Remote desktop", "Wheel and two-finger scrolling in RDP windows. Lower it if a scroll moves too far. Applies to this browser.", state.rdpWheelSpeed, actions.rdpWheel, state.rdpWheelSpeedOptions),
      ]));
      const shortcuts = this.document.createElement("button");
      shortcuts.type = "button"; shortcuts.className = "settings-background-button"; shortcuts.textContent = "Manage shortcuts...";
      shortcuts.addEventListener("click", actions.shortcuts);
      content.appendChild(this.section("Shortcuts", [shortcuts]));
      break;
    }
    case "clipboard":
      content.appendChild(this.section("Clipboard", [rows.clipboard()]));
      break;
    case "performance":
      content.appendChild(this.section("Performance", [rows.performance()]));
      break;
    case "security": {
      const signIn = this.section("Sign-in", []);
      content.appendChild(signIn);
      void this.renderSignIn(signIn, { recovery: this.recovery });
      if (state.authMode !== "off") {
        const devices = this.section("Signed-in devices", []);
        content.appendChild(devices);
        void this.renderDevices(devices);
      }
      break;
    }
    case "advanced":
      content.append(
        this.section("Terminal", [rows.term()]),
        this.section("Performance", [
          rows.renderer(),
          rows.toggle("Paint coalescing", "While terminal output is streaming, wait up to one frame for a 3 ms pause before painting so animation frames split across many writes are not drawn in pieces. Applies to this browser only.", state.terminalPaintCoalescing, actions.paintCoalescing),
          rows.toggle("Server output coalescing", "Ask the server to join terminal output that arrives within 2 ms (holding at most 8 ms) into one WebSocket message. Applies to this browser's connections only.", state.terminalOutputCoalescing, actions.outputCoalescing),
          rows.backlog(),
        ]),
      );
      break;
    case "diagnostics": {
      const diagnostics = this.document.createElement("div");
      diagnostics.id = "settings-diagnostics";
      diagnostics.className = "settings-diagnostics-page";
      content.appendChild(diagnostics);
      diagnostics.append(rows.compatibility(), rows.keyReadout());
      break;
    }
    }
  }

  render() {
    // Late preference callbacks or stale controls must not remount a closed
    // Diagnostics page and restart its timer/metrics behind the hidden modal.
    if (this.modal.hidden) return;
    const { modal, document } = this;
    const state = this.state();
    const previous = modal.querySelector(".settings-content");
    if (previous && this.renderedCategory) this.pageScroll.set(this.renderedCategory, previous.scrollTop);
    const focused = modal.contains(document.activeElement) ? document.activeElement : null;
    this.clearDiagnostics();
    const category = settingsCategories.find(category => category.id === this.category) || settingsCategories[0];
    this.category = category.id;
    this.renderedCategory = category.id;
    this.metrics(this.category === "diagnostics");
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
    close.type = "button"; close.className = "settings-close"; close.textContent = "×";
    close.setAttribute("aria-label", "Close settings");
    close.addEventListener("click", () => this.close());
    titleBar.append(title, close);
    const layout = document.createElement("div");
    layout.className = "settings-layout";
    const navigation = document.createElement("nav");
    navigation.className = "settings-sidebar";
    navigation.setAttribute("aria-label", "Settings categories");
    const compact = document.createElement("div");
    compact.className = "settings-category-picker";
    const compactLabel = document.createElement("label");
    compactLabel.textContent = "Category"; compactLabel.htmlFor = "settings-category-picker";
    const picker = document.createElement("select");
    picker.id = "settings-category-picker";
    picker.className = "settings-theme-select";
    picker.setAttribute("aria-label", "Settings category");
    for (const item of settingsCategories) {
      const button = document.createElement("button");
      button.type = "button"; button.id = `settings-category-${item.id}`;
      button.className = "settings-category-button";
      button.setAttribute("aria-current", item.id === this.category ? "page" : "false");
      button.setAttribute("aria-controls", "settings-category-content");
      button.setAttribute("data-category", item.id);
      const icon = document.createElement("span");
      icon.className = "settings-category-icon"; icon.textContent = item.icon;
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span"); label.textContent = item.label;
      button.append(icon, label);
      button.addEventListener("click", () => this.selectCategory(item.id));
      button.addEventListener("keydown", event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const index = settingsCategories.indexOf(item);
        let next;
        if (event.key === "ArrowDown") next = (index + 1) % settingsCategories.length;
        else if (event.key === "ArrowUp") next = (index + settingsCategories.length - 1) % settingsCategories.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = settingsCategories.length - 1;
        else return;
        event.preventDefault();
        this.selectCategory(settingsCategories[next].id, true);
      });
      navigation.appendChild(button);
      const option = document.createElement("option");
      option.value = item.id; option.textContent = item.label; option.selected = item.id === this.category;
      picker.appendChild(option);
    }
    picker.addEventListener("change", () => this.selectCategory(picker.value));
    compact.append(compactLabel, picker);
    const content = document.createElement("div");
    content.className = "settings-content settings-category-content";
    content.id = "settings-category-content";
    content.setAttribute("role", "region");
    content.setAttribute("aria-labelledby", "settings-category-heading");
    const header = document.createElement("header");
    header.className = "settings-page-header";
    const heading = document.createElement("h3");
    heading.id = "settings-category-heading"; heading.textContent = category.label;
    const description = document.createElement("p"); description.textContent = category.detail;
    header.append(heading, description); content.appendChild(header);
    layout.append(navigation, compact, content);
    panel.append(titleBar, layout); modal.appendChild(panel);
    this.renderPage(content, state);
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
    content.scrollTop = this.pageScroll.get(this.category) || 0;
  }
}
