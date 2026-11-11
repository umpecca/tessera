import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalInput } from "./terminal-input-bridge.mjs";
import { createPhone } from "./phone-workspace.mjs";
import { createTerminal } from "./terminal-view.mjs";

function surface() {
  const listeners = new Map(), captured = new Set();
  return {
    scrollTop: 100,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    setPointerCapture(id) { captured.add(id); }, hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id),
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) }),
    dispatch(type, fields = {}) {
      const event = { type, currentTarget: this, pointerType: "touch", pointerId: 1, clientX: 100, clientY: 200, button: 0, buttons: 1,
        preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...fields };
      for (const listener of listeners.get(type) || []) listener(event);
      return event;
    },
    get listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}

function fixture() {
  const container = surface(), reading = surface(), messages = [], local = [], keys = [], focused = [];
  const document = surface(), window = surface();
  container.contains = node => node === container;
  reading.contains = node => node === reading;
  let tracking = true;
  const phoneView = { active: true, openPaneID: "pane", mode: "scroll", readingView: reading, input: { direct: true } };
  const term = { cols: 80, rows: 30, renderer: { getMetrics: () => ({ height: 20 }) },
    wasmTerm: { isAlternateScreen: () => true }, hasMouseTracking: () => tracking,
    hasSelection: () => true, clearSelection: () => assert.fail("pre-existing selection was cleared"),
    scrollWheelLines: lines => local.push(lines), input: key => keys.push(key), focus: () => focused.push("focus"),
  };
  const rect = { id: "pane", kind: "terminal", terminalContainer: container };
  const input = createTerminalInput({ phone: () => ({ phoneView }), preferences: () => ({}),
    interactions: () => ({ appleKeyboardLayout: false }), menus: () => ({ hideFloatingMenus() {} }),
    desktop: () => ({ setActivePane() {} }) }, { WebSocket: { OPEN: 1 }, document, window });
  const bridge = input.attachTerminalMouseBridge(rect, term, { readyState: 1, send: data => messages.push(JSON.parse(data)) });
  return { input, bridge, term, phoneView, container, reading, document, window, messages, local, keys, focused, tracking: on => { tracking = on; } };
}

test("a fresh primary touch recovers Select after a cancelled finger's release is lost", () => {
  for (const interrupted of ["selection", "scroll", "mode"]) {
    const f = fixture(), selected = [];
    f.phoneView.mode = "interaction"; f.phoneView.selecting = true;
    f.term.clearSelection = () => {};
    f.term.selectionIntegration = { beginPointerSelection: event => { selected.push(event.pointerId); return true; },
      movePointerSelection() {}, endPointerSelection() {}, cancelDrag() {} };
    f.container.dispatch("pointerdown", { isPrimary: true });
    if (interrupted === "scroll") f.container.dispatch("pointerdown", { pointerId: 2, isPrimary: false });
    if (interrupted === "mode") f.bridge.cancelTouchGesture();
    // iOS omits the old pointerup/cancel after OS UI or a capture/layout change.
    f.container.dispatch("pointerdown", { pointerId: 9, isPrimary: true });
    f.container.dispatch("pointermove", { pointerId: 9, clientY: 160 });
    f.container.dispatch("pointerup", { pointerId: 9 });
    assert.deepEqual(selected, [1, 9], interrupted);
    const before = f.messages.length;
    f.container.dispatch("pointerdown", { pointerId: 10, isPrimary: true });
    f.container.dispatch("pointerdown", { pointerId: 11, isPrimary: false });
    f.container.dispatch("pointermove", { pointerId: 10, clientY: 160 });
    f.container.dispatch("pointermove", { pointerId: 11, clientY: 160 });
    assert.ok(f.messages.length > before, "two-finger scrolling recovers too");
    assert.deepEqual(f.keys, []); assert.deepEqual(f.focused, []);
    f.bridge.dispose();
  }
});

