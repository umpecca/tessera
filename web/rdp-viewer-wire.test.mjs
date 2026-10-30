import assert from "node:assert/strict";
import test from "node:test";

import {
  endConnectionLost,
  inputMessage,
  inputRecords,
  maxViewerMessageBytes,
  parseViewerFrame,
  refreshMessage,
  shownMessage,
  wiggleMessage,
  resizeMessage,
  viewDetached,
  viewEnded,
  viewH264,
  viewImage,
} from "./rdp-viewer-wire.mjs";

const bytes = (...values) => Array.from(Uint8Array.from(values));
const frame = (...values) => Uint8Array.from(values).buffer;

test("encodes input records the way the host reads them", () => {
  assert.deepEqual(bytes(...inputRecords.mouseMove(10, 20)), [1, 10, 0, 20, 0]);
  assert.deepEqual(bytes(...inputRecords.mouseMove(70000, -5)), [1, 0xff, 0xff, 0, 0]);
  assert.deepEqual(bytes(...inputRecords.mouseButton(2, true)), [2, 2, 1]);
  assert.deepEqual(bytes(...inputRecords.mouseButton(0, false)), [2, 0, 0]);
  assert.deepEqual(bytes(...inputRecords.mouseButton(5, true)), []);
  assert.deepEqual(bytes(...inputRecords.key(0xe05b, true)), [4, 0x5b, 0xe0, 1]);
  assert.deepEqual(bytes(...inputRecords.key(0x1e, false)), [4, 0x1e, 0, 0]);
  assert.deepEqual(bytes(...inputRecords.unicode(0x20ac, true)), [5, 0xac, 0x20, 0, 0, 1]);
  assert.deepEqual(bytes(...inputRecords.releaseAll()), [6]);
});

test("converts wheel units to pixels like IronRDP's web client", () => {
  assert.deepEqual(bytes(...inputRecords.wheel(true, -120, 0)), [3, 1, 0x88, 0xff]);
  assert.deepEqual(bytes(...inputRecords.wheel(false, 3, 1)), [3, 0, 150, 0]);
  assert.deepEqual(bytes(...inputRecords.wheel(true, 1, 2)), [3, 1, 0x6c, 0x07]);
  assert.deepEqual(bytes(...inputRecords.wheel(true, 1000, 2)), [3, 1, 0xff, 0x7f]);
});

test("builds viewer messages", () => {
  const records = [inputRecords.mouseMove(1, 2), inputRecords.mouseButton(0, true), new Uint8Array(0)];
  assert.deepEqual(bytes(...inputMessage(records)), [1, 1, 1, 0, 2, 0, 2, 0, 1]);
  assert.equal(inputMessage([]), null);
  assert.equal(inputMessage([new Uint8Array(0)]), null);
  assert.equal(inputMessage([new Uint8Array(maxViewerMessageBytes)]), null);
  assert.deepEqual(bytes(...resizeMessage(1216, 640)), [2, 0xc0, 0x04, 0x80, 0x02]);
  assert.deepEqual(bytes(...resizeMessage(1216, 640, 200)), [2, 0xc0, 0x04, 0x80, 0x02, 200, 0]);
  assert.deepEqual(bytes(...resizeMessage(1216, 640, 50)), [2, 0xc0, 0x04, 0x80, 0x02], "no scale below 100%");
  assert.deepEqual(bytes(...refreshMessage()), [3]);
  assert.deepEqual(bytes(...wiggleMessage(true, false)), [4, 1]);
  assert.deepEqual(bytes(...wiggleMessage(true, true)), [4, 3]);
  assert.deepEqual(bytes(...wiggleMessage(false, true)), [4, 2]);
  assert.deepEqual(bytes(...shownMessage(true)), [5, 1]);
  assert.deepEqual(bytes(...shownMessage(false)), [5, 0]);
});

test("parses frames from the host", () => {
  assert.deepEqual(parseViewerFrame(frame(1, 0xc0, 0x04, 0x80, 0x02)), { type: "size", width: 1216, height: 640 });

  const h264 = parseViewerFrame(frame(viewH264, 7, 0, 9, 1, 0, 2, 0, 3, 0, 10, 0, 5, 0, 0, 0, 0, 1, 0x65));
  assert.equal(h264.type, "h264");
  assert.equal(h264.surface, 7);
  assert.equal(h264.view, 9);
  assert.deepEqual(Array.from(h264.regions), [2, 3, 10, 5]);
  assert.deepEqual(Array.from(h264.data), [0, 0, 0, 1, 0x65]);

  const image = parseViewerFrame(frame(viewImage, 1, 0, 2, 0, 1, 0, 1, 0, 9, 8, 7, 0));
  assert.equal(image.type, "image");
  assert.deepEqual([image.x, image.y, image.width, image.height], [1, 2, 1, 1]);
  assert.deepEqual(Array.from(image.rgba), [9, 8, 7, 0]);

  const ended = parseViewerFrame(new Uint8Array([viewEnded, endConnectionLost, ...new TextEncoder().encode("gone")]).buffer);
  assert.deepEqual(ended, { type: "ended", end: endConnectionLost, reason: "gone" });
  const detached = parseViewerFrame(new Uint8Array([viewDetached, ...new TextEncoder().encode("taken")]).buffer);
  assert.deepEqual(detached, { type: "detached", reason: "taken" });
});

test("rejects malformed frames", () => {
  for (const malformed of [
    null,
    new Uint8Array(0).buffer,
    frame(1, 0, 0, 0),
    frame(viewH264, 7, 0),
    frame(viewH264, 7, 0, 0, 1),
    frame(viewH264, 7, 0, 0, 1, 0, 2, 0),
    frame(viewImage, 0, 0, 0, 0, 2, 0, 2, 0, 1, 2, 3, 4),
    frame(viewEnded),
    frame(99, 1, 2, 3),
    [1, 2, 3],
  ]) {
    assert.equal(parseViewerFrame(malformed), null);
  }
});
