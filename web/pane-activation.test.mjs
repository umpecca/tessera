import assert from "node:assert/strict";
import test from "node:test";

import { activePaneOnLoad, focusPane, paneNeedsRaise } from "./pane-activation.mjs";

function pane(id, options = {}) {
  return {
    id,
    zIndex: options.zIndex ?? 1,
    isFull: Boolean(options.isFull),
    minimized: Boolean(options.minimized),
  };
}

test("a reloaded workspace activates the pane that was last focused", () => {
  const panes = [pane("a", { zIndex: 3 }), pane("b", { zIndex: 9 })];

  assert.equal(activePaneOnLoad(panes, "a"), panes[0]);
});

// Focusing a window in front of a maximized one is an explicit choice, and a
// reload used to throw it away and hand the maximized pane the focus back.
test("a pane raised above a maximized one keeps the focus it was given", () => {
  const maximized = pane("editor", { zIndex: 26, isFull: true });
  const raised = pane("terminal", { zIndex: 27 });

  assert.equal(activePaneOnLoad([maximized, raised], "terminal"), raised);
});

// Putting the caret in a window the operator cannot see would be worse than
// ignoring what was saved.
test("a maximized pane takes over when the saved pane is behind it", () => {
  const maximized = pane("editor", { zIndex: 26, isFull: true });
  const buried = pane("terminal", { zIndex: 4 });

  assert.equal(activePaneOnLoad([maximized, buried], "terminal"), maximized);
});

test("a maximized pane that is itself the saved pane is activated", () => {
  const maximized = pane("editor", { zIndex: 26, isFull: true });

  assert.equal(activePaneOnLoad([maximized, pane("other", { zIndex: 2 })], "editor"), maximized);
});

test("a minimized pane is never activated, saved or maximized", () => {
  const hidden = pane("editor", { zIndex: 30, isFull: true, minimized: true });
  const visible = pane("terminal", { zIndex: 4 });

  assert.equal(activePaneOnLoad([hidden, visible], "editor"), null);
  assert.equal(activePaneOnLoad([hidden, visible], "terminal"), visible);
});

test("the topmost maximized pane wins when more than one is maximized", () => {
  const lower = pane("a", { zIndex: 10, isFull: true });
  const upper = pane("b", { zIndex: 20, isFull: true });

  assert.equal(activePaneOnLoad([lower, upper], "missing"), upper);
});

test("a workspace with nothing saved and nothing maximized activates nothing", () => {
  assert.equal(activePaneOnLoad([pane("a", { zIndex: 1 })], ""), null);
  assert.equal(activePaneOnLoad([], "a"), null);
});

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
