import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { CommandWheel, commandWheelGroups, commandWheelSector } from "./command-wheel.mjs";

const commands = [
  { id: "new-browser", label: "New Browser", code: "NB" },
  { id: "new-terminal", label: "New Terminal", code: "NN" },
  { id: "dock-top", label: "Dock Top", code: "DT" },
  { id: "destroy-window", label: "Destroy Window", code: "DD" },
  { id: "settings", label: "Settings", code: "S" },
  { label: "A runtime window", run() {} },
];

function fixture() {
  const wheel = Object.assign(Object.create(CommandWheel.prototype), {
    element: { hidden: false }, groups: commandWheelGroups(commands), prefix: "",
    status: { textContent: "" }, rendered: 0, invoked: [], closed: 0,
    render() { this.rendered++; },
  });
  wheel.onCommand = command => { wheel.invoked.push(command); wheel.element.hidden = true; };
  wheel.onClose = () => { wheel.closed++; wheel.element.hidden = true; };
  return wheel;
}

function key(value, modifiers = {}) {
  return { key: value, ...modifiers, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

test("groups contain only available fixed codes, preserving command identity and deterministic group order", () => {
  const groups = commandWheelGroups([...commands, { label: "duplicate", code: "NB" }, { code: "bad" }]);
  assert.deepEqual(groups.map(group => group.key), ["N", "D", "S"]);
  assert.deepEqual(groups[0].commands, commands.slice(0, 2));
  assert.equal(groups[1].commands[1], commands[3]);
  assert.deepEqual(commandWheelGroups(commands.filter(command => !command.code?.startsWith("D"))).map(group => group.key), ["N", "S"]);
});

test("annular wedge geometry stays inside the wheel and excludes the center hub", () => {
  for (const angle of [-174, -90, -45, 90, 225]) {
    const clip = commandWheelSector(angle, 28, 34.5, 49);
    const points = [...clip.matchAll(/([\d.]+)% ([\d.]+)%/g)].map(match => [Number(match[1]), Number(match[2])]);
    assert.ok(points.length > 20);
    for (const [x, y] of points) {
      assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100);
      const radius = Math.hypot(x - 50, y - 50);
      assert.ok(radius > 34 && radius < 49.01);
    }
  }
});

test("typing N then B dispatches the original command exactly once and isolates keys", () => {
  const wheel = fixture();
  const first = key("n"), second = key("B", { shiftKey: true });
  wheel.handleKeyboard(first);
  assert.equal(wheel.prefix, "N");
  assert.equal(wheel.invoked.length, 0);
  wheel.handleKeyboard(second);
  wheel.handleKeyboard(second);
  wheel.chooseKey("B");
  assert.deepEqual(wheel.invoked, [commands[0]]);
  assert.ok(first.prevented && first.stopped && second.prevented && second.stopped);
});

test("typing S opens Settings directly, including after a hover preview", () => {
  for (const hovered of [false, true]) {
    const wheel = fixture();
    if (hovered) wheel.chooseGroup("S", false);
    assert.equal(wheel.invoked.length, 0);
    const event = key("s");
    wheel.handleKeyboard(event);
    wheel.handleKeyboard(event);
    assert.deepEqual(wheel.invoked, [commands[4]]);
    assert.ok(event.prevented && event.stopped);
  }
});

test("Settings hover never dispatches, while activation runs it once", () => {
  const wheel = fixture();
  wheel.chooseGroup("S", false);
  wheel.chooseGroup("S", false);
  assert.equal(wheel.prefix, "S");
  assert.equal(wheel.groupPinned, false);
  assert.equal(wheel.invoked.length, 0);
  wheel.chooseGroup("S");
  wheel.chooseGroup("S");
  assert.deepEqual(wheel.invoked, [commands[4]]);
});

test("single-key Settings respects input guards and does not interrupt another typed group", () => {
  const wheel = fixture();
  for (const modifiers of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    wheel.handleKeyboard(key("s", modifiers));
  }
  wheel.handleKeyboard(key("n"));
  wheel.handleKeyboard(key("s"));
  assert.equal(wheel.prefix, "N");
  assert.equal(wheel.invoked.length, 0);
  wheel.handleKeyboard(key("Backspace"));
  wheel.handleKeyboard(key("s"));
  assert.deepEqual(wheel.invoked, [commands[4]]);
});

test("invalid keys, modifier combinations, composition, and repeat never invoke a command", () => {
  const wheel = fixture();
  wheel.handleKeyboard(key("z"));
  assert.match(wheel.status.textContent, /not an available first key/);
  wheel.handleKeyboard(key("n"));
  wheel.handleKeyboard(key("d"));
  assert.match(wheel.status.textContent, /not a next key for N/);
  for (const modifiers of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    wheel.handleKeyboard(key("w", modifiers));
  }
  assert.equal(wheel.prefix, "N");
  assert.equal(wheel.invoked.length, 0);
});

test("parent selection switches branches, while Backspace returns to first keys and Escape dismisses", () => {
  const wheel = fixture();
  wheel.chooseGroup("N");
  wheel.chooseGroup("D");
  assert.equal(wheel.prefix, "D");
  wheel.chooseGroup("Z");
  assert.equal(wheel.prefix, "D");
  wheel.handleKeyboard(key("Backspace"));
  assert.equal(wheel.prefix, "");
  assert.equal(wheel.closed, 0);
  wheel.handleKeyboard(key("Backspace", { repeat: true }));
  assert.equal(wheel.closed, 0);
  wheel.handleKeyboard(key("Escape"));
  assert.equal(wheel.closed, 1);
});

test("hover previews can be pinned by a click or typed key, and Backspace releases the selection", () => {
  const wheel = fixture();
  wheel.chooseGroup("N", false);
  assert.equal(wheel.groupPinned, false);
  const renders = wheel.rendered;
  wheel.chooseGroup("N");
  assert.equal(wheel.groupPinned, true);
  assert.equal(wheel.rendered, renders);
  wheel.handleKeyboard(key("Backspace"));
  assert.equal(wheel.groupPinned, false);
  assert.equal(wheel.prefix, "");
});

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const codesStart = source.indexOf("const paletteShortcutCodes = {");
const codesEnd = source.indexOf("\n};", codesStart) + 3;
const paletteShortcutCodes = vm.runInNewContext(source.slice(codesStart, codesEnd) + "\npaletteShortcutCodes");
function appFunction(name, globals) {
  globals.shortcutsUI ||= { element: { hidden: true } };
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf("\n}\n", start) + 2;
  return vm.runInNewContext("(" + source.slice(start, end) + ")", globals);
}
function overlays() {
  return Object.fromEntries(["settingsModal", "localHTTPSModal", "renameWindowModal", "sessionsModal", "sessionActionModal",
    "serverUpdateModal", "serverConnectionModal", "workspaceConflictModal", "helpModal", "directoryBrowser",
    "userSelect", "commandPalette", "commandWheel", "windowList"].map(name => [name, { hidden: true }]));
}

// Only the DOM operations used to render the wheel and palette are needed.
function element() {
  const classes = new Set();
  return {
    children: [], style: {}, dataset: {}, attributes: {}, listeners: {},
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll(selector) { return this.children.filter(child => child.className?.split(" ").includes(selector.slice(1))); },
    scrollIntoView() {},
    focus() {},
  };
}

test("the rendered Settings wedge activates directly without a second-key wedge", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: element };
  try {
    const wheel = fixture();
    wheel.panel = element();
    wheel.render = CommandWheel.prototype.render;
    wheel.chooseGroup("S", false);
    const ring = wheel.panel.children[0];
    const settings = ring.children.find(button => button.dataset?.group === "S");
    assert.equal(settings.attributes["aria-label"], "S: Settings");
    assert.equal(settings.attributes["aria-pressed"], undefined);
    assert.equal(ring.children.some(button => button.className.includes("command-wheel-command")), false);
    assert.equal(wheel.status.textContent, "Press S or click Settings.");
    settings.listeners.click();
    assert.deepEqual(wheel.invoked, [commands[4]]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("palette codes map Settings to S and continue matching two-letter commands", () => {
  const assign = appFunction("assignPaletteShortcutCodes", { paletteShortcutCodes });
  const available = commands.map(command => ({ ...command }));
  assign(available);
  const match = appFunction("findPaletteCodeMatch", {});
  assert.equal(match(" s ", available), available[4]);
  assert.equal(match("nb", available), available[0]);
  for (const query of ["", "ST", "settings", "N", "SS", "123"]) {
    assert.equal(match(query, available), null);
  }
});

function sessionPaletteCommands(activePane, onSessions = () => {}) {
  const globals = {
    browseLocalPortHelpCommand: { id: "browse-local-port-help", label: "Browse local port" },
    deskbarButtonEnabled: true, currentSessionName: "Main", currentSessionID: "main",
    sessions: [{ id: "main", name: "Main" }, { id: "other", name: "Other" }],
    rectangles: activePane ? [activePane] : [], getActivePane: () => activePane,
    arrangeOutSnapshot: null, workspaceMenuLabel: pane => pane.title,
    window: {}, multiUser: false, openSessionsModal: onSessions,
    openShortcuts() {}, shortcutsUI: { items: [] },
  };
  const available = appFunction("buildPaletteCommands", globals)();
  appFunction("assignPaletteShortcutCodes", { paletteShortcutCodes })(available);
  return available;
}

function paletteFixture(available) {
  const invoked = [];
  const globals = {
    commandPaletteInput: { value: "" }, buildPaletteCommands: () => available,
    assignPaletteShortcutCodes: appFunction("assignPaletteShortcutCodes", { paletteShortcutCodes }),
    findPaletteCodeMatch: appFunction("findPaletteCodeMatch", {}),
    paletteScore: appFunction("paletteScore", {}),
    document: { createElement: element }, commandPaletteList: element(),
    runPaletteCommand: command => invoked.push(command),
    window: { setTimeout() { assert.fail("Typing must not schedule a command"); } },
  };
  for (const name of ["renderPaletteResults", "setPaletteSelection", "movePaletteSelection", "runPaletteSelection", "handlePaletteKeyboard"]) {
    globals[name] = appFunction(name, globals);
  }
  return { globals, invoked, search(query) {
    globals.commandPaletteInput.value = query;
    globals.renderPaletteResults();
  } };
}

test("searching se highlights Settings first; Tessera Sessions remains searchable", () => {
  for (const pane of [null, { kind: "terminal", title: "Main terminal" }]) {
    const available = sessionPaletteCommands(pane);
    const { globals, search } = paletteFixture(available);
    search("se");
    assert.equal(globals.paletteSelection, 0);
    assert.equal(globals.paletteEntries[0].id, "settings");
    assert.equal(globals.commandPaletteList.children[0].children[0].textContent, "Settings...");
    assert.ok(globals.paletteEntries.some(command => command.id === "sessions"));
    if (pane) assert.ok(globals.paletteEntries.some(command => command.id === "rename-window"));
    for (const search of ["sessions", "tessera sessions"]) {
      globals.commandPaletteInput.value = search;
      globals.renderPaletteResults();
      assert.equal(globals.paletteEntries[0].id, "sessions");
      assert.equal(globals.paletteEntries[0].label, "Tessera Sessions...");
    }
  }
});

test("Tessera Sessions uses TS in the palette and wheel, with keyboard and pointer dispatch", () => {
  let sessionOpens = 0;
  const available = sessionPaletteCommands(null, () => sessionOpens++);
  const sessions = available.find(command => command.id === "sessions");
  const match = appFunction("findPaletteCodeMatch", {});
  assert.equal(match("ts", available), sessions);
  assert.equal(match("s", available).id, "settings");
  sessions.run();
  assert.equal(sessionOpens, 1);
  const wheel = fixture();
  wheel.groups = commandWheelGroups(available);
  wheel.handleKeyboard(key("t"));
  assert.equal(wheel.prefix, "T");
  assert.equal(wheel.invoked.length, 0);
  wheel.handleKeyboard(key("s"));
  assert.deepEqual(wheel.invoked, [sessions]);

  const previousDocument = globalThis.document;
  globalThis.document = { createElement: element };
  try {
    const pointerWheel = fixture();
    pointerWheel.groups = commandWheelGroups(available);
    pointerWheel.panel = element();
    pointerWheel.render = CommandWheel.prototype.render;
    pointerWheel.render();
    const sessionsGroup = pointerWheel.panel.children[1].children[0];
    assert.equal(sessionsGroup.children[0].textContent, "T");
    assert.equal(sessionsGroup.children[1], " Tessera Sessions");
    sessionsGroup.listeners.click();
    assert.equal(pointerWheel.centerLabel.textContent, "Tessera Sessions");
    const choice = pointerWheel.panel.children[0].children.find(button => button.dataset?.code === "TS");
    assert.equal(choice.title, "Tessera Sessions...");
    assert.equal(choice.children[0].children[1].children[0].textContent, "Tessera Sessions");
    choice.listeners.click();
    assert.deepEqual(pointerWheel.invoked, [sessions]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("pausing on palette shortcuts never runs a command; Enter runs the highlighted result", async () => {
  const { globals, invoked, search } = paletteFixture(sessionPaletteCommands({ kind: "terminal", title: "Main" }));
  for (const query of ["s", "nb", "oo", "ts", "dd"]) {
    search(query);
    assert.equal(invoked.length, 0);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(invoked.length, 0);
  search("s");
  search("sessions");
  assert.equal(invoked.length, 0);
  globals.handlePaletteKeyboard(key("Enter"));
  assert.equal(invoked[0].id, "sessions");
});

test("exact codes rank first and Enter runs the visibly selected command", () => {
  const { globals, invoked, search } = paletteFixture(sessionPaletteCommands({ kind: "terminal", title: "Main" }));
  for (const [query, id] of [["nb", "new-browser"], [" OO ", "arrange-out"], ["S", "settings"], ["ts", "sessions"], ["dd", "destroy-window"]]) {
    search(query);
    assert.equal(globals.paletteEntries[0].id, id);
    const first = globals.commandPaletteList.children[0];
    assert.ok(first.classList.contains("is-selected"));
    assert.equal(first.children[0].textContent, globals.paletteEntries[0].label);
    const event = key("Enter");
    globals.handlePaletteKeyboard(event);
    assert.ok(event.prevented);
    assert.equal(invoked.at(-1).id, id);
  }
});

test("keyboard and pointer selection override a typed shortcut when Enter runs", () => {
  for (const navigation of ["keyboard", "pointer"]) {
    const { globals, invoked, search } = paletteFixture(sessionPaletteCommands({ kind: "terminal", title: "Main" }));
    search("s");
    const alternative = globals.paletteEntries[1];
    assert.notEqual(alternative.id, "settings");
    if (navigation === "keyboard") globals.handlePaletteKeyboard(key("ArrowDown"));
    else globals.commandPaletteList.children[1].listeners.pointermove();
    assert.equal(globals.paletteSelection, 1);
    assert.ok(globals.commandPaletteList.children[1].classList.contains("is-selected"));
    assert.equal(globals.commandPaletteList.children[0].classList.contains("is-selected"), false);
    assert.equal(invoked.length, 0);
    globals.handlePaletteKeyboard(key("Enter"));
    assert.deepEqual(invoked, [alternative]);
  }
});

test("search aliases find commands by familiar names without changing visible labels", () => {
  const { globals, invoked, search } = paletteFixture(sessionPaletteCommands({ kind: "terminal", title: "Main" }));
  for (const [query, id, label] of [
    ["preferences", "settings", "Settings..."],
    ["Preferences", "settings", "Settings..."],
    ["rename", "rename-window", "Set Window Title..."],
    ["rename window", "rename-window", "Set Window Title..."],
    ["close", "destroy-window", "Destroy Window"],
    ["close window", "destroy-window", "Destroy Window"],
  ]) {
    search(query);
    assert.equal(globals.paletteEntries[0].id, id);
    assert.equal(globals.commandPaletteList.children[0].children[0].textContent, label);
    assert.equal(globals.paletteEntries.filter(command => command.id === id).length, 1);
    globals.commandPaletteList.children[0].listeners.click();
    assert.equal(invoked.at(-1).id, id);
  }
});

test("unavailable commands and empty results cannot be invoked by code or alias; composition owns Enter", () => {
  const { globals, invoked, search } = paletteFixture(sessionPaletteCommands(null));
  for (const query of ["oo", "dd", "rename", "close"]) {
    search(query);
    assert.equal(globals.paletteEntries.some(command => ["arrange-out", "destroy-window", "rename-window"].includes(command.id)), false);
    assert.equal(invoked.length, 0);
  }
  search("no-such-command");
  assert.equal(globals.paletteEntries.length, 0);
  assert.equal(globals.commandPaletteList.children[0].textContent, "No matching commands");
  globals.handlePaletteKeyboard(key("ArrowDown"));
  globals.handlePaletteKeyboard(key("Enter"));
  assert.equal(invoked.length, 0);
  search("s");
  globals.handlePaletteKeyboard(key("Enter", { isComposing: true }));
  assert.equal(invoked.length, 0);
  globals.handlePaletteKeyboard(key("Enter"));
  assert.equal(invoked[0].id, "settings");
});

test("Ctrl/Cmd+; opens the wheel, Ctrl/Cmd+K still opens the palette, and open dialogs own input", () => {
  const globals = overlays();
  let wheelOpens = 0, paletteOpens = 0;
  globals.toggleCommandWheel = () => wheelOpens++;
  globals.toggleCommandPalette = () => paletteOpens++;
  const resolve = appFunction("paneShortcutAction", globals);
  resolve({ key: ";", ctrlKey: true }).run();
  resolve({ key: ";", metaKey: true }).run();
  resolve({ key: "ö", code: "Semicolon", ctrlKey: true }).run();
  assert.equal(wheelOpens, 3);
  globals.commandWheel.hidden = false;
  resolve({ key: "k", ctrlKey: true }).run();
  assert.equal(paletteOpens, 1);
  for (const keys of [key("Backspace", { ctrlKey: true }), key("Enter", { ctrlKey: true }), key("t", { ctrlKey: true }), key(";", { ctrlKey: true, repeat: true })]) {
    assert.equal(resolve(keys), null);
  }
  globals.commandWheel.hidden = true;
  globals.settingsModal.hidden = false;
  assert.equal(resolve({ key: ";", ctrlKey: true }), null);
});

test("dismissal defers pane focus and preserves a handoff to the palette or a modal", () => {
  const globals = overlays();
  const callbacks = [];
  let focuses = 0;
  Object.assign(globals, {
    window: { requestAnimationFrame: callback => callbacks.push(callback) },
    document: { body: {}, activeElement: null },
    focusPane() { focuses++; }, getActivePane: () => ({}),
  });
  globals.document.activeElement = globals.document.body;
  const restore = appFunction("restorePaneFocusAfterOverlayDismiss", globals);
  const overlay = { hidden: true, contains: () => false };
  restore(overlay); callbacks.shift()();
  assert.equal(focuses, 1);
  for (const modal of [globals.commandPalette, globals.commandWheel, globals.settingsModal, globals.renameWindowModal]) {
    modal.hidden = false;
    restore(overlay); callbacks.shift()();
    modal.hidden = true;
  }
  assert.equal(focuses, 1);
});

test("browser panes relay the wheel opener without forwarding ordinary or destructive keys", () => {
  const proxy = readFileSync(new URL("../internal/httpapi/browser_proxy.go", import.meta.url), "utf8");
  const script = proxy.slice(proxy.indexOf("const relayKeys=")).split("\n").slice(0, 2).join("\n");
  let handler;
  const posted = [];
  vm.runInNewContext(script, {
    addEventListener: (type, callback) => { handler = callback; },
    parent: { postMessage: message => posted.push(message) },
  });
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    const event = key(";", { ...modifiers, code: "Semicolon" });
    handler(event);
    assert.ok(event.prevented);
  }
  for (const event of [key(";"), key("n"), key("w"), key("Backspace", { ctrlKey: true }), key(";", { ctrlKey: true, altKey: true })]) {
    handler(event);
    assert.equal(event.prevented, undefined);
  }
  assert.equal(posted.length, 2);
});
