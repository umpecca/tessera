import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { connectRDPViewer, rdpViewerModule, rdpViewerURL } from "./rdp-viewer.mjs";
import { endConnectionLost, endError, viewDetached, viewEnded, viewH264, viewImage } from "./rdp-viewer-wire.mjs";

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.listeners = {};
    this.closeCode = null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  send(bytes) {
    this.sent.push(Array.from(bytes));
  }

  close(code) {
    this.closeCode = code;
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type, event) {
    for (const listener of this.listeners[type] || []) listener(event);
  }

  frame(...values) {
    this.emit("message", { data: Uint8Array.from(values).buffer });
  }
}

class FakeImageData {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
}

function setup(options = {}) {
  const sockets = [];
  const drawn = [];
  const contexts = [];
  const canvas = {
    width: 300,
    height: 200,
    getContext(kind, settings) {
      contexts.push([kind, settings]);
      return { putImageData: (image, x, y) => drawn.push({ image, x, y }) };
    },
  };
  const presenters = [];
  const createPresenter = (options) => {
    const { canvas: target } = options;
    const presenter = { canvas: target, options, pushed: [], closed: false, push(data, regions, view, surface) { this.pushed.push({ data, regions, view, surface }); }, close() { this.closed = true; } };
    presenters.push(presenter);
    return presenter;
  };
  const connecting = connectRDPViewer({
    url: "wss://tessera.test/api/rdp-kept/view?workspaceId=w&pane=p",
    canvas,
    WebSocketImpl: class extends FakeSocket {
      constructor(url) {
        super(url);
        sockets.push(this);
      }
    },
    ImageDataImpl: FakeImageData,
    createPresenter,
    ...options,
  });
  return { connecting, canvas, drawn, contexts, presenters, socket: () => sockets[0] };
}

const sizeFrame = [1, 0xc0, 0x04, 0x80, 0x02];
const text = (value) => Array.from(new TextEncoder().encode(value));

test("builds the viewer URL on the page's origin", () => {
  assert.equal(
    rdpViewerURL("w 1", "pane-2", { protocol: "https:", host: "desk.test" }),
    "wss://desk.test/api/rdp-kept/view?workspaceId=w+1&pane=pane-2",
  );
});

test("resolves once the desktop size arrives and sizes the canvas", async () => {
  const { connecting, canvas, contexts, socket } = setup();
  assert.deepEqual(contexts, [["2d", { alpha: false }]]);
  assert.equal(socket().binaryType, "arraybuffer");
  socket().frame(...sizeFrame);
  const session = await connecting;
  assert.deepEqual(session.desktopSize(), { width: 1216, height: 640 });
  assert.deepEqual([canvas.width, canvas.height], [1216, 640]);
});

test("draws image regions opaque and H.264 pictures through the presenter", async () => {
  const { connecting, drawn, presenters, socket } = setup();
  socket().frame(...sizeFrame);
  await connecting;
  socket().frame(viewImage, 4, 0, 6, 0, 1, 0, 1, 0, 10, 20, 30, 0);
  assert.equal(drawn.length, 1);
  assert.deepEqual([drawn[0].x, drawn[0].y, drawn[0].image.width, drawn[0].image.height], [4, 6, 1, 1]);
  assert.deepEqual(Array.from(drawn[0].image.data), [10, 20, 30, 255]);

  socket().frame(viewH264, 7, 0, 0, 1, 0, 2, 0, 3, 0, 10, 0, 5, 0, 0, 0, 0, 1, 0x65);
  socket().frame(viewH264, 7, 0, 2 | 4, 0, 0, 0, 0, 0, 1, 0x41);
  assert.equal(presenters.length, 1, "one presenter serves every picture");
  assert.deepEqual(Array.from(presenters[0].pushed[0].regions), [2, 3, 10, 5]);
  assert.deepEqual(Array.from(presenters[0].pushed[0].data), [0, 0, 0, 1, 0x65]);
  assert.equal(presenters[0].pushed[0].view, 0);
  assert.equal(presenters[0].pushed[0].surface, 7);
  assert.equal(presenters[0].pushed[1].regions.length, 0);
  assert.equal(presenters[0].pushed[1].view, 2 | 4, "the view reaches the presenter");
});

