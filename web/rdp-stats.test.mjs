import assert from "node:assert/strict";
import test from "node:test";

import { createRDPStatsOverlay, rdpStatsLines, rdpStatsPreferenceKey, readRDPStatsPreference, saveRDPStatsPreference } from "./rdp-stats.mjs";

const reading = (values = {}) => ({
  pictures: 0, bytes: 0, decoded: 0, presented: 0, dropped: 0, errors: 0,
  pushMs: 0, decodeMs: 0, decodeMaxMs: 0, readMs: 0, drawMs: 0, latencyMs: 0, latencyMaxMs: 0,
  decodeQueue: 0, waiting: 0, fullColor: false, ...values,
});

test("remembers whether the overlay shows", () => {
  const items = new Map();
  const storage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: (key) => items.delete(key) };
  assert.equal(readRDPStatsPreference(storage), false);
  saveRDPStatsPreference(storage, true);
  assert.equal(items.get(rdpStatsPreferenceKey), "on");
  assert.equal(readRDPStatsPreference(storage), true);
  saveRDPStatsPreference(storage, false);
  assert.equal(readRDPStatsPreference(storage), false);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readRDPStatsPreference(blocked), false);
  assert.doesNotThrow(() => saveRDPStatsPreference(blocked, true));
});

test("describes the second between two readings", () => {
  const previous = reading({ pictures: 10, bytes: 1 << 20, decoded: 10, presented: 10, decodeMs: 40, pushMs: 1, drawMs: 10, latencyMs: 60 });
  const current = reading({
    pictures: 40, bytes: 4 << 20, decoded: 40, presented: 40, dropped: 1,
    decodeMs: 160, decodeMaxMs: 9.5, pushMs: 4, drawMs: 40, readMs: 15, latencyMs: 300, latencyMaxMs: 21,
    decodeQueue: 2, waiting: 1, compositing: 8, backpressured: true, fullColor: true,
  });
  const lines = rdpStatsLines(previous, current, 1000, { count: 60, longestMs: 34 }, "in page · 2560×1440");
  assert.deepEqual(lines, [
    "in page · 2560×1440",
    "pictures 30/s · 3.0 MB/s · 4:4:4",
    "decode 4.0 ms · max 9.5 · queue 2 · waiting 1 · compositing 8 · behind",
    "push 0.1 ms · draw 1.0 ms · read 0.5 ms",
    "shown after 8.0 ms · max 21",
    "page 60 fps · longest frame 34 ms · pictures 3.3%",
    "dropped 1 · errors 0",
  ]);
});

test("starts the counts again for a new connection, and adds the host's", () => {
  const previous = reading({ pictures: 500, socketMessages: 900 });
  const current = reading({ pictures: 20, bytes: 512 << 10, presented: 20, socketMessages: 25, socketBytes: 600 << 10, images: 2, imageMs: 3 });
  const lines = rdpStatsLines(previous, current, 2000, { count: 0, longestMs: 0 }, "kept on host · 1920×1080");
  assert.equal(lines[1], "pictures 10/s · 256 KB/s");
  assert.equal(lines.at(-1), "from host 13 msgs/s · 300 KB/s · bitmaps 2 in 3.0 ms");
});

test("says when there are no pictures yet", () => {
  assert.deepEqual(rdpStatsLines(null, null, 1000, { count: 59, longestMs: 18 }, "in page · 800×600"), [
    "in page · 800×600",
    "no H.264 pictures yet",
    "page 59 fps · longest frame 18 ms",
  ]);
  const bitmapsOnly = rdpStatsLines(null, { socketMessages: 4, socketBytes: 4096, images: 4, imageMs: 2 }, 1000, { count: 60, longestMs: 17 }, "kept on host · 800×600");
  assert.equal(bitmapsOnly.at(-1), "from host 4 msgs/s · 4 KB/s · bitmaps 4 in 2.0 ms");
});

test("refreshes each second until closed, timing the page's frames", () => {
  const appended = [];
  const element = { remove() { this.removed = true; } };
  const container = { append: (child) => appended.push(child) };
  const documentRef = { createElement: (tag) => Object.assign(element, { tag }) };
  let frame = null;
  let interval = null;
  let clock = 0;
  const readings = [reading(), reading({ pictures: 30, presented: 30, decoded: 30 })];
  const overlay = createRDPStatsOverlay({
    container,
    documentRef,
    read: () => readings.shift(),
    title: () => "in page · 800×600",
    now: () => clock,
    requestFrame: (callback) => {
      frame = callback;
      return 1;
    },
    cancelFrame: () => {
      frame = null;
    },
    every: (callback) => {
      interval = callback;
      return 2;
    },
    stopEvery: () => {
      interval = null;
    },
  });
  assert.deepEqual(appended, [element]);
  assert.equal(element.tag, "pre");
  assert.equal(element.className, "rdp-stats");
  assert.match(element.textContent, /measuring/);
  for (const time of [0, 16, 33, 83]) frame(time);
  clock = 1000;
  interval();
  assert.match(element.textContent, /pictures 30\/s/);
  assert.match(element.textContent, /page 3 fps · longest frame 50 ms/);
  overlay.close();
  assert.equal(frame, null);
  assert.equal(interval, null);
  assert.equal(element.removed, true);
});
