import assert from "node:assert/strict";
import test from "node:test";

import {
  PhoneInput,
  characterKeyInit,
  insertAttachmentPath,
  phoneDraftStoragePrefix,
  phoneKeyInit,
  phoneKeys,
  phoneReplies,
  removeAttachmentPath,
  terminalAwaitsReply,
} from "./phone-input.mjs";

const keyNamed = (name) => phoneKeys.find((definition) => definition.name === name || definition.label === name);

test("key-row keys are the key events a keyboard sends", () => {
  assert.deepEqual(phoneKeyInit(keyNamed("Escape")), { key: "Escape", code: "Escape" });
  assert.deepEqual(phoneKeyInit(keyNamed("Shift+Tab")), { key: "Tab", code: "Tab", shiftKey: true });
  assert.deepEqual(phoneKeyInit(keyNamed("Up")), { key: "ArrowUp", code: "ArrowUp" });
  assert.deepEqual(phoneKeyInit(keyNamed("Control+C")), { key: "c", code: "KeyC", ctrlKey: true });
  assert.deepEqual(phoneKeyInit(keyNamed("Pipe")), { key: "|", code: "Backslash", shiftKey: true });
  assert.deepEqual(phoneKeyInit(keyNamed("Up"), { ctrl: true }), { key: "ArrowUp", code: "ArrowUp", ctrlKey: true });
  assert.equal(phoneKeyInit(keyNamed("Ctrl")), null, "Ctrl itself sends nothing");
  assert.deepEqual(phoneReplies.map((reply) => reply.init.key), ["1", "2", "3", "y", "n", "Enter", "Escape"]);
});

test("a character typed with Ctrl held becomes that control key", () => {
  assert.deepEqual(characterKeyInit("r", { ctrl: true }), { key: "r", code: "KeyR", ctrlKey: true });
  assert.deepEqual(characterKeyInit("R", { ctrl: true }), { key: "r", code: "KeyR", ctrlKey: true }, "the phone capitalized it");
  assert.deepEqual(characterKeyInit("[", { ctrl: true }), { key: "[", code: "BracketLeft", ctrlKey: true });
  assert.deepEqual(characterKeyInit("A"), { key: "A", code: "KeyA", ctrlKey: false, shiftKey: true });
  assert.deepEqual(characterKeyInit("7"), { key: "7", code: "Digit7", ctrlKey: false });
  assert.equal(characterKeyInit("é", { ctrl: true }), null);
  assert.equal(characterKeyInit("ab"), null);
});

test("a running program that has gone quiet is waiting for an answer", () => {
  assert.equal(terminalAwaitsReply(null), false);
  assert.equal(terminalAwaitsReply({ running: true, outputSecondsAgo: 0 }), false, "still printing");
  assert.equal(terminalAwaitsReply({ running: true, outputSecondsAgo: 1 }, 2), true, "quiet for 3 s by now");
  assert.equal(terminalAwaitsReply({ running: false, outputSecondsAgo: 60 }), false, "a shell at its prompt");
  assert.equal(terminalAwaitsReply({ running: true, outputSecondsAgo: -1 }, 10), false, "never printed");
  assert.equal(terminalAwaitsReply({ running: true, exited: true, outputSecondsAgo: 9 }), false);
  assert.equal(terminalAwaitsReply({ running: false }, 0, true), true, "it rang or notified");
});

