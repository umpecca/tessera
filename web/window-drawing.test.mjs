import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function fixture() {
  const captures = [], menus = [], destroyed = [];
  const board = { setPointerCapture: id => captures.push(id) };
  const ctx = vm.createContext({
    board, interaction: null, activeRect: { cwd: "/project" }, activePaneID: "editor",
    nextZIndex: 10, rectangles: [], browserPaneKind: "browser", serverConnectionModal: { hidden: true },
    hideAllMenus() {}, boardPoint: event => ({ x: event.clientX, y: event.clientY }),
    clearActivePane() { ctx.activeRect = null; ctx.activePaneID = ""; },
    createRectangle(x, y, width, height, options) {
      const rect = { x, y, width, height, ...options };
      ctx.rectangles.push(rect);
      return rect;
    },
    clampIntoBoard() {}, setRectangle: (rect, box) => Object.assign(rect, box),
    destroyRectangle(rect, options) { destroyed.push({ rect, options }); ctx.rectangles.splice(ctx.rectangles.indexOf(rect), 1); },
    showWindowTypeMenu: (rect, x, y) => menus.push({ rect, x, y }),
  });
  for (const name of ["startDrawing", "createDrawnRectangle", "continueInteraction", "finishInteraction", "boxFromDrag", "handleBrowserPaneDraw"]) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\n}\n", start) + 2;
    vm.runInContext(source.slice(start, end), ctx);
  }
  return { ctx, board, captures, menus, destroyed };
}