test("outside pointer releases and native all-fingers-up clear cancelled or phantom touches", () => {
  for (const end of ["pointerup", "pointercancel", "touchend", "touchcancel"]) {
    const f = fixture();
    f.container.dispatch("pointerdown");
    f.bridge.cancelTouchGesture();
    f.document.dispatch(end, { touches: [], target: {} });
    // Even without primary-pointer metadata, a new gesture must work.
    f.container.dispatch("pointerdown", { pointerId: 9 });
    f.container.dispatch("pointermove", { pointerId: 9, clientY: 160 });
    assert.deepEqual(f.local, [2.7], end);
    f.bridge.dispose();
    assert.equal(f.document.listenerCount, 0);
    assert.equal(f.window.listenerCount, 0);
  }
});

test("interruption suppresses remaining fingers, but a fresh gesture recovers after blur or hidden-page return", () => {
  for (const interruption of ["blur", "visibilitychange"]) {
    const f = fixture();
    f.container.dispatch("pointerdown", { isPrimary: true });
    if (interruption === "blur") f.window.dispatch("blur");
    else { f.document.hidden = true; f.document.dispatch("visibilitychange"); f.document.hidden = false; }
    f.container.dispatch("pointerdown", { pointerId: 2, isPrimary: false });
    f.container.dispatch("pointermove", { pointerId: 2, clientY: 160 });
    f.container.dispatch("pointermove", { clientY: 160 });
    assert.deepEqual(f.local, [], "held fingers must not restart after interruption");
    f.container.dispatch("pointerdown", { pointerId: 9, isPrimary: true });
    f.container.dispatch("pointermove", { pointerId: 9, clientY: 160 });
    assert.deepEqual(f.local, [2.7], interruption);
    assert.deepEqual(f.keys, []); assert.deepEqual(f.focused, []);
    f.bridge.dispose();
  }
});

test("Select routes one finger to local cells and safely cancels release/lost capture/mode changes", () => {
  for (const finish of ["pointerup", "pointercancel", "lostpointercapture", "mode"]) {
    const f = fixture(), calls = [];
    f.phoneView.mode = "interaction";
    f.phoneView.selecting = true;
    f.phoneView.input.direct = false;
    f.term.selectionIntegration = {
      beginPointerSelection: event => { calls.push(["begin", event.pointerId]); return true; },
      movePointerSelection: event => calls.push(["move", event.pointerId]),
      endPointerSelection: () => calls.push(["end"]),
    };
    f.container.dispatch("pointerdown");
    f.container.dispatch("pointermove", { clientY: 180 });
    assert.equal(f.container.hasPointerCapture(1), true);
    if (finish === "mode") f.bridge.cancelTouchGesture();
    else f.container.dispatch(finish);
    f.container.dispatch("pointermove", { clientY: 160 });
    f.container.dispatch("mousedown"); f.container.dispatch("click");
    for (const type of ["mousemove", "mouseleave", "dblclick"]) assert.equal(f.container.dispatch(type).prevented, true);
    f.container.dispatch("contextmenu"); f.container.dispatch("touchend", { touches: [] });
    assert.deepEqual(calls, [["begin", 1], ["move", 1], ["end"]], finish);
    assert.equal(f.container.hasPointerCapture(1), false);
    assert.deepEqual(f.messages, []); assert.deepEqual(f.keys, []); assert.deepEqual(f.focused, []);
    f.bridge.dispose();
  }
});

test("selection touch defaults are cancelled and stale direct-typing state cannot refocus the terminal", () => {
  const f = fixture();
  f.phoneView.mode = "interaction";
  f.phoneView.selecting = true;
  assert.equal(f.phoneView.input.direct, true, "exercise even a stale Type flag");
  assert.equal(f.container.dispatch("touchstart", { touches: [{}] }).prevented, true);
  f.container.dispatch("touchend", { touches: [] });
  assert.deepEqual(f.focused, []);
  assert.equal(f.input.phoneTypingInto({ id: "pane" }), false);
  f.phoneView.selecting = false;
  assert.equal(f.input.phoneTypingInto({ id: "pane" }), true, "Type works again after Done");
  assert.equal(Boolean(f.container.dispatch("touchstart", { touches: [{}] }).prevented), false);
  f.bridge.dispose();
});

