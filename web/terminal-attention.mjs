// Bells, desktop notifications (OSC 9 and OSC 777) and long commands
// finishing (from the shell's prompt marks, OSC 133) in terminal panes. The host sends each as a "terminal-alert" message to every
// browser showing the pane, paused or not, and repeats the latest one nobody
// has seen to each browser that connects.

const maximumTitleLength = 200;
const maximumBodyLength = 1000;

// Programs write these, so control characters and runs of space become one
// space, and long text is cut short.
export function cleanTerminalAlertText(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, " ").trim();
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
}

// The alert in a host message if it is new to this pane, or null. `seen`
// holds the newest alert the pane has had, and is updated.
export function acceptTerminalAlert(seen, message) {
  if (message?.type !== "terminal-alert" || typeof message.epoch !== "string" || !Number.isSafeInteger(message.id) || message.id < 1) return null;
  if (message.kind !== "bell" && message.kind !== "notification" && message.kind !== "command") return null;
  if (seen.epoch === message.epoch && message.id <= seen.id) return null;
  seen.epoch = message.epoch;
  seen.id = message.id;
  if (message.kind === "bell") return { epoch: message.epoch, id: message.id, kind: "bell" };
  if (message.kind === "command") {
    return {
      epoch: message.epoch, id: message.id, kind: "command",
      title: cleanTerminalAlertText(message.title, maximumTitleLength),
      status: Number.isSafeInteger(message.status) && message.status >= 0 && message.status <= 255 ? message.status : null,
      seconds: Number.isSafeInteger(message.seconds) && message.seconds > 0 ? message.seconds : 0,
    };
  }
  const title = cleanTerminalAlertText(message.title, maximumTitleLength);
  const body = cleanTerminalAlertText(message.body, maximumBodyLength);
  return title || body ? { epoch: message.epoch, id: message.id, kind: "notification", title, body } : null;
}

// What a pane waiting to be looked at holds: the newest alert, except that a
// bell does not replace anything else. The id is always the newest, which
// is what showing the pane marks as seen.
export function mergeTerminalAttention(current, alert) {
  if (current && current.kind !== "bell" && alert.kind === "bell") return { ...current, epoch: alert.epoch, id: alert.id };
  return alert;
}

// Whether a finished command failed: a status other than 0.
export function terminalCommandFailed(alert) {
  return alert?.kind === "command" && alert.status !== null && alert.status !== 0;
}

// "12 s", "4 min 12 s", "2 h 5 min".
export function terminalDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, rest = total % 60;
  if (hours) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}

// The suffix on a pane's name in window lists.
export function terminalAttentionLabel(attention) {
  if (attention?.kind === "command") return terminalCommandFailed(attention) ? " [failed]" : " [finished]";
  if (attention?.kind === "notification") return " [notification]";
  if (attention?.kind === "bell") return " [bell]";
  return "";
}

// A notice's heading, text and source line. OSC 9 carries no title, so the
// window's name heads it instead.
export function terminalNoticeText(alert, windowTitle) {
  const name = (typeof windowTitle === "string" && windowTitle.trim()) || "Terminal";
  if (alert.kind === "bell") return { title: name, body: "Bell", source: "" };
  if (alert.kind === "command") {
    const after = alert.seconds ? ` after ${terminalDuration(alert.seconds)}` : "";
    const body = terminalCommandFailed(alert) ? `Failed with exit status ${alert.status}${after}`
      : `Finished${after}`;
    return alert.title ? { title: alert.title, body, source: name } : { title: name, body: `Command ${body.toLowerCase()}`, source: "" };
  }
  if (alert.title) return { title: alert.title, body: alert.body, source: name };
  return { title: name, body: alert.body, source: "" };
}

// Shows the operating system's notification when the browser allows it, or
// returns null. Some browsers throw without a service worker.
export function showSystemNotification(NotificationClass, { title, body, tag }, onClick) {
  if (typeof NotificationClass !== "function" || NotificationClass.permission !== "granted") return null;
  try {
    const notification = new NotificationClass(title, { body, tag });
    notification.onclick = () => {
      notification.close();
      onClick();
    };
    return notification;
  } catch {
    return null;
  }
}

// Notices in the page's corner, one per pane: a newer one from the same pane
// replaces it. Clicking one opens the pane.
export class TerminalNotices {
  constructor(container, { onOpen, timeoutMs = 8000, limit = 3, setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis) } = {}) {
    this.container = container;
    this.onOpen = onOpen;
    this.timeoutMs = timeoutMs;
    this.limit = limit;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.notices = new Map();
  }

  show(key, { title, body, source }) {
    this.dismiss(key);
    const document = this.container.ownerDocument;
    const notice = document.createElement("div");
    notice.className = "terminal-notice";
    notice.setAttribute("role", "status");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "terminal-notice-open";
    const heading = document.createElement("strong");
    heading.textContent = title;
    open.appendChild(heading);
    for (const [text, className] of [[body, "terminal-notice-body"], [source, "terminal-notice-source"]]) {
      if (!text) continue;
      const line = document.createElement("span");
      line.className = className;
      line.textContent = text;
      open.appendChild(line);
    }
    open.addEventListener("click", () => {
      this.dismiss(key);
      this.onOpen?.(key);
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-notice-close";
    close.textContent = "×";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss notification");
    close.addEventListener("click", () => this.dismiss(key));
    notice.append(open, close);
    this.container.appendChild(notice);
    const timer = this.setTimer(() => this.dismiss(key), this.timeoutMs);
    this.notices.set(key, { notice, timer });
    while (this.notices.size > this.limit) this.dismiss(this.notices.keys().next().value);
    this.container.hidden = false;
  }

  dismiss(key) {
    const entry = this.notices.get(key);
    if (!entry) return;
    this.clearTimer(entry.timer);
    entry.notice.remove();
    this.notices.delete(key);
    if (this.notices.size === 0) this.container.hidden = true;
  }
}
