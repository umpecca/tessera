export const terminalReconnectInitialDelay = 500;
export const terminalReconnectMaximumDelay = 10000;

// Returns the pause before a retry. A capped delay lets a restored server
// recover quickly without keeping a disconnected browser in a tight loop.
export function terminalReconnectDelay(attempt) {
  const normalizedAttempt = Math.max(0, Number.isFinite(attempt) ? Math.floor(attempt) : 0);
  return Math.min(terminalReconnectInitialDelay * (2 ** normalizedAttempt), terminalReconnectMaximumDelay);
}