test("selection changes toggle the terminal input lock before clearing/starting another drag", () => {
  const calls = [], state = { term: { clearSelection: () => calls.push("clear"),
    selectionIntegration: { setInputSuppressed: on => calls.push(["input locked", on]) } } };
  const phone = createPhone({ desktop: () => ({ rectangles: [{ id: "a", terminal: state }] }),
    terminal: () => ({ terminalFits: { cancelGridSize: () => calls.push("hold size") } }) });
  phone.phoneView = { active: true, openPaneID: "a", mode: "interaction", input: { direct: true } };
  phone.changePhoneSelection("a", true);
  phone.changePhoneSelection("a", false);
  assert.deepEqual(calls, ["hold size", "clear", ["input locked", true], "hold size", "clear", ["input locked", false]]);
});

test("phone canvas input stays locked in Interact and Scroll until an explicit Type action", () => {
  const locked = [], phone = createPhone({ desktop: () => ({ rectangles: [{ id: "a", terminal: { term: {
    selectionIntegration: { setInputSuppressed: on => locked.push(on) },
  } } }] }) });
  phone.phoneView = { active: true, openPaneID: "a", mode: "interaction", selecting: false, input: { direct: false } };
  phone.syncPhoneTerminalInput("a");
  phone.syncPhoneTerminalInput("a", { direct: true });
  phone.phoneView.input.direct = true;
  phone.syncPhoneTerminalInput("a", { selecting: true });
  phone.phoneView.mode = "scroll";
  phone.syncPhoneTerminalInput("a");
  phone.phoneView.active = false;
  phone.syncPhoneTerminalInput("a");
  assert.deepEqual(locked, [true, false, true, true, false]);
});

test("Interact forwards Fresh mouse selection without focusing input, unless Type was explicitly enabled", () => {
  for (const direct of [false, true]) {
    const f = fixture(); f.phoneView.mode = "interaction"; f.phoneView.input.direct = direct;
    f.container.dispatch("pointerdown", { isPrimary: true });
    f.container.dispatch("pointermove", { clientY: 160 });
    f.container.dispatch("pointerup", { clientY: 160 });
    assert.ok(f.messages.length >= 2, "Fresh still gets its application press/drag/release");
    assert.deepEqual(f.focused, direct ? ["focus"] : []);
    assert.equal(f.container.dispatch("mousedown").prevented === true, !direct);
    f.bridge.dispose();
  }
});

test("Select two-finger scrolling ends local selection and uses TUI wheel only", () => {
  for (const tracking of [true, false]) {
    const f = fixture(); f.phoneView.mode = "interaction"; f.phoneView.selecting = true;
    f.tracking(tracking);
    let ended = 0;
    f.term.clearSelection = () => {};
    f.term.selectionIntegration = { beginPointerSelection: () => true, endPointerSelection: () => ended++ };
    f.container.dispatch("pointerdown");
    f.container.dispatch("pointerdown", { pointerId: 2 });
    f.container.dispatch("pointermove", { clientY: 160 });
    f.container.dispatch("pointermove", { pointerId: 2, clientY: 160 });
    assert.equal(ended, 1);
    assert.equal(f.messages.length > 0, tracking);
    assert.ok(f.messages.every(message => message.data.startsWith("\x1b[<65;")));
    assert.deepEqual(f.keys, []); assert.deepEqual(f.local, []);
    f.bridge.dispose();
  }
});

