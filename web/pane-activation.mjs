export function paneNeedsRaise(panes, pane) {
  return panes.some((other) => other !== pane && other.zIndex >= pane.zIndex);
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
