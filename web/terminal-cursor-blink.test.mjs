import assert from "node:assert/strict";
import test from "node:test";
import { TerminalCursorBlink } from "./terminal-cursor-blink.mjs";
import { TerminalRenderScheduler } from "./terminal-render-scheduler.mjs";

test("an idle active terminal renders only on cursor changes, and stops when hidden", () => {
  const timers = new Map();
  const frames = new Map();
  let id = 0;
  let renders = 0;
  const scheduler = new TerminalRenderScheduler({
    requestFrame(callback) { frames.set(++id, callback); return id; },
    cancelFrame(id) { frames.delete(id); },
  });
  const terminal = {};
  const blink = new TerminalCursorBlink(() => scheduler.request(terminal), {
    setInterval(callback, delay) { assert.equal(delay, 530); timers.set(++id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  const flush = () => {
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
  };
  scheduler.register(terminal, () => renders++);
  blink.setActive(true);
  flush();
  assert.equal(renders, 1);
  assert.equal(frames.size, 0, "no permanent idle frame loop");
  for (let i = 0; i < 10; i++) {
    [...timers.values()][0]();
    assert.equal(frames.size, 1);
    flush();
    assert.equal(frames.size, 0);
  }
  assert.equal(renders, 11, "ten blink ticks produced exactly ten additional renders");
  blink.setVisible(false);
  assert.equal(timers.size, 0);
  blink.setVisible(true);
  assert.equal(timers.size, 1);
  blink.setActive(false);
  assert.equal(timers.size, 0);
  assert.equal(blink.cursorVisible, false);
  blink.setActive(true);
  blink.dispose();
  assert.equal(timers.size, 0);
});
