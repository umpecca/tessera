import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptTerminalAlert,
  cleanTerminalAlertText,
  mergeTerminalAttention,
  showSystemNotification,
  terminalAttentionLabel,
  terminalNoticeText,
  TerminalNotices,
} from "./terminal-attention.mjs";

const alert = (fields) => ({ type: "terminal-alert", epoch: "e1", id: 1, kind: "bell", ...fields });

test("an alert is taken once per shell, newest first", () => {
  const seen = { epoch: "", id: 0 };
  assert.deepEqual(acceptTerminalAlert(seen, alert({ id: 2 })), { epoch: "e1", id: 2, kind: "bell" });
  assert.equal(acceptTerminalAlert(seen, alert({ id: 2 })), null, "repeated on reconnect");
  assert.equal(acceptTerminalAlert(seen, alert({ id: 1 })), null, "older");
  assert.deepEqual(seen, { epoch: "e1", id: 2 });
  assert.deepEqual(acceptTerminalAlert(seen, alert({ epoch: "e2", id: 1, kind: "notification", title: "Build", body: "Done" })),
    { epoch: "e2", id: 1, kind: "notification", title: "Build", body: "Done" }, "a new shell counts from one");
});

test("malformed alerts are ignored", () => {
  const seen = { epoch: "", id: 0 };
  for (const message of [null, { type: "attach" }, alert({ id: 0 }), alert({ id: 1.5 }), alert({ id: "3" }), alert({ epoch: 4 }), alert({ kind: "beep" })]) {
    assert.equal(acceptTerminalAlert(seen, message), null, JSON.stringify(message));
  }
  assert.deepEqual(seen, { epoch: "", id: 0 });
  assert.equal(acceptTerminalAlert(seen, alert({ kind: "notification", title: " \x1b ", body: "\x07" })), null, "nothing left to show");
  assert.deepEqual(seen, { epoch: "e1", id: 1 }, "but it was had");
});

test("alert text loses control characters and is cut short", () => {
  assert.equal(cleanTerminalAlertText("  Tests\x1b[31m\npassed\t\u0085ok  ", 100), "Tests [31m passed ok");
  assert.equal(cleanTerminalAlertText("ab😀cd", 4), "ab😀…");
  assert.equal(cleanTerminalAlertText(undefined, 10), "");
  const long = acceptTerminalAlert({ epoch: "", id: 0 }, alert({ kind: "notification", title: "t".repeat(500), body: "b".repeat(5000) }));
  assert.equal([...long.title].length, 200);
  assert.equal([...long.body].length, 1000);
});

test("a bell does not hide a notification waiting to be seen", () => {
  const notification = { epoch: "e1", id: 1, kind: "notification", title: "Build", body: "Done" };
  assert.deepEqual(mergeTerminalAttention(null, notification), notification);
  assert.deepEqual(mergeTerminalAttention(notification, { epoch: "e1", id: 2, kind: "bell" }), { ...notification, id: 2 });
  assert.deepEqual(mergeTerminalAttention({ epoch: "e1", id: 1, kind: "bell" }, notification), notification);
});

test("labels and notice text", () => {
  assert.equal(terminalAttentionLabel(null), "");
  assert.equal(terminalAttentionLabel({ kind: "bell" }), " [bell]");
  assert.equal(terminalAttentionLabel({ kind: "notification" }), " [notification]");
  assert.deepEqual(terminalNoticeText({ kind: "notification", title: "Tests", body: "12 passed" }, " Editor "), { title: "Tests", body: "12 passed", source: "Editor" });
  assert.deepEqual(terminalNoticeText({ kind: "notification", title: "", body: "Build done" }, "Editor"), { title: "Editor", body: "Build done", source: "" }, "OSC 9 has no title");
  assert.deepEqual(terminalNoticeText({ kind: "notification", title: "", body: "x" }, "  "), { title: "Terminal", body: "x", source: "" });
});

test("system notifications only with permission, and a click opens the pane", () => {
  let opened = 0;
  class Granted {
    static permission = "granted";
    constructor(title, options) { this.title = title; this.options = options; this.closed = false; }
    close() { this.closed = true; }
  }
  const shown = showSystemNotification(Granted, { title: "Build", body: "Done", tag: "tessera-p1" }, () => { opened += 1; });
  assert.deepEqual([shown.title, shown.options], ["Build", { body: "Done", tag: "tessera-p1" }]);
  shown.onclick();
  assert.equal(opened, 1);
  assert.equal(shown.closed, true);
  assert.equal(showSystemNotification(class { static permission = "default"; }, { title: "x" }, () => {}), null);
  assert.equal(showSystemNotification(undefined, { title: "x" }, () => {}), null);
  assert.equal(showSystemNotification(class { static permission = "granted"; constructor() { throw new TypeError("service worker"); } }, { title: "x" }, () => {}), null);
});

