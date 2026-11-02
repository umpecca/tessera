import assert from "node:assert/strict";
import test from "node:test";

import { readVideoFramePlanes, viewRows } from "./rdp-avc444.mjs";

test("a view's rows are the macroblock rows its rectangles touch", () => {
  assert.deepEqual(viewRows([[0, 20, 10, 5]], 100), { top: 16, rows: 16 });
  assert.deepEqual(viewRows([[0, 20, 10, 5], [40, 70, 8, 2]], 100), { top: 16, rows: 64 });
  assert.deepEqual(viewRows([[0, 90, 10, 10]], 100), { top: 80, rows: 20 }, "not past the view");
  assert.deepEqual(viewRows([], 100), { top: 0, rows: 0 });
  assert.deepEqual(viewRows([[0, 20, 0, 5], [0, 30, 5, 0]], 100), { top: 0, rows: 0 });
});

// A 64x48 frame whose copies are recorded. `rects` false makes it ignore the
// rectangle it is asked for; "throws" makes copying one fail.
function fakeFrame({ format = "NV12", rects = true } = {}) {
  const copies = [];
  const size = (options) => (options?.rect && rects === true ? 64 * options.rect.height * 1.5 : 64 * 48 * 1.5);
  return {
    copies,
    format,
    codedWidth: 64,
    codedHeight: 48,
    visibleRect: { x: 0, y: 0, width: 64, height: 48 },
    allocationSize: size,
    async copyTo(data, options) {
      if (options?.rect && rects === "throws") throw new TypeError("rect not supported");
      copies.push({ bytes: data.byteLength, rect: rects === true ? options?.rect : undefined });
      return [{ offset: 0, stride: 64 }, { offset: size(options) / 1.5, stride: 64 }];
    },
  };
}

test("copies only the rows the regions need", async () => {
  const frame = fakeFrame();
  const planes = await readVideoFramePlanes(frame, null, [[8, 20, 16, 4]], {});
  assert.deepEqual(frame.copies, [{ bytes: 64 * 16 * 1.5, rect: { x: 0, y: 16, width: 64, height: 16 } }]);
  assert.deepEqual([planes.top, planes.rows, planes.dataTop, planes.width, planes.height], [16, 16, 16, 64, 48]);
});

test("copies the whole picture for regions covering it, or without regions", async () => {
  const frame = fakeFrame();
  const covering = await readVideoFramePlanes(frame, null, [[0, 0, 64, 48]], {});
  const whole = await readVideoFramePlanes(frame, null);
  assert.deepEqual(frame.copies.map((copy) => copy.rect), [undefined, undefined]);
  assert.deepEqual([covering.top, covering.rows, covering.dataTop], [0, 48, 0]);
  assert.deepEqual([whole.top, whole.rows, whole.dataTop], [0, 48, 0]);
});

test("copies nothing for no regions", async () => {
  const frame = fakeFrame();
  const buffer = new Uint8Array(8);
  const planes = await readVideoFramePlanes(frame, buffer, [], {});
  assert.equal(frame.copies.length, 0);
  assert.equal(planes.rows, 0);
  assert.equal(planes.data, buffer);
});

test("goes on with whole pictures where a part can't be copied", async () => {
  for (const rects of [false, "throws"]) {
    const frame = fakeFrame({ rects });
    const state = {};
    const first = await readVideoFramePlanes(frame, null, [[0, 20, 8, 4]], state);
    assert.equal(state.wholePictures, true, String(rects));
    assert.deepEqual([first.top, first.rows, first.dataTop], [16, 16, 0], "uploads only the rows needed");
    assert.equal(frame.copies.at(-1).bytes, 64 * 48 * 1.5);
    await readVideoFramePlanes(frame, null, [[0, 20, 8, 4]], state);
    assert.equal(frame.copies.length, 2);
    assert.equal(frame.copies.at(-1).rect, undefined);
  }
});

test("reuses a buffer large enough", async () => {
  const frame = fakeFrame();
  const buffer = new Uint8Array(64 * 48 * 2);
  const planes = await readVideoFramePlanes(frame, buffer, [[0, 0, 8, 8]], {});
  assert.equal(planes.data, buffer);
});

test("reads only I420 and NV12", async () => {
  assert.equal(await readVideoFramePlanes(fakeFrame({ format: "RGBA" }), null, [[0, 0, 8, 8]], {}), null);
  assert.ok(await readVideoFramePlanes(fakeFrame({ format: "I420" }), null, [[0, 0, 8, 8]], {}));
});
