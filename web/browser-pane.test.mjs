import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  browseLocalPortHelpCommand,
  browserHelpAddress,
  browserLocalPortExamples,
  isLoopbackBrowserHost,
  normalizeBrowserAddress,
} from "./browser-pane.mjs";

test("normalizes loopback development-server addresses", () => {
  assert.equal(normalizeBrowserAddress("localhost:5000"), "http://localhost:5000/");
  assert.equal(normalizeBrowserAddress("127.0.0.1:5173/app?q=1"), "http://127.0.0.1:5173/app?q=1");
  assert.equal(normalizeBrowserAddress("http://[::1]:8080/"), "http://[::1]:8080/");
  assert.equal(normalizeBrowserAddress("https://localhost:8443/#secret"), "https://localhost:8443/");
});

test("rejects non-loopback and non-HTTP browser addresses", () => {
  assert.equal(normalizeBrowserAddress("https://example.com"), "");
  assert.equal(normalizeBrowserAddress("file:///tmp/index.html"), "");
  assert.equal(normalizeBrowserAddress("http://user:pass@localhost:5000"), "");
  assert.equal(normalizeBrowserAddress("not a url"), "");
  assert.equal(normalizeBrowserAddress(""), "");
  assert.equal(isLoopbackBrowserHost("127.255.10.4"), true);
  assert.equal(isLoopbackBrowserHost("128.0.0.1"), false);
});

test("local-port help uses the current valid address or the Flask default", () => {
  assert.equal(browserHelpAddress("localhost:5173/app"), "http://localhost:5173/app");
  assert.equal(browserHelpAddress("https://example.com"), "localhost:5000");
  assert.equal(browserHelpAddress(""), "localhost:5000");
});

test("local-port help examples are valid and expose the command-palette route", () => {
  assert.equal(browseLocalPortHelpCommand.id, "browse-local-port-help");
  assert.equal(browseLocalPortHelpCommand.label, "Browse Local Port Help");
  assert.equal(browserLocalPortExamples.length, 3);
  for (const example of browserLocalPortExamples) {
    assert.ok(example.label);
    assert.ok(example.command);
    assert.ok(normalizeBrowserAddress(example.address), `${example.address} should be a valid Browser address`);
  }
});

function openTerminalLinkWith(rectangles) {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const start = source.indexOf("function openTerminalLink(");
  const end = source.indexOf("\n}\n", start) + 2;
  const calls = { tabs: [], created: [], navigated: [], raised: [] };
  const open = vm.runInNewContext(`(${source.slice(start, end)})`, {
    normalizeBrowserAddress, rectangles, browserPaneKind: "browser",
    window: { open: (url) => calls.tabs.push(url) },
    paneSpawnPoint: () => ({ x: 48, y: 80 }),
    createBrowserPane: (x, y) => { const pane = { x, y }; calls.created.push(pane); return pane; },
    navigateBrowserPane: async (pane, url) => { calls.navigated.push([pane, url]); },
    setActivePane: (rect) => calls.raised.push(rect),
  });
  return { open, calls };
}

test("a terminal link to the host's loopback opens in a Browser window", () => {
  const { open, calls } = openTerminalLinkWith([]);
  open("http://localhost:5173/app");
  open("http://127.0.0.1:8000/");
  assert.deepEqual(calls.navigated.map(([, url]) => url), ["http://localhost:5173/app", "http://127.0.0.1:8000/"]);
  assert.equal(calls.created.length, 2);
  assert.deepEqual(calls.tabs, []);
});

test("a terminal link already showing in a Browser window brings that window forward", () => {
  const showing = { kind: "browser", browser: {}, browserUrl: "http://localhost:5173/" };
  const { open, calls } = openTerminalLinkWith([{ kind: "terminal" }, showing]);
  open("http://localhost:5173/");
  assert.deepEqual(calls.raised, [showing]);
  assert.equal(calls.created.length, 0);
});

test("other terminal links open in a new tab", () => {
  const { open, calls } = openTerminalLinkWith([]);
  for (const url of ["https://example.com/", "http://192.168.1.5:3000/", "http://user:pw@localhost:5000/"]) open(url);
  assert.deepEqual(calls.tabs, ["https://example.com/", "http://192.168.1.5:3000/", "http://user:pw@localhost:5000/"]);
  assert.equal(calls.created.length, 0);
});
