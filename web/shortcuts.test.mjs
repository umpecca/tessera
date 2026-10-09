import assert from "node:assert/strict";
import test from "node:test";
import { shortcutCodeError, duplicateShortcut, ShortcutsModal } from "./shortcuts.mjs";

test("custom codes reject duplicate, built-in, and direct-dispatch prefixes", () => {
  const items = [{ id: "first", code: "CE" }], reserved = ["NN", "CS", "S"];
  assert.equal(shortcutCodeError("CE", items, reserved, "first"), "");
  for (const code of ["CE", "NN", "CS", "SA", "C", "123", "ce"]) assert.ok(shortcutCodeError(code, items, reserved, "other"));
  assert.equal(shortcutCodeError("CF", items, reserved, "other"), "");
});

test("duplicate creates a separate editable definition and requires a new code", () => {
  const original = { id: "one", name: "Editor", code: "CE", fields: [{ id: "file", default: "original" }] };
  const copy = duplicateShortcut(original);
  copy.fields[0].default = "copy";
  assert.notEqual(copy.id, original.id); assert.equal(copy.code, ""); assert.equal(copy.name, "Editor copy");
  assert.equal(original.fields[0].default, "original");
});

function launchFixture() {
  let resolve, reject;
  const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
  const context = { user: "alice", workspaceId: "one", cwd: "/project" }, launched = [];
  const modal = Object.create(ShortcutsModal.prototype);
  Object.assign(modal, {
    generation: 1, busy: false, user: "alice", element: { hidden: true },
    getContext: () => context, setBusy(value) { this.busy = value; }, showError(error) { this.lastError = error; }, render() {},
    request: () => pending, onLaunch: value => launched.push(value),
    invocation: { shortcut: { id: "editor", name: "Editor" }, test: false, context: { ...context } },
  });
  return { modal, context, resolve, reject, launched };
}

test("a launch is single-use while pending and cancellation suppresses late responses", async () => {
  const f = launchFixture(); const first = f.modal.launch({ file: "draft" });
  await f.modal.launch({ file: "second" }); f.modal.close();
  f.resolve({ command: "fresh", title: "Editor" }); await first;
  assert.deepEqual(f.launched, []);
});

test("user and workspace switches cannot launch a late terminal", async () => {
  for (const key of ["user", "workspaceId"]) {
    const f = launchFixture(); const pending = f.modal.launch({}); f.context[key] = "other";
    f.resolve({ command: "fresh" }); await pending; assert.deepEqual(f.launched, []);
  }
});

test("launch errors retain supplied values and successful responses launch once", async () => {
  const f = launchFixture(); const values = { file: "draft with spaces", flag: false };
  const pending = f.modal.launch(values); f.reject(new Error("required input")); await pending;
  assert.equal(f.modal.element.hidden, false); assert.deepEqual(f.modal.invocation.values, values);
  assert.match(f.modal.lastError.message, /required/); assert.deepEqual(f.launched, []);
  const success = launchFixture(); const launched = success.modal.launch({}); success.resolve({ command: "fresh" }); await launched;
  assert.deepEqual(success.launched, [{ command: "fresh" }]); assert.equal(success.modal.element.hidden, true);
});

test("concurrent saves preserve draft edits and offer reloading", async () => {
  const f = launchFixture();
  f.modal.revision = "old"; f.modal.items = []; f.modal.draft = { name: "Unsaved" }; f.modal.dirty = true;
  f.modal.reloadButton = { hidden: true };
  const pending = f.modal.save([]); f.reject(Object.assign(new Error("changed"), { status: 409 })); await pending;
  assert.equal(f.modal.draft.name, "Unsaved"); assert.equal(f.modal.dirty, true); assert.equal(f.modal.revision, "old");
  assert.equal(f.modal.reloadButton.hidden, false); assert.equal(f.modal.busy, false);
});
