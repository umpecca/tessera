import assert from "node:assert/strict";
import test from "node:test";
import { SettingsDialog, settingsCategories } from "./settings-dialog.mjs";

// Small DOM model for the Settings lifecycle. Real tab order and responsive
// visibility are also checked in a browser; no DOM dependency is needed here.
function fixture({ authMode = "off" } = {}) {
  const document = {};
  class Element extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this.inert = false;
      this.scrollTop = 0;
      this.text = "";
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    set textContent(value) { this.text = value; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
    get tabIndex() {
      if (this.attributes.has("tabindex")) return Number(this.attributes.get("tabindex"));
      return /^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(this.tagName)
        || (this.tagName === "A" && this.href) ? 0 : -1;
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.append(...children);
    }
    contains(child) { return child === this || this.children.some(candidate => candidate.contains(child)); }
    get isConnected() { return document.body.contains(this); }
    matches(selector) {
      return selector.split(",").some(part => {
        const value = part.trim();
        if (value === ":disabled") return this.disabled;
        if (value === "[hidden]") return this.hidden;
        if (value === "[inert]") return this.inert;
        if (value === "[tabindex]") return this.attributes.has("tabindex");
        if (value === "a[href]") return this.tagName === "A" && Boolean(this.href);
        if (value.startsWith("#")) return this.id === value.slice(1);
        if (value.startsWith(".")) return this.className?.split(" ").includes(value.slice(1));
        return this.tagName === value.toUpperCase();
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() {
      if (!this.isConnected || this.closest("[hidden], [inert]")) return [];
      for (let child = this; child.parent; child = child.parent) {
        if (child.parent.tagName === "DETAILS" && !child.parent.open && child.tagName !== "SUMMARY") return [];
      }
      return [{}];
    }
    focus() { if (!this.disabled && this.getClientRects().length) document.activeElement = this; }
    scrollIntoView() {}
  }
  document.body = new Element("body");
  document.activeElement = document.body;
  document.createElement = tag => new Element(tag);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const settingsModal = new Element("div");
  settingsModal.className = "settings-modal";
  settingsModal.hidden = true;
  const deskbarButton = new Element("button");
  document.body.append(settingsModal, deskbarButton);
  const frames = [], metrics = [], intervals = new Set();
  let diagnosticsCreated = 0, paneFocusCount = 0, signInCreated = 0, devicesCreated = 0;
  const context = {
    authMode, document, settingsModal, deskbarButton, signInRecovery: {}, renderSignInSettings: async () => {},
    commandPalette: { hidden: true }, windowList: { hidden: true }, sessionList: { hidden: true },
    compatibilityUpdateTimer: null, settingsReturnFocus: null,
    defaultPaneFontSize: 14, defaultTheme: "beos", themeID: "beos", windowWobbleEnabled: true,
    terminalShellIntegration: true, commandNoticesEnabled: true, setTerminalShellIntegration() {}, setCommandNoticesEnabled() {},
    setWindowWobbleEnabled() {},
    terminalWheelSensitivity: 1, editorWheelSensitivity: 1, rdpWheelSpeed: 1, rdpWheelSpeedOptions: [1], setRDPWheelSpeed() {},
    terminalPaintCoalescing: true, terminalOutputCoalescing: false,
    window: {
      requestAnimationFrame: callback => frames.push(callback),
      clearInterval: timer => intervals.delete(timer),
      setInterval: () => { const timer = diagnosticsCreated; intervals.add(timer); return timer; },
    },
    hideDeskbar() {},
    openShortcuts() {},
    directoryBrowserButton: label => row(label, "button"),
    setTerminalPaintCoalescing() {},
    setTerminalOutputCoalescing() {},
    setTerminalRenderingMetricsEnabled: enabled => metrics.push(enabled),
    getActivePane: () => ({ id: "pane" }),
    focusPane: () => { paneFocusCount++; document.activeElement = deskbarButton; },
    renderSettingsCompatibilityRow: () => {
      diagnosticsCreated++;
      dialog.startDiagnostics(() => {});
      return row("Copy diagnostics");
    },
    renderSettingsKeyReadoutRow: () => row("Key test", "textarea"),
  };
  function row(label, tag = "select") {
    const control = new Element(tag);
    control.setAttribute("aria-label", label);
    return control;
  }
  const renderers = {
    renderSettingsFontRow: label => row(`${label} font size`, "button"),
    renderCurrentPaneFontRow: () => row("Current font size", "button"),
    renderSettingsThemeRow: label => row(`${label} theme`),
    displaySettingsScope: () => "on desktops and iPads",
    renderSettingsOLEDWindowBorderRow: () => row("OLED border", "button"),
    renderSettingsTerminalFontRow: () => row("Application font"),
    renderSettingsInterfaceFontSizeRow: () => row("Interface font size", "button"),
    renderSettingsTerminalRowSpacingRow: () => row("Terminal row spacing"),
    renderSettingsTerminalColorModeRow: () => row("Terminal colors"),
    renderSettingsTerminalPredictionRow: () => row("Typing prediction"),
    renderSettingsWheelRow: label => row(`${label} wheel speed`),
    renderSettingsBackgroundRow: () => row("Set background", "button"),
    renderSettingsBackgroundModeRow: () => row("Background display"),
    renderSettingsClipboardRow: () => { const section = new Element("div"); section.id = "settings-clipboard"; section.append(row("Check clipboard", "button")); return section; },
    renderSettingsPerformanceRow: () => row("Performance profile"),
    renderSettingsTerminalTERMRow: () => row("Terminal TERM value", "input"),
    renderSettingsExperimentalRendererRow: () => row("Terminal renderer"),
    renderSettingsToggleRow: label => row(label),
    renderSettingsTerminalBacklogRow: () => row("Terminal output backlog"),
  };
  Object.assign(context, renderers);
  const dialog = new SettingsDialog({
    modal: settingsModal, document, window: context.window,
    state: () => ({ ...context, scope: "on desktops and iPads" }),
    rows: {
      font: context.renderSettingsFontRow, currentPaneFont: context.renderCurrentPaneFontRow,
      interfaceFontSize: context.renderSettingsInterfaceFontSizeRow,
      theme: context.renderSettingsThemeRow, oledBorder: context.renderSettingsOLEDWindowBorderRow,
      toggle: context.renderSettingsToggleRow, terminalFont: context.renderSettingsTerminalFontRow,
      rowSpacing: context.renderSettingsTerminalRowSpacingRow, terminalColor: context.renderSettingsTerminalColorModeRow,
      prediction: context.renderSettingsTerminalPredictionRow, wheel: context.renderSettingsWheelRow,
      background: context.renderSettingsBackgroundRow, backgroundMode: context.renderSettingsBackgroundModeRow,
      clipboard: context.renderSettingsClipboardRow, performance: context.renderSettingsPerformanceRow,
      term: context.renderSettingsTerminalTERMRow, renderer: context.renderSettingsExperimentalRendererRow,
      backlog: context.renderSettingsTerminalBacklogRow, compatibility: context.renderSettingsCompatibilityRow,
      keyReadout: context.renderSettingsKeyReadoutRow,
    },
    actions: { shortcuts() {} }, hideDeskbar() {},
    otherOverlay: () => !context.commandPalette.hidden || !context.windowList.hidden || !context.sessionList.hidden,
    focusWorkspace: () => context.focusPane(), metrics: enabled => metrics.push(enabled),
    renderSignIn(section) { signInCreated++; section.append(row("Sign-in settings")); },
    renderDevices(section) { devicesCreated++; section.append(row("Signed-in devices")); },
  });
  Object.assign(context, {
    openSettingsModal: options => dialog.open(options), hideSettingsModal: () => dialog.close(),
    settingsOwnsFocus: () => dialog.ownsFocus(), settingsFocusControls: () => dialog.controls(),
    containSettingsFocus: event => dialog.containFocus(event), handleSettingsKeyboard: event => dialog.keydown(event),
    settingsDiagnosticsOpen: () => dialog.diagnosticsOpen(), renderSettingsModal: () => dialog.render(),
  });
  return {
    context, document, settingsModal, deskbarButton, metrics, intervals,
    flush: () => { for (const callback of frames.splice(0)) callback(); },
    row,
    selectCategory: id => dialog.selectCategory(id),
    get category() { return dialog.category; },
    get diagnosticsCreated() { return diagnosticsCreated; },
    get signInCreated() { return signInCreated; },
    get devicesCreated() { return devicesCreated; },
    get paneFocusCount() { return paneFocusCount; },
  };
}

function key(context, name, options = {}) {
  const event = {
    key: name, shiftKey: false, defaultPrevented: false, ...options,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  context.handleSettingsKeyboard(event);
  return event;
}

test("Settings has a category sidebar and only renders the selected page", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  const content = f.settingsModal.querySelector(".settings-content");
  assert.equal(f.settingsModal.querySelector("#settings-category-heading").textContent, "Appearance");
  assert.deepEqual(content.children.slice(1).map(child => child.children[0].textContent), ["Theme", "Background"]);
  const buttons = f.settingsModal.querySelector(".settings-sidebar").children;
  assert.deepEqual(buttons.map(button => button.id), settingsCategories.map(category => `settings-category-${category.id}`));
  assert.deepEqual(buttons.filter(button => button.getAttribute("aria-current") === "page").map(button => button.id), ["settings-category-appearance"]);
  assert.equal(f.signInCreated, 0, "inactive pages must not start sign-in requests");
  assert.equal(f.diagnosticsCreated, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.document.activeElement.getAttribute("aria-label"), "Close settings");
  f.selectCategory("fonts");
  const labels = f.context.settingsFocusControls().map(control => control.getAttribute("aria-label"));
  assert.ok(labels.includes("Application font"));
  assert.ok(labels.includes("Interface font size"));
  assert.ok(labels.includes("Terminal default font size"));
  for (const label of ["Terminal renderer", "Paint coalescing", "Server output coalescing", "Terminal output backlog", "Terminal TERM value"]) {
    assert.ok(!labels.includes(label), label);
  }
});

test("Tab and Shift+Tab wrap, ignore disabled and inactive controls, and preserve normal movement", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  const first = f.document.activeElement;
  const last = f.context.settingsFocusControls().at(-1);
  assert.equal(key(f.context, "Tab", { shiftKey: true }).defaultPrevented, true);
  assert.equal(f.document.activeElement, last);
  assert.equal(key(f.context, "Tab").defaultPrevented, true);
  assert.equal(f.document.activeElement, first);
  assert.equal(key(f.context, "Tab").defaultPrevented, false);
  f.selectCategory("advanced");
  const input = f.settingsModal.querySelector("input");
  input.focus();
  assert.equal(key(f.context, "ArrowLeft").defaultPrevented, false);
  assert.equal(key(f.context, "Tab").defaultPrevented, false);
  input.disabled = true;
  assert.ok(!f.context.settingsFocusControls().includes(input));
  f.context.settingsFocusControls().at(-1).focus();
  assert.equal(key(f.context, "Tab").defaultPrevented, true);
  assert.equal(f.document.activeElement.getAttribute("aria-label"), "Close settings");
});

test("unexpected background focus returns to Settings; other modals retain their keyboard input", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  f.deskbarButton.focus();
  f.context.containSettingsFocus({ target: f.deskbarButton });
  assert.equal(f.document.activeElement.getAttribute("aria-label"), "Close settings");
  const other = f.document.createElement("div");
  other.className = "settings-modal";
  f.document.body.append(other);
  f.deskbarButton.focus();
  f.context.containSettingsFocus({ target: f.deskbarButton });
  assert.equal(f.document.activeElement, f.deskbarButton);
  assert.equal(key(f.context, "Tab").defaultPrevented, false);
  assert.equal(key(f.context, "Escape").defaultPrevented, false);
  assert.equal(f.settingsModal.hidden, false);
});

test("Escape closes and returns focus, while a same-tick overlay handoff keeps its focus", () => {
  const f = fixture();
  f.deskbarButton.focus();
  f.context.openSettingsModal();
  f.flush();
  const event = key(f.context, "Escape");
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.equal(f.settingsModal.hidden, true);
  f.flush();
  assert.equal(f.document.activeElement, f.deskbarButton);
  f.context.openSettingsModal();
  f.flush();
  f.context.hideSettingsModal();
  f.context.commandPalette.hidden = false;
  f.flush();
  assert.equal(f.document.activeElement, f.document.body);
  assert.equal(f.paneFocusCount, 0);
});

test("closing falls back to the active pane when the invoking control is hidden", () => {
  const f = fixture();
  const opener = f.row("Settings", "button");
  f.document.body.append(opener);
  opener.focus();
  f.context.openSettingsModal();
  f.flush();
  opener.hidden = true;
  f.context.hideSettingsModal();
  f.flush();
  assert.equal(f.paneFocusCount, 1);
});

test("redraw preserves the page, focused preference and per-page scroll; reopening remembers the category", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  f.selectCategory("fonts");
  const controls = f.context.settingsFocusControls();
  controls.find(control => control.getAttribute("aria-label") === "Terminal default font size").focus();
  f.settingsModal.querySelector(".settings-content").scrollTop = 175;
  f.context.renderSettingsModal();
  assert.equal(f.document.activeElement.getAttribute("aria-label"), "Terminal default font size");
  assert.equal(f.settingsModal.querySelector(".settings-content").scrollTop, 175);
  assert.equal(f.category, "fonts");
  f.selectCategory("terminal");
  assert.equal(f.settingsModal.querySelector(".settings-content").scrollTop, 0);
  f.settingsModal.querySelector(".settings-content").scrollTop = 80;
  f.selectCategory("fonts");
  assert.equal(f.settingsModal.querySelector(".settings-content").scrollTop, 175);
  f.context.hideSettingsModal();
  f.context.openSettingsModal();
  f.flush();
  assert.equal(f.category, "fonts");
  assert.equal(f.settingsModal.querySelector(".settings-content").scrollTop, 0);
  assert.equal(f.settingsModal.hidden, false);
});

