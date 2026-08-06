export function paneNeedsRaise(panes, pane) {
  return panes.some((other) => other !== pane && other.zIndex >= pane.zIndex);
}

// Which pane a freshly loaded workspace should activate. The saved pane is
// the operator's own last choice, so it wins wherever it can actually be
// seen. A maximized pane fills the board and hides everything beneath it,
// so it takes over only when the saved pane is behind it — putting the caret
// in a window nobody can see would be worse than ignoring the saved choice.
export function activePaneOnLoad(panes, savedActivePaneID) {
  const visible = panes.filter((pane) => !pane.minimized);
  const covering = visible
    .filter((pane) => pane.isFull)
    .reduce((top, pane) => (top === null || pane.zIndex > top.zIndex ? pane : top), null);
  const saved = visible.find((pane) => pane.id === savedActivePaneID) || null;
  if (saved && (covering === null || saved === covering || saved.zIndex > covering.zIndex)) {
    return saved;
  }
  return covering;
}

export function focusPane(pane) {
  if (!pane) {
    return false;
  }

  if (pane.kind === "terminal" && typeof pane.terminal?.term?.focus === "function") {
    pane.terminal.term.focus();
    return true;
  }
  if (typeof pane.editor?.focus === "function") {
    pane.editor.focus();
    return true;
  }

  let target = pane.element;
  if (pane.kind === "browser") {
    target = pane.browser?.frame && !pane.browser.frame.hidden
      ? pane.browser.frame
      : pane.browser?.address || target;
  } else if (pane.kind === "file-browser") {
    const entry = pane.fileBrowserView?.content?.querySelector?.(".pane-file-browser-entry.is-selected")
      || pane.fileBrowserView?.content?.querySelector?.(".pane-file-browser-entry")
      || pane.fileBrowserView?.upButton;
    target = entry && !entry.disabled ? entry : target;
  } else if (pane.kind === "audio") {
    target = pane.audio?.play && !pane.audio.play.disabled ? pane.audio.play : target;
  }

  if (typeof target?.focus !== "function") {
    return false;
  }
  target.focus({ preventScroll: true });
  return true;
}
