export const serverHealthFailureThreshold = 2;

export const browserWakeClockGap = 10_000;

// Date.now() advances while macOS sleeps, while Firefox's monotonic clock does
// not. Comparing the two distinguishes a lid-close gap from an ordinary slow
// or backgrounded callback, where both clocks advance together.
export function browserWakeDetected(previous, current, threshold = browserWakeClockGap) {
  if (!previous || !current) return false;
  const wallElapsed = current.wall - previous.wall;
  const monotonicElapsed = current.monotonic - previous.monotonic;
  if (![wallElapsed, monotonicElapsed, threshold].every(Number.isFinite) || threshold <= 0) return false;
  return wallElapsed >= threshold && wallElapsed - Math.max(0, monotonicElapsed) >= threshold;
}

// Reduces health-probe results into the small set of states the recovery modal
// renders. Keeping this independent from the DOM makes transient-failure and
// recovery behavior deterministic and directly testable.
export function nextServerConnectionState(current, { healthy, online = true, force = false } = {}) {
  const previous = current || { failures: 0, state: "" };
  if (healthy) {
    return {
      failures: 0,
      state: previous.state ? "restored" : "",
    };
  }

  const failures = (previous.failures || 0) + 1;
  if (!force && failures < serverHealthFailureThreshold && !previous.state) {
    return { failures, state: "" };
  }
  return {
    failures,
    state: online ? "unreachable" : "offline",
  };
}