test("Copy reads the canvas selection synchronously, reports clipboard fallback and never focuses", async () => {
  let selected = "fixture text";
  const notices = [], copied = [];
  const phone = createPhone({ desktop: () => ({ rectangles: [{ id: "a", terminal: { term: {
    getSelection: () => selected, focus: () => assert.fail("Copy focused terminal"),
  } } }] }), clipboard: () => ({ writeClipboardText: async text => { copied.push(text); return false; } }) });
  phone.phoneView = { active: true, openPaneID: "a", selecting: false, input: { showNotice: text => notices.push(text) } };
  const pending = phone.copyPhoneSelection("a");
  selected = "";
  await pending;
  assert.deepEqual(copied, ["fixture text"]);
  assert.match(notices[0], /system clipboard unavailable/);
  await phone.copyPhoneSelection("a");
  assert.match(notices[1], /Drag across/);
});

test("mobile Paste sends sanitized clipboard text as a paste without Enter, keys, keyboard focus or draft edits", async () => {
  const pasted = [], notices = [], calls = [];
  const term = { paste: text => pasted.push(text), scrollToBottom: () => calls.push("bottom"), focus: () => assert.fail("Paste focused terminal"),
    input: () => assert.fail("Paste synthesized keys") };
  const phone = createPhone({ desktop: () => ({ rectangles: [{ id: "a", kind: "terminal", terminal: { term } }] }),
    clipboard: () => ({ readClipboardText: async options => { assert.deepEqual(options, { allowFocus: false }); return "one\ntwo\x1b[201~"; } }) });
  phone.phoneView = { active: true, openPaneID: "a", mode: "interaction", selecting: true,
    setSelecting: on => calls.push(["selecting", on]), input: { field: { value: "keep draft" }, showNotice: text => notices.push(text) } };
  assert.equal(await phone.pastePhoneClipboard("a"), true);
  assert.deepEqual(pasted, ["one\ntwo"]);
  assert.deepEqual(calls, [["selecting", false], "bottom"]);
  assert.equal(phone.phoneView.input.field.value, "keep draft");
  assert.deepEqual(notices, ["Pasted."]);
});

test("pending mobile clipboard reads cannot paste into a changed pane, mode or replacement terminal", async () => {
  for (const change of ["pane", "scroll", "replace", "cancel", "inactive"]) {
    let resolve;
    const rect = { id: "a", kind: "terminal", terminal: { term: { paste: () => assert.fail(`late paste after ${change}`) } } };
    const phone = createPhone({ desktop: () => ({ rectangles: [rect] }),
      terminal: () => ({ terminalFits: { cancelGridSize() {} } }),
      clipboard: () => ({ readClipboardText: () => new Promise(done => { resolve = done; }) }) });
    phone.phoneView = { active: true, openPaneID: "a", mode: "interaction", setSelecting() {}, input: { showNotice() {} } };
    const pending = phone.pastePhoneClipboard("a");
    if (change === "pane") phone.phoneView.openPaneID = "b";
    if (change === "scroll") phone.phoneView.mode = "scroll";
    if (change === "replace") rect.terminal.term = {};
    if (change === "cancel") phone.changePhoneInteractionMode("a");
    if (change === "inactive") phone.phoneView.active = false;
    resolve("late fixture");
    assert.equal(await pending, false);
  }
});

test("mobile Paste reports empty, denied and internal-fallback clipboards without sending shortcut keys", async () => {
  for (const scenario of ["empty", "denied", "fallback", "scroll"]) {
    const notices = [], pasted = [], clipboard = { clipboardReadFellBack: scenario === "fallback", readClipboardText: async () => {
      if (scenario === "denied") throw new Error("Permission denied");
      if (scenario === "scroll") assert.fail("Scroll mode read clipboard for paste");
      return scenario === "fallback" ? "last copy" : "";
    } };
    const rect = { id: "a", kind: "terminal", terminal: { term: { paste: text => pasted.push(text) } } };
    const phone = createPhone({ desktop: () => ({ rectangles: [rect] }),
      clipboard: () => clipboard });
    phone.phoneView = { active: true, openPaneID: "a", mode: scenario === "scroll" ? "scroll" : "interaction", setSelecting() {}, input: { showNotice: text => notices.push(text) } };
    assert.equal(await phone.pastePhoneClipboard("a"), scenario === "fallback");
    assert.deepEqual(pasted, scenario === "fallback" ? ["last copy"] : []);
    if (scenario === "empty") assert.match(notices[0], /No text/);
    if (scenario === "denied") assert.match(notices[0], /Permission denied/);
    if (scenario === "fallback") assert.match(notices[0], /last copy; system clipboard unavailable/);
  }
});

