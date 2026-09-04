import assert from "node:assert/strict";
import test from "node:test";

import {
  terminalCloseOutcome,
  terminalConnectingStatus,
  terminalExitFailedCloseCode,
  terminalExitedCloseCode,
  terminalFailureCloseCode,
  terminalReconnectDelay,
  terminalShouldRetry,
  terminalStatusLabel,
} from "./terminal-reconnect.mjs";

const dropped = { code: 1006, reason: "" };

test("incompatible terminal core requires reload instead of retrying", () => {
  const outcome = terminalCloseOutcome({ code: 4503, reason: "terminal core changed; reload Tessera" });
  assert.equal(outcome.reconnect, false);
  assert.equal(outcome.closesPane, false);
  assert.match(outcome.summary, /reload Tessera/);
});

test("terminal reconnect delay grows conservatively and is capped", () => {
  assert.equal(terminalReconnectDelay(0), 500);
  assert.equal(terminalReconnectDelay(1), 1000);
  assert.equal(terminalReconnectDelay(5), 10000);
  assert.equal(terminalReconnectDelay(20), 10000);
});

test("an unexplained close reads as an ordinary disconnect", () => {
  const outcome = terminalCloseOutcome(dropped, { attempt: 0, now: 1000 });
  assert.equal(outcome.state, "disconnected");
  assert.equal(outcome.summary, "Terminal disconnected");
  assert.equal(outcome.reconnect, true);
  assert.equal(outcome.closesPane, false);
  assert.equal(outcome.delay, 500);
  assert.equal(outcome.retryAt, 1500);
  assert.equal(outcome.settled, false);
  assert.equal(outcome.showBadge, true);
});

test("a close is only a disconnect when the socket never opened", () => {
  const outcome = terminalCloseOutcome(undefined, { attempt: 0 });
  assert.equal(outcome.state, "disconnected");
  assert.equal(outcome.reconnect, true);
});

test("the backoff settles once the wait reaches its cap", () => {
  assert.equal(terminalCloseOutcome(dropped, { attempt: 3 }).settled, false);
  assert.equal(terminalCloseOutcome(dropped, { attempt: 5 }).settled, true);
  assert.equal(terminalCloseOutcome(dropped, { attempt: 40 }).settled, true);
});

// The workspace-level outage dialog is already saying this. One badge per
// pane repeating it is the same news N more times.
test("a workspace already reporting the server down suppresses pane badges", () => {
  const outcome = terminalCloseOutcome(dropped, { attempt: 0, serverReported: true });
  assert.equal(outcome.showBadge, false);
  assert.equal(outcome.reconnect, true, "a suppressed badge must not suppress the retry");
});

test("the server's failure reason survives into the outcome", () => {
  const outcome = terminalCloseOutcome({
    code: terminalFailureCloseCode,
    reason: "terminal failed: fork/exec /bin/zsh: no such file",
  }, { attempt: 1, now: 0 });
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.reconnect, true);
  assert.equal(outcome.closesPane, false);
  assert.equal(outcome.summary, "Terminal failed: fork/exec /bin/zsh: no such file");
  assert.equal(outcome.retryAt, 1000);
});

test("a shell that exited cleanly retires its pane and shows nothing", () => {
  const outcome = terminalCloseOutcome({ code: terminalExitedCloseCode, reason: "terminal exited" });
  assert.equal(outcome.state, "exited");
  assert.equal(outcome.reconnect, false);
  assert.equal(outcome.closesPane, true);
  assert.equal(outcome.showBadge, false);
  assert.equal(outcome.retryAt, 0);
});

// A pane that vanished would take the only account of the crash with it.
test("a shell that died of an error keeps its pane and its reason", () => {
  const outcome = terminalCloseOutcome({
    code: terminalExitFailedCloseCode,
    reason: "terminal exited: read /dev/ptmx: input/output error",
  });
  assert.equal(outcome.state, "exited");
  assert.equal(outcome.reconnect, false);
  assert.equal(outcome.closesPane, false);
  assert.equal(outcome.showBadge, true);
  assert.equal(outcome.settled, true);
  assert.equal(outcome.summary, "Terminal exited: read /dev/ptmx: input/output error");
});

