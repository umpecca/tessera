// The phone view: a list of the session's terminals, and one terminal at a
// time full screen, for a screen too small for windows. The host's
// /api/workspace/{id}/terminals says what each shell is doing without the
// phone attaching to it; the terminal it opens is the workspace's own pane,
// shown without its window and with its saved geometry untouched.

import { terminalCommandFailed, terminalDuration } from "./terminal-attention.mjs";
import { terminalProgressDescription, terminalProgressWidth } from "./terminal-progress.mjs";
import { PhoneInput } from "./phone-input.mjs";

export const phoneViewMaxWidth = 600;
export const phoneViewStorageKey = "tessera.phone-view.v1";
const retryDelaysMs = [1000, 2000, 5000, 10000, 30000];
const clockTickMs = 10000;
// An open terminal's quick replies follow its quiet seconds more closely.
const openClockTickMs = 2000;
const readingRefreshMs = 1000;
export const phoneReadingStorageKey = "tessera.phone-reading.v1";

// The font size at which the shell's columns fill width, given the cell
// width at fontSize, then times zoom: in quarter points, from 4 to largest.
export function phoneFontSize({ columns, width, fontSize, cellWidth, zoom = 1, largest = 40 }) {
  if (!(columns > 0 && width > 0 && fontSize > 0 && cellWidth > 0)) return fontSize;
  const size = Math.floor(((fontSize * width) / (columns * cellWidth)) * zoom * 4) / 4;
  return Math.max(4, Math.min(largest, size));
}

// After a font change, the size to try next if the columns, measured at
// fontSize, still don't fit the width; null once they fit or the font is
// as small as it goes. Cells round to whole pixels, so a size computed
// from one measurement can come out wider than planned, and computing again
// from the next can swing back the other way: only ever stepping down
// settles.
export function phoneFontShrink({ columns, width, fontSize, cellWidth }) {
  if (!(columns > 0 && width > 0 && fontSize > 4 && cellWidth > 0)) return null;
  if (columns * cellWidth <= width) return null;
  const proportional = Math.floor(((fontSize * width) / (columns * cellWidth)) * 4) / 4;
  return Math.max(4, Math.min(fontSize - 0.25, proportional));
}

// The terminal's rows as lines of text: a row the terminal wrapped onto the
// next joins it, keeping the spaces at the wrap, and other rows lose their
// trailing blanks. Blank rows after the last text go.
export function readingLines(rows) {
  const lines = [];
  let current = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const wrapsOn = Boolean(rows[i + 1]?.continues);
    const text = wrapsOn ? row.text : row.text.replace(/\s+$/u, "");
    if (current !== null && row.continues) current += text;
    else {
      if (current !== null) lines.push(current);
      current = text;
    }
  }
  if (current !== null) lines.push(current);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines;
}

// "phone" or "desktop" when this browser chose one, otherwise "".
export function normalizePhoneViewOverride(value) {
  return value === "phone" || value === "desktop" ? value : "";
}

// /m always opens the phone view, and leaves it chosen for this browser.
export function phoneViewPathOverride(pathname) {
  return /^\/m\/?$/.test(pathname || "") ? "phone" : "";
}

export function shouldUsePhoneView({ width, coarsePointer, override }) {
  const chosen = normalizePhoneViewOverride(override);
  if (chosen) return chosen === "phone";
  return Boolean(coarsePointer) && Number(width) > 0 && Number(width) < phoneViewMaxWidth;
}

// Whether this device is a phone, whichever view it shows: its screen's
// shorter side, unlike the window, stays put through rotation and resizing.
// A phone keeps display settings apart from desktops and iPads.
export function isPhoneDevice({ coarsePointer, screenWidth, screenHeight }) {
  const shorter = Math.min(Number(screenWidth), Number(screenHeight));
  return Boolean(coarsePointer) && shorter > 0 && shorter < phoneViewMaxWidth;
}

