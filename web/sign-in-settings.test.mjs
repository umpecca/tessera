import assert from "node:assert/strict";
import test from "node:test";

import { describeSignInMode, modeChoices, offersWorkspaceMove } from "./sign-in-settings.mjs";

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