test("an attempt in flight drops the countdown but keeps the reason", () => {
  const waiting = terminalCloseOutcome({
    code: terminalFailureCloseCode,
    reason: "terminal failed: no shell",
  }, { attempt: 5, now: 0 });
  assert.equal(waiting.settled, true);
  const connecting = terminalConnectingStatus(waiting);
  assert.equal(connecting.state, "connecting");
  assert.equal(connecting.retryAt, 0);
  assert.equal(connecting.settled, false);
  assert.equal(connecting.summary, "Terminal failed: no shell");
  assert.equal(terminalConnectingStatus(null), null);
});

// The pane cannot see the server come back; whoever can brings it forward.
test("a waiting pane is retried the moment anything says the server is back", () => {
  assert.equal(terminalShouldRetry(terminalCloseOutcome(dropped, { attempt: 5 })), true);
  assert.equal(terminalShouldRetry(terminalCloseOutcome({
    code: terminalFailureCloseCode,
    reason: "terminal failed: no shell",
  })), true);
});

test("a pane with nothing to wait for is left alone", () => {
  assert.equal(terminalShouldRetry(null), false);
  assert.equal(terminalShouldRetry(undefined), false);
  assert.equal(
    terminalShouldRetry(terminalCloseOutcome({ code: terminalExitedCloseCode, reason: "terminal exited" })),
    false,
  );
  assert.equal(
    terminalShouldRetry(terminalCloseOutcome({ code: terminalExitFailedCloseCode, reason: "terminal exited: io" })),
    false,
  );
});

test("an attempt that just started is not raced by a second one", () => {
  const connecting = terminalConnectingStatus(terminalCloseOutcome(dropped, { attempt: 2 }), 10_000);
  assert.equal(terminalShouldRetry(connecting, { now: 10_500 }), false);
  assert.equal(terminalShouldRetry(connecting, { now: 12_999 }), false);
});

// After a machine suspends, a socket can sit in CONNECTING against a
// connection that no longer exists, and nothing says so until TCP gives up.
test("an attempt that has hung long enough is abandoned for a fresh one", () => {
  const connecting = terminalConnectingStatus(terminalCloseOutcome(dropped, { attempt: 2 }), 10_000);
  assert.equal(terminalShouldRetry(connecting, { now: 13_000 }), true);
  assert.equal(terminalShouldRetry(connecting, { now: 600_000 }), true);
});

test("a connecting status with no start time is treated as stale", () => {
  const connecting = { ...terminalCloseOutcome(dropped, { attempt: 0 }), state: "connecting" };
  assert.equal(terminalShouldRetry(connecting, { now: 5000 }), true);
});

test("a waiting pane counts down and offers the retry", () => {
  const outcome = terminalCloseOutcome(dropped, { attempt: 0 });
  assert.equal(
    terminalStatusLabel(outcome, 2400),
    "Terminal disconnected; reconnecting in 3s — click to retry now",
  );
  assert.equal(
    terminalStatusLabel(outcome, 0),
    "Terminal disconnected; reconnecting now — click to retry now",
  );
});

test("a countdown that ran past its deadline never reads as negative", () => {
  const outcome = terminalCloseOutcome(dropped, { attempt: 0 });
  assert.equal(
    terminalStatusLabel(outcome, -5000),
    "Terminal disconnected; reconnecting now — click to retry now",
  );
});

test("an attempt under way says so instead of counting", () => {
  const connecting = terminalConnectingStatus(terminalCloseOutcome(dropped, { attempt: 0 }));
  assert.equal(terminalStatusLabel(connecting, 0), "Terminal disconnected; reconnecting now");
});

test("a settled state states itself and stops there", () => {
  const outcome = terminalCloseOutcome({
    code: terminalExitFailedCloseCode,
    reason: "terminal exited: input/output error",
  });
  assert.equal(terminalStatusLabel(outcome, 0), "Terminal exited: input/output error");
});
