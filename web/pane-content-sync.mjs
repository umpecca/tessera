// Archived documents from retired panes may be large; most saves change only
// dragging or resizing a window. paneContentFields lets a save name the content
// it already stored instead of resending it; the server keeps its stored copy
// for every field flagged unchanged.

export function paneContentFields(content, saved) {
  const fields = {};
  if (saved && saved.bufferText === content.bufferText) {
    fields.bufferTextUnchanged = true;
  } else {
    fields.bufferText = content.bufferText;
  }
  if (saved && saved.editorTabs === content.editorTabs) {
    fields.editorTabsUnchanged = true;
  } else {
    fields.editorTabs = content.editorTabs;
  }
  return fields;
}
