export function terminalMouseMessage(data) {
  return JSON.stringify({ type: "mouse", data });
}
