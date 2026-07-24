import assert from "node:assert/strict";
import test from "node:test";

import { focusPane, paneNeedsRaise } from "./pane-activation.mjs";

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

function focusable() {
  return {
    calls: 0,
    focus() {
      this.calls += 1;
    },
  };
}

test("terminal and editor panes use their native focus APIs", () => {
  const terminal = focusable();
  const editor = focusable();

  assert.equal(focusPane({ kind: "terminal", terminal: { term: terminal } }), true);
  assert.equal(focusPane({ kind: "worksheet", editor }), true);
  assert.equal(terminal.calls, 1);
  assert.equal(editor.calls, 1);
});

test("browser panes focus the live frame or fall back to the address", () => {
  const frame = { ...focusable(), hidden: false };
  const address = focusable();

  focusPane({ kind: "browser", browser: { frame, address } });
  assert.equal(frame.calls, 1);
  assert.equal(address.calls, 0);

  frame.hidden = true;
  focusPane({ kind: "browser", browser: { frame, address } });
  assert.equal(address.calls, 1);
});

test("file browser, audio, and generic panes use pane-owned DOM targets", () => {
  const selectedEntry = focusable();
  const firstEntry = focusable();
  const upButton = focusable();
  const play = focusable();
  const element = focusable();
  const content = {
    querySelector(selector) {
      return selector.includes(".is-selected") ? selectedEntry : firstEntry;
    },
  };

  focusPane({ kind: "file-browser", fileBrowserView: { content, upButton } });
  focusPane({ kind: "audio", audio: { play } });
  focusPane({ kind: "pending", element });

  assert.equal(selectedEntry.calls, 1);
  assert.equal(firstEntry.calls, 0);
  assert.equal(upButton.calls, 0);
  assert.equal(play.calls, 1);
  assert.equal(element.calls, 1);
});

test("disabled pane controls fall back to the pane container", () => {
  const play = { ...focusable(), disabled: true };
  const element = focusable();

  focusPane({ kind: "audio", audio: { play }, element });

  assert.equal(play.calls, 0);
  assert.equal(element.calls, 1);
});

test("focusPane reports when a pane has no focusable target", () => {
  assert.equal(focusPane(null), false);
  assert.equal(focusPane({ kind: "audio" }), false);
});
