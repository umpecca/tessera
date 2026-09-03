export function windowSwitcherEntries(panes, activePaneID) {
  const visible = panes
    .map((pane, sourceIndex) => ({ pane, sourceIndex }))
    .filter(({ pane }) => pane.kind !== "pending" && !pane.minimized);
  const total = visible.length;
  return visible.map(({ pane, sourceIndex }, index) => ({
    pane,
    id: pane.id,
    name: typeof pane.title === "string" && pane.title.trim()
      ? pane.title.trim()
      : `Window ${sourceIndex + 1}`,
    position: index + 1,
    total,
    active: pane.id === activePaneID,
  }));
}

export function adjacentWindowPane(panes, currentPane, direction) {
  const entries = windowSwitcherEntries(panes, currentPane?.id || "");
  if (entries.length === 0) {
    return null;
  }
  const currentIndex = entries.findIndex((entry) => entry.pane === currentPane);
  const nextIndex = (currentIndex + direction + entries.length) % entries.length;
  return entries[nextIndex].pane;
}
