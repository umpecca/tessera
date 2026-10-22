import test from "node:test";
import assert from "node:assert/strict";

import {
  clipboardSaveEntries,
  deleteSavedFiles,
  hostFileURL,
  LastClipboardSave,
  saveEntries,
  transferSaveEntries,
  uniqueSaveNames,
} from "./save-clipboard.mjs";

const item = (types) => ({
  types: Object.keys(types),
  getType: async (type) => new Blob([types[type]], { type }),
});

test("repeated names get a number before the extension", () => {
  assert.deepEqual(uniqueSaveNames(["clipboard.png", "clipboard.png", "notes", "notes", "clipboard.png"]),
    ["clipboard.png", "clipboard-2.png", "notes", "notes-2", "clipboard-3.png"]);
});

test("clipboard items save as an image when they hold one, else plain text", async () => {
  const entries = await clipboardSaveEntries([
    item({ "image/png": "png", "text/plain": "alt" }),
    item({ "text/html": "<b>x</b>", "text/plain": "x" }),
    item({ "text/html": "<b>only</b>" }),
    item({ "text/plain": "" }),
  ]);
  assert.deepEqual(entries.map(entry => [entry.name, entry.kind, entry.blob.type]), [
    ["clipboard.png", "image", "image/png"],
    ["clipboard.txt", "text", "text/plain"],
    ["clipboard.html", "text", "text/html"],
  ]);
});

test("a paste or drop saves its files under their own names, else its text", () => {
  const pdf = new File(["%PDF"], "report.pdf", { type: "application/pdf" });
  const shot = new File(["png"], "", { type: "image/png" });
  assert.deepEqual(transferSaveEntries({ files: [pdf, shot], getData: () => "ignored" }).map(entry => [entry.name, entry.kind]),
    [["report.pdf", "file"], ["clipboard.png", "image"]]);
  assert.deepEqual(transferSaveEntries({ files: [], getData: () => "hello" }).map(entry => entry.name), ["clipboard.txt"]);
  assert.deepEqual(transferSaveEntries({ files: [], getData: () => "" }), []);
});

test("the save URL carries the folder, the name and overwrite only when agreed", () => {
  assert.equal(hostFileURL("/Users/me", "a b.txt"), "/api/host/files?directory=%2FUsers%2Fme&name=a+b.txt");
  assert.match(hostFileURL("/tmp", "a.txt", true), /&overwrite=1$/);
});

function fakeServer(existing = new Set()) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const query = new URL(url, "http://tessera").searchParams;
    const name = query.get("name");
    calls.push({ name, overwrite: query.get("overwrite") === "1", body: await options.body.text() });
    if (existing.has(name) && query.get("overwrite") !== "1") {
      return { ok: false, status: 409, json: async () => ({ error: "destination file already exists" }) };
    }
    return { ok: true, status: 201, json: async () => ({ path: `${query.get("directory")}/${name}` }) };
  };
  return { calls, fetchImpl };
}

test("saving asks before replacing and skips a file the person keeps", async () => {
  const server = fakeServer(new Set(["keep.txt", "replace.txt"]));
  const entries = ["new.txt", "keep.txt", "replace.txt"].map(name => ({ name, blob: new Blob([name]) }));
  const asked = [];
  const result = await saveEntries(entries, "/tmp", {
    fetchImpl: server.fetchImpl,
    confirmReplace: async (name) => { asked.push(name); return name === "replace.txt"; },
  });
  assert.deepEqual(asked, ["keep.txt", "replace.txt"]);
  assert.deepEqual(result, { saved: ["/tmp/new.txt", "/tmp/replace.txt"], skipped: ["keep.txt"] });
  assert.deepEqual(server.calls.filter(call => call.overwrite).map(call => call.name), ["replace.txt"]);
});

test("a failed save stops and names the file", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "destination is not a directory" }) });
  await assert.rejects(saveEntries([{ name: "a.txt", blob: new Blob(["a"]) }], "/nope", { fetchImpl }),
    /a\.txt: destination is not a directory/);
});

test("delete sends the saved paths and reports what was kept", async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ deleted: ["/tmp/a.txt"], kept: [{ path: "/tmp/b.txt", reason: "changed since it was saved" }] }) };
  };
  const result = await deleteSavedFiles(["/tmp/a.txt", "/tmp/b.txt"], fetchImpl);
  assert.equal(sent.url, "/api/host/files/delete");
  assert.deepEqual(sent.body, { paths: ["/tmp/a.txt", "/tmp/b.txt"] });
  assert.equal(result.kept[0].reason, "changed since it was saved");
});

test("the last save survives a reload and clears after delete", () => {
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  new LastClipboardSave({ storage }).set(["/tmp/a.txt"], "/tmp");
  const reloaded = new LastClipboardSave({ storage });
  assert.deepEqual(reloaded.paths, ["/tmp/a.txt"]);
  reloaded.set([], "");
  assert.deepEqual(new LastClipboardSave({ storage }).paths, []);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const memoryOnly = new LastClipboardSave({ storage: broken });
  memoryOnly.set(["/tmp/b.txt"], "/tmp");
  assert.deepEqual(memoryOnly.paths, ["/tmp/b.txt"]);
});