test("Diagnostics starts checks on its page, then cleans up on navigation and close", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  f.selectCategory("diagnostics");
  assert.equal(f.context.settingsDiagnosticsOpen(), true);
  assert.equal(f.diagnosticsCreated, 1);
  assert.equal(f.metrics.at(-1), true);
  assert.equal(f.intervals.size, 1);
  f.context.renderSettingsModal();
  assert.equal(f.intervals.size, 1);
  const createdAfterRedraw = f.diagnosticsCreated;
  f.selectCategory("diagnostics");
  assert.equal(f.diagnosticsCreated, createdAfterRedraw);
  f.selectCategory("fonts");
  assert.equal(f.context.settingsDiagnosticsOpen(), false);
  assert.equal(f.metrics.at(-1), false);
  assert.equal(f.intervals.size, 0);
  f.selectCategory("diagnostics");
  f.context.hideSettingsModal();
  assert.equal(f.metrics.at(-1), false);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.intervals.size, 0);
});

test("every existing control remains reachable in its category", () => {
  const f = fixture({ authMode: "file" });
  f.context.openSettingsModal(); f.flush();
  const pages = {
    appearance: ["Default theme", "Current theme", "OLED border", "Wobbly windows", "Set background", "Background display"],
    fonts: ["Application font", "Interface font size", "Terminal default font size", "Current font size"],
    terminal: ["Terminal row spacing", "Terminal colors", "Typing prediction", "Shell integration", "Command finished notices"],
    input: ["Terminal wheel speed", "Remote desktop wheel speed"],
    clipboard: ["Check clipboard"], performance: ["Performance profile"],
    security: ["Sign-in settings", "Signed-in devices"],
    advanced: ["Terminal TERM value", "Terminal renderer", "Paint coalescing", "Server output coalescing", "Terminal output backlog"],
    diagnostics: ["Copy diagnostics", "Key test"],
  };
  for (const [id, expected] of Object.entries(pages)) {
    f.selectCategory(id);
    const labels = f.context.settingsFocusControls().map(control => control.getAttribute("aria-label"));
    for (const label of expected) assert.ok(labels.includes(label), `${id}: ${label}`);
  }
  assert.equal(f.signInCreated, 1);
  assert.equal(f.devicesCreated, 1);
});