test("Scroll mode routes one finger locally, two fingers to application wheel, and never clicks/types/focuses", () => {
  const f = fixture();
  f.container.dispatch("pointerdown");
  f.container.dispatch("pointermove", { clientY: 160 });
  assert.deepEqual(f.local, [2.7], "even a mouse-tracking full-screen program keeps one finger local");
  assert.deepEqual(f.messages, []);
  f.container.dispatch("pointerdown", { pointerId: 2, clientY: 160 });
  f.container.dispatch("pointermove", { clientY: 120 });
  f.container.dispatch("pointermove", { pointerId: 2, clientY: 120 });
  assert.equal(f.messages.length, 2);
  assert.ok(f.messages.every(message => message.type === "mouse" && message.data.startsWith("\x1b[<65;")));
  f.container.dispatch("pointerup", { pointerId: 2, clientY: 120 });
  f.container.dispatch("pointermove", { clientY: 80 });
  assert.deepEqual(f.local, [2.7], "one finger left after mouse scrolling cannot become a local drag");
  f.container.dispatch("pointerup", { clientY: 80 });
  assert.equal(f.container.dispatch("mousedown").prevented, true);
  assert.equal(f.container.dispatch("click").prevented, true);
  f.container.dispatch("touchend", { touches: [] });
  assert.deepEqual(f.keys, []);
  assert.deepEqual(f.focused, []);
  f.bridge.dispose();
});

test("phone finger scrolling is 35% faster for TUI navigation but other layouts keep their speed", () => {
  for (const context of ["phone", "desktop", "other-pane"]) {
    const f = fixture();
    if (context === "desktop") f.phoneView.active = false;
    if (context === "other-pane") f.phoneView.openPaneID = "other";
    f.container.dispatch("pointerdown");
    f.container.dispatch("pointerdown", { pointerId: 2 });
    f.container.dispatch("pointermove", { clientY: 100 });
    f.container.dispatch("pointermove", { pointerId: 2, clientY: 100 });
    const wheels = f.messages.filter(message => message.type === "mouse" && message.data.startsWith("\x1b[<65;"));
    assert.equal(wheels.length, context === "phone" ? 6 : 5, context);
    assert.deepEqual(f.keys, [], "scroll speed cannot introduce keyboard input");
    f.bridge.dispose();
  }
});

test("two fingers never fall back to arrow keys or local history when the application doesn't track the mouse", () => {
  const f = fixture(); f.tracking(false);
  f.container.dispatch("pointerdown");
  f.container.dispatch("pointerdown", { pointerId: 2 });
  f.container.dispatch("pointermove", { clientY: 100 });
  f.container.dispatch("pointermove", { pointerId: 2, clientY: 100 });
  assert.deepEqual(f.messages, []); assert.deepEqual(f.keys, []); assert.deepEqual(f.local, []);
  f.bridge.dispose();
});

test("the text-reading overlay uses the same gesture modes and all its listeners are disposed", () => {
  const f = fixture();
  f.reading.dispatch("pointerdown");
  f.reading.dispatch("pointermove", { clientY: 160 });
  assert.equal(f.reading.scrollTop, 154);
  assert.deepEqual(f.local, []);
  f.reading.dispatch("pointerdown", { pointerId: 2, clientY: 160 });
  f.reading.dispatch("pointermove", { clientY: 120 });
  assert.equal(f.messages.length, 1);
  assert.equal(f.reading.scrollTop, 154);
  f.bridge.dispose();
  assert.equal(f.reading.listenerCount, 0);
  assert.equal(f.container.listenerCount, 0);
});