function pointer(button, x, y, extra = {}) {
  return { button, clientX: x, clientY: y, pointerId: 1, target: {},
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
}

test("middle dragging defers creation, inherits the active directory and draws above other panes", () => {
  const { ctx, captures, menus } = fixture();
  const active = ctx.activeRect;
  const down = pointer(1, 100, 80);
  ctx.startDrawing(down);
  assert.equal(down.prevented, true);
  assert.equal(down.stopped, true);
  assert.equal(ctx.activeRect, active);
  ctx.continueInteraction(pointer(1, 103, 82));
  assert.equal(ctx.rectangles.length, 0);
  ctx.continueInteraction(pointer(1, 300, 240));
  const rect = ctx.rectangles[0];
  assert.deepEqual({ ...rect }, { x: 100, y: 80, width: 200, height: 160, kind: "pending", cwd: "/project", zIndex: 10 });
  assert.equal(ctx.activeRect, null);
  assert.equal(ctx.nextZIndex, 11);
  ctx.finishInteraction(pointer(1, 300, 240, { type: "pointerup" }));
  assert.equal(ctx.interaction, null);
  assert.deepEqual(captures, [1]);
  assert.deepEqual(menus, [{ rect, x: 300, y: 240 }]);
});

test("simple middle clicks and foreign pointers leave the active pane and window list intact", () => {
  const { ctx, menus } = fixture();
  const active = ctx.activeRect;
  ctx.startDrawing(pointer(1, 100, 80));
  ctx.continueInteraction(pointer(1, 300, 240, { pointerId: 2 }));
  ctx.finishInteraction(pointer(1, 300, 240, { pointerId: 2, type: "pointerup" }));
  assert.ok(ctx.interaction);
  ctx.finishInteraction(pointer(1, 100, 80, { type: "pointerup" }));
  assert.equal(ctx.activeRect, active);
  assert.equal(ctx.rectangles.length, 0);
  assert.equal(menus.length, 0);
});

test("canceled and narrow drags discard their outline without opening the type picker", () => {
  for (const [x, y, type] of [[300, 240, "pointercancel"], [300, 82, "pointerup"]]) {
    const { ctx, menus, destroyed } = fixture();
    ctx.startDrawing(pointer(1, 100, 80));
    ctx.continueInteraction(pointer(1, x, y));
    ctx.finishInteraction(pointer(1, x, y, { type }));
    assert.equal(ctx.rectangles.length, 0);
    assert.equal(destroyed.length, 1);
    assert.equal(destroyed[0].options.selectNext, false);
    assert.equal(menus.length, 0);
  }
});

test("left drawing stays confined to the empty desktop and Shift preserves square drawing", () => {
  const { ctx, board, menus } = fixture();
  ctx.startDrawing(pointer(0, 300, 240));
  ctx.startDrawing(pointer(2, 300, 240, { target: board }));
  assert.equal(ctx.interaction, null);
  ctx.startDrawing(pointer(0, 300, 240, { target: board }));
  assert.equal(ctx.rectangles.length, 1);
  ctx.continueInteraction(pointer(0, 100, 180, { shiftKey: true }));
  assert.deepEqual({ ...ctx.rectangles[0] }, { x: 100, y: 40, width: 200, height: 200, kind: "pending", cwd: "/project", zIndex: 10 });
  ctx.finishInteraction(pointer(0, 100, 180, { type: "pointerup" }));
  assert.equal(menus.length, 1);
});

test("Browser drawing validates the sending frame and translates captured drags outside its bounds", () => {
  const { ctx, captures, menus } = fixture();
  const frame = { contentWindow: {}, clientWidth: 200, clientHeight: 100, hidden: false,
    getBoundingClientRect: () => ({ left: 100, top: 80, width: 400, height: 200 }) };
  const rect = { kind: "browser", browser: { frame } };
  ctx.rectangles.push(rect);
  const send = (phase, clientX, clientY, extra = {}, sender = frame.contentWindow) => ctx.handleBrowserPaneDraw({
    source: sender, data: { phase, clientX, clientY, pointerId: 4, ...extra },
  });
  send("start", 10, 20, {}, {});
  send("start", -10, 20);
  send("start", 10, 20, { pointerId: "4" });
  assert.equal(ctx.interaction, null);
  send("start", 10, 20);
  assert.equal(ctx.interaction.browserFrame, frame);
  assert.deepEqual(captures, []);
  send("move", 250, 150, { pointerId: 5 });
  assert.equal(ctx.rectangles.length, 1);
  send("move", 250, 150);
  assert.deepEqual({ ...ctx.rectangles[1] }, { x: 120, y: 120, width: 480, height: 260, kind: "pending", cwd: "/project", zIndex: 10 });
  send("end", 250, 150);
  assert.equal(menus[0].x, 600);
  assert.equal(menus[0].y, 380);
  send("start", 10, 20);
  send("move", 80, 90);
  send("cancel", 0, 0);
  assert.equal(ctx.rectangles.length, 2);
  assert.equal(menus.length, 1);
});

test("the Browser bootstrap captures middle gestures, suppresses page actions and relays cancellation", () => {
  const proxy = readFileSync(new URL("../internal/httpapi/browser_proxy.go", import.meta.url), "utf8");
  const start = proxy.indexOf("let drawPointer=null;");
  const end = proxy.indexOf('document.addEventListener("click"', start);
  const listeners = new Map(), posted = [], captured = new Set();
  vm.runInNewContext(proxy.slice(start, end), {
    addEventListener(type, callback) { listeners.set(type, callback); },
    parent: { postMessage: message => posted.push({ ...message }) },
    document: { documentElement: {
      setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
      releasePointerCapture: id => captured.delete(id),
    } },
  });
  const send = (type, extra = {}) => {
    const event = pointer(1, 20, 30, { type, ...extra, stopImmediatePropagation() { this.stopped = true; } });
    listeners.get(type)(event);
    return event;
  };
  assert.equal(send("pointerdown", { button: 0 }).prevented, undefined);
  assert.equal(posted.length, 0);
  assert.equal(send("pointerdown").stopped, true);
  assert.equal(captured.has(1), true);
  assert.equal(send("pointermove", { pointerId: 2 }).prevented, undefined);
  send("pointermove", { clientX: -50, clientY: 200, shiftKey: true });
  send("pointerup");
  assert.deepEqual(posted.map(message => message.phase), ["start", "move", "end"]);
  assert.equal(posted[1].clientX, -50);
  assert.equal(posted[1].shiftKey, true);
  assert.equal(send("auxclick").prevented, true);
  assert.equal(send("auxclick", { button: 0 }).prevented, undefined);
  for (const cancel of ["pointercancel", "lostpointercapture", "blur", "keydown"]) {
    posted.length = 0;
    send("pointerdown");
    send(cancel, { key: "Escape" });
    send("pointerup");
    assert.deepEqual(posted.map(message => message.phase), ["start", "cancel"], cancel);
    assert.equal(captured.has(1), false);
  }
});
