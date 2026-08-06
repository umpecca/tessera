export const terminalReconnectInitialDelay = 500;
export const terminalReconnectMaximumDelay = 10000;

// Application close codes the server uses to say why a terminal socket
// ended. The reason rides along in the close frame, which keeps it out of
// the terminal buffer where it would outlive the event it describes.
export const terminalFailureCloseCode = 4500;
export const terminalExitedCloseCode = 4501;
export const terminalExitFailedCloseCode = 4502;

// Returns the pause before a retry. A capped delay lets a restored server
// recover quickly without keeping a disconnected browser in a tight loop.
export function terminalReconnectDelay(attempt) {
  const normalizedAttempt = Math.max(0, Number.isFinite(attempt) ? Math.floor(attempt) : 0);
  return Math.min(terminalReconnectInitialDelay * (2 ** normalizedAttempt), terminalReconnectMaximumDelay);
}

// Everything a pane decides when its socket closes: what the badge says,
// whether to retry, and when the attempt lands. The caller supplies the
// inputs it owns — how many attempts have gone by, and whether the
// workspace is already reporting the server down — and applies the result.
export function terminalCloseOutcome(closeEvent, options = {}) {
  const { attempt = 0, now = Date.now(), serverReported = false } = options;
  const status = terminalCloseStatus(closeEvent);
  if (!status.reconnect) {
    // Nothing is coming: no countdown to run, and a settled badge to show
    // unless the pane is on its way out anyway.
    return { ...status, delay: 0, retryAt: 0, settled: true, showBadge: !status.closesPane };
  }
  const delay = terminalReconnectDelay(attempt);
  return {
    ...status,
    delay,
    retryAt: now + delay,
    // Past the backoff cap the pane has settled into waiting, and a badge
    // that pulses forever asks for attention nothing will reward.
    settled: delay >= terminalReconnectMaximumDelay,
    // A workspace-wide outage is already on screen as its own dialog. One
    // badge per pane saying the same thing is the same news N more times.
    showBadge: !serverReported,
  };
}

// How long an attempt may be in flight before something outside the pane is
// allowed to abandon it. A socket opened before a laptop slept can stay in
// CONNECTING long after the connection behind it is gone, and nothing will
// say so until TCP gives up.
export const terminalStaleConnectDelay = 3000;

// Moves a status to the state a pane is in while an attempt is in flight.
export function terminalConnectingStatus(status, now = Date.now()) {
  if (!status) {
    return null;
  }
  return { ...status, state: "connecting", retryAt: 0, settled: false, connectingSince: now };
}

// Whether a pane should start a fresh socket now. Callers use this when
// something the pane cannot see — a health probe that answered, the browser
// coming back online, a tab returning to the foreground — says the server is
// reachable again. A pane that is not waiting has nothing to bring forward,
// and one that only just started an attempt is already doing the fastest
// thing available.
export function terminalShouldRetry(status, options = {}) {
  const { now = Date.now(), staleAfter = terminalStaleConnectDelay } = options;
  if (!status?.reconnect) {
    return false;
  }
  if (status.state !== "connecting") {
    return true;
  }
  return now - (status.connectingSince || 0) >= staleAfter;
}

// Describes a closed terminal socket, and says what the pane should do
// about it. A shell that exited cleanly takes its pane with it, the way a
// terminal emulator closes a tab. One that died of an error leaves the pane
// standing, since a pane vanishing is no way to report a crash. Everything
// else is a connection problem worth retrying.
function terminalCloseStatus(closeEvent) {
  const code = closeEvent?.code;
  const reason = String(closeEvent?.reason || "").trim();
  if (code === terminalExitedCloseCode) {
    return { state: "exited", summary: capitalize(reason || "terminal exited"), reconnect: false, closesPane: true };
  }
  if (code === terminalExitFailedCloseCode) {
    return { state: "exited", summary: capitalize(reason || "terminal exited"), reconnect: false, closesPane: false };
  }
  if (code === terminalFailureCloseCode) {
    return { state: "failed", summary: capitalize(reason || "terminal failed"), reconnect: true, closesPane: false };
  }
  return { state: "disconnected", summary: "Terminal disconnected", reconnect: true, closesPane: false };
}

// The badge's tooltip. A pane that is going to retry says when, and that a
// click brings the attempt forward; anything settled just states itself.
export function terminalStatusLabel(status, remainingMs) {
  if (status?.state === "connecting") {
    return `${status.summary}; reconnecting now`;
  }
  if (!status?.reconnect) {
    return status?.summary || "";
  }
  const seconds = Math.max(0, Math.ceil((Number.isFinite(remainingMs) ? remainingMs : 0) / 1000));
  const when = seconds > 0 ? `reconnecting in ${seconds}s` : "reconnecting now";
  return `${status.summary}; ${when} — click to retry now`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
