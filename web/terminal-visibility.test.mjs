import test from "node:test";
import assert from "node:assert/strict";
import { terminalIsCovered } from "./terminal-visibility.mjs";

const terminal = { kind: "terminal", x: 20, y: 20, width: 100, height: 100, zIndex: 1 };
const cover = { kind: "worksheet", x: 0, y: 0, width: 150, height: 150, zIndex: 2 };

test("pauses only when a higher opaque pane completely covers the terminal", () => {
  assert.equal(terminalIsCovered(terminal, [terminal, cover]), true);
  assert.equal(terminalIsCovered(terminal, [terminal, { ...terminal, zIndex: 2 }]), true);
  for (const change of [{ minimized: true }, { kind: "pending" }, { zIndex: 0 }, { x: 30 }, { height: 100 }]) {
    assert.equal(terminalIsCovered(terminal, [terminal, { ...cover, ...change }]), false);
  }
  assert.equal(terminalIsCovered(terminal, [terminal]), false);
});
