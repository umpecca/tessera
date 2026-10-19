// Progress reports (OSC 9;4) from the programs in terminal panes, shown as a
// bar along the window's title bar. The host sends each change as a
// "terminal-progress" message to every browser showing the pane, and the
// current one when a browser connects.

const states = new Set(["remove", "set", "error", "indeterminate", "pause"]);

// A program that stops reporting without removing its progress leaves it
// for this long, as in Ghostty.
export const terminalProgressLifetimeMs = 15000;

// The progress in a host message: null to remove it, undefined if the
// message is not one.
export function terminalProgressFromMessage(message) {
  if (message?.type !== "terminal-progress" || !states.has(message.state)) return undefined;
  if (message.state === "remove") return null;
  const percent = Number.isInteger(message.percent) && message.percent >= 0 && message.percent <= 100 ? message.percent : null;
  return { state: message.state, percent };
}

// How full the bar is, as a percentage, or null when it moves without one.
// An error or pause without a percentage fills it.
export function terminalProgressWidth(progress) {
  if (progress.state === "indeterminate") return null;
  if (progress.percent === null) return progress.state === "set" ? null : 100;
  return progress.percent;
}

export function terminalProgressDescription(progress) {
  const amount = progress.percent === null ? "" : ` ${progress.percent}%`;
  if (progress.state === "error") return `Error${amount}`;
  if (progress.state === "pause") return `Paused${amount}`;
  if (progress.state === "indeterminate" || progress.percent === null) return "In progress";
  return `${progress.percent}% done`;
}
