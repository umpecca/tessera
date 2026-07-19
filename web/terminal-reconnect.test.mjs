import assert from "node:assert/strict";
import test from "node:test";

import { terminalReconnectDelay } from "./terminal-reconnect.mjs";

test("terminal reconnect delay grows conservatively and is capped", () => {
  assert.equal(terminalReconnectDelay(0), 500);
  assert.equal(terminalReconnectDelay(1), 1000);
  assert.equal(terminalReconnectDelay(5), 10000);
  assert.equal(terminalReconnectDelay(20), 10000);
});
