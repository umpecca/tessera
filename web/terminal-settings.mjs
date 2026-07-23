export const defaultTerminalTERM = "xterm-256color";

export function normalizeTerminalTERM(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(normalized)) {
    return defaultTerminalTERM;
  }
  return normalized;
}
