// Key readout for Settings → Diagnostics: lists what the browser reports for
// each keystroke typed into a test field, so keys a hardware keyboard lacks
// (the iPad Magic Keyboard has no Home, End or forward Delete) can be mapped
// from combinations that actually reach the page. A combination iPadOS or the
// browser keeps for itself produces no line at all.

const keyReadoutLimit = 12;

// keyModifierNames names held modifiers as an Apple keyboard labels them.
export function keyModifierNames(event) {
  const names = [];
  if (event.ctrlKey) names.push("Ctrl");
  if (event.altKey) names.push("Option");
  if (event.shiftKey) names.push("Shift");
  if (event.metaKey) names.push("Cmd");
  if (event.getModifierState?.("Fn")) names.push("Fn");
  return names;
}

// describeKeyEvent is one readout line. keydown gives the logical key, the
// physical code and the legacy keyCode; beforeinput gives the edit the text
// field would have made, which is how some keyboards report a delete whose
// keydown is ambiguous.
export function describeKeyEvent(event) {
  if (event.type === "beforeinput") {
    const data = event.data ? ` data ${JSON.stringify(event.data)}` : "";
    return `beforeinput ${event.inputType || "(no inputType)"}${data}`;
  }
  const modifiers = keyModifierNames(event);
  const flags = [event.repeat && "repeat", event.isComposing && "composing"].filter(Boolean);
  return [
    `${event.type} ${modifiers.length ? `${modifiers.join("+")} ` : ""}key ${JSON.stringify(event.key)}`,
    `code ${event.code || "(none)"}`,
    `keyCode ${event.keyCode ?? "?"}`,
    ...flags,
  ].join(" · ");
}

// KeyReadout keeps the most recent lines, newest first. It outlives the
// Settings markup, which is rebuilt whenever Settings re-renders.
export class KeyReadout {
  constructor(limit = keyReadoutLimit) {
    this.limit = limit;
    this.entries = [];
  }

  record(event) {
    this.entries.unshift(describeKeyEvent(event));
    this.entries.length = Math.min(this.entries.length, this.limit);
  }

  clear() {
    this.entries = [];
  }

  text(header) {
    return [header, ...this.entries.slice().reverse()].join("\n");
  }
}

// keyReadoutShouldPreventKeydown keeps a test keystroke from acting on the
// page. Command and Control with a character are browser shortcuts (Cmd+R,
// Cmd+W); the browser ignores the cancel for some, but it stops the rest.
// Other keys go through so the field's beforeinput still shows their edit,
// and Tab and Escape keep moving focus and closing Settings.
export function keyReadoutShouldPreventKeydown(event) {
  return Boolean((event.metaKey || event.ctrlKey) && event.key?.length === 1);
}
