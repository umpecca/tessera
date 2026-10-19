import assert from "node:assert/strict";
import test from "node:test";

import { terminalWorkingDirectory } from "./terminal-working-directory.mjs";

test("a report from the host gives its decoded path", () => {
  for (const host of ["", "localhost", "studio", "studio.local", "STUDIO.local.", "127.0.0.1"]) {
    assert.equal(terminalWorkingDirectory(`file://${host}/Users/me/My%20Project`, "studio.local"), "/Users/me/My Project", host);
  }
  assert.equal(terminalWorkingDirectory("file://studio/Users/me/caf%C3%A9", "studio"), "/Users/me/café");
  assert.equal(terminalWorkingDirectory("file://studio/Users/me/My Project", "studio"), "/Users/me/My Project", "unencoded spaces");
  assert.equal(terminalWorkingDirectory("file:///", "studio"), "/");
  assert.equal(terminalWorkingDirectory("file:///C:/Users/me", "pc"), "C:/Users/me");
});

test("a report from another machine, or not a file URL, gives nothing", () => {
  assert.equal(terminalWorkingDirectory("file://buildbox/home/me", "studio.local"), "");
  assert.equal(terminalWorkingDirectory("file://studio/home/me", ""), "", "the host name is not known yet");
  assert.equal(terminalWorkingDirectory("https://studio/home/me", "studio"), "");
  assert.equal(terminalWorkingDirectory("/home/me", "studio"), "");
  assert.equal(terminalWorkingDirectory("file:///tmp/100%", "studio"), "", "malformed escape");
  assert.equal(terminalWorkingDirectory("file:///tmp/a%0Ab", "studio"), "", "control characters");
  assert.equal(terminalWorkingDirectory(`file:///${"a".repeat(4096)}`, "studio"), "");
});