test("switching modes during a gesture cancels it until every finger lifts", () => {
  const f = fixture();
  f.container.dispatch("pointerdown");
  f.bridge.cancelTouchGesture(); f.phoneView.mode = "interaction";
  f.container.dispatch("pointermove", { clientY: 100 });
  f.container.dispatch("pointerup", { clientY: 100 });
  assert.deepEqual(f.local, []); assert.deepEqual(f.messages, []);
  f.container.dispatch("pointerdown");
  assert.equal(f.messages.length, 1, "a new interaction gesture is a normal TUI press");
  f.bridge.cancelTouchGesture(); f.phoneView.mode = "scroll";
  assert.ok(f.messages.at(-1).data.endsWith("m"), "an already-reported press gets its release");
  const count = f.messages.length;
  f.container.dispatch("pointermove", { clientY: 100 }); f.container.dispatch("pointerup");
  assert.equal(f.messages.length, count);
  f.container.dispatch("pointerdown"); f.container.dispatch("pointermove", { clientY: 160 });
  assert.deepEqual(f.local, [2.7]);
  f.bridge.dispose();
});

test("page buttons scroll visible canvas rows locally, even when the program tracks the mouse", () => {
  const scrolls = [], paints = [];
  const term = { rows: 60, buffer: { active: { type: "normal" } }, renderer: { getMetrics: () => ({ height: 20 }) },
    hasMouseTracking: () => true, wasmTerm: { isAlternateScreen: () => false },
    scrollLines: lines => scrolls.push(lines), requestRender: () => paints.push("paint"),
    focus: () => assert.fail("Paging focused the terminal"), input: () => assert.fail("Paging sent input") };
  const rect = { id: "a", kind: "terminal", terminalContainer: { clientHeight: 600 },
    terminal: { term, phoneModeHold: true, socket: { send: () => assert.fail("Paging sent a socket message") } } };
  const phone = createPhone({ desktop: () => ({ rectangles: [rect] }) });
  phone.phoneView = { mode: "scroll", openPaneID: "a" };
  phone.scrollPhoneTerminalPage("a", -1);
  phone.scrollPhoneTerminalPage("a", 1);
  assert.deepEqual(scrolls, [-28, 28], "one visible page minus two rows of overlap, not the entire host grid");
  assert.equal(paints.length, 2);
  assert.equal(rect.terminal.phoneModeHold, true, "paging never claims shell sizing");
  rect.terminalContainer.clientHeight = 200;
  phone.scrollPhoneTerminalPage("a", -1);
  assert.equal(scrolls.at(-1), -8, "page size follows rotation/window height");
  term.buffer.active.type = "alternate";
  phone.scrollPhoneTerminalPage("a", 1);
  term.buffer.active.type = "normal";
  phone.phoneView.mode = "interaction";
  phone.scrollPhoneTerminalPage("a", 1);
  phone.phoneView.mode = "scroll";
  phone.scrollPhoneTerminalPage("missing", 1);
  phone.scrollPhoneTerminalPage("a", 0);
  assert.equal(scrolls.length, 3, "full-screen programs, hidden panes and invalid clicks receive no keys or scrolls");
});

test("compose keyboard layout pans the existing canvas without claiming shell size, then refits once", () => {
  const effects = [], container = { scrollTop: 5, scrollHeight: 700, clientHeight: 680 };
  const state = { phoneFit: true, term: {}, phoneModeHold: false };
  const rect = { id: "a", kind: "terminal", terminal: state, terminalContainer: container };
  const phone = createPhone({ desktop: () => ({ rectangles: [rect] }), terminal: () => ({
    terminalFits: { cancelGridSize: candidate => { assert.equal(candidate, state); effects.push("cancel resize"); } },
    requestTerminalFit: candidate => { assert.equal(candidate, rect); effects.push("refit"); },
  }) });
  phone.phoneViewWanted = () => true;
  phone.phoneView = { mode: "interaction" };
  assert.equal(phone.terminalWatchesSize(state), false);
  phone.holdPhoneComposeViewport("a", true);
  phone.holdPhoneComposeViewport("a", true);
  assert.equal(phone.terminalWatchesSize(state), true);
  container.clientHeight = 380;
  phone.followPhoneComposeViewport("a");
  assert.equal(container.scrollTop, 320, "the last canvas rows stay above the keyboard");
  assert.deepEqual(effects, ["cancel resize"], "animation steps do not claim sizes or refit the host");
  container.clientHeight = 680;
  phone.holdPhoneComposeViewport("a", false);
  assert.equal(phone.terminalWatchesSize(state), false);
  assert.equal(container.scrollTop, 5, "the original local scroll offset is restored");
  assert.deepEqual(effects, ["cancel resize", "cancel resize", "refit"]);
  phone.followPhoneComposeViewport("a");
  assert.equal(container.scrollTop, 5, "normal scrolling is not pinned after compose editing ends");
});

