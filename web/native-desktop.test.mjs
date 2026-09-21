import test from "node:test";
import assert from "node:assert/strict";
import { installNativeClose } from "./native-desktop.mjs";

function fixture(desktop = true, confirm = true) {
  const messages = [];
  let close;
  const win = {
    __tesseraDesktop: desktop,
    confirm: () => confirm,
    addEventListener: (name, fn) => { assert.equal(name, "tessera:native-close"); close = fn; },
    webkit: { messageHandlers: { tesseraLifecycle: { postMessage: message => messages.push(message) } } },
  };
  return { win, messages, close: () => close?.() };
}

test("ordinary webserver browser installs no native lifecycle", () => {
  const f = fixture(false);
  installNativeClose(f.win, () => assert.fail("unexpected flush"));
  assert.deepEqual(f.messages, []);
  assert.equal(f.close(), undefined);
});

test("native close waits for persistence before acknowledging", async () => {
  const f = fixture();
  let finish;
  installNativeClose(f.win, () => new Promise(resolve => { finish = resolve; }));
  const pending = f.close();
  assert.deepEqual(f.messages, ["ready"]);
  await f.close(); // Repeated close cannot race the first flush.
  finish();
  await pending;
  assert.deepEqual(f.messages, ["ready", "saved"]);
});

test("cancel keeps the host running without flushing", async () => {
  const f = fixture(true, false);
  installNativeClose(f.win, () => assert.fail("cancel flushed"));
  await f.close();
  assert.deepEqual(f.messages, ["ready", "cancel"]);
});

test("failed persistence does not acknowledge a successful close", async () => {
  const f = fixture();
  installNativeClose(f.win, async () => { throw new Error("conflict"); });
  await f.close();
  assert.deepEqual(f.messages, ["ready", "save-failed"]);
});
