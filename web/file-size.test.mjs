import assert from "node:assert/strict";
import test from "node:test";

import { formatFileSize } from "./file-size.mjs";

test("formats bytes and IEC unit boundaries compactly", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(1023), "1023 B");
  assert.equal(formatFileSize(1024), "1 KiB");
  assert.equal(formatFileSize(1536), "1.5 KiB");
  assert.equal(formatFileSize(10 * 1024), "10 KiB");
  assert.equal(formatFileSize(1024 ** 2), "1 MiB");
  assert.equal(formatFileSize(2.25 * 1024 ** 3), "2.3 GiB");
  assert.equal(formatFileSize(1024 ** 5), "1 PiB");
});

test("leaves directory sizes blank", () => {
  assert.equal(formatFileSize(4096, "directory"), "");
  assert.equal(formatFileSize(null, "directory"), "");
});

test("marks unavailable or invalid file sizes", () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, "1024"]) {
    assert.equal(formatFileSize(value), "—");
  }
});
