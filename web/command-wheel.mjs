const primaryKeys = ["N", "D", "M", "W", "O", "S", "H", "P"];
const groupLabels = {
  N: "New / next", D: "Dock / close", M: "Window size", W: "Window title",
  O: "Arrange", S: "Settings", H: "Help / UI", P: "Previous",
  R: "Repair", B: "Local ports", L: "Local HTTPS", U: "Update", T: "Tessera Sessions",
};
const shortLabels = {
  NN: "Terminal", NW: "Worksheet", NF: "Files", NE: "Editor", NB: "Browser",
  NA: "Audio", NX: "Next window", PW: "Previous", OO: "Cascade",
  DT: "Top", DL: "Left", DR: "Right", DB: "Bottom", DD: "Destroy",
  WT: "Set title", HP: "Help", HB: "Deskbar", LH: "HTTPS",
  UP: "Update server", RV: "Repair view", BL: "Port help", TS: "Tessera Sessions",
};
const compactLabels = {
  N: "New", D: "Dock", M: "Size", W: "Title", O: "Arrange", S: "Settings", H: "Help", P: "Prev",
  NN: "Term", NW: "Sheet", NF: "Files", NE: "Edit", NB: "Web", NA: "Audio", NX: "Next",
  PW: "Prev", OO: "Stack", DT: "Top", DL: "Left", DR: "Right", DB: "Bottom", DD: "Close",
  MM: "Max", MN: "Min", WT: "Title", HP: "Help", HB: "Bar", LH: "HTTPS", UP: "Update", RV: "Repair", BL: "Ports",
};

// Native buttons are clipped to annular slices, so the visible wedge is also
// its pointer target. The center and neighbouring slices stay independent.
export function commandWheelSector(angle, width, innerRadius, outerRadius) {
  const points = [];
  const start = angle - width / 2, end = angle + width / 2;
  const point = (degrees, radius) => {
    const radians = degrees * Math.PI / 180;
    return (50 + Math.cos(radians) * radius).toFixed(3) + "% " + (50 + Math.sin(radians) * radius).toFixed(3) + "%";
  };
  for (let degrees = start; degrees < end; degrees += 2) points.push(point(degrees, outerRadius));
  points.push(point(end, outerRadius));
  for (let degrees = end; degrees > start; degrees -= 2) points.push(point(degrees, innerRadius));
  points.push(point(start, innerRadius));
  return "polygon(" + points.join(",") + ")";
}

// Use the same available commands as the palette; dynamic entries without a
// fixed code remain discoverable through Search all commands.
export function commandWheelGroups(commands) {
  const groups = new Map();
  const codes = new Set();
  for (const command of commands) {
    if (!/^[A-Z]{1,2}$/.test(command.code || "") || codes.has(command.code)) continue;
    codes.add(command.code);
    const key = command.code[0];
    if (!groups.has(key)) groups.set(key, { key, label: groupLabels[key] || key, commands: [] });
    groups.get(key).commands.push(command);
  }
  const order = [...primaryKeys, "T", "R", "B", "L", "U"];
  return [...groups.values()].sort((a, b) => {
    const aIndex = order.includes(a.key) ? order.indexOf(a.key) : order.length;
    const bIndex = order.includes(b.key) ? order.indexOf(b.key) : order.length;
    return aIndex - bIndex || a.key.localeCompare(b.key);
  });
}

export class CommandWheel {
  constructor(element, { onCommand, onClose, onSearch }) {
    this.element = element;
    this.onCommand = onCommand;
    this.onClose = onClose;
    this.onSearch = onSearch;
    this.groups = [];
    this.prefix = "";
    this.panel = document.createElement("section");
    this.panel.className = "command-wheel-panel";
    this.panel.tabIndex = 0;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-labelledby", "command-wheel-title");
    this.panel.setAttribute("aria-describedby", "command-wheel-hint");
    element.appendChild(this.panel);
    element.addEventListener("pointerdown", event => {
      if (event.target === element) this.onClose();
    });
    this.panel.addEventListener("keydown", event => this.handleKeyboard(event));
    element.addEventListener("pointermove", event => {
      // Ignore the stationary pointer when keyboard opening creates the menu
      // underneath it. Only deliberate mouse movement changes the first key.
      if (this.groupPinned || event.pointerType !== "mouse" || (!event.movementX && !event.movementY)) return;
      const group = event.target.closest(".command-wheel-parent");
      if (group && !group.disabled) this.chooseGroup(group.dataset.group, false);
    });
  }

