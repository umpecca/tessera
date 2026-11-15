import { featureFixture } from "./application.test-support.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { terminalAudioDisabledKey } from "./terminal-audio.mjs";

function page(saved = {}) {
  const storage = new Map(Object.entries(saved)), calls = [];
  const window = {
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    addEventListener() {}, removeEventListener() {},
  };
  const terminalAudioPlayer = {
    enabled: false,
    enableByDefault: target => calls.push(["default", target]),
    enable: async () => { calls.push(["enable"]); },
    disable: () => calls.push(["disable"]),
  };
  const context = featureFixture(["enableTerminalAudio", "disableTerminalAudio", "enableTerminalAudioByDefault"], { window, terminalAudioPlayer });
  return { context, storage, calls, window };
}

test("terminal audio is enabled by default in a new browser", () => {
  const { context, calls, window } = page();
  context.enableTerminalAudioByDefault();
  assert.deepEqual(calls, [["default", window]]);
});

test("a remembered Disable keeps terminal audio off until Enable", async () => {
  const { context, storage, calls } = page();
  context.disableTerminalAudio();
  assert.equal(storage.get(terminalAudioDisabledKey), "true");
  context.enableTerminalAudioByDefault();
  assert.deepEqual(calls, [["disable"]]);
  await context.enableTerminalAudio();
  assert.equal(storage.has(terminalAudioDisabledKey), false);
  context.enableTerminalAudioByDefault();
  assert.deepEqual(calls.map(call => call[0]), ["disable", "enable", "default"]);
});

test("unavailable storage still enables terminal audio by default", () => {
  const { context, calls, window } = page();
  window.localStorage.getItem = () => { throw new Error("blocked"); };
  context.enableTerminalAudioByDefault();
  assert.equal(calls[0][0], "default");
});
