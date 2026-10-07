export const defaultTerminalTERM = "xterm-256color";
export const defaultTerminalRowSpacing = "tight";
export const terminalRowSpacings = Object.freeze({
  tight: Object.freeze({ label: "Tight", padding: 0 }),
  comfortable: Object.freeze({ label: "Comfortable", padding: 2 }),
});

export function normalizeTerminalRowSpacing(value) {
  return value === "comfortable" ? value : defaultTerminalRowSpacing;
}

export function normalizeTerminalTERM(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(normalized)) {
    return defaultTerminalTERM;
  }
  return normalized;
}
