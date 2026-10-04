import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// Small DOM model for the Settings lifecycle. Real tab order and disclosure
// visibility are also checked in a browser; no DOM dependency is needed here.
function fixture() {
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
  let diagnosticsCreated = 0, paneFocusCount = 0;
  const context = vm.createContext({
    document, settingsModal, deskbarButton,
    commandPalette: { hidden: true }, commandWheel: { hidden: true }, windowList: { hidden: true },
    compatibilityUpdateTimer: null, settingsReturnFocus: null,
    defaultPaneFontSize: 14, defaultTheme: "beos", themeID: "beos",
    terminalWheelSensitivity: 1, editorWheelSensitivity: 1,
    terminalPaintCoalescing: true, terminalOutputCoalescing: false,
    window: {
      requestAnimationFrame: callback => frames.push(callback),
      clearInterval: timer => intervals.delete(timer),
    },
    hideDeskbar() {},
    setTerminalPaintCoalescing() {},
    setTerminalOutputCoalescing() {},
    setTerminalRenderingMetricsEnabled: enabled => metrics.push(enabled),
    getActivePane: () => ({ id: "pane" }),
    focusPane: () => { paneFocusCount++; document.activeElement = deskbarButton; },
    renderSettingsCompatibilityRow: () => {
      diagnosticsCreated++;
      context.compatibilityUpdateTimer = diagnosticsCreated;
      intervals.add(diagnosticsCreated);
      return row("Copy diagnostics");
    },
  });
  function row(label, tag = "select") {
    const control = new Element(tag);
    control.setAttribute("aria-label", label);
    return control;
  }
  const renderers = {
    renderSettingsFontRow: label => row(`${label} font size`, "button"),
    renderCurrentPaneFontRow: () => row("Current font size", "button"),
    renderSettingsThemeRow: label => row(`${label} theme`),
    renderSettingsOLEDWindowBorderRow: () => row("OLED border", "button"),
    renderSettingsTerminalFontRow: () => row("Terminal font"),
    renderSettingsTerminalColorModeRow: () => row("Terminal colors"),
    renderSettingsWheelRow: label => row(`${label} wheel speed`),
    renderSettingsBackgroundRow: () => row("Set background", "button"),
    renderSettingsBackgroundModeRow: () => row("Background display"),
    renderSettingsClipboardRow: () => { const control = row("Check clipboard", "button"); control.id = "settings-clipboard"; return control; },
    renderSettingsPerformanceRow: () => row("Performance profile"),
    renderSettingsTerminalTERMRow: () => row("Terminal TERM value", "input"),
    renderSettingsExperimentalRendererRow: () => row("Terminal renderer"),
    renderSettingsToggleRow: label => row(label),
    renderSettingsTerminalBacklogRow: () => row("Terminal output backlog"),
  };
  Object.assign(context, renderers);
  for (const name of ["openSettingsModal", "hideSettingsModal", "settingsOwnsFocus", "settingsFocusControls",
    "containSettingsFocus", "handleSettingsKeyboard", "settingsDiagnosticsOpen", "renderSettingsModal", "renderSettingsSection"]) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\n}\n", start) + 2;
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(source.slice(start, end), context);
  }
  return {
    context, document, settingsModal, deskbarButton, metrics, intervals,
    flush: () => { for (const callback of frames.splice(0)) callback(); },
    row,
    get diagnosticsCreated() { return diagnosticsCreated; },
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

test("Settings leads with everyday preferences and hides technical controls by default", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  const content = f.settingsModal.querySelector(".settings-content");
  assert.deepEqual(content.children.map(child => child.children[0].textContent), [
    "Font size", "Theme", "Terminal", "Scroll wheel", "Background", "Clipboard", "Performance", "Advanced", "Diagnostics",
  ]);
  const advanced = f.settingsModal.querySelector("#settings-advanced");
  assert.equal(advanced.open, false);
  const labels = f.context.settingsFocusControls().map(control => control.getAttribute("aria-label"));
  assert.ok(labels.includes("Terminal font"));
  for (const label of ["Terminal renderer", "Paint coalescing", "Server output coalescing", "Terminal output backlog", "Terminal TERM value"]) {
    assert.ok(!labels.includes(label), label);
    assert.ok(advanced.querySelectorAll("select, input").some(control => control.getAttribute("aria-label") === label));
  }
  assert.equal(f.diagnosticsCreated, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.document.activeElement.getAttribute("aria-label"), "Close settings");
});

