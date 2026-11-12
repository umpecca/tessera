import assert from "node:assert/strict";
import test from "node:test";
import { createPalette } from "./command-palette.mjs";
import { createPaletteIcon } from "./command-palette-icons.mjs";

class Element extends EventTarget {
  children = [];
  attributes = {};
  className = "";
  value = "";
  constructor(tagName, namespaceURI) { super(); Object.assign(this, { tagName, namespaceURI }); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; if (name === "class") this.className = value; }
  get classList() {
    return {
      add: name => this.classList.toggle(name, true),
      toggle: (name, on) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        if (on) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
      },
    };
  }
  querySelectorAll(selector) { return this.children.filter(child => child.className.split(" ").includes(selector.slice(1))); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  scrollIntoView() { this.scrolled = true; }
  focus() {}
}

function fixture() {
  const document = { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag, ns), body: new Element("body") };
  const effects = [];
  const panes = ["terminal", "browser", "rdp", "vnc", "pending"].map((kind, i) => ({ id: kind, kind, title: `${kind} pane`, minimized: false, terminal: kind === "terminal" ? { term: {} } : undefined }));
  const navigation = { currentSessionName: "Main", currentSessionID: "main", sessions: [{ id: "main", name: "Main" }, { id: "other", name: "Other" }],
    userSelect: { hidden: true }, authMode: "system", multiUser: true, currentUser: "alice", userRoster: ["alice", "bob"],
    shortcutsUI: { items: [{ id: "shell", name: "My shell", code: "ZZ" }] }, openShortcuts() {},
    switchSession: session => effects.push(session.id), jumpToUser: name => effects.push(name), invokeShortcut: shortcut => effects.push(shortcut.id) };
  const phoneView = { active: false };
  const palette = createPalette({
    navigation: () => navigation, phone: () => ({ phoneView }),
    desktop: () => ({ rectangles: panes, getActivePane: () => panes[0], createTerminalPane: () => effects.push("new terminal") }),
    preferences: () => ({ deskbarButtonEnabled: true }), clipboard: () => ({ lastClipboardSave: { paths: ["saved.txt"] } }),
    geometry: () => ({ arrangeOutSnapshot: null }), menus: () => ({ workspaceMenuLabel: pane => pane.title, hideAllMenus() {} }),
    interactions: () => ({ appleKeyboardLayout: false }), settings: () => ({ openSettingsModal: () => effects.push("settings") }),
    switcher: () => ({ restorePaneFocusAfterOverlayDismiss() {} }),
  }, { document });
  palette.initializeCommandPalette(); palette.initializePaletteEntries(); palette.initializePaletteShortcutCodes();
  return { palette, document, effects, panes, navigation, phoneView };
}

test("all built-in commands have decorative local SVG icons, independent of their labels", () => {
  const f = fixture();
  for (const command of f.palette.buildPaletteCommands().filter(command => command.id && !command.shortcut)) {
    const icon = createPaletteIcon(command, f.document);
    assert.notEqual(icon.attributes["data-icon"], "window", command.id);
    assert.equal(icon.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(icon.attributes["aria-hidden"], "true");
    assert.equal(icon.attributes.focusable, "false");
    assert.equal(icon.attributes.viewBox, "0 0 24 24");
    assert.match(icon.children[0].attributes.d, /^M\d/);
    assert.equal(icon.attributes["aria-label"], undefined);
    assert.equal(icon.attributes.tabindex, undefined);
    assert.equal(createPaletteIcon({ ...command, label: "renamed" }, f.document).children[0].attributes.d, icon.children[0].attributes.d);
  }
});

test("dynamic entries use terminal, pane-type, session-switch and user icons", () => {
  const f = fixture();
  const icons = () => new Map(f.palette.buildPaletteCommands().map(command => [command.label, createPaletteIcon(command, f.document).attributes["data-icon"]]));
  let names = icons();
  for (const [label, name] of [["Create My shell", "terminal"], ["Switch Session: Other", "switch"], ["Switch user: bob", "user"],
    ["terminal pane", "terminal"], ["browser pane", "browser"], ["rdp pane", "remote"], ["vnc pane", "remote"], ["Phone View", "phone"]]) assert.equal(names.get(label), name);
  assert.equal(names.has("pending pane"), false);
  f.phoneView.active = true;
  assert.equal(icons().get("Desktop View"), "desktop");
  f.panes[0].isFull = true; f.panes[0].minimized = true;
  const toggles = f.palette.buildPaletteCommands().filter(command => ["maximize-toggle", "minimize-toggle"].includes(command.id));
  assert.equal(toggles.length, 2);
  for (const command of toggles) assert.equal(createPaletteIcon(command, f.document).attributes["data-icon"], "restore");
  assert.equal(createPaletteIcon({ id: "future-command", icon: "unknown" }, f.document).children[0].attributes.d,
    createPaletteIcon({}, f.document).children[0].attributes.d, "unknown icons have a safe generic fallback");
});

test("rendered icons preserve labels, hints, codes and keyboard/pointer activation", () => {
  const f = fixture(), p = f.palette;
  p.openCommandPalette();
  assert.equal(p.commandPaletteList.children.length, 12);
  for (const row of p.commandPaletteList.children) {
    const [label, meta] = row.children;
    assert.equal(label.children[0].tagName, "svg");
    assert.equal(label.children[0].attributes["aria-hidden"], "true");
    assert.equal(label.children[1].textContent, p.paletteEntries[p.commandPaletteList.children.indexOf(row)].label);
    assert.equal(meta.className, "command-palette-item-meta");
  }
  p.commandPaletteInput.value = "S"; p.renderPaletteResults();
  assert.equal(p.paletteEntries[0].id, "settings");
  assert.equal(p.commandPaletteList.children[0].children[1].children[0].textContent, "S");
  assert.deepEqual(f.effects, [], "typing only filters, never activates");
  p.handlePaletteKeyboard({ key: "Enter", preventDefault() {} });
  assert.deepEqual(f.effects, ["settings"]); assert.equal(p.commandPalette.hidden, true);
  p.openCommandPalette();
  p.handlePaletteKeyboard({ key: "ArrowDown", preventDefault() {} });
  assert.equal(p.paletteSelection, 1); assert.equal(p.commandPaletteList.children[1].scrolled, true);
  assert.match(p.commandPaletteList.children[1].className, /is-selected/);
  p.handlePaletteKeyboard({ key: "ArrowUp", preventDefault() {} }); assert.equal(p.paletteSelection, 0);
  p.commandPaletteInput.value = "ZZ"; p.renderPaletteResults();
  assert.equal(p.paletteEntries[0].id, "shortcut:shell");
  p.commandPaletteList.children[0].dispatchEvent(new Event("click"));
  assert.deepEqual(f.effects, ["settings", "shell"]);
  p.commandPaletteInput.value = "no matching command 12345"; p.renderPaletteResults();
  assert.equal(p.paletteEntries.length, 0);
  assert.equal(p.commandPaletteList.children[0].textContent, "No matching commands");
});
