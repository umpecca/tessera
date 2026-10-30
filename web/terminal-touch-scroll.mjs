// Two fingers dragged on a terminal scroll it, as the wheel does; one finger
// still selects, pans a zoomed phone screen, or presses for a program that
// reads the mouse. Once a second finger lands the gesture is a scroll until
// every finger lifts, so lifting one early doesn't start a selection.
export class TerminalTouchScroll {
  constructor() {
    this.touches = new Map();
    this.scrolling = false;
    this.y = null;
  }

  // Notes a finger down. Returns true when it is the second, which starts a
  // scroll, and for any finger that lands during one.
  down(event) {
    if (event.pointerType !== "touch") return false;
    this.touches.set(event.pointerId, event.clientY);
    if (this.touches.size < 2 && !this.scrolling) return false;
    this.scrolling = true;
    this.y = this.middle();
    return true;
  }

  // Returns how far the fingers moved down, in pixels, while scrolling, and
  // null for a pointer that isn't part of a scroll.
  move(event) {
    if (!this.scrolling || !this.touches.has(event.pointerId)) {
      if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, event.clientY);
      return null;
    }
    this.touches.set(event.pointerId, event.clientY);
    if (this.touches.size < 2) return 0;
    const y = this.middle();
    const moved = y - this.y;
    this.y = y;
    return moved;
  }

  // Notes a finger lifted or cancelled. Returns true when it was part of a
  // scroll, which the terminal shouldn't hear about.
  up(event) {
    if (!this.touches.delete(event.pointerId)) return false;
    const scrolling = this.scrolling;
    if (this.touches.size === 0) {
      this.scrolling = false;
      this.y = null;
    } else if (scrolling) {
      this.y = this.middle();
    }
    return scrolling;
  }

  middle() {
    let total = 0;
    for (const y of this.touches.values()) total += y;
    return total / this.touches.size;
  }
}