test("sidebar arrow/Home/End keys navigate categories without capturing input arrows", () => {
  const f = fixture(); f.context.openSettingsModal(); f.flush();
  const press = (id, key) => {
    const button = f.settingsModal.querySelector(`#settings-category-${id}`);
    button.focus();
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key }); button.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  press("appearance", "ArrowDown");
  assert.equal(f.category, "fonts");
  assert.equal(f.document.activeElement.id, "settings-category-fonts");
  press("fonts", "End"); assert.equal(f.category, "diagnostics");
  press("diagnostics", "ArrowDown"); assert.equal(f.category, "appearance");
  press("appearance", "ArrowUp"); assert.equal(f.category, "diagnostics");
  press("diagnostics", "Home"); assert.equal(f.category, "appearance");
});

test("compact navigation and clipboard deep-link select the matching page", () => {
  const f = fixture(); f.context.openSettingsModal(); f.flush();
  const picker = f.settingsModal.querySelector("#settings-category-picker");
  assert.deepEqual(picker.children.map(option => option.value), settingsCategories.map(category => category.id));
  picker.value = "advanced"; picker.dispatchEvent(new Event("change"));
  assert.equal(f.category, "advanced");
  f.context.openSettingsModal({ clipboard: true }); f.flush();
  assert.equal(f.category, "clipboard");
  assert.equal(f.document.activeElement.getAttribute("aria-label"), "Check clipboard");
  assert.equal(f.signInCreated, 0);
  f.selectCategory("not-a-category"); assert.equal(f.category, "clipboard");
});

test("late rerenders and stale navigation cannot restart diagnostics after close", () => {
  const f = fixture(); f.context.openSettingsModal(); f.flush();
  const staleButton = f.settingsModal.querySelector("#settings-category-diagnostics");
  f.selectCategory("diagnostics");
  f.context.hideSettingsModal();
  f.context.renderSettingsModal();
  staleButton.dispatchEvent(new Event("click"));
  assert.equal(f.settingsModal.hidden, true);
  assert.equal(f.settingsModal.children.length, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.metrics.at(-1), false);
});