class FakeElement {
  constructor(ownerDocument, tag) {
    this.ownerDocument = ownerDocument;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.className = "";
    this.textContent = "";
    this.value = "";
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  dispatch(type, event = {}) {
    let prevented = false;
    for (const listener of this.listeners[type] || []) listener({ preventDefault() { prevented = true; }, target: this, ...event });
    return prevented;
  }
  click() { this.dispatch("click"); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  get innerText() { return this.textContent + this.children.map((child) => child.innerText).join(""); }
  findAll(match) { const found = []; for (const child of this.children) { if (match(child)) found.push(child); found.push(...child.findAll(match)); } return found; }
  byClass(name) { return this.findAll((node) => node.className.split(" ").includes(name)); }
  button(name) { return this.findAll((node) => node.tagName === "BUTTON" && (node.attributes["aria-label"] === name || node.textContent === name))[0]; }
}

function setup(overrides = {}) {
  const document = { activeElement: null, createElement: (tag) => new FakeElement(document, tag) };
  const sent = [];
  const stored = new Map();
  const input = new PhoneInput(document, {
    sendText: (pane, text, options) => sent.push(["text", pane, text, options.enter]),
    sendKey: (pane, init) => sent.push(["key", pane, init]),
    typeDirectly: (pane) => sent.push(["direct", pane]),
    storage: { get: (key) => stored.get(key) ?? null, set: (key, value) => stored.set(key, value), remove: (key) => stored.delete(key) },
    newID: () => "new-id",
    ...overrides,
  });
  return { document, input, sent, stored };
}

test("the compose field sends a line, keeps drafts per terminal, and Send can skip Enter", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { input, sent, stored } = setup();
  stored.set(phoneDraftStoragePrefix + "b", "half-typed");
  input.attach("a");
  assert.equal(input.element.hidden, false);
  input.field.value = "git status";
  input.field.dispatch("input");
  assert.equal(stored.get(phoneDraftStoragePrefix + "a"), "git status");
  input.sendButton.dispatch("pointerdown");
  input.sendButton.dispatch("pointerup");
  input.sendButton.click();
  assert.deepEqual(sent, [["text", "a", "git status", true]]);
  assert.equal(input.field.value, "");
  assert.equal(stored.has(phoneDraftStoragePrefix + "a"), false, "a sent draft is gone");

  input.attach("b");
  assert.equal(input.field.value, "half-typed", "each terminal keeps its own draft");
  input.sendButton.dispatch("pointerdown");
  t.mock.timers.tick(500);
  input.sendButton.click();
  assert.deepEqual(sent.at(-1), ["text", "b", "half-typed", false], "held: sent without Enter");
  assert.equal(sent.length, 2, "the click after a hold sends nothing more");

  input.sendButton.click();
  assert.deepEqual(sent.at(-1), ["text", "b", "", true], "an empty field still sends Enter");
  input.detach();
  assert.equal(input.element.hidden, true);
  input.sendButton.click();
  assert.equal(sent.length, 3, "nothing goes to a terminal no longer open");
});

test("Ctrl applies to the next key or typed character, once", () => {
  const { input, sent } = setup();
  input.attach("a");
  const ctrl = input.ctrlButton;
  ctrl.click();
  assert.equal(ctrl.getAttribute("aria-pressed"), "true");
  input.keys.button("Up").click();
  assert.deepEqual(sent.at(-1), ["key", "a", { key: "ArrowUp", code: "ArrowUp", ctrlKey: true }]);
  assert.equal(ctrl.getAttribute("aria-pressed"), "false");
  input.keys.button("Up").click();
  assert.deepEqual(sent.at(-1), ["key", "a", { key: "ArrowUp", code: "ArrowUp" }]);

  ctrl.click();
  const prevented = input.field.dispatch("beforeinput", { inputType: "insertText", data: "R" });
  assert.equal(prevented, true, "the R is not typed into the field");
  assert.deepEqual(sent.at(-1), ["key", "a", { key: "r", code: "KeyR", ctrlKey: true }]);
  assert.equal(input.field.dispatch("beforeinput", { inputType: "insertText", data: "x" }), false, "Ctrl was used up");
});

test("quick replies show while a program waits, and on request", () => {
  const { input, sent } = setup();
  input.attach("a");
  assert.equal(input.replies.hidden, true);
  input.update({ running: true, outputSecondsAgo: 0 }, 0);
  assert.equal(input.replies.hidden, true);
  input.update({ running: true, outputSecondsAgo: 4 }, 0);
  assert.equal(input.replies.hidden, false);
  assert.equal(input.element.dataset.waiting, "true");
  input.replies.button("2").click();
  assert.deepEqual(sent.at(-1), ["key", "a", { key: "2", code: "Digit2" }]);
  input.update({ running: false, outputSecondsAgo: 0 }, 0);
  assert.equal(input.replies.hidden, true);
  input.repliesButton.click();
  assert.equal(input.replies.hidden, false, "asked for");

  input.attach("b", { alerted: true });
  assert.equal(input.replies.hidden, false, "it rang before the phone opened it");
  input.update({ running: true, outputSecondsAgo: 9999 }, 0);
  assert.equal(input.replies.hidden, false);
  input.field.value = "yes";
  input.sendButton.click();
  input.update({ running: false, outputSecondsAgo: 9999 }, 0);
  assert.equal(input.replies.hidden, true, "answered");
});

test("the keys button types straight into the terminal instead", () => {
  const { input, sent, document } = setup();
  input.attach("a");
  input.directButton.click();
  assert.deepEqual(sent.at(-1), ["direct", "a"]);
  assert.equal(input.compose.hidden, true);
  input.directButton.click();
  assert.equal(input.compose.hidden, false);
  assert.equal(document.activeElement, input.field);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the sheet fills the field from recent commands and snippets, and edits snippets", async () => {
  let doc = { revision: "r1", snippets: [{ id: "s1", label: "Review", text: "Review the diff.\nBe brief." }] };
  const saves = [];
  const { input, sent } = setup({
    loadSnippets: async () => structuredClone(doc),
    saveSnippets: async (next) => {
      saves.push(structuredClone(next));
      if (next.revision !== doc.revision) throw Object.assign(new Error("conflict"), { status: 409 });
      doc = { revision: `r${saves.length + 1}`, snippets: next.snippets };
      return structuredClone(doc);
    },
  });
  input.attach("a");
  input.update({ recentCommands: ["make test", "git push"] }, 0);
  await input.openSheet();
  assert.equal(input.sheet.hidden, false);
  assert.deepEqual(input.sheet.byClass("phone-sheet-command").map((node) => node.textContent), ["make test", "git push"]);
  input.sheet.byClass("phone-sheet-command")[1].click();
  assert.equal(input.field.value, "git push");
  assert.equal(input.sheet.hidden, true);
  assert.equal(sent.length, 0, "filling never sends");

  await input.openSheet();
  input.sheet.byClass("phone-sheet-use")[0].click();
  assert.equal(input.field.value, "Review the diff.\nBe brief.");

  // A new snippet starts from what is in the field.
  input.field.value = "npm test -- --watch";
  await input.openSheet();
  input.sheet.button("New snippet").click();
  const form = input.sheet.byClass("phone-snippet-form")[0];
  const [name, text] = form.findAll((node) => node.tagName === "INPUT" || node.tagName === "TEXTAREA");
  assert.equal(text.value, "npm test -- --watch");
  name.value = "Watch tests";
  form.dispatch("submit");
  await settle();
  assert.deepEqual(saves.at(-1).snippets.map((s) => [s.id, s.label]), [["s1", "Review"], ["new-id", "Watch tests"]]);
  assert.equal(input.editing, null);
  assert.equal(input.sheet.byClass("phone-sheet-label").map((n) => n.textContent).join(","), "Review,Watch tests");

  // Another device saved first: the list reloads and the edit stays open.
  doc = { revision: "elsewhere", snippets: [{ id: "s9", label: "", text: "ls" }] };
  input.sheet.button("Edit Review").click();
  const editForm = input.sheet.byClass("phone-snippet-form")[0];
  editForm.findAll((node) => node.tagName === "TEXTAREA")[0].value = "Changed";
  editForm.dispatch("submit");
  await settle(); await settle();
  assert.equal(input.snippetsRevision, "elsewhere");
  assert.match(input.sheet.byClass("phone-sheet-error")[0].textContent, /Another device/);
  assert.equal(input.editing.text, "Changed", "what was typed is kept");

  // A snippet can't be empty.
  const again = input.sheet.byClass("phone-snippet-form")[0];
  again.findAll((node) => node.tagName === "TEXTAREA")[0].value = "  ";
  again.dispatch("submit");
  await settle();
  assert.match(input.sheet.byClass("phone-sheet-error")[0].textContent, /needs text/);
});

test("an attached path goes in at the cursor, set apart by spaces, and can come out again", () => {
  assert.deepEqual(insertAttachmentPath("", 0, 0, "/a.png"), { value: "/a.png ", cursor: 7 });
  assert.deepEqual(insertAttachmentPath("look at", 7, 7, "/a.png"), { value: "look at /a.png ", cursor: 15 });
  assert.deepEqual(insertAttachmentPath("look at  please", 8, 8, "/a.png"), { value: "look at /a.png please", cursor: 14 });
  assert.deepEqual(insertAttachmentPath("see X now", 4, 5, "/a.png"), { value: "see /a.png now", cursor: 10 }, "replaces a selection");
  assert.equal(removeAttachmentPath("look at /a.png please", "/a.png"), "look at please");
  assert.equal(removeAttachmentPath("/a.png ", "/a.png"), "");
  assert.equal(removeAttachmentPath("look at /a.png", "/a.png"), "look at");
  assert.equal(removeAttachmentPath("edited away", "/a.png"), "edited away");
});

test("picked and pasted images are kept on the host, their paths put in the field", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const uploads = [];
  const pastes = [];
  let refuse = "";
  const { input, sent } = setup({
    attachFile: async (file) => {
      uploads.push(file.name);
      if (refuse) throw new Error(refuse);
      return { path: `/cache/attachments/${file.name}` };
    },
    pasteImage: async (pane, file) => { pastes.push([pane, file.name]); },
  });
  input.attach("a");
  input.field.value = "what is wrong in";
  input.field.selectionStart = input.field.selectionEnd = input.field.value.length;
  let opened = 0;
  input.picker.click = () => { opened += 1; };
  input.attachButton.click();
  assert.equal(opened, 1, "the button opens the phone's picker");

  input.picker.files = [{ name: "IMG_1.jpeg", type: "image/jpeg" }];
  input.picker.dispatch("change");
  await settle();
  assert.deepEqual(uploads, ["IMG_1.jpeg"]);
  assert.equal(input.field.value, "what is wrong in /cache/attachments/IMG_1.jpeg ");
  assert.equal(input.noticeText.textContent, "Added IMG_1.jpeg");
  assert.equal(input.noticeAction.hidden, false);
  assert.equal(sent.length, 0, "nothing is sent until Send");

  // Pasting it into the program instead takes its path back out.
  input.noticeAction.click();
  await settle();
  assert.deepEqual(pastes, [["a", "IMG_1.jpeg"]]);
  assert.equal(input.field.value, "what is wrong in");
  assert.equal(input.noticeText.textContent, "Pasted IMG_1.jpeg into the program");

  // A screenshot pasted into the field; text pastes stay text.
  const paste = (files, text = "") => input.field.dispatch("paste", { clipboardData: { files, getData: () => text } });
  assert.equal(paste([{ name: "shot.png", type: "image/png" }], "a caption"), false, "text wins");
  assert.equal(paste([{ name: "shot.png", type: "image/png" }, { name: "two.png", type: "image/png" }]), true);
  await settle(); await settle();
  assert.deepEqual(uploads.slice(1), ["shot.png", "two.png"]);
  assert.match(input.field.value, /\/cache\/attachments\/shot\.png \/cache\/attachments\/two\.png $/);
  assert.equal(input.noticeText.textContent, "Added 2 images");
  assert.equal(input.noticeAction.hidden, true, "no paste instead for several");

  refuse = "it is larger than the host accepts";
  input.picker.files = [{ name: "huge.heic", type: "image/heic" }];
  input.picker.dispatch("change");
  await settle();
  assert.equal(input.noticeText.textContent, "huge.heic wasn't sent: it is larger than the host accepts");
  t.mock.timers.tick(10000);
  assert.equal(input.notice.hidden, true, "the notice goes after a while");
});
