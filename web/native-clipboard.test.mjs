import assert from "node:assert/strict";
import test from "node:test";
import { ClipboardBridge, NativeClipboardBridge, createClipboardBridge } from "./clipboard-bridge.mjs";
import { createClipboard } from "./clipboard-access.mjs";
import { createMenus } from "./workspace-menus.mjs";
import { clipboardItemsContent } from "./clipboard-image.mjs";
import { createSettings } from "./settings-view.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c2ioAAAAASUVORK5CYII=";
function nativeFixture(respond = () => ({ text: "", ok: true })) {
  const calls = [];
  const host = { setTimeout, clearTimeout,
    webkit: { messageHandlers: { tesseraClipboard: { postMessage(message) { calls.push(message); return Promise.resolve().then(() => respond(message)); } } } },
    location: { origin: "http://studio:7331" }, addEventListener() {}, removeEventListener() {},
  };
  host.top = host;
  return { bridge: createClipboardBridge(host), host, calls };
}

test("native clipboard discovery uses a top-frame WebKit capability, not the user agent or HTTPS", async () => {
  const f = nativeFixture(({ operation }) => {
    assert.equal(operation, "hello", "discovery must not read clipboard contents");
    return { version: "1.0.0", native: true, images: true, terminal: true };
  });
  assert.ok(f.bridge instanceof NativeClipboardBridge);
  assert.deepEqual(await f.bridge.check(), { version: "1.0.0", native: true, images: true, terminal: false });
  f.bridge.dispose();
  f.host.top = {};
  const child = createClipboardBridge(f.host);
  assert.ok(child instanceof ClipboardBridge);
  child.dispose();
  delete f.host.webkit;
  f.host.top = f.host;
  f.host.navigator = { userAgent: "TesseraApp/0.1" };
  const ordinary = createClipboardBridge(f.host);
  assert.ok(ordinary instanceof ClipboardBridge);
  ordinary.dispose();
});

test("native clipboard reads/writes Unicode and empty text and rejects oversized/malformed data", async () => {
  let text = "hello 🌍";
  const f = nativeFixture(message => message.operation === "writeText" ? { ok: true } : { text });
  assert.equal(await f.bridge.readText(), text);
  await f.bridge.writeText(text);
  assert.deepEqual(f.calls.at(-1), { operation: "writeText", text });
  text = "";
  assert.equal(await f.bridge.readText(), "");
  text = null;
  await assert.rejects(f.bridge.readText(), /Invalid native clipboard text/);
  await assert.rejects(f.bridge.writeText("🌍".repeat(300000)), /1 MiB/);
  await assert.rejects(f.bridge.writeText("background", true), /disabled/);
  f.bridge.dispose();
});

test("native image payloads work without the browser ClipboardItem or secure-context API", async () => {
  const f = nativeFixture(() => ({ text: "", image: { type: "image/png", data: png }, ok: true }));
  const items = await f.bridge.read();
  assert.deepEqual(items[0].types, ["image/png"]);
  const content = await clipboardItemsContent(items);
  assert.equal(content.image.type, "image/png");
  assert.equal(content.image.size, Buffer.from(png, "base64").length);
  await assert.rejects(items[0].getType("text/plain"), /unavailable/);
  await f.bridge.writeImage(content.image);
  assert.deepEqual(f.calls.at(-1), { operation: "writeImage", data: png });
  await assert.rejects(f.bridge.writeImage(new Blob(["bad"], { type: "image/svg+xml" })), /PNG\/JPEG/);
  f.bridge.dispose();
});

test("malformed or oversized native images are never handed to terminal paste", async () => {
  for (const image of [
    { type: "image/svg+xml", data: png }, { type: "image/png", data: "not-base64" },
    { type: "image/png", data: "YWJjZA==" },
    { type: "image/png", data: "A".repeat(4 * Math.ceil(16 * 1024 * 1024 / 3) + 4) },
  ]) {
    const f = nativeFixture(() => ({ text: "", image }));
    await assert.rejects(f.bridge.read(), /Invalid native clipboard/);
    f.bridge.dispose();
  }
});

test("native denial, timeout, disposal and late replies never become successful requests", async () => {
  const denied = nativeFixture(() => { throw new Error("Paste cancelled"); });
  await assert.rejects(denied.bridge.read(), /Paste cancelled/);
  denied.bridge.dispose();
  let reply;
  const delayed = nativeFixture(() => new Promise(resolve => { reply = resolve; }));
  delayed.bridge.timeoutMs = 5;
  await assert.rejects(delayed.bridge.readText(), /expired/);
  reply({ text: "late" });
  assert.equal(delayed.bridge.pending.size, 0);
  const closing = delayed.bridge.readText();
  delayed.bridge.dispose();
  await assert.rejects(closing, /closed/);
  await assert.rejects(delayed.bridge.readText(), /closed/);
});

