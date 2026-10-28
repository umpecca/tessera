import assert from "node:assert/strict";
import test from "node:test";

import { offerLoginToBrowser } from "./password-manager.mjs";

class PasswordCredential {
  constructor(data) { Object.assign(this, data); }
}

test("offers a login that worked to the browser's password manager where it can", async () => {
  const stored = [];
  const env = { PasswordCredential, navigator: { credentials: { store: async (credential) => { stored.push(credential); } } } };
  assert.equal(await offerLoginToBrowser({ username: "jaxdad", password: "secret", name: "jaxdad — localhost:3389" }, env), true);
  assert.deepEqual({ ...stored[0] }, { id: "jaxdad", password: "secret", name: "jaxdad — localhost:3389" });
  assert.equal(await offerLoginToBrowser({ username: "alice", password: "pw" }, env), true);
  assert.equal(stored[1].name, "alice", "named by the user name when nothing else is given");
});

test("offers nothing without a login, without the API, or when the browser refuses", async () => {
  const env = { PasswordCredential, navigator: { credentials: { store: async () => {} } } };
  assert.equal(await offerLoginToBrowser({ username: "", password: "secret" }, env), false);
  assert.equal(await offerLoginToBrowser({ username: "jaxdad", password: "" }, env), false);
  assert.equal(await offerLoginToBrowser({ username: "jaxdad", password: "secret" }, { navigator: {} }), false);
  const refusing = { PasswordCredential, navigator: { credentials: { store: async () => { throw new Error("denied"); } } } };
  assert.equal(await offerLoginToBrowser({ username: "jaxdad", password: "secret" }, refusing), false);
});
