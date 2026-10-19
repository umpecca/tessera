// OSC 22 sets the mouse pointer's shape over the terminal. The core reports
// the shape as Ghostty's MouseShape value; these are the matching CSS cursor
// names, in that enum's order.
export const terminalPointerShapes = [
  "default", "context-menu", "help", "pointer", "progress", "wait", "cell",
  "crosshair", "text", "vertical-text", "alias", "copy", "move", "no-drop",
  "not-allowed", "grab", "grabbing", "all-scroll", "col-resize", "row-resize",
  "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize",
  "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize",
  "nwse-resize", "zoom-in", "zoom-out",
];

// The terminal's own pointer, until a program sets another.
export const defaultTerminalPointerShape = "text";

export function terminalPointerShape(value) {
  return terminalPointerShapes[value] ?? defaultTerminalPointerShape;
}