function accessFixture(bridge) {
  const statuses = [];
  const clipboard = createClipboard({ workspace: () => ({ setWorkspaceStatus: (...args) => statuses.push(args) }) }, {
    navigator: { clipboard: { readText: () => assert.fail("native denial fell back to browser"), read: () => assert.fail("native images fell back to browser") } },
  });
  clipboard.clipboardBridge = bridge;
  clipboard.clipboardText = "stale previous copy";
  clipboard.pasteTextWithHiddenField = () => assert.fail("native denial used hidden-field fallback");
  return { clipboard, statuses };
}

test("mobile clipboard text reads never focus hidden fields, while ordinary reads retain their fallback", async () => {
  const clipboard = createClipboard({}, { navigator: { clipboard: { readText: async () => { throw new Error("Not allowed"); } } } });
  clipboard.clipboardBridge = { status: null };
  clipboard.clipboardText = "copied fixture";
  clipboard.pasteTextWithHiddenField = () => assert.fail("mobile Paste opened a keyboard-triggering field");
  assert.equal(await clipboard.readClipboardText({ allowFocus: false }), "copied fixture");
  assert.equal(clipboard.clipboardReadFellBack, true);
  clipboard.pasteTextWithHiddenField = () => "ordinary paste fallback";
  assert.equal(await clipboard.readClipboardText(), "ordinary paste fallback");
  assert.equal(clipboard.clipboardReadFellBack, false);
});

test("native cancellation cannot paste stale text or silently fall back to another clipboard path", async () => {
  const f = nativeFixture(() => { throw new Error("Paste cancelled"); });
  const { clipboard } = accessFixture(f.bridge);
  for (const read of [clipboard.readClipboardText, clipboard.readClipboardContent, clipboard.readClipboardForSave]) {
    await assert.rejects(read(), /Paste cancelled/);
    assert.equal(clipboard.clipboardReadFellBack, false);
  }
  f.bridge.dispose();
});

test("native rich reads preserve terminal text priority and Save Clipboard image priority", async () => {
  const f = nativeFixture(() => ({ text: "caption", image: { type: "image/png", data: png } }));
  const { clipboard } = accessFixture(f.bridge);
  assert.deepEqual(await clipboard.readClipboardContent(), { text: "caption" });
  const entries = await clipboard.readClipboardForSave();
  assert.equal(entries[0].kind, "image");
  assert.equal(entries[0].name, "clipboard.png");
  f.bridge.dispose();
});

test("native copy failures report failure without invoking browser fallbacks", async () => {
  const f = nativeFixture(() => { throw new Error("App is inactive"); });
  const { clipboard, statuses } = accessFixture(f.bridge);
  assert.equal(await clipboard.writeClipboardText("new copy"), false);
  assert.equal(clipboard.clipboardText, "new copy");
  assert.equal(statuses[0][1], "Copy failed");
  f.bridge.dispose();
});

test("terminal Paste routes native images through the existing host clipboard path and handles cancellation", async () => {
  const effects = [], statuses = [];
  const term = { focus() {}, paste: text => effects.push(["text", text]) }, rect = { terminal: { term } };
  const clipboard = { readClipboardContent: async () => ({ image: new Blob(["image"], { type: "image/png" }) }), reportClipboardFallback() {} };
  const menus = createMenus({ clipboard: () => clipboard, interactions: () => ({ appleKeyboardLayout: true }),
    terminalInput: () => ({ pasteImageIntoTerminal: async (...args) => effects.push(["image", ...args]) }),
    workspace: () => ({ setWorkspaceStatus: (...args) => statuses.push(args) }),
  });
  await menus.applyTerminalMenuAction("paste", rect);
  assert.equal(effects[0][0], "image");
  clipboard.readClipboardContent = async () => { throw new Error("Paste cancelled"); };
  await menus.applyTerminalMenuAction("paste", rect);
  assert.equal(effects.length, 1);
  assert.equal(statuses[0][1], "Paste unavailable");
});

test("a native paste approved after its terminal was disposed sends no input", async () => {
  let resolve;
  const term = { focus() {}, paste: () => assert.fail("pasted into disposed terminal") }, rect = { terminal: { term } };
  const menus = createMenus({ clipboard: () => ({ readClipboardContent: () => new Promise(reply => { resolve = reply; }) }) });
  const paste = menus.applyTerminalMenuAction("paste", rect);
  rect.terminal = null;
  resolve({ text: "late approval" });
  await paste;
});

test("native clipboard Settings checks capabilities without reading data or fetching an extension", async () => {
  class Element extends EventTarget {
    children = [];
    append(...children) { this.children.push(...children); }
    setAttribute() {}
  }
  const f = nativeFixture(() => ({ native: true, version: "1.0.0", images: true }));
  const settings = createSettings({ clipboard: () => ({ clipboardBridge: f.bridge }) }, {
    document: { createElement: () => new Element() },
    fetch: () => assert.fail("native clipboard tried to load a Firefox extension"),
  });
  const row = settings.renderSettingsClipboardRow();
  assert.equal(f.calls.length, 0, "opening Settings must not read the clipboard");
  assert.match(row.children[1].textContent, /native confirmation/);
  row.children[2].dispatchEvent(new Event("click"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].operation, "hello");
  assert.match(row.children[0].textContent, /connected/);
  f.bridge.dispose();
});
