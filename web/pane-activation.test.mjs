import assert from "node:assert/strict";
import test from "node:test";

import { paneNeedsRaise } from "./pane-activation.mjs";

test("a frontmost pane does not need another z-index", () => {
  const panes = [{ zIndex: 2 }, { zIndex: 8 }];

  assert.equal(paneNeedsRaise(panes, panes[1]), false);
});

test("a pane below another pane needs to be raised", () => {
  const panes = [{ zIndex: 2 }, { zIndex: 8 }];

  assert.equal(paneNeedsRaise(panes, panes[0]), true);
});

test("a tied z-index is raised to establish an unambiguous frontmost pane", () => {
  const panes = [{ zIndex: 8 }, { zIndex: 8 }];

  assert.equal(paneNeedsRaise(panes, panes[0]), true);
});
