import assert from "node:assert/strict";
import test from "node:test";

import { describeSignInMode, modeChoices, offersWorkspaceMove, renderSignInSettings } from "./sign-in-settings.mjs";

test("offers the modes this host supports, and always Off", () => {
  assert.deepEqual(modeChoices({ mode: "off", fileAvailable: true, systemAvailable: true }), ["off", "file", "system"]);
  assert.deepEqual(modeChoices({ mode: "off", fileAvailable: false, systemAvailable: false }), ["off"]);
  // The current mode stays listed even if it could no longer be chosen.
  assert.deepEqual(modeChoices({ mode: "file", fileAvailable: false, systemAvailable: true }), ["off", "file", "system"]);
});

test("offers to bring workspaces along only when whose they are changes", () => {
  const off = { mode: "off", canMoveWorkspaces: true };
  assert.equal(offersWorkspaceMove(off, "file"), true);
  assert.equal(offersWorkspaceMove(off, "system"), false);
  assert.equal(offersWorkspaceMove({ mode: "file", canMoveWorkspaces: true }, "off"), true);
  assert.equal(offersWorkspaceMove({ mode: "file", canMoveWorkspaces: true }, "system"), true);
  assert.equal(offersWorkspaceMove({ mode: "off", canMoveWorkspaces: false }, "file"), false);
});

test("describes each mode, warning when sign-in is off on a reachable server", () => {
  assert.match(describeSignInMode({ mode: "off", exposed: true }), /another device/);
  assert.match(describeSignInMode({ mode: "off", exposed: false }), /this computer/);
  assert.match(describeSignInMode({ mode: "system", systemAccount: "jax" }), /password of jax/);
  assert.match(describeSignInMode({ mode: "file" }), /Tessera account/);
});

test("CLI account settings explain the override without offering saved-account mutations", async () => {
  const nodes = [];
  const doc = { createElement(tag) {
    const node = { tag, children: [], textContent: "", append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); }, remove() {} };
    nodes.push(node);
    return node;
  } };
  const section = doc.createElement("section");
  const calls = [];
  await renderSignInSettings(section, { doc, target: { async fetch(path) {
    calls.push(path);
    return { ok: true, status: 200, async json() { return { mode: "file", locked: true, cliAccount: true, canManage: true, account: "cli-admin" }; } };
  } } });
  assert.deepEqual(calls, ["/api/auth/settings"]);
  assert.equal(nodes.some(node => node.tag === "button"), false);
  assert.ok(nodes.some(node => node.textContent === "cli-admin"));
  assert.ok(nodes.some(node => /Saved accounts are inactive and unchanged/.test(node.textContent)));
  assert.ok(nodes.some(node => /-username/.test(node.textContent)));
});