// "~/src/tessera" for a path in the host account's home folder.
export function shortenDirectory(path, home) {
  if (typeof path !== "string" || !path) return "";
  const base = typeof home === "string" ? home.replace(/\/+$/, "") : "";
  if (base && (path === base || path.startsWith(`${base}/`))) return `~${path.slice(base.length)}`;
  return path;
}

function commandName(line, fallback) {
  const text = typeof line === "string" ? line.trim() : "";
  if (!text) return fallback;
  return [...text].length > 60 ? `${[...text].slice(0, 59).join("")}…` : text;
}

function alertFromSummary(alert) {
  if (!alert || typeof alert !== "object") return null;
  if (alert.kind === "command") {
    return { kind: "command", title: alert.title || "", status: Number.isInteger(alert.status) ? alert.status : null, seconds: alert.seconds || 0 };
  }
  if (alert.kind === "notification" || alert.kind === "bell") return { kind: alert.kind, title: alert.title || "", body: alert.body || "" };
  return null;
}

// What a card says about a shell, and which kind of state it is in, which
// sets its colour and order: attention (a bell or notification nobody has
// seen), failed or finished (a long command nobody has seen end), running,
// idle at a prompt, exited, or quiet for a shell that doesn't mark prompts.
// elapsedSeconds is how long ago the summary arrived.
export function terminalCardStatus(summary, elapsedSeconds = 0) {
  if (!summary) return { state: "closed", label: "Not running" };
  if (summary.exited) return { state: "exited", label: "Shell exited" };
  const alert = alertFromSummary(summary.alert);
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  if (alert?.kind === "command") {
    const after = alert.seconds ? ` after ${terminalDuration(alert.seconds)}` : "";
    const name = commandName(alert.title, "Command");
    return terminalCommandFailed(alert)
      ? { state: "failed", label: `${name} · failed (exit ${alert.status})${after}` }
      : { state: "finished", label: `${name} · finished${after}` };
  }
  if (alert?.kind === "notification") {
    const text = [alert.title, alert.body].filter(Boolean).join(": ");
    return { state: "attention", label: text || "Notification" };
  }
  if (alert?.kind === "bell") return { state: "attention", label: "Bell" };
  if (summary.running) {
    return { state: "running", label: `${commandName(summary.command, "Running")} · ${terminalDuration((summary.runningSeconds || 0) + elapsed)}` };
  }
  if (summary.marksPrompts) {
    const last = summary.lastCommand;
    if (last && Number.isInteger(last.status) && last.status !== 0) {
      return { state: "idle", label: `At the prompt · ${commandName(last.line, "last command")} failed (exit ${last.status})` };
    }
    return { state: "idle", label: "At the prompt" };
  }
  if (summary.outputSecondsAgo >= 0) {
    return { state: "quiet", label: `Output ${terminalDuration(summary.outputSecondsAgo + elapsed)} ago` };
  }
  return { state: "quiet", label: "No output yet" };
}

const stateOrder = { attention: 0, failed: 0, finished: 0, running: 1, idle: 2, quiet: 2, exited: 3, closed: 4 };

// Unseen alerts first, then running shells, then by most recent output.
export function sortTerminalCards(cards) {
  return [...cards].sort((a, b) => {
    const order = (stateOrder[a.status.state] ?? 5) - (stateOrder[b.status.state] ?? 5);
    if (order) return order;
    const ageA = a.summary?.outputSecondsAgo ?? -1, ageB = b.summary?.outputSecondsAgo ?? -1;
    if ((ageA < 0) !== (ageB < 0)) return ageA < 0 ? 1 : -1;
    if (ageA !== ageB) return ageA - ageB;
    return a.title.localeCompare(b.title);
  });
}

