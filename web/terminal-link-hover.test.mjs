import assert from "node:assert/strict";
import test from "node:test";

import { TerminalLinkHover } from "./terminal-link-hover.mjs";

test("tells listeners when the URI shown changes, once per change", () => {
  const hover = new TerminalLinkHover({});
  const seen = [];
  const listener = hover.onChange(uri => seen.push(uri));
  hover.set("https://example.com");
  hover.set("https://example.com");
  hover.set("");
  listener.dispose();
  hover.set("file:///tmp/b");
  assert.deepEqual(seen, ["https://example.com", ""]);
  assert.equal(hover.uri, "file:///tmp/b");
});

test("looks again at the last pointer position after output, once per frame", () => {
  const frames = [];
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  try {
    const moves = [];
    const hover = new TerminalLinkHover({ processMouseMove: event => moves.push(event) });
    const pointer = { clientX: 10, clientY: 20 };

    hover.notePointer(pointer);
    hover.recheck();
    assert.equal(frames.length, 0, "nothing is shown, so nothing can be stale");

    hover.set("https://example.com");
    hover.recheck();
    hover.recheck();
    assert.equal(frames.length, 1);
    frames[0]();
    assert.deepEqual(moves, [pointer]);

    hover.recheck();
    hover.leave();
    frames[1]();
    assert.equal(moves.length, 1, "the pointer left before the frame ran");
  } finally {
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test("dispose drops listeners", () => {
  const hover = new TerminalLinkHover({});
  let seen = 0;
  hover.onChange(() => { seen += 1; });
  hover.dispose();
  hover.set("https://example.com");
  assert.equal(seen, 0);
});