class FakeElement {
  constructor(document, tag) { this.ownerDocument = document; this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.parent = null; this.hidden = false; this.textContent = ""; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  click() { this.listeners.click?.(); }
  text() { return [this.textContent, ...this.children.map((child) => child.text())].filter(Boolean).join("|"); }
}
const fakeDocument = { createElement(tag) { return new FakeElement(fakeDocument, tag); } };

test("notices: one per pane, a limit, timeouts, open and dismiss", () => {
  const container = new FakeElement(fakeDocument, "div");
  const timers = new Map();
  let nextTimer = 0;
  const opened = [];
  const notices = new TerminalNotices(container, {
    onOpen: (key) => opened.push(key),
    limit: 2,
    setTimer: (run) => { nextTimer += 1; timers.set(nextTimer, run); return nextTimer; },
    clearTimer: (id) => timers.delete(id),
  });
  notices.show("p1", { title: "Build", body: "Done", source: "Editor" });
  assert.equal(container.hidden, false);
  assert.equal(container.children[0].text(), "Build|Done|Editor|×");
  notices.show("p1", { title: "Build", body: "Failed", source: "" });
  assert.equal(container.children.length, 1, "a newer notice replaces the pane's");
  assert.equal(container.children[0].text(), "Build|Failed|×");
  assert.equal(timers.size, 1);
  notices.show("p2", { title: "Two", body: "", source: "" });
  notices.show("p3", { title: "Three", body: "", source: "" });
  assert.deepEqual(container.children.map((notice) => notice.children[0].children[0].textContent), ["Two", "Three"], "oldest goes past the limit");
  container.children[0].children[0].click();
  assert.deepEqual(opened, ["p2"]);
  assert.equal(container.children.length, 1);
  container.children[0].children[1].click();
  assert.deepEqual(opened, ["p2"], "dismissing does not open");
  assert.equal(container.hidden, true);
  notices.show("p4", { title: "Four", body: "", source: "" });
  [...timers.values()].at(-1)();
  assert.equal(container.children.length, 0, "times out");
  assert.equal(timers.size, 0);
});

test("finished commands: accepted, worded by outcome and duration, labelled, and kept over bells", async () => {
  const { acceptTerminalAlert, mergeTerminalAttention, terminalAttentionLabel, terminalNoticeText, terminalCommandFailed, terminalDuration } = await import("./terminal-attention.mjs");
  const seen = { epoch: "", id: 0 };
  const failed = acceptTerminalAlert(seen, { type: "terminal-alert", epoch: "e", id: 1, kind: "command", title: "make\tall", status: 2, seconds: 252 });
  assert.deepEqual({ ...failed }, { epoch: "e", id: 1, kind: "command", title: "make all", status: 2, seconds: 252 });
  assert.equal(terminalCommandFailed(failed), true);
  assert.deepEqual(terminalNoticeText(failed, "Build"), { title: "make all", body: "Failed with exit status 2 after 4 min 12 s", source: "Build" });
  assert.equal(terminalAttentionLabel(failed), " [failed]");

  const quiet = acceptTerminalAlert(seen, { type: "terminal-alert", epoch: "e", id: 2, kind: "command", status: 0, seconds: 7 });
  assert.equal(terminalCommandFailed(quiet), false);
  assert.deepEqual(terminalNoticeText(quiet, "Build"), { title: "Build", body: "Command finished after 7 s", source: "" }, "no command line: the window's name");
  assert.equal(terminalAttentionLabel(quiet), " [finished]");

  const unknown = acceptTerminalAlert(seen, { type: "terminal-alert", epoch: "e", id: 3, kind: "command", status: -1, seconds: "x" });
  assert.equal(unknown.status, null, "no status from the shell");
  assert.equal(unknown.seconds, 0);
  assert.equal(terminalCommandFailed(unknown), false, "an unknown status isn't a failure");
  assert.deepEqual(terminalNoticeText(unknown, ""), { title: "Terminal", body: "Command finished", source: "" });
  assert.equal(acceptTerminalAlert(seen, { type: "terminal-alert", epoch: "e", id: 3, kind: "command" }), null, "seen already");

  const bell = { epoch: "e", id: 4, kind: "bell" };
  assert.deepEqual(mergeTerminalAttention(failed, bell), { ...failed, id: 4 }, "a bell keeps the command");
  assert.deepEqual(mergeTerminalAttention(bell, failed), failed);
  assert.deepEqual([terminalDuration(0), terminalDuration(59), terminalDuration(60), terminalDuration(3600), terminalDuration(3725)],
    ["0 s", "59 s", "1 min", "1 h", "1 h 2 min"]);
});