// One card per terminal pane, in the order to show them. Panes of other
// kinds come back separately, since they open only on the desktop view.
export function phoneCards(panes, response, elapsedSeconds = 0) {
  const summaries = new Map((response?.terminals || []).map((summary) => [summary.paneId, summary]));
  const terminals = [], others = [];
  for (const pane of panes) {
    if (pane.kind !== "terminal") {
      others.push({ id: pane.id, kind: pane.kind, title: pane.title });
      continue;
    }
    const summary = summaries.get(pane.id) || null;
    terminals.push({
      id: pane.id,
      title: pane.title || "Terminal",
      summary,
      status: terminalCardStatus(summary, elapsedSeconds),
      directory: shortenDirectory(summary?.directory || pane.cwd || "", response?.home),
      tail: Array.isArray(summary?.tail) ? summary.tail : [],
      progress: summary?.progress?.state && summary.progress.state !== "remove"
        ? { state: summary.progress.state, percent: Number.isInteger(summary.progress.percent) && summary.progress.percent >= 0 ? summary.progress.percent : null }
        : null,
    });
  }
  return { terminals: sortTerminalCards(terminals), others };
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The view itself. The page supplies the workspace and acts on panes:
//   panes()            the workspace's panes ({ id, kind, title, cwd })
//   workspaceID()      the session the list belongs to
//   sessionName()      its name, for the header
//   onOpen(id)         show that terminal; the view has already set itself up
//   onBack(id)         the terminal stopped being shown
//   onInterrupt(id), onRename(id), onClose(id), onNewTerminal()
//   onSessions(), onDesktop()
//   onShellsChanged()  the host's shells and the page's panes disagree, as
//                      when the desk opened or closed a window
//   input              PhoneInput's options, for typing into the open terminal
//   terminalView(id)   { cols, rows, fitted, zoom, alternate } for the open one
//   setZoom(id, factor), setFit(id, on)
//   refreshTerminal(id) the open terminal is on screen; keep its view current
//   readingText(id)    its lines of text, or null for a full-screen program
//   storage            { get(key), set(key, value) }, for the chosen view

export class PhoneView {
  constructor(root, options) {
    this.root = root;
    this.document = root.ownerDocument;
    this.options = options;
    this.fetch = options.fetch || ((...args) => globalThis.fetch(...args));
    this.active = false;
    this.openPaneID = "";
    this.response = null;
    this.receivedAt = 0;
    this.version = "";
    this.polling = null;
    this.retry = 0;
    this.clock = null;
    this.menu = null;
    this.mismatch = "";
    // Text unless this browser chose the screen: a desk's terminal is too wide
    // to read as a screen at a phone's width.
    this.reading = this.options.storage?.get?.(phoneReadingStorageKey) !== "screen";
    this.readingTimer = null;
    this.build();
  }

  build() {
    const doc = this.document;
    this.root.className = "phone-view";
    this.root.hidden = true;

    this.inbox = element(doc, "section", "phone-inbox");
    this.inbox.setAttribute("aria-label", "Terminals");
    const header = element(doc, "header", "phone-header");
    this.sessionButton = element(doc, "button", "phone-session-button");
    this.sessionButton.type = "button";
    this.sessionButton.addEventListener("click", () => this.options.onSessions?.());
    const actions = element(doc, "div", "phone-header-actions");
    const add = element(doc, "button", "phone-icon-button", "+");
    add.type = "button";
    add.setAttribute("aria-label", "New terminal");
    add.addEventListener("click", () => this.options.onNewTerminal?.());
    const desktop = element(doc, "button", "phone-text-button", "Desktop");
    desktop.type = "button";
    desktop.title = "Use the desktop view in this browser";
    desktop.addEventListener("click", () => this.options.onDesktop?.());
    actions.append(add, desktop);
    header.append(this.sessionButton, actions);
    this.status = element(doc, "p", "phone-list-status");
    this.status.setAttribute("role", "status");
    this.list = element(doc, "ul", "phone-cards");
    this.others = element(doc, "p", "phone-others");
    this.inbox.append(header, this.status, this.list, this.others);

    this.terminalHeader = element(doc, "header", "phone-header phone-terminal-header");
    this.terminalHeader.hidden = true;
    const back = element(doc, "button", "phone-icon-button phone-back", "‹");
    back.type = "button";
    back.setAttribute("aria-label", "Back to terminals");
    back.addEventListener("click", () => this.back());
    const heading = element(doc, "div", "phone-terminal-heading");
    this.terminalTitle = element(doc, "span", "phone-terminal-title");
    this.terminalState = element(doc, "span", "phone-terminal-state");
    heading.append(this.terminalTitle, this.terminalState);
    const view = element(doc, "button", "phone-icon-button phone-view-button", "Aa");
    view.type = "button";
    view.setAttribute("aria-label", "View");
    view.addEventListener("click", (event) => {
      event.stopPropagation();
      this.showViewMenu(view);
    });
    const more = element(doc, "button", "phone-icon-button", "⋯");
    more.type = "button";
    more.setAttribute("aria-label", "Terminal actions");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.showMenu(this.openPaneID, more);
    });
    this.terminalHeader.append(back, heading, view, more);

    this.readingView = element(doc, "div", "phone-reading");
    this.readingView.hidden = true;
    this.readingView.setAttribute("role", "log");
    this.readingView.setAttribute("aria-label", "Terminal output as text");

    this.input = this.options.input ? new PhoneInput(doc, this.options.input) : null;
    this.root.append(this.inbox, this.terminalHeader, this.readingView, ...(this.input ? [this.input.element] : []));
    this.onVisibility = () => {
      if (!this.active) return;
      if (this.document.hidden) this.stopPolling();
      else this.startPolling({ fresh: true });
    };
    this.onOutsidePointer = (event) => {
      if (this.menu && !this.menu.contains(event.target)) this.hideMenu();
    };
    this.onViewport = () => this.measure();
    if (this.input && typeof globalThis.ResizeObserver === "function") {
      new globalThis.ResizeObserver(this.onViewport).observe(this.input.element);
    }
  }

  // The open terminal sits above the input area, and both sit above the
  // phone's keyboard, which covers the bottom of the page without making it
  // any shorter.
  measure() {
    const style = this.document.documentElement.style;
    if (!style?.setProperty) return;
    const viewport = globalThis.visualViewport;
    const keyboard = viewport ? Math.max(0, Math.round(globalThis.innerHeight - viewport.height - viewport.offsetTop)) : 0;
    style.setProperty("--phone-keyboard-inset", `${keyboard}px`);
    const input = this.input && !this.input.element.hidden ? this.input.element.offsetHeight || 0 : 0;
    style.setProperty("--phone-input-height", `${input}px`);
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.root.hidden = false;
    this.document.documentElement.dataset.phoneView = this.openPaneID ? "terminal" : "inbox";
    this.document.addEventListener("visibilitychange", this.onVisibility);
    this.document.addEventListener("pointerdown", this.onOutsidePointer, true);
    globalThis.visualViewport?.addEventListener("resize", this.onViewport);
    globalThis.visualViewport?.addEventListener("scroll", this.onViewport);
    this.startClock();
    this.render();
    this.startPolling({ fresh: true });
  }

  leave() {
    if (!this.active) return;
    const open = this.openPaneID;
    this.showInbox();
    this.active = false;
    this.root.hidden = true;
    delete this.document.documentElement.dataset.phoneView;
    this.document.removeEventListener("visibilitychange", this.onVisibility);
    this.document.removeEventListener("pointerdown", this.onOutsidePointer, true);
    globalThis.visualViewport?.removeEventListener("resize", this.onViewport);
    globalThis.visualViewport?.removeEventListener("scroll", this.onViewport);
    globalThis.clearInterval(this.clock);
    this.clock = null;
    this.stopPolling();
    if (open) this.options.onBack?.(open);
  }

  startClock() {
    globalThis.clearInterval(this.clock);
    this.clock = globalThis.setInterval(() => this.render(), this.openPaneID ? openClockTickMs : clockTickMs);
  }

  // The session changed underneath: forget the old one's list.
  reset() {
    const open = this.openPaneID;
    this.showInbox();
    if (open) this.options.onBack?.(open);
    this.response = null;
    this.version = "";
    this.render();
    if (this.active) this.startPolling({ fresh: true });
  }

  open(paneID) {
    if (!this.active || !paneID) return;
    this.hideMenu();
    const previous = this.openPaneID;
    this.openPaneID = paneID;
    this.document.documentElement.dataset.phoneView = "terminal";
    this.inbox.hidden = true;
    this.terminalHeader.hidden = false;
    const card = this.cards().terminals.find((candidate) => candidate.id === paneID);
    this.input?.attach(paneID, { alerted: Boolean(card?.summary?.alert) });
    this.measure();
    this.renderTerminalHeader();
    this.startClock();
    if (previous && previous !== paneID) this.options.onBack?.(previous);
    this.options.onOpen?.(paneID);
    this.renderReading({ follow: true });
  }

  back() {
    const open = this.openPaneID;
    if (!open) return;
    this.showInbox();
    this.options.onBack?.(open);
    this.render();
    // The list may have been waiting on a version from before the terminal
    // was opened; ask again now that it is on screen.
    this.startPolling({ fresh: true });
  }

  showInbox() {
    this.hideMenu();
    this.input?.detach();
    this.readingView.hidden = true;
    globalThis.clearInterval(this.readingTimer);
    this.readingTimer = null;
    this.openPaneID = "";
    if (this.clock) this.startClock();
    if (this.active) this.document.documentElement.dataset.phoneView = "inbox";
    this.inbox.hidden = false;
    this.terminalHeader.hidden = true;
  }

  setReading(on) {
    this.reading = on;
    this.options.storage?.set(phoneReadingStorageKey, on ? "text" : "screen");
    this.renderReading({ follow: true });
  }

  // Text mode shows what the terminal holds as lines of text, rewrapped to
  // the phone, kept up to date while it is open and following new output
  // unless scrolled up. A full-screen program's screen isn't lines of text,
  // so it shows as the screen.
  renderReading({ follow = false } = {}) {
    const paneID = this.openPaneID;
    const lines = this.reading && paneID ? this.options.readingText?.(paneID) : null;
    if (!lines) {
      this.readingView.hidden = true;
      globalThis.clearInterval(this.readingTimer);
      this.readingTimer = null;
      return;
    }
    const view = this.readingView;
    const atEnd = follow || view.hidden || view.scrollHeight - view.scrollTop - view.clientHeight < 48;
    const text = lines.join("\n");
    if (text !== this.readingTextShown || view.hidden) {
      view.textContent = text;
      this.readingTextShown = text;
    }
    view.hidden = false;
    if (atEnd) view.scrollTop = view.scrollHeight;
    this.readingTimer ??= globalThis.setInterval(() => this.renderReading(), readingRefreshMs);
  }

  // A pane went away or was renamed.
  panesChanged() {
    if (this.openPaneID && !this.options.panes().some((pane) => pane.id === this.openPaneID)) this.showInbox();
    this.render();
  }

  cards() {
    const elapsed = this.receivedAt ? (Date.now() - this.receivedAt) / 1000 : 0;
    return phoneCards(this.options.panes(), this.response, elapsed);
  }

  render() {
    if (!this.active) return;
    this.sessionButton.textContent = this.options.sessionName?.() || "Tessera";
    this.sessionButton.title = "Switch session";
    if (this.openPaneID) {
      this.renderTerminalHeader();
      return;
    }
    const { terminals, others } = this.cards();
    this.list.replaceChildren(...terminals.map((card) => this.renderCard(card)));
    if (!this.response && this.retry === 0) this.status.textContent = "Loading…";
    else if (!terminals.length) this.status.textContent = "No terminals in this session. Tap + to start one.";
    else this.status.textContent = "";
    this.status.hidden = !this.status.textContent;
    this.others.hidden = !others.length;
    this.others.textContent = others.length
      ? `${others.length === 1 ? "1 other window" : `${others.length} other windows`} (${others.map((pane) => pane.title).join(", ")}) open on the desktop view.`
      : "";
  }

  renderCard(card) {
    const doc = this.document;
    const item = element(doc, "li", "phone-card");
    item.dataset.state = card.status.state;
    item.dataset.paneId = card.id;
    const open = element(doc, "button", "phone-card-open");
    open.type = "button";
    open.addEventListener("click", () => this.open(card.id));
    const top = element(doc, "span", "phone-card-top");
    top.append(element(doc, "span", "phone-card-title", card.title), element(doc, "span", "phone-card-dot"));
    open.append(top, element(doc, "span", "phone-card-state", card.status.label));
    // The directory is cut from the left, so its end stays in view; the
    // marks keep the slashes of a left-to-right path where they belong.
    if (card.directory) open.append(element(doc, "span", "phone-card-directory", `\u200e${card.directory}\u200e`));
    if (card.progress) open.append(this.renderProgress(card.progress));
    if (card.tail.length) {
      const tail = element(doc, "span", "phone-card-tail");
      tail.textContent = card.tail.join("\n");
      open.append(tail);
    }
    open.setAttribute("aria-label", `${card.title}. ${card.status.label}${card.directory ? `. ${card.directory}` : ""}`);
    const more = element(doc, "button", "phone-icon-button phone-card-more", "⋯");
    more.type = "button";
    more.setAttribute("aria-label", `Actions for ${card.title}`);
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.showMenu(card.id, more);
    });
    item.append(open, more);
    return item;
  }

  renderProgress(progress) {
    const bar = element(this.document, "span", "phone-card-progress");
    const width = terminalProgressWidth(progress);
    bar.dataset.state = progress.state;
    bar.classList.toggle("is-indeterminate", width === null);
    const fill = element(this.document, "span");
    if (width !== null) fill.style.width = `${width}%`;
    bar.append(fill);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", terminalProgressDescription(progress));
    return bar;
  }

  renderTerminalHeader() {
    const card = this.cards().terminals.find((candidate) => candidate.id === this.openPaneID);
    const pane = this.options.panes().find((candidate) => candidate.id === this.openPaneID);
    this.terminalTitle.textContent = card?.title || pane?.title || "Terminal";
    // The open terminal is being looked at, so its alert is seen already.
    const summary = card?.summary ? { ...card.summary, alert: null } : null;
    const elapsed = this.receivedAt ? (Date.now() - this.receivedAt) / 1000 : 0;
    const status = terminalCardStatus(summary, elapsed);
    this.terminalState.textContent = status.label;
    this.terminalHeader.dataset.state = status.state;
    this.input?.update(card?.summary || null, elapsed);
    if (this.openPaneID) this.options.refreshTerminal?.(this.openPaneID);
  }

  showMenu(paneID, anchor) {
    if (!paneID) return;
    this.showItems(anchor, [
      ...(this.openPaneID === paneID ? [] : [{ label: "Open", run: () => this.open(paneID) }]),
      { label: "Interrupt (Ctrl+C)", run: () => this.options.onInterrupt?.(paneID) },
      { label: "Rename…", run: () => this.options.onRename?.(paneID) },
      { label: "Close…", run: () => this.options.onClose?.(paneID), danger: true },
    ]);
  }

  // How the open terminal is shown: its screen at the shell's own size, in
  // a font small enough for the phone's width and larger on request, or as
  // text; or the shell resized to the phone while it stays open.
  showViewMenu(anchor) {
    const paneID = this.openPaneID;
    const view = this.options.terminalView?.(paneID);
    if (!view) return;
    const text = this.reading && !view.alternate;
    const size = `Shell ${view.cols}×${view.rows} · ${view.fitted ? "fitted to this phone" : "its own size"}`;
    this.showItems(anchor, [
      { note: size },
      { label: "Screen", checked: !text, run: () => this.setReading(false) },
      { label: view.alternate ? "Text (not for full-screen programs)" : "Text", checked: text, disabled: view.alternate, run: () => this.setReading(true) },
      { label: "Larger", disabled: text || view.fitted, run: () => this.options.setZoom?.(paneID, 1.25) },
      { label: "Smaller", disabled: text || view.fitted || view.zoom <= 1, run: () => this.options.setZoom?.(paneID, 0.8) },
      { label: "Fit to this phone", checked: view.fitted, run: () => this.options.setFit?.(paneID, !view.fitted) },
    ], "phone-view-menu");
  }

  showItems(anchor, items, className = "") {
    this.hideMenu();
    const doc = this.document;
    const menu = element(doc, "div", `phone-menu ${className}`.trim());
    menu.setAttribute("role", "menu");
    for (const item of items) {
      if (item.note) {
        menu.append(element(doc, "p", "phone-menu-note", item.note));
        continue;
      }
      const button = element(doc, "button", "phone-menu-item", item.label);
      button.type = "button";
      button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
      if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
      if (item.danger) button.dataset.danger = "true";
      button.disabled = Boolean(item.disabled);
      button.addEventListener("click", () => {
        this.hideMenu();
        item.run();
      });
      menu.append(button);
    }
    const box = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(box.bottom + 4)}px`;
    menu.style.right = `${Math.max(8, Math.round(doc.documentElement.clientWidth - box.right))}px`;
    this.root.append(menu);
    this.menu = menu;
    menu.querySelector("button")?.focus({ preventScroll: true });
  }

  hideMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  // One request stays open at a time. It comes back when the shells change,
  // or after a while with nothing new, and the next one goes out at once.
  startPolling({ fresh = false } = {}) {
    this.stopPolling();
    if (!this.active || this.document.hidden) return;
    const controller = new AbortController();
    this.polling = controller;
    const workspace = this.options.workspaceID();
    const version = fresh ? "" : this.version;
    const url = `/api/workspace/${encodeURIComponent(workspace)}/terminals${version ? `?version=${encodeURIComponent(version)}` : ""}`;
    this.fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`terminal list failed (${response.status})`);
        return response.json();
      })
      .then((data) => {
        if (this.polling !== controller || workspace !== this.options.workspaceID()) return;
        this.polling = null;
        this.retry = 0;
        this.version = typeof data.version === "string" ? data.version : "";
        this.response = data;
        this.receivedAt = Date.now();
        this.render();
        this.checkShells();
        this.startPolling();
      })
      .catch((error) => {
        if (this.polling !== controller || error?.name === "AbortError") return;
        this.polling = null;
        const delay = retryDelaysMs[Math.min(this.retry, retryDelaysMs.length - 1)];
        this.retry += 1;
        if (!this.response) {
          this.status.textContent = "Can't reach Tessera. Trying again…";
          this.status.hidden = false;
        }
        this.retryTimer = globalThis.setTimeout(() => this.startPolling(), delay);
      });
  }

  // Said once for each way the lists differ, and only while the list is on
  // screen: refreshing the workspace under an open terminal would reconnect it.
  checkShells() {
    const panes = new Set(this.options.panes().filter((pane) => pane.kind === "terminal").map((pane) => pane.id));
    const shells = new Set((this.response?.terminals || []).map((summary) => summary.paneId));
    const differ = [...shells].filter((id) => !panes.has(id)).sort().join(" ")
      + "|" + [...panes].filter((id) => !shells.has(id)).sort().join(" ");
    if (differ === "|") {
      this.mismatch = "";
      return;
    }
    if (this.openPaneID || differ === this.mismatch) return;
    this.mismatch = differ;
    this.options.onShellsChanged?.();
  }

  stopPolling() {
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const polling = this.polling;
    this.polling = null;
    polling?.abort();
  }
}
