import assert from "node:assert/strict";
import test from "node:test";

import { terminalMouseMessage } from "./terminal-input.mjs";

test("terminal mouse input is tagged separately from ordinary binary input", () => {
  const sequence = "\x1b[<32;53;17M";
  assert.deepEqual(JSON.parse(terminalMouseMessage(sequence)), {
    type: "mouse",
    data: sequence,
  });
});
