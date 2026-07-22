import assert from "node:assert/strict";
import test from "node:test";

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