  open(commands) {
    this.groups = commandWheelGroups(commands);
    this.prefix = "";
    this.groupPinned = false;
    this.element.hidden = false;
    this.render();
  }

  chooseGroup(key, pinned = true) {
    if (this.element.hidden) return;
    const group = this.groups.find(group => group.key === key);
    if (!group) return;
    const directCommand = group.commands.find(command => command.code === key);
    if (pinned && directCommand) {
      this.onCommand(directCommand);
      return;
    }
    this.groupPinned = pinned;
    if (this.prefix === key) return;
    this.prefix = key;
    this.render();
  }

  chooseKey(key) {
    if (this.element.hidden) return;
    if (!this.prefix) {
      if (this.groups.some(group => group.key === key)) this.chooseGroup(key);
      else this.status.textContent = key + " is not an available first key.";
      return;
    }
    const group = this.groups.find(group => group.key === this.prefix);
    const command = group?.commands.find(command => command.code === this.prefix + key
      || (key === this.prefix && command.code === key));
    if (command) this.onCommand(command);
    else this.status.textContent = key + " is not a next key for " + this.prefix + ".";
  }

  handleKeyboard(event) {
    if (event.isComposing || this.element.hidden) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); this.onClose();
    } else if (event.key === "Backspace") {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return;
      if (this.prefix) { this.prefix = ""; this.groupPinned = false; this.render(); }
      else this.onClose();
    } else if (/^[a-z]$/i.test(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) this.chooseKey(event.key.toUpperCase());
    } else if (event.key === "Tab") {
      const buttons = [...this.panel.querySelectorAll("button")].filter(button => !button.disabled && button.getClientRects().length);
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || (!event.shiftKey && index === buttons.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault();
        buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
      }
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const buttons = [...this.panel.querySelectorAll(this.prefix ? ".command-wheel-command" : ".command-wheel-parent")].filter(button => !button.disabled);
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const index = buttons.indexOf(document.activeElement);
      const next = index < 0 ? (direction > 0 ? 0 : buttons.length - 1) : (index + direction + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }

  button(className, label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  position(button, angle, radius) {
    const radians = angle * Math.PI / 180;
    button.style.left = (50 + Math.cos(radians) * radius) + "%";
    button.style.top = (50 + Math.sin(radians) * radius) + "%";
  }

  wedge(className, key, label, compact, angle, width, innerRadius, outerRadius, action) {
    const button = this.button(className + " command-wheel-wedge", "", action);
    button.style.clipPath = commandWheelSector(angle, width, innerRadius, outerRadius);
    const content = document.createElement("span");
    content.className = "command-wheel-wedge-content";
    this.position(content, angle, (innerRadius + outerRadius) / 2);
    const keyLabel = document.createElement("span");
    keyLabel.className = "command-wheel-key";
    keyLabel.textContent = key;
    const text = document.createElement("span");
    text.className = "command-wheel-label";
    const full = document.createElement("span");
    full.className = "command-wheel-label-full";
    full.textContent = label;
    const short = document.createElement("span");
    short.className = "command-wheel-label-compact";
    short.textContent = compact || label;
    text.append(full, short);
    content.append(keyLabel, text);
    button.appendChild(content);
    return button;
  }

  preview(label, code) {
    this.centerLabel.textContent = label;
    this.centerCode.textContent = code || this.prefix || "Ctrl/Cmd+;";
  }

  render() {
    this.panel.replaceChildren();
    const selected = this.groups.find(group => group.key === this.prefix);
    const ring = document.createElement("div");
    ring.className = "command-wheel-ring";
    ring.setAttribute("aria-label", this.prefix ? "Available next keys" : "Available first keys");
    for (const key of primaryKeys) {
      const group = this.groups.find(group => group.key === key);
      const label = groupLabels[key];
      const button = this.wedge("command-wheel-parent", key, label, compactLabels[key],
        -90 + primaryKeys.indexOf(key) * 45, 43.5, 15, 33.5, () => this.chooseGroup(key));
      button.dataset.group = key;
      button.disabled = !group;
      button.setAttribute("aria-label", key + ": " + label + (group ? "" : " (unavailable)"));
      if (!group?.commands.some(command => command.code === key)) {
        button.setAttribute("aria-pressed", String(key === this.prefix));
      }
      button.title = label;
      ring.appendChild(button);
    }
    const choices = selected?.commands.filter(command => command.code.length === 2) || [];
    const groupAngle = primaryKeys.includes(this.prefix) ? -90 + primaryKeys.indexOf(this.prefix) * 45 : 90;
    const step = Math.min(32, 196 / Math.max(1, choices.length));
    choices.forEach((choice, index) => {
      const key = choice.code[1];
      const label = choice.code === "MM" || choice.code === "MN" ? choice.label.replace(/ Window$/, "")
        : shortLabels[choice.code] || choice.label.replace(/ Window$/, "");
      const angle = groupAngle + (index - (choices.length - 1) / 2) * step;
      const compact = /^Restore/.test(label) ? "Back" : compactLabels[choice.code];
      const button = this.wedge("command-wheel-choice command-wheel-command", key, label, compact,
        angle, step - 1, 34, 49, () => {
          if (!this.element.hidden) this.onCommand(choice);
        });
      if (choice.code === "DD") button.classList.add("is-danger");
      button.dataset.key = key;
      button.dataset.code = choice.code;
      button.setAttribute("aria-label", choice.code + ": " + choice.label);
      button.title = choice.label;
      button.addEventListener("pointerenter", () => this.preview(choice.label, this.prefix + " › " + key));
      button.addEventListener("pointerleave", () => this.preview(selected.label, this.prefix));
      button.addEventListener("focus", () => this.preview(choice.label, this.prefix + " › " + key));
      ring.appendChild(button);
    });
    const back = this.button("command-wheel-hub", "", () => {
      if (this.prefix) { this.prefix = ""; this.groupPinned = false; this.render(); }
      else this.onClose();
    });
    back.setAttribute("aria-label", this.prefix ? "Back to first key" : "Close command wheel");
    const title = document.createElement("span");
    title.className = "command-wheel-title";
    title.id = "command-wheel-title";
    title.textContent = "Command Wheel";
    this.centerLabel = document.createElement("span");
    this.centerLabel.className = "command-wheel-center-label";
    this.centerLabel.textContent = selected?.label || "Choose a command or group";
    this.centerCode = document.createElement("span");
    this.centerCode.className = "command-wheel-center-code";
    this.centerCode.textContent = this.prefix || "Ctrl/Cmd+;";
    const backGlyph = document.createElement("span");
    backGlyph.className = "command-wheel-back";
    backGlyph.textContent = this.prefix ? "←" : "×";
    backGlyph.setAttribute("aria-hidden", "true");
    back.append(title, this.centerLabel, this.centerCode, backGlyph);
    ring.appendChild(back);
    const more = document.createElement("div");
    more.className = "command-wheel-more";
    for (const group of this.groups.filter(group => !primaryKeys.includes(group.key))) {
      const button = this.button("command-wheel-secondary", "", () => this.chooseGroup(group.key));
      const key = document.createElement("kbd");
      key.textContent = group.key;
      button.append(key, " " + group.label);
      button.setAttribute("aria-pressed", String(group.key === this.prefix));
      more.appendChild(button);
    }
    this.status = document.createElement("div");
    this.status.className = "command-wheel-status";
    this.status.setAttribute("aria-live", "polite");
    this.status.textContent = selected?.commands.some(command => command.code === this.prefix)
      ? "Press " + this.prefix + " or click " + selected.label + "."
      : this.prefix ? "Choose the next key · " + this.prefix : "Move to a group or type a key.";
    const footer = document.createElement("footer");
    footer.className = "command-wheel-footer";
    const hint = document.createElement("span");
    hint.id = "command-wheel-hint";
    hint.textContent = "Backspace: back · Esc: close";
    footer.append(this.button("command-wheel-search", "Search all commands", this.onSearch), hint,
      this.button("command-wheel-close", "Esc", this.onClose));
    this.panel.append(ring, more, this.status, footer);
    this.panel.focus({ preventScroll: true });
  }
}
