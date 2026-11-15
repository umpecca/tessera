import assert from "node:assert/strict";
import test from "node:test";

import { browserWakeDetected, nextServerConnectionState } from "./server-connection.mjs";

test("detects system sleep without mistaking a throttled callback for wake", () => {
  assert.equal(browserWakeDetected(
    { wall: 1_000, monotonic: 500 },
    { wall: 61_000, monotonic: 700 },
  ), true);
  assert.equal(browserWakeDetected(
    { wall: 1_000, monotonic: 500 },
    { wall: 61_000, monotonic: 60_500 },
  ), false);
  assert.equal(browserWakeDetected(null, { wall: 61_000, monotonic: 700 }), false);
});

test("one failed health probe stays silent and the second shows recovery", () => {
  let state = nextServerConnectionState(null, { healthy: false });
  assert.deepEqual(state, { failures: 1, state: "" });
  state = nextServerConnectionState(state, { healthy: false });
  assert.deepEqual(state, { failures: 2, state: "unreachable" });
});

test("offline forces the modal immediately", () => {
  const state = nextServerConnectionState(null, { healthy: false, online: false, force: true });
  assert.deepEqual(state, { failures: 1, state: "offline" });
});

test("success always clears the state, so recovery needs no reload", () => {
  assert.deepEqual(nextServerConnectionState(null, { healthy: true }), { failures: 0, state: "" });
  assert.deepEqual(
    nextServerConnectionState({ failures: 2, state: "unreachable" }, { healthy: true }),
    { failures: 0, state: "" },
  );
});

test("a failure after recovery needs the threshold again", () => {
  let state = nextServerConnectionState({ failures: 2, state: "unreachable" }, { healthy: true });
  state = nextServerConnectionState(state, { healthy: false });
  assert.deepEqual(state, { failures: 1, state: "" });
  assert.deepEqual(nextServerConnectionState(state, { healthy: false }), { failures: 2, state: "unreachable" });
});
