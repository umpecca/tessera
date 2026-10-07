import assert from "node:assert/strict";
import test from "node:test";

import { defaultTerminalTERM, normalizeTerminalTERM, defaultTerminalRowSpacing, normalizeTerminalRowSpacing, terminalRowSpacings } from "./terminal-settings.mjs";

test("terminal TERM normalization preserves conventional terminfo names", () => {
  assert.equal(normalizeTerminalTERM(" xterm-ghostty "), "xterm-ghostty");
  assert.equal(normalizeTerminalTERM("screen_256color+custom"), "screen_256color+custom");
});

test("terminal TERM normalization falls back for unsafe or missing values", () => {
  for (const value of ["", "-xterm", "xterm 256color", "xterm;echo nope", null]) {
    assert.equal(normalizeTerminalTERM(value), defaultTerminalTERM);
  }
});

test("terminal row spacing defaults to Tight and accepts Comfortable", () => {
  assert.equal(defaultTerminalRowSpacing, "tight");
  assert.equal(terminalRowSpacings.tight.padding, 0);
  assert.equal(terminalRowSpacings.comfortable.padding, 2);
  assert.equal(normalizeTerminalRowSpacing("comfortable"), "comfortable");
  for (const value of [undefined, null, "", "tight", "invalid", 2]) {
    assert.equal(normalizeTerminalRowSpacing(value), "tight");
  }
});