test("Select TUI scrolling sends wheel reports only, never arrow-key fallbacks or shell input", () => {
  const messages = [];
  let tracking = true;
  const term = { cols: 80, rows: 40, buffer: { active: { type: "alternate" } },
    hasMouseTracking: () => tracking, input: () => assert.fail("TUI scrolling synthesized keyboard input") };
  const socket = { readyState: 1, send: data => messages.push(JSON.parse(data)) };
  const rect = { id: "a", kind: "terminal", terminal: { term, socket } };
  const phone = createPhone({ desktop: () => ({ rectangles: [rect] }) }, { WebSocket: { OPEN: 1 } });
  phone.phoneView = { active: true, openPaneID: "a", selecting: true };
  assert.equal(phone.scrollPhoneSelection("a", 1), true);
  assert.equal(messages.length, 5);
  assert.ok(messages.every(message => message.type === "mouse" && message.data === "\x1b[<65;40;20M"));
  messages.length = 0;
  assert.equal(phone.scrollPhoneSelection("a", -1), true);
  assert.ok(messages.every(message => message.data === "\x1b[<64;40;20M"));
  messages.length = 0;
  tracking = false;
  assert.equal(phone.scrollPhoneSelection("a", 1), false);
  tracking = true; term.buffer.active.type = "normal";
  assert.equal(phone.scrollPhoneSelection("a", 1), false);
  term.buffer.active.type = "alternate"; phone.phoneView.selecting = false;
  assert.equal(phone.scrollPhoneSelection("a", 1), false);
  phone.phoneView.selecting = true; socket.readyState = 3;
  assert.equal(phone.scrollPhoneSelection("a", 1), false);
  assert.equal(phone.scrollPhoneSelection("missing", 1), false);
  assert.equal(phone.scrollPhoneSelection("a", 0), false);
  assert.deepEqual(messages, []);
});

test("mode layout changes hold the shell's size until actual interaction resumes", () => {
  const effects = [], state = { phoneFit: true, mouseBridge: { cancelTouchGesture: () => effects.push("gesture") } };
  const rect = { id: "pane", kind: "terminal", terminal: state };
  const terminalFits = { cancelGridSize: () => effects.push("cancel resize"), claimGridSize: () => effects.push("claim size") };
  const phone = createPhone({ desktop: () => ({ rectangles: [rect] }), terminal: () => ({ terminalFits }) });
  phone.phoneViewWanted = () => true; phone.phoneView = { mode: "interaction" };
  assert.equal(phone.terminalWatchesSize(state), false);
  phone.changePhoneInteractionMode("pane");
  assert.equal(phone.terminalWatchesSize(state), true);
  assert.deepEqual(effects, ["cancel resize", "gesture"]);
  const terminal = createTerminal({ phone: () => phone });
  terminal.browserInUse = () => true; terminal.terminalFits = terminalFits;
  terminal.claimTerminalSize(rect);
  assert.equal(state.phoneModeHold, false);
  assert.equal(phone.terminalWatchesSize(state), false);
  phone.phoneView.mode = "scroll";
  assert.equal(phone.terminalWatchesSize(state), true);
});