test("Tab and Shift+Tab wrap, ignore disabled and collapsed controls, and preserve normal movement", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  const first = f.document.activeElement;
  const diagnostics = f.settingsModal.querySelector("#settings-diagnostics");
  const last = diagnostics.children[0];
  assert.equal(key(f.context, "Tab", { shiftKey: true }).defaultPrevented, true);
  assert.equal(f.document.activeElement, last);
  assert.equal(key(f.context, "Tab").defaultPrevented, true);
  assert.equal(f.document.activeElement, first);
  assert.equal(key(f.context, "Tab").defaultPrevented, false);
  const advanced = f.settingsModal.querySelector("#settings-advanced");
  advanced.open = true;
  const input = advanced.querySelector("input");
  input.focus();
  assert.equal(key(f.context, "ArrowLeft").defaultPrevented, false);
  assert.equal(key(f.context, "Tab").defaultPrevented, false);
  input.disabled = true;
  assert.ok(!f.context.settingsFocusControls().includes(input));
  assert.equal(key(f.context, "Tab").defaultPrevented, true);
  assert.equal(f.document.activeElement, first);
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

test("redraw preserves focused preference, scroll, and disclosures; reopening resets them", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  f.settingsModal.querySelector("#settings-advanced").open = true;
  const controls = f.context.settingsFocusControls();
  controls.find(control => control.getAttribute("aria-label") === "Default font size").focus();
  f.settingsModal.querySelector(".settings-content").scrollTop = 175;
  f.context.renderSettingsModal();
  assert.equal(f.document.activeElement.getAttribute("aria-label"), "Default font size");
  assert.equal(f.settingsModal.querySelector(".settings-content").scrollTop, 175);
  assert.equal(f.settingsModal.querySelector("#settings-advanced").open, true);
  f.context.hideSettingsModal();
  f.context.openSettingsModal();
  f.flush();
  assert.equal(f.settingsModal.querySelector("#settings-advanced").open, false);
  assert.equal(f.settingsModal.querySelector(".settings-content").scrollTop, 0);
  assert.equal(f.settingsModal.hidden, false);
});

test("Diagnostics starts checks and metrics on disclosure, then cleans up on collapse and close", () => {
  const f = fixture();
  f.context.openSettingsModal();
  f.flush();
  let diagnostics = f.settingsModal.querySelector("#settings-diagnostics");
  diagnostics.open = true;
  diagnostics.dispatchEvent(new Event("toggle"));
  assert.equal(f.context.settingsDiagnosticsOpen(), true);
  assert.equal(f.diagnosticsCreated, 1);
  assert.equal(f.metrics.at(-1), true);
  assert.equal(f.intervals.size, 1);
  f.context.renderSettingsModal();
  assert.equal(f.intervals.size, 1);
  diagnostics = f.settingsModal.querySelector("#settings-diagnostics");
  const createdAfterRedraw = f.diagnosticsCreated;
  diagnostics.dispatchEvent(new Event("toggle"));
  assert.equal(f.diagnosticsCreated, createdAfterRedraw);
  diagnostics.open = false;
  diagnostics.dispatchEvent(new Event("toggle"));
  assert.equal(f.context.settingsDiagnosticsOpen(), false);
  assert.equal(f.metrics.at(-1), false);
  assert.equal(f.intervals.size, 0);
  diagnostics.open = true;
  diagnostics.dispatchEvent(new Event("toggle"));
  f.context.hideSettingsModal();
  assert.equal(f.metrics.at(-1), false);
  assert.equal(f.intervals.size, 0);
  diagnostics.dispatchEvent(new Event("toggle"));
  assert.equal(f.intervals.size, 0);
});