test("sends input, resize, refresh and release-all", async () => {
  const { connecting, socket } = setup();
  socket().frame(...sizeFrame);
  const session = await connecting;
  const { DeviceEvent, InputTransaction } = rdpViewerModule.Backend;
  const transaction = new InputTransaction();
  transaction.addEvent(DeviceEvent.mouseMove(10, 20));
  transaction.addEvent(DeviceEvent.mouseButtonPressed(0));
  transaction.addEvent(DeviceEvent.keyPressed(0xe05b));
  transaction.addEvent(DeviceEvent.wheelRotations(true, 2, 1));
  session.applyInputs(transaction);
  session.applyInputs(new InputTransaction());
  session.resize(1280, 720);
  session.refresh();
  session.releaseAllInputs();
  assert.deepEqual(socket().sent, [
    [1, 1, 10, 0, 20, 0, 2, 0, 1, 4, 0x5b, 0xe0, 1, 3, 1, 100, 0],
    [2, 0x00, 0x05, 0xd0, 0x02],
    [3],
    [1, 6],
  ]);
});

test("run resolves with the reason when the session is lost", async () => {
  const { connecting, socket } = setup();
  socket().frame(...sizeFrame);
  const session = await connecting;
  const running = session.run();
  socket().frame(viewEnded, endConnectionLost, ...text("the connection closed"));
  socket().emit("close", {});
  assert.match((await running).reason(), /connection to the RDP server was lost.*rejoin/);
});

test("run rejects when the session failed", async () => {
  const { connecting, socket } = setup();
  socket().frame(...sizeFrame);
  const session = await connecting;
  socket().frame(viewEnded, endError, ...text("logon failed"));
  socket().emit("close", {});
  await assert.rejects(session.run(), /logon failed/);
});

test("run reports another viewer taking over", async () => {
  const { connecting, socket } = setup();
  socket().frame(...sizeFrame);
  const session = await connecting;
  socket().frame(viewDetached, ...text("another viewer took over"));
  socket().emit("close", {});
  assert.equal((await session.run()).reason(), "another viewer took over");
});

test("shutdown closes the socket and the presenter, and run resolves quietly", async () => {
  const { connecting, presenters, socket } = setup();
  socket().frame(...sizeFrame);
  const session = await connecting;
  socket().frame(viewH264, 7, 0, 0, 0, 0, 0, 0, 1);
  session.shutdown();
  assert.equal(socket().closeCode, 1000);
  assert.equal(presenters[0].closed, true);
  assert.equal((await session.run()).reason(), "");
  session.applyInputs({ records: [rdpViewerModule.Backend.DeviceEvent.mouseMove(1, 2)] });
  assert.equal(socket().sent.length, 0, "nothing is sent after shutdown");
});

test("rejects when the socket closes before the desktop size", async () => {
  const { connecting, socket } = setup();
  socket().emit("close", {});
  await assert.rejects(connecting, /connection to Tessera closed/);
});

test("rejects when the host sends nothing", async () => {
  const { connecting, socket } = setup({ timeoutMs: 20 });
  await assert.rejects(connecting, /didn't answer/);
  assert.equal(socket().closeCode, 1000);
});

test("an invalid frame ends the viewer", async () => {
  const { connecting, socket } = setup();
  socket().frame(...sizeFrame);
  const session = await connecting;
  socket().frame(99, 1, 2);
  assert.equal(socket().closeCode, 1000);
  assert.match((await session.run()).reason(), /invalid RDP frame/);
});

// The pane drives a kept session through the same calls as IronRDP's, so the
// viewer must offer every session method and input event the pane uses. A
// missing one throws inside an input handler, and that input is lost.
test("offers every session method and input event the RDP pane calls", async () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const called = (pattern) => [...new Set([...app.matchAll(pattern)].map((match) => match[1]))];
  const sessionMethods = called(/\bsession\??\.([A-Za-z]+)\(/g);
  const deviceEvents = called(/\bDeviceEvent\.([A-Za-z]+)\(/g);
  assert.ok(sessionMethods.includes("applyInputs") && deviceEvents.includes("mouseMove"), "app.js calls weren't found");

  const { connecting, socket } = setup();
  socket().frame(...sizeFrame);
  const session = await connecting;
  for (const method of sessionMethods) {
    assert.equal(typeof session[method], "function", `session.${method}`);
  }
  for (const event of deviceEvents) {
    assert.equal(typeof rdpViewerModule.Backend.DeviceEvent[event], "function", `DeviceEvent.${event}`);
  }
});
