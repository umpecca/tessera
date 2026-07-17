export const serverHealthFailureThreshold = 2;

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
